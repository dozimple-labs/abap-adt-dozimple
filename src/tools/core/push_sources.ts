import { z } from "zod";
import type { InactiveObject } from "abap-adt-api";
import { activateObjects } from "../../core/activation.js";
import { stateOf } from "../../core/confirm.js";
import { ToolError } from "../../core/errors.js";
import { CLASS_INCLUDES, resolveObject, sourceUrl, TYPE_HELP } from "../../core/objects.js";
import { defineTool, type ToolContext } from "../../core/tool.js";
import { applySourceEdits } from "./edit_source.js";
import { previewSave, runSave } from "./write_source.js";

/**
 * Varias fuentes en una operación (Ola 3, punto 15): una sola vista previa consolidada (sintaxis y diff de cada
 * objeto), una sola confirmación, guardado objeto a objeto con las mismas garantías que write_source y una
 * activación conjunta al final. Lo que falle se cuenta por objeto; nunca se activa lo que no se guardó.
 */
const MAX_FILES = 20;

const EDIT = z.object({
  old_text: z.string().min(1).describe("Texto exacto que hay ahora (una sola aparición, salvo replace_all)"),
  new_text: z.string().describe("Texto nuevo; vacío borra"),
  replace_all: z.boolean().default(false),
});
const FILE = z.object({
  object_name: z.string().min(1),
  object_type: z.string().optional().describe(TYPE_HELP),
  include: z.enum(CLASS_INCLUDES).default("main"),
  source: z.string().min(1).optional().describe("Fuente completa nueva de ese objeto o include (o bien edits)"),
  edits: z.array(EDIT).min(1).max(50).optional().describe("Sustituciones sobre la fuente actual, como en edit_source (o bien source)"),
});
type File = z.infer<typeof FILE>;

/** Cómo se obtiene la fuente nueva de cada archivo: completa, o la actual con las sustituciones aplicadas. */
const builder = (f: File) => (current: string) => (f.source !== undefined ? f.source : applySourceEdits(current, f.edits!));

const keyOf = (f: File) => `${f.object_name.trim().toUpperCase()}|${(f.object_type ?? "").toUpperCase()}|${f.include}`;

function checkFiles(files: File[]): void {
  const seen = new Set<string>();
  for (const f of files) {
    const k = keyOf(f);
    if (seen.has(k)) throw new ToolError("INPUT", `${f.object_name} (${f.include}) aparece dos veces en files.`);
    if ((f.source === undefined) === (f.edits === undefined)) throw new ToolError("INPUT", `${f.object_name}: indica source o edits, uno de los dos.`);
    seen.add(k);
  }
}

/** Huella de lo que hay ahora en SAP para cada archivo, en el mismo orden; la combinada viaja con la confirmación. */
async function currentStates(files: File[], ctx: Pick<ToolContext, "sap">): Promise<{ states: string[]; combined: string; refs: InactiveObject[] }> {
  const c = await ctx.sap.adt();
  const states: string[] = [];
  const refs: InactiveObject[] = [];
  for (const f of files) {
    const obj = await resolveObject(c, f.object_name, f.object_type);
    const url = await sourceUrl(c, obj, f.include);
    states.push(stateOf(await c.getObjectSource(url)));
    if (!refs.some((r) => r["adtcore:uri"] === obj.uri)) refs.push({ "adtcore:name": obj.name, "adtcore:type": obj.type, "adtcore:uri": obj.uri, "adtcore:parentUri": "" });
  }
  return { states, combined: stateOf(states.join("|")), refs };
}

export default defineTool({
  name: "push_sources",
  title: "Guardar varias fuentes en una operación",
  timeoutMs: 300_000,
  description:
    "Varios objetos existentes (hasta 20) en la misma orden con una sola vista previa consolidada (sintaxis y diff " +
    "por objeto), una sola confirmación y activación conjunta. Cada objeto lleva su fuente completa o sus " +
    "ediciones (texto actual → nuevo, como edit_source). Lo que falle se dice y no se activa. Nuevos: create_object.",
  access: "write",
  input: {
    files: z.array(FILE).min(1).max(MAX_FILES),
    transport: z.string().optional().describe("Orden (o tarea) para todos. Obligatoria salvo objetos locales"),
    activate: z.boolean().default(true).describe("Activar todos juntos al final"),
    skip_syntax_check: z.boolean().default(false),
  },
  async preview({ files, transport, activate, skip_syntax_check }, ctx) {
    checkFiles(files);
    const parts: string[] = [`${files.length} fuentes · orden ${transport ?? "ninguna indicada (solo vale para objetos locales)"} · activar al final: ${activate ? "sí, todas juntas" : "no"}`];
    for (const [i, f] of files.entries()) {
      ctx.signal?.throwIfAborted();
      ctx.progress?.(`Vista previa ${i + 1} de ${files.length}: ${f.object_name}`, i + 1, files.length);
      const p = await previewSave({ ...f, transport, activate: false, skip_syntax_check }, ctx, builder(f));
      const text = typeof p === "string" ? p : p.text;
      parts.push("", `━━ ${i + 1}/${files.length} ━━`, text.replace(/\n\nSi el objeto está bloqueado en otra orden[^\n]*/, "").replace(/\nOrden: [^\n]*activar después: no/, ""));
    }
    parts.push("", "Si algún objeto está bloqueado en otra orden, ese guardado se detendrá y los demás seguirán; nada se activa si no se guardó.");
    const { combined } = await currentStates(files, ctx);
    return { text: parts.join("\n"), state: combined };
  },
  async run({ files, transport, activate, skip_syntax_check }, ctx) {
    checkFiles(files);
    const { states, combined, refs } = await currentStates(files, ctx);
    if (ctx.confirmedState && ctx.confirmedState !== combined) {
      return { text: "No se escribió nada: alguna de las fuentes cambió en SAP después de la vista previa. Pide una vista previa nueva.", isError: true };
    }
    const lines: string[] = [];
    const savedUris = new Set<string>();
    let failed = 0;
    for (const [i, f] of files.entries()) {
      ctx.signal?.throwIfAborted();
      ctx.progress?.(`Guardando ${i + 1} de ${files.length}: ${f.object_name}`, i + 1, files.length);
      const r = await runSave({ ...f, transport, activate: false, skip_syntax_check }, { sap: ctx.sap, confirmedState: states[i] }, builder(f));
      const text = typeof r === "string" ? r : r.text;
      const ok = typeof r === "string" ? true : !r.isError;
      if (ok) {
        const c = await ctx.sap.adt();
        const obj = await resolveObject(c, f.object_name, f.object_type);
        savedUris.add(obj.uri);
      } else failed++;
      lines.push(`${ok ? "✓" : "✗"} ${f.object_name}${f.include !== "main" ? ` (${f.include})` : ""}: ${text.split("\n")[0]}`);
    }
    let activation = "";
    if (activate && savedUris.size) {
      const c = await ctx.sap.adt();
      const act = await activateObjects(c, refs.filter((r) => savedUris.has(r["adtcore:uri"])));
      activation = `\n\nActivación conjunta de ${savedUris.size} objetos:\n${act.text}`;
      if (!act.ok) failed++;
    } else if (activate) activation = "\n\nNada que activar: ningún guardado terminó bien.";
    else if (savedUris.size) activation = `\n\nSin activar (activate=false): ${savedUris.size} objetos quedan como versión inactiva.`;
    return { text: `${files.length - (failed > files.length ? files.length : Math.min(failed, files.length))} de ${files.length} guardados.\n${lines.join("\n")}${activation}`, isError: failed > 0 };
  },
});
