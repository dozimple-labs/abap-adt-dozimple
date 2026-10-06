import { z } from "zod";
import { ToolError } from "../../core/errors.js";
import { sqlLiteral } from "../../core/objects.js";
import { tsv } from "../../core/output.js";
import { defineTool } from "../../core/tool.js";
import { sapLanguage } from "./function_modules.js";

/**
 * Encontrar la tabla cuando solo se sabe de qué va («partición», «garantía», «log de tickets»): busca en la
 * descripción (DD02T) y en el nombre. ABAP SQL compara LIKE con mayúsculas exactas, y en 7.50 no se puede aplicar
 * UPPER en el WHERE, así que se prueban las variantes de capitalización habituales.
 */
const KIND: Record<string, string> = { TRANSP: "tabla", INTTAB: "estructura", VIEW: "vista", POOL: "tabla pool", CLUSTER: "tabla cluster", APPEND: "append" };

export function variants(kw: string): string[] {
  const k = kw.trim();
  const lower = k.toLowerCase();
  return [...new Set([k, lower, k.toUpperCase(), lower[0].toUpperCase() + lower.slice(1)])];
}

const escapeLike = (s: string) => s.replace(/[%_#]/g, (c) => `#${c}`);

export default defineTool({
  name: "search_tables",
  title: "Buscar tablas por descripción",
  description:
    "Busca tablas, estructuras y vistas del diccionario por una palabra de su descripción o de su nombre " +
    "(«partición», «garantía», «ZDZ_TICKET»). Sirve cuando se sabe qué dato se busca pero no la tabla. Devuelve nombre, " +
    "tipo (tabla, estructura, vista…), descripción y clase de entrega. Solo metadatos: no lee datos.",
  access: "read",
  input: {
    text: z.string().min(2).max(60).describe("Palabra o fragmento; sin comodines"),
    kind: z.enum(["TRANSP", "INTTAB", "VIEW", "all"]).default("all").describe("TRANSP tablas, INTTAB estructuras, VIEW vistas"),
    only_custom: z.boolean().default(false).describe("Solo objetos Z/Y"),
    max: z.number().int().min(1).max(500).default(50),
  },
  async run({ text, kind, only_custom, max }, { sap, system }) {
    if (/[%*?]/.test(text)) throw new ToolError("INPUT", "Sin comodines: escribe solo la palabra.");
    const lang = sapLanguage(system.language);
    const like = (v: string) => `'%${escapeLike(v).replace(/'/g, "''")}%' ESCAPE '#'`;
    const textConds = variants(text).map((v) => `t~ddtext LIKE ${like(v)}`);
    const nameCond = `l~tabname LIKE ${like(text.toUpperCase())}`;
    const where = [
      `l~as4local = 'A'`,
      `( ${[...textConds, nameCond].join(" OR ")} )`,
      kind !== "all" ? `l~tabclass = ${sqlLiteral(kind)}` : "",
      only_custom ? `( l~tabname LIKE 'Z%' OR l~tabname LIKE 'Y%' )` : "",
    ].filter(Boolean);
    // LEFT JOIN al texto en el idioma de la conexión: las tablas sin texto en ese idioma siguen saliendo por nombre.
    const r = await sap.query(
      `SELECT l~tabname, l~tabclass, l~contflag, t~ddtext FROM dd02l AS l ` +
        `LEFT OUTER JOIN dd02t AS t ON t~tabname = l~tabname AND t~as4local = 'A' AND t~ddlanguage = ${sqlLiteral(lang)} ` +
        `WHERE ${where.join(" AND ")} ORDER BY l~tabname`,
      max,
    );
    if (!r.values.length) return `La búsqueda «${text}» se ejecutó y no encontró tablas${kind !== "all" ? ` de tipo ${kind}` : ""}.`;
    const table = tsv(
      ["tabla", "tipo", "entrega", "descripción"],
      r.values.map((v) => [String(v.TABNAME).trim(), KIND[String(v.TABCLASS).trim()] ?? v.TABCLASS, String(v.CONTFLAG ?? "").trim(), String(v.DDTEXT ?? "").trim()]),
    );
    const capped = r.values.length >= max ? `\n\nTope de ${max} alcanzado: puede haber más; acota con kind u only_custom.` : "";
    return `${r.values.length} resultados para «${text}»\n\n${table}${capped}\n\nPara los campos: get_source(object_type=TABL); para las claves externas: foreign_keys.`;
  },
});
