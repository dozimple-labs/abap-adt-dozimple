import { z } from "zod";
import { guardedQuery } from "../../core/datapolicy.js";
import { ToolError } from "../../core/errors.js";
import { defineTool } from "../../core/tool.js";

/**
 * Cuántas filas hay antes de pedirlas: evita traer 200 filas para descubrir que son 3 millones, y en productivo el
 * recuento no expone datos. Pasa por la misma política que sql_query (tablas vetadas, columnas personales en WHERE).
 */
const NAME_RE = /^(\/[A-Z0-9_]+\/)?[A-Z0-9_]{1,30}$/;

export function countSql(table: string, where?: string, group_by?: string): string {
  if (!NAME_RE.test(table)) throw new ToolError("INPUT", `Nombre de tabla inválido: ${table}`);
  if (where && /;|--|\/\*/.test(where)) throw new ToolError("INPUT", "La condición no admite «;» ni comentarios.");
  if (group_by && !/^[A-Z0-9_]+(\s*,\s*[A-Z0-9_]+)*$/i.test(group_by)) throw new ToolError("INPUT", "group_by: lista de columnas separadas por coma.");
  const cols = group_by ? `${group_by.toUpperCase()}, COUNT( * ) AS n` : `COUNT( * ) AS n`;
  return `SELECT ${cols} FROM ${table}${where ? ` WHERE ${where}` : ""}${group_by ? ` GROUP BY ${group_by.toUpperCase()} ORDER BY n DESCENDING` : ""}`;
}

export default defineTool({
  name: "count_rows",
  title: "Contar filas",
  description:
    "Cuenta las filas de una tabla o vista, con condición opcional y agrupación opcional (p. ej. por año o por " +
    "estado), sin traer datos. Úsala antes de sql_query o table_contents para saber el tamaño real de lo que vas a " +
    "pedir. Misma política que sql_query: tablas vetadas y columnas personales en WHERE se bloquean.",
  access: "read",
  input: {
    table: z.string().min(1).max(30).transform((s) => s.trim().toUpperCase()),
    where: z.string().max(500).optional().describe("Condición ABAP SQL sin WHERE, literales entre comillas simples"),
    group_by: z.string().max(100).optional().describe("Columnas por las que agrupar, separadas por coma"),
    max_groups: z.number().int().min(1).max(500).default(50),
  },
  async run({ table, where, group_by, max_groups }, { sap, system }) {
    const sql = countSql(table.trim().toUpperCase(), where, group_by);
    const r = await guardedQuery(sap, system, sql, group_by ? max_groups : 1);
    const notes = r.notes.length ? `\n\n${r.notes.join("\n")}` : "";
    if (!group_by) {
      const n = Number(r.values[0]?.N ?? 0);
      return `${table}${where ? ` WHERE ${where}` : ""}: ${n.toLocaleString("es-CL")} filas.${notes}`;
    }
    if (!r.values.length) return `${table}${where ? ` WHERE ${where}` : ""}: 0 filas.${notes}`;
    const cols = r.columns.filter((c) => c !== "N");
    const lines = r.values.map((v) => `${cols.map((c) => v[c]).join(" · ")}\t${Number(v.N).toLocaleString("es-CL")}`);
    return `${table}${where ? ` WHERE ${where}` : ""} por ${group_by}: ${r.values.length} grupos${r.capped ? " (tope alcanzado)" : ""}\n\n${cols.join(" · ")}\tfilas\n${lines.join("\n")}${notes}`;
  },
});
