import { z } from "zod";
import type { ADTClient, Revision } from "abap-adt-api";
import { isError, renderSyntax, syntaxCheck } from "../../core/checks.js";
import { stateOf } from "../../core/confirm.js";
import { diffLines, unified } from "../../core/diff.js";
import { ToolError } from "../../core/errors.js";
import { CLASS_INCLUDES, resolveObject, sourceUrl, TYPE_HELP, type ResolvedObject } from "../../core/objects.js";
import { assertTrkorr, assertPackageAllowed } from "../../core/policy.js";
import { versionNumber } from "../../core/revisions.js";
import { defineTool } from "../../core/tool.js";
import { transportWarnings } from "../../core/transport.js";
import writeSource from "./write_source.js";

/**
 * Deshacer con confirmación, nunca automático. Tras un write_source cuya activación falló, el objeto queda con un
 * borrador inactivo (versión 99999 de ADT) encima de la versión activa (00000). Esta tool escribe de nuevo la
 * versión elegida —la activa, la anterior a la activa, o una concreta del historial— pasando por la misma vista
 * previa, confirmación, bloqueo y orden que cualquier escritura. Un rollback que pisara una versión sin preguntar
 * sería peor que dejar el objeto inactivo.
 */
const TARGET_HELP =
  "«active»: la última versión activa (deshace un borrador inactivo, p. ej. un write_source cuya activación falló). " +
  "«previous»: la versión anterior a la activa (deshace la última activación). " +
  "Un número N: la versión N tal como la lista object_versions.";

type Target = "active" | "previous" | number;

function pickRevision(revs: Revision[], target: Target): { rev: Revision; label: string } {
  if (typeof target === "number") {
    const rev = revs[target - 1];
    if (!rev) throw new ToolError("INPUT", `Solo hay ${revs.length} versiones (object_versions las lista).`);
    return { rev, label: `versión ${target} del historial` };
  }
  const active = revs.find((r) => versionNumber(r) === "00000");
  if (target === "active") {
    if (!active) throw new ToolError("NOT_FOUND", "SAP no devuelve una versión activa de este objeto.");
    return { rev: active, label: "última versión activa" };
  }
  const numbered = revs
    .filter((r) => /^\d{5}$/.test(versionNumber(r)) && !["00000", "99999"].includes(versionNumber(r)))
    .sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0) || Number(versionNumber(b)) - Number(versionNumber(a)));
  if (!numbered.length) throw new ToolError("NOT_FOUND", "No hay ninguna versión grabada anterior a la activa.");
  return { rev: numbered[0], label: "versión anterior a la activa" };
}

async function chosenSource(c: ADTClient, obj: ResolvedObject, include: (typeof CLASS_INCLUDES)[number], target: Target) {
  const revs = await c.revisions(obj.uri, obj.type.startsWith("CLAS") ? include : undefined);
  if (!revs.length) throw new ToolError("NOT_FOUND", `${obj.name}: SAP no devuelve versiones para este objeto.`);
  const { rev, label } = pickRevision(revs, target);
  const hasDraft = revs.some((r) => versionNumber(r) === "99999");
  return { rev, label, hasDraft, source: await c.getObjectSource(rev.uri) };
}

const input = {
  object_name: z.string().min(1),
  object_type: z.string().optional().describe(TYPE_HELP),
  include: z.enum(CLASS_INCLUDES).default("main"),
  target: z.union([z.enum(["active", "previous"]), z.number().int().min(1)]).default("active").describe(TARGET_HELP),
  transport: z.string().optional().describe("Orden (o tarea) donde debe ir la reversión. Obligatoria salvo objetos locales"),
  activate: z.boolean().default(true),
};

export default defineTool({
  name: "revert_source",
  title: "Volver a una versión anterior",
  description:
    "Deshace un cambio escribiendo de nuevo una versión anterior del objeto: la última activa (para limpiar un " +
    "borrador inactivo tras un write_source cuya activación falló), la anterior a la activa, o una concreta del " +
    "historial de object_versions. Pasa por la misma vista previa, confirmación, bloqueo y orden que write_source: " +
    "nunca revierte por su cuenta. Solo objetos de código fuente.",
  access: "write",
  input,
  async preview({ object_name, object_type, include, target, transport, activate }, { sap, system }) {
    const requested = transport ? assertTrkorr(transport) : undefined;
    const c = await sap.adt();
    const obj = await resolveObject(c, object_name, object_type);
    assertPackageAllowed(system, obj.packageName, obj.name);
    const url = await sourceUrl(c, obj, include);
    const current = await c.getObjectSource(url);
    const { rev, label, hasDraft, source } = await chosenSource(c, obj, include, target);
    const out = [
      `${obj.name} (${obj.type})${include !== "main" ? ` · include ${include}` : ""} · paquete ${obj.packageName ?? "?"}`,
      `Volver a: ${label} · ${rev.date} · ${rev.author}${rev.versionTitle ? ` · ${rev.versionTitle}` : ""}`,
      `Orden: ${requested ?? "ninguna indicada (solo vale para objetos locales)"} · activar después: ${activate ? "sí" : "no"}`,
      hasDraft ? "Estado: el objeto tiene un borrador inactivo (cambios guardados sin activar)." : "Estado: sin borrador inactivo.",
    ];
    if (target === "active" && !hasDraft) out.push("Aviso: no hay borrador que deshacer; la versión activa ya es la que se ve.");
    if (requested) {
      const warn = await transportWarnings(sap, requested, system.user);
      out.push(warn.length ? `⚠ AVISOS DE LA ORDEN ${requested}:\n${warn.map((w) => "  ⚠ " + w).join("\n")}` : `Orden ${requested}: modificable, con destino y del usuario de esta conexión.`);
    }
    const msgs = await syntaxCheck(c, obj, url, source);
    out.push(msgs.some(isError) ? `Sintaxis de la versión elegida: CON ERRORES, la escritura se detendrá.\n${renderSyntax(msgs)}` : `Sintaxis de la versión elegida: sin errores${msgs.length ? ` (${msgs.length} avisos)` : ""}.`);
    const ops = diffLines(current, source);
    if (!ops) out.push("", "Cambio: el objeto se reescribe casi entero (demasiadas diferencias para mostrarlas como diff).");
    else {
      const u = unified(ops, 3);
      const lines = u.text.split("\n");
      out.push("", u.hunks ? `Cambio respecto a lo que hay ahora: +${u.added} −${u.removed} en ${u.hunks} bloques` : "Cambio: ninguno (la versión elegida es idéntica a lo que hay ahora).");
      if (u.hunks) out.push(lines.slice(0, 400).join("\n") + (lines.length > 400 ? `\n[… ${lines.length - 400} líneas más de diff]` : ""));
    }
    return { text: out.join("\n"), state: stateOf(current) };
  },
  async run({ object_name, object_type, include, target, transport, activate }, ctx) {
    const c = await ctx.sap.adt();
    const obj = await resolveObject(c, object_name, object_type);
    assertPackageAllowed(ctx.system, obj.packageName, obj.name);
    const { label, source } = await chosenSource(c, obj, include, target);
    // La escritura real es la de write_source: mismo bloqueo, misma comprobación de que nada cambió desde la vista
    // previa (ctx.confirmedState), misma decisión de orden y misma activación.
    const r = await writeSource.run({ object_name, object_type, include, source, transport, activate, skip_syntax_check: false }, ctx);
    const text = typeof r === "string" ? r : r.text;
    return { text: `Revertido a la ${label}.\n${text}`, isError: typeof r === "string" ? false : !!r.isError };
  },
});
