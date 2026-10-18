import { z } from "zod";
import { guardedQuery, readPreview } from "../../core/datapolicy.js";
import { tsv } from "../../core/output.js";
import { defineTool } from "../../core/tool.js";

/** La salida estructurada duplica el contenido del texto: se acota para no doblar respuestas enormes. */
const STRUCTURED_ROWS = 500;

export default defineTool({
  name: "sql_query",
  title: "Consulta ABAP SQL",
  description:
    "Ejecuta un SELECT de ABAP SQL (WHERE, JOIN, ORDER BY, subconsultas) por la vista previa de datos de ADT. " +
    "Solo lectura. Literales entre comillas simples, sin «;» ni UP TO (usa max_rows). Útil para " +
    "E070/E071/TADIR/TLOCK/DD03L y datos de negocio. En sistemas productivos las columnas personales salen " +
    "enmascaradas y hay tope de filas.",
  access: "read",
  confirmReads: true,
  input: {
    query: z.string().min(1).describe("SELECT ... FROM ... WHERE ..."),
    max_rows: z.number().int().min(1).max(5000).default(100),
  },
  output: {
    rows: z.number().int().describe("Filas devueltas"),
    columns: z.array(z.string()),
    values: z.array(z.record(z.unknown())).describe(`Filas como objetos columna→valor (hasta ${STRUCTURED_ROWS}; el texto las trae todas)`),
    truncated: z.boolean().describe("true si values no incluye todas las filas"),
    notes: z.array(z.string()).describe("Avisos de la política de datos (enmascarado, tope de filas)"),
  },
  async preview({ query, max_rows }, { system }) {
    return readPreview(system, query, max_rows);
  },
  previewStructured(_a, previewText) {
    return { rows: 0, columns: [], values: [], truncated: false, notes: ["Vista previa: la consulta no se ha ejecutado todavía.", previewText.split("\n").slice(0, 3).join(" ")] };
  },
  async run({ query, max_rows }, { sap, system }) {
    const r = await guardedQuery(sap, system, query, max_rows);
    const structured = {
      rows: r.values.length,
      columns: r.columns,
      values: r.values.slice(0, STRUCTURED_ROWS),
      truncated: r.values.length > STRUCTURED_ROWS,
      notes: r.notes,
    };
    if (!r.values.length) return { text: `La consulta se ejecutó y no devolvió filas.`, structured };
    const table = tsv(r.columns, r.values.map((v) => r.columns.map((c) => v[c])));
    return { text: `${r.values.length} filas\n\n${table}${r.notes.length ? `\n\n${r.notes.join("\n")}` : ""}`, structured };
  },
});
