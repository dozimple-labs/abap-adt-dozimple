import { z } from "zod";
import { ToolError } from "../../core/errors.js";
import { sqlLiteral } from "../../core/objects.js";
import { tsv } from "../../core/output.js";
import { defineTool } from "../../core/tool.js";

/**
 * Claves externas de una tabla en las dos direcciones: qué tablas de verificación usa (sus campos → la clave de la
 * otra) y quién la usa a ella como tabla de verificación. Es lo que hace falta para escribir un JOIN correcto o para
 * saber qué se rompe si se borra una fila. DD08L = cabeceras, DD05S = asignación campo a campo.
 */
const NAME_RE = /^(\/[A-Z0-9_]+\/)?[A-Z0-9_]{1,30}$/;
const CARD: Record<string, string> = { "1": "1", C: "0..1", N: "1..n", CN: "0..n" };
const FRKART: Record<string, string> = { KEY: "clave", REF: "referencia", TEXT: "tabla de textos", "": "sin tipo" };

export interface ForeignKey {
  table: string;
  field: string;
  checkTable: string;
  kind: string;
  cardinality: string;
  on: Array<[string, string]>;
}

export async function foreignKeysOf(sap: { query: (sql: string, rows: number) => Promise<{ values: Record<string, any>[] }> }, table: string, direction: "from" | "to"): Promise<ForeignKey[]> {
  const col = direction === "from" ? "tabname" : "checktable";
  const heads = await sap.query(`SELECT tabname, fieldname, checktable, frkart, cardleft, card FROM dd08l WHERE ${col} = ${sqlLiteral(table)} AND as4local = 'A' ORDER BY tabname, fieldname`, 500);
  if (!heads.values.length) return [];
  const tables = [...new Set(heads.values.map((h) => String(h.TABNAME).trim()))];
  const checks = [...new Set(heads.values.map((h) => String(h.CHECKTABLE).trim()))];
  // DD05S: por cada campo de clave externa, qué campo propio (FORKEY) va en la posición PRIMPOS de la clave de la
  // tabla de verificación. El campo de la tabla de verificación es su clave en esa posición (DD03L).
  const pairs = await sap.query(`SELECT tabname, fieldname, primpos, forkey FROM dd05s WHERE tabname IN ( ${tables.map(sqlLiteral).join(", ")} ) AND as4local = 'A' ORDER BY tabname, fieldname, primpos`, 2000);
  const keys = await sap.query(`SELECT tabname, fieldname, position FROM dd03l WHERE tabname IN ( ${checks.map(sqlLiteral).join(", ")} ) AND as4local = 'A' AND keyflag = 'X' ORDER BY tabname, position`, 2000);
  const keyOf = new Map<string, string[]>();
  for (const k of keys.values) {
    const t = String(k.TABNAME).trim();
    keyOf.set(t, [...(keyOf.get(t) ?? []), String(k.FIELDNAME).trim()]);
  }
  return heads.values.map((h) => {
    const t = String(h.TABNAME).trim();
    const f = String(h.FIELDNAME).trim();
    const check = String(h.CHECKTABLE).trim();
    const on = pairs.values
      .filter((p) => String(p.TABNAME).trim() === t && String(p.FIELDNAME).trim() === f)
      .map((p) => [String(p.FORKEY).trim(), keyOf.get(check)?.[Number(p.PRIMPOS) - 1] ?? `?${p.PRIMPOS}`] as [string, string])
      .filter(([a]) => a && !a.startsWith("'"));
    return {
      table: t,
      field: f,
      checkTable: check,
      kind: FRKART[String(h.FRKART ?? "").trim()] ?? String(h.FRKART).trim(),
      cardinality: `${CARD[String(h.CARDLEFT ?? "").trim()] ?? "?"} : ${CARD[String(h.CARD ?? "").trim()] ?? "?"}`,
      on,
    };
  });
}

const joinOf = (fk: ForeignKey) => fk.on.map(([a, b]) => `${fk.table}~${a} = ${fk.checkTable}~${b}`).join(" AND ");

export default defineTool({
  name: "foreign_keys",
  title: "Claves externas de una tabla",
  description:
    "Claves externas de una tabla en las dos direcciones: las tablas de verificación que usa (campo a campo) y las " +
    "tablas que la usan a ella como verificación. Con cada una viene la condición de JOIN lista para sql_query. Útil " +
    "para unir tablas sin adivinar campos y para saber qué depende de un registro. Solo metadatos.",
  access: "read",
  input: {
    table: z.string().min(1).max(30).transform((s) => s.trim().toUpperCase()),
    direction: z.enum(["from", "to", "both"]).default("both").describe("from: las que usa esta tabla; to: las que la usan a ella"),
  },
  async run(a, { sap }) {
    const { direction } = a;
    const table = a.table.trim().toUpperCase();
    if (!NAME_RE.test(table)) throw new ToolError("INPUT", `Nombre de tabla inválido: ${table}`);
    const exists = await sap.query(`SELECT tabname FROM dd02l WHERE tabname = ${sqlLiteral(table)} AND as4local = 'A'`, 1);
    if (!exists.values.length) throw new ToolError("NOT_FOUND", `${table} no existe activa en el diccionario.`);
    const out: string[] = [];
    if (direction !== "to") {
      const from = await foreignKeysOf(sap, table, "from");
      out.push(
        from.length ? `${table} usa ${from.length} tablas de verificación:\n` + tsv(["campo", "tabla verif.", "tipo", "cardinalidad", "join"], from.map((fk) => [fk.field, fk.checkTable, fk.kind, fk.cardinality, joinOf(fk) || "(sin asignación de campos)"])) : `${table} no tiene claves externas hacia otras tablas.`,
      );
    }
    if (direction !== "from") {
      const to = await foreignKeysOf(sap, table, "to");
      out.push(
        to.length ? `${to.length} tablas usan ${table} como verificación:\n` + tsv(["tabla", "campo", "tipo", "cardinalidad", "join"], to.map((fk) => [fk.table, fk.field, fk.kind, fk.cardinality, joinOf(fk) || "(sin asignación de campos)"])) : `Ninguna tabla usa ${table} como tabla de verificación.`,
      );
    }
    return out.join("\n\n");
  },
});
