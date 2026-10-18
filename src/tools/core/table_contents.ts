import { z } from "zod";
import { guardedQuery, readPreview } from "../../core/datapolicy.js";
import { ToolError } from "../../core/errors.js";
import { tsv } from "../../core/output.js";
import { defineTool } from "../../core/tool.js";

const NAME_RE = /^[A-Z0-9_/]+$/;

/**
 * WHERE y ORDER BY se concatenan al SELECT, así que se validan por LISTA BLANCA: el fragmento se trocea y cada
 * pieza tiene que ser una de las formas esperadas de una condición sobre columnas. Lo que no encaje (otra cláusula,
 * subconsulta, comentario, «;», comillas dobles, host variables…) se rechaza, aunque una versión futura de ABAP SQL
 * lo admitiera. Para consultas más ricas está sql_query.
 */
const CONDITION_WORDS = new Set(["AND", "OR", "NOT", "LIKE", "IN", "BETWEEN", "IS", "NULL", "INITIAL", "ESCAPE", "EQ", "NE", "LT", "GT", "LE", "GE"]);
/** Palabras de cláusula o de sentencia: nunca pueden aparecer como «columna» en un filtro. */
const CLAUSE_WORDS = new Set([
  "SELECT", "FROM", "WHERE", "JOIN", "INNER", "OUTER", "LEFT", "RIGHT", "CROSS", "UNION", "INTERSECT", "EXCEPT", "INTO",
  "GROUP", "ORDER", "BY", "HAVING", "UP", "TO", "ROWS", "CLIENT", "SPECIFIED", "USING", "EXISTS", "ALL", "ANY", "SOME",
  "FOR", "UPDATE", "DELETE", "INSERT", "MODIFY", "DISTINCT", "SINGLE", "WITH", "AS", "CASE", "WHEN", "THEN", "ELSE",
  "END", "BYPASSING", "BUFFER", "CONNECTION", "APPENDING", "PACKAGE", "SIZE", "OFFSET", "FIELDS",
]);
const TOKEN = /\s*(?:('(?:[^']|'')*')|(\d+(?:\.\d+)?)|([A-Za-z_/][A-Za-z0-9_/~]*)|(<>|<=|>=|!=|=|<|>)|([(),]))/y;

export function assertSafeFragment(frag: string, label: string): void {
  const fail = (why: string): never => {
    throw new ToolError("INPUT", `${label}: ${why}. Solo condiciones sobre columnas (columna, operador, literal, AND/OR/NOT, LIKE, IN, BETWEEN, IS NULL/INITIAL, paréntesis); para más, sql_query.`);
  };
  let depth = 0;
  TOKEN.lastIndex = 0;
  let pos = 0;
  while (pos < frag.length) {
    if (!frag.slice(pos).trim()) break;
    TOKEN.lastIndex = pos;
    const m = TOKEN.exec(frag);
    if (!m) fail(`«${frag.slice(pos).trim().slice(0, 12)}…» no es parte de una condición`);
    pos = TOKEN.lastIndex;
    const [, lit, , word, , punct] = m!;
    if (lit !== undefined && lit.length < 2) fail("comilla sin cerrar");
    if (word !== undefined) {
      const w = word.toUpperCase();
      if (CLAUSE_WORDS.has(w)) fail(`«${word}» es una cláusula, no una columna`);
      if (!CONDITION_WORDS.has(w) && !/^[A-Za-z_/][A-Za-z0-9_/]*(~[A-Za-z0-9_/]+)?$/.test(word)) fail(`«${word}» no es un nombre de columna`);
    }
    if (punct === "(") depth++;
    if (punct === ")" && --depth < 0) fail("paréntesis sin abrir");
  }
  if (depth !== 0) fail("paréntesis sin cerrar");
}

/** SELECT de la tool, validado por lista blanca; lo usan la vista previa y la ejecución. */
export function buildSql(a: { table: string; columns?: string[]; where?: string; order_by?: string }): string {
  const t = a.table.trim().toUpperCase();
  if (!NAME_RE.test(t)) throw new ToolError("INPUT", `Nombre de tabla inválido: ${a.table}`);
  const cols = a.columns?.map((c) => c.trim().toUpperCase()) ?? [];
  for (const c of cols) if (!NAME_RE.test(c)) throw new ToolError("INPUT", `Columna inválida: ${c}`);
  if (a.where) assertSafeFragment(a.where, "where");
  if (a.order_by) {
    assertSafeFragment(a.order_by, "order_by");
    if (!/^[A-Za-z0-9_/~]+(\s+(asc|desc))?(\s*,\s*[A-Za-z0-9_/~]+(\s+(asc|desc))?)*$/i.test(a.order_by.trim())) {
      throw new ToolError("INPUT", "order_by: columnas separadas por coma, con ASC/DESC opcional.");
    }
  }
  return `SELECT ${cols.length ? cols.join(", ") : "*"} FROM ${t}` + (a.where ? ` WHERE ${a.where}` : "") + (a.order_by ? ` ORDER BY ${a.order_by}` : "");
}

export default defineTool({
  name: "table_contents",
  title: "Contenido de una tabla",
  description:
    "Filas de una tabla, vista o CDS, con columnas y filtro opcionales. Atajo de sql_query para el caso típico " +
    "«enséñame lo que hay en ZTABLA donde …». Para JOIN, subconsultas o agregados usa sql_query.",
  access: "read",
  confirmReads: true,
  input: {
    table: z.string().min(1),
    columns: z.array(z.string()).optional().describe("Columnas; por defecto todas"),
    where: z.string().optional().describe("Condición ABAP SQL sin la palabra WHERE, p. ej. werks = '1000' AND lvorm = ''"),
    order_by: z.string().optional(),
    max_rows: z.number().int().min(1).max(5000).default(100),
  },
  async preview(a, { system }) {
    return readPreview(system, buildSql(a), a.max_rows);
  },
  async run({ table, columns, where, order_by, max_rows }, { sap, system }) {
    const t = table.trim().toUpperCase();
    const sql = buildSql({ table, columns, where, order_by });
    const r = await guardedQuery(sap, system, sql, max_rows);
    if (!r.values.length) return `${t}: la consulta se ejecutó y no devolvió filas${where ? " con ese filtro" : ""}.`;
    return `${t}: ${r.values.length} filas\n\n${tsv(r.columns, r.values.map((v) => r.columns.map((n) => v[n])))}${r.notes.length ? `\n\n${r.notes.join("\n")}` : ""}`;
  },
});
