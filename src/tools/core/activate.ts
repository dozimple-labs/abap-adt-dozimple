import { z } from "zod";
import type { ADTClient, InactiveObject } from "abap-adt-api";
import { activateObject, activateObjects } from "../../core/activation.js";
import { stateOf } from "../../core/confirm.js";
import { ToolError } from "../../core/errors.js";
import { resolveObject, TYPE_HELP } from "../../core/objects.js";
import { assertTrkorr } from "../../core/policy.js";
import { defineTool, type ToolContext } from "../../core/tool.js";

/**
 * Activar uno o varios objetos. Varios van en UNA sola activación de SAP (como «Activar» con varios objetos en Eclipse
 * o SE80): así SAP resuelve las dependencias mutuas que, una a una, fallan. Idea tomada de sap-ai-dev-toolkit / vsp
 * (ActivateMultiple) y del ABAP Accelerator de AWS; implementación propia sobre abap-adt-api.
 *
 * Dos salvaguardas: nunca se activa un borrado pendiente (activarlo borra el objeto en SAP), y si la lista de objetos
 * cambió entre la vista previa y la confirmación, no se activa nada.
 */
const MAX_OBJECTS = 100;

const OBJ = z.object({ name: z.string().min(1), type: z.string().optional().describe(TYPE_HELP) });

const input = {
  object_name: z.string().min(1).optional().describe("Un objeto"),
  object_type: z.string().optional().describe(TYPE_HELP),
  objects: z.array(OBJ).min(2).max(MAX_OBJECTS).optional().describe("Varios objetos, activados juntos en una sola activación"),
  all_inactive: z.boolean().default(false).describe("Todos los objetos inactivos del usuario de la conexión (como «activar todo» en Eclipse)"),
  transport: z.string().optional().describe("Con all_inactive: solo los inactivos de esta orden"),
};
type Args = z.objectOutputType<typeof input, z.ZodTypeAny>;

interface Plan {
  targets: InactiveObject[];
  /** Borrados pendientes que NO se activan. */
  skippedDeletions: string[];
  label: string;
}

const ref = (name: string, type: string, uri: string, parentUri = ""): InactiveObject => ({
  "adtcore:name": name,
  "adtcore:type": type,
  "adtcore:uri": uri,
  "adtcore:parentUri": parentUri,
});

async function plan(c: ADTClient, a: Args, ctx: ToolContext): Promise<Plan> {
  const modes = [a.object_name, a.objects?.length ? "x" : undefined, a.all_inactive ? "x" : undefined].filter(Boolean).length;
  if (modes !== 1) throw new ToolError("INPUT", "Indica exactamente uno: object_name, objects o all_inactive=true.");
  if (a.transport && !a.all_inactive) throw new ToolError("INPUT", "transport solo filtra all_inactive.");

  if (a.object_name || a.objects) {
    const wanted = a.object_name ? [{ name: a.object_name, type: a.object_type }] : a.objects!;
    const targets: InactiveObject[] = [];
    for (const w of wanted) {
      const o = await resolveObject(c, w.name, w.type);
      targets.push(ref(o.name, o.type, o.uri));
    }
    return { targets, skippedDeletions: [], label: a.object_name ? targets[0]["adtcore:name"] : `${targets.length} objetos indicados` };
  }

  const tr = a.transport ? assertTrkorr(a.transport) : undefined;
  const me = ctx.system.user.toUpperCase();
  const recs = (await c.inactiveObjects()).filter((r) => r.object && r.object.user?.toUpperCase() === me);
  const inScope = recs.filter((r) => !tr || r.transport?.["adtcore:name"]?.toUpperCase() === tr);
  const skippedDeletions = inScope.filter((r) => r.object!.deleted).map((r) => `${r.object!["adtcore:name"]} (${r.object!["adtcore:type"]})`);
  const targets = inScope
    .filter((r) => !r.object!.deleted)
    .map((r) => ref(r.object!["adtcore:name"], r.object!["adtcore:type"], r.object!["adtcore:uri"], r.object!["adtcore:parentUri"]));
  if (targets.length > MAX_OBJECTS) {
    throw new ToolError("INPUT", `Hay ${targets.length} objetos inactivos; el máximo por activación es ${MAX_OBJECTS}. Acota con transport.`);
  }
  return { targets, skippedDeletions, label: `inactivos de ${me}${tr ? ` en la orden ${tr}` : ""}` };
}

/** Huella de la lista exacta que se mostró: si cambia antes de confirmar, no se activa. */
const listState = (p: Plan) => stateOf(p.targets.map((t) => `${t["adtcore:type"]}|${t["adtcore:uri"]}`).sort().join("\n"));

export default defineTool({
  name: "activate",
  title: "Activar objetos",
  description:
    "Activa un objeto, una lista de objetos o todos los inactivos del usuario (opcionalmente de una orden) y devuelve " +
    "los mensajes de SAP tal cual (errores con línea, avisos, objetos que quedan inactivos). Varios objetos se activan " +
    "JUNTOS en una sola activación, que resuelve dependencias mutuas (clase ↔ interfaz, programa ↔ include) que una a " +
    "una fallan. Nunca activa borrados pendientes.",
  access: "write",
  timeoutMs: 180_000,
  requires: { adt: ["/sap/bc/adt/activation"] },
  input,
  async preview(a, ctx) {
    const c = await ctx.sap.adt();
    const p = await plan(c, a, ctx);
    if (!p.targets.length) {
      const del = p.skippedDeletions.length ? ` Hay ${p.skippedDeletions.length} borrados pendientes, que esta tool no activa: ${p.skippedDeletions.join(", ")}.` : "";
      throw new ToolError("INPUT", `No hay nada que activar (${p.label}).${del}`);
    }
    const out = [
      p.targets.length === 1 ? `Se activará ${p.targets[0]["adtcore:name"]} (${p.targets[0]["adtcore:type"]}).` : `Se activarán juntos ${p.targets.length} objetos (${p.label}), en una sola activación:`,
      ...(p.targets.length > 1 ? p.targets.slice(0, 50).map((t) => `  · ${t["adtcore:name"]} (${t["adtcore:type"]})`) : []),
      ...(p.targets.length > 50 ? [`  … y ${p.targets.length - 50} más`] : []),
      "La versión inactiva pasa a ser la activa: quien ejecute el objeto usará el código nuevo.",
    ];
    if (p.skippedDeletions.length) {
      out.push(`⚠ ${p.skippedDeletions.length} borrados pendientes NO se activan (activarlos borraría el objeto en SAP): ${p.skippedDeletions.join(", ")}.`);
    }
    return { text: out.join("\n"), state: listState(p) };
  },
  async run(a, ctx) {
    const c = await ctx.sap.adt();
    const p = await plan(c, a, ctx);
    if (!p.targets.length) return { text: `No hay nada que activar (${p.label}).`, isError: true };
    if (ctx.confirmedState && ctx.confirmedState !== listState(p)) {
      return { text: "No se activó nada: la lista de objetos cambió desde la vista previa (alguien guardó o activó entretanto). Pide una vista previa nueva.", isError: true };
    }
    if (a.object_name) {
      const o = await resolveObject(c, a.object_name, a.object_type);
      const r = await activateObject(c, o);
      return { text: r.text, isError: !r.ok };
    }
    ctx.progress?.(`Activando ${p.targets.length} objetos juntos…`);
    const r = await activateObjects(c, p.targets);
    const skipped = p.skippedDeletions.length ? `\n\nNo se activaron ${p.skippedDeletions.length} borrados pendientes: ${p.skippedDeletions.join(", ")}.` : "";
    return { text: r.text + skipped, isError: !r.ok };
  },
});
