import { z } from "zod";
import { ToolError } from "../../core/errors.js";
import { CLASS_INCLUDES, TYPE_HELP } from "../../core/objects.js";
import { defineTool } from "../../core/tool.js";
import { previewSave, runSave } from "./write_source.js";

/**
 * Cambiar unas pocas líneas de un objeto sin reenviar la fuente entera: en un programa de miles de líneas, reproducirlo
 * completo para cambiar una sentencia es lento y es donde se cuelan cambios no pedidos. Aquí solo viaja el fragmento;
 * el servidor lee la fuente de SAP, sustituye y sigue el mismo camino que write_source.
 */
const EDIT = z.object({
  old_text: z.string().min(1).describe("Fragmento EXACTO que hay hoy en la fuente (con su sangría). Debe aparecer una sola vez, salvo replace_all"),
  new_text: z.string().describe("Texto que lo sustituye. Vacío = borrar el fragmento"),
  replace_all: z.boolean().default(false).describe("Sustituir todas las apariciones"),
});
export type SourceEdit = z.infer<typeof EDIT>;

const count = (text: string, part: string) => text.split(part).length - 1;

/** Aplica las sustituciones en orden, cada una sobre el resultado de la anterior. No adivina: 0 o varias coincidencias es error. */
export function applySourceEdits(source: string, edits: SourceEdit[]): string {
  const crlf = source.includes("\r\n");
  let text = source.replace(/\r\n/g, "\n");
  edits.forEach((e, i) => {
    const n = `Edición ${i + 1}`;
    const oldText = e.old_text.replace(/\r\n/g, "\n");
    const newText = e.new_text.replace(/\r\n/g, "\n");
    if (oldText === newText) throw new ToolError("INPUT", `${n}: old_text y new_text son iguales.`);
    const found = count(text, oldText);
    if (found === 0) {
      const loose = count(text.toUpperCase(), oldText.toUpperCase());
      throw new ToolError(
        "INPUT",
        `${n}: old_text no aparece en la fuente.`,
        loose ? "Aparece con otras mayúsculas/minúsculas: cópialo tal como está (get_source)." : "Léelo con get_source y copia el fragmento exacto, con su sangría. Si una edición anterior ya lo cambió, usa el texto resultante.",
      );
    }
    if (found > 1 && !e.replace_all) {
      throw new ToolError("INPUT", `${n}: old_text aparece ${found} veces.`, "Amplía el fragmento con líneas de contexto hasta que sea único, o usa replace_all=true.");
    }
    text = e.replace_all ? text.split(oldText).join(newText) : text.replace(oldText, () => newText);
  });
  return crlf ? text.replace(/\n/g, "\r\n") : text;
}

export default defineTool({
  name: "edit_source",
  title: "Editar un fragmento de la fuente",
  description:
    "Sustituye fragmentos concretos de la fuente de un objeto existente sin reenviarla entera: cada edición es el texto " +
    "exacto que hay hoy y el que lo reemplaza. Úsala para cambios pequeños en objetos grandes; para reescribir un objeto, " +
    "write_source. Mismas garantías que write_source: vista previa con la sintaxis de SAP sobre la fuente resultante y el " +
    "diff, orden explícita, y no escribe si el objeto cambió desde la vista previa o está bloqueado en otra orden.",
  access: "write",
  input: {
    object_name: z.string().min(1),
    object_type: z.string().optional().describe(TYPE_HELP),
    include: z.enum(CLASS_INCLUDES).default("main"),
    edits: z.array(EDIT).min(1).max(50).describe("Sustituciones, aplicadas en orden"),
    transport: z.string().optional().describe("Orden (o tarea) donde debe ir el cambio. Obligatoria salvo objetos locales"),
    activate: z.boolean().default(true),
  },
  preview: (a, ctx) => previewSave({ ...a, skip_syntax_check: false }, ctx, (current) => applySourceEdits(current, a.edits)),
  run: (a, ctx) => runSave({ ...a, skip_syntax_check: false }, ctx, (current) => applySourceEdits(current, a.edits)),
});
