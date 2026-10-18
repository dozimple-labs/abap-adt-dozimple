import { z } from "zod";
import type { ADTClient, Revision } from "abap-adt-api";
import { diffLines, unified } from "../../core/diff.js";
import { normalizeError, ToolError } from "../../core/errors.js";
import { resolveByTypePrefix, sqlLiteral } from "../../core/objects.js";
import { assertTrkorr } from "../../core/policy.js";
import { pool } from "../../core/concurrency.js";
import { selectRevisionPair, sourceObjectsOf, versionNumber, type SourceObjectRef } from "../../core/revisions.js";
import { describeOrder, orderHeaders } from "../../core/transport.js";
import { defineTool } from "../../core/tool.js";

const resolveRef = (c: ADTClient, ref: SourceObjectRef) => resolveByTypePrefix(c, ref.name, ref.types);

const label = (r?: Revision) =>
  r ? `${r.version || "sin orden"} (v${versionNumber(r) || "?"}, ${r.date.slice(0, 10)}, ${r.author})` : "—";

export default defineTool({
  name: "transport_diff",
  timeoutMs: 180_000,
  title: "Qué cambió una orden (diff de código)",
  description:
    "Revisión de código de una orden: por cada objeto con fuente (programas, includes, clases, interfaces, FM, " +
    "CDS) compara la versión grabada con esa orden contra la anterior y muestra el diff unificado, con la calidad " +
    "de la evidencia (exacta, aproximada, objeto nuevo). Lo sin fuente (diccionario, customizing) se lista " +
    "aparte. Vale para órdenes abiertas y liberadas.",
  access: "read",
  input: {
    transport: z.string().describe("Orden (o tarea), p. ej. DEVK900123"),
    objects: z.array(z.string()).optional().describe("Solo estos objetos"),
    context: z.number().int().min(0).max(20).default(3).describe("Líneas de contexto alrededor de cada cambio"),
    summary_only: z.boolean().default(false).describe("Solo +/− por objeto, sin el diff"),
    max_objects: z.number().int().min(1).max(60).default(20),
    max_diff_lines: z.number().int().min(20).max(3000).default(300).describe("Tope de líneas de diff por objeto"),
  },
  async run({ transport, objects, context, summary_only, max_objects, max_diff_lines }, ctx) {
    const { sap } = ctx;
    const tr = assertTrkorr(transport);
    const heads = await orderHeaders(sap, [tr]);
    const head = heads.get(tr);
    if (!head) throw new ToolError("NOT_FOUND", `La orden ${tr} no existe en este sistema.`);
    const root = head.parent || tr; // si es una tarea, la orden padre y sus hermanas también cuentan
    const tasks = await sap.query(`SELECT trkorr FROM e070 WHERE strkorr = ${sqlLiteral(root)}`, 500);
    const ids = [root, ...tasks.values.map((v) => v.TRKORR as string)];
    const rows = await sap.query(
      `SELECT pgmid, object, obj_name FROM e071 WHERE trkorr IN ( ${ids.map(sqlLiteral).join(", ")} )`,
      5000,
    );
    const { source, ddic, other } = sourceObjectsOf(rows.values as any);
    const wanted = objects?.map((o) => o.toUpperCase());
    const selected = source.filter((s) => !wanted || wanted.includes(s.name.toUpperCase()));
    const shown = selected.slice(0, max_objects);

    const c = await sap.adt();
    let done = 0;
    ctx.progress?.(`Comparando ${shown.length} objetos de ${root}…`, 0, shown.length);
    const blocks = await pool(shown, 4, async (ref) => {
      // Cancelación entre objetos: el que está en curso termina, el siguiente ya no empieza.
      ctx.signal?.throwIfAborted();
      try {
        const res = await resolveRef(c, ref);
        if (!res) return { name: ref.name, text: `■ ${ref.name}: ya no existe en el sistema (¿borrado en la orden?).`, added: 0, removed: 0 };
        const revs = await c.revisions(res.uri, res.type.startsWith("CLAS") ? "main" : undefined);
        const pair = selectRevisionPair(revs, ids);
        if (!pair.current) return { name: ref.name, text: `■ ${ref.name} (${res.type}): SAP no guarda versiones de este objeto.`, added: 0, removed: 0 };
        const evidence =
          pair.evidence === "exacta"
            ? "versión de la orden"
            : "APROXIMADO: ninguna versión nombra esta orden; se compara la última versión con la anterior";
        const newSrc = await c.getObjectSource(pair.current.uri);
        if (!pair.previous) {
          const lines = newSrc.split("\n").length;
          const note = pair.evidence === "exacta" ? "objeto NUEVO en esta orden (no hay versión anterior)" : "sin versión anterior con la que comparar";
          return { name: ref.name, text: `■ ${ref.name} (${res.type}) · ${note} · ${lines} líneas · ${label(pair.current)}`, added: lines, removed: 0 };
        }
        const oldSrc = await c.getObjectSource(pair.previous.uri);
        const ops = diffLines(oldSrc, newSrc);
        const headLine =
          `■ ${ref.name} (${res.type}) · ${evidence}${pair.inactiveDraft ? " · INCLUYE CAMBIOS SIN ACTIVAR" : ""}\n` +
          `  ${label(pair.current)}  contra  ${label(pair.previous)}`;
        if (!ops) return { name: ref.name, text: `${headLine}\n  (demasiados cambios para mostrarlos como diff: el objeto se reescribió casi entero)`, added: 0, removed: 0 };
        const u = unified(ops, context);
        if (!u.hunks) return { name: ref.name, text: `${headLine}\n  sin diferencias de código entre esas dos versiones`, added: 0, removed: 0 };
        let body = "";
        if (!summary_only) {
          const dl = u.text.split("\n");
          body = "\n" + dl.slice(0, max_diff_lines).join("\n") + (dl.length > max_diff_lines ? `\n  […${dl.length - max_diff_lines} líneas más de diff: pide objects=["${ref.name}"] con max_diff_lines mayor]` : "");
        }
        return { name: ref.name, text: `${headLine} · +${u.added} −${u.removed} en ${u.hunks} bloques${body}`, added: u.added, removed: u.removed };
      } catch (e) {
        const te = normalizeError(e);
        if (te.kind === "NETWORK" || te.kind === "AUTH") throw te;
        return { name: ref.name, text: `■ ${ref.name}: no se pudo comparar (${te.kind}: ${te.message})`, added: 0, removed: 0 };
      } finally {
        ctx.progress?.(`${++done} de ${shown.length} objetos comparados`, done, shown.length);
      }
    });

    const tot = blocks.reduce((a, b) => ({ added: a.added + b.added, removed: a.removed + b.removed }), { added: 0, removed: 0 });
    const out = [
      describeOrder(heads.get(root) ?? head) + (root !== tr ? `  (pediste la tarea ${tr}; se revisa la orden entera)` : ""),
      `${selected.length} objetos con fuente${selected.length > shown.length ? ` (se muestran ${shown.length}; sube max_objects o filtra con objects)` : ""} · +${tot.added} −${tot.removed}`,
      "",
      ...blocks.map((b) => b.text),
    ];
    if (ddic.length) out.push("", `Diccionario (sin diff de fuente, revisar con ddic_type_info / get_source): ${ddic.join(", ")}`);
    if (other.length) out.push("", `Otras entradas no revisadas aquí: ${other.slice(0, 40).join(", ")}${other.length > 40 ? ` y ${other.length - 40} más` : ""}`);
    if (!source.length) out.push("", "La orden no contiene objetos con código fuente.");
    return out.join("\n");
  },
});
