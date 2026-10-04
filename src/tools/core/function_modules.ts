import { z } from "zod";
import { ToolError } from "../../core/errors.js";
import { sqlLiteral } from "../../core/objects.js";
import { tsv } from "../../core/output.js";
import { defineTool } from "../../core/tool.js";

const NAME_RE = /^(\/[A-Z0-9_]+\/)?[A-Z0-9_]+$/;

/** ISO 639-1 → clave de idioma SAP de un carácter (SPRAS). No es la inicial: español es S, alemán D. */
const SPRAS: Record<string, string> = {
  EN: "E", DE: "D", ES: "S", FR: "F", IT: "I", PT: "P", NL: "N", JA: "J", ZH: "1", RU: "R", PL: "L", CS: "C",
  SV: "V", DA: "K", FI: "U", NO: "O", TR: "T", KO: "3", HU: "H", SK: "Q", EL: "G", AR: "A", HE: "B",
};
export const sapLanguage = (iso: string) => SPRAS[iso.trim().toUpperCase()] ?? iso.trim().toUpperCase().slice(0, 1);

const MODE: Record<string, string> = { R: "RFC", "": "normal", K: "update (V1)", L: "update (V2)", X: "update" };
/** TFDIR-UTASK: cómo se ejecuta un módulo de actualización. FMODE no lo dice: viene vacío en los de actualización. */
const UTASK: Record<string, string> = { "1": "update (V1)", "2": "update (V1, sin reinicio)", "3": "update (V2)", "4": "update (colectiva)" };
export function moduleKind(fmode: unknown, utask: unknown): string {
  const u = UTASK[String(utask ?? "").trim()];
  const f = String(fmode ?? "").trim();
  if (u) return f === "R" ? `RFC, ${u}` : u;
  return MODE[f] ?? f;
}

export default defineTool({
  name: "function_modules",
  title: "Módulos de función de un grupo",
  description:
    "Lista los módulos de función de un grupo de funciones, con su texto y si son RFC o de actualización. Con function " +
    "en vez de group, dice a qué grupo pertenece ese módulo y lista sus hermanos. Úsala cuando un nombre resulte ser un " +
    "grupo y no un módulo, o antes de remediar un grupo entero. Funciona con namespaces (/XXX/).",
  access: "read",
  input: {
    group: z.string().optional().describe("Grupo de funciones, p. ej. ZDEMO_GROUP"),
    function: z.string().optional().describe("En vez del grupo: un módulo; se busca su grupo"),
  },
  async run({ group, function: fm }, { sap, system }) {
    if (!group && !fm) throw new ToolError("INPUT", "Indica group o function.");
    let area = group?.trim().toUpperCase();
    let via = "";
    if (!area) {
      const f = fm!.trim().toUpperCase();
      if (!NAME_RE.test(f)) throw new ToolError("INPUT", `Nombre de módulo inválido: ${fm}`);
      const r = await sap.query(`SELECT area FROM enlfdir WHERE funcname = ${sqlLiteral(f)}`, 1);
      area = (r.values[0]?.AREA as string | undefined)?.trim();
      if (!area) throw new ToolError("NOT_FOUND", `No existe el módulo de función ${f}.`, "Si es un grupo, llama con group.");
      via = ` (grupo de ${f})`;
    }
    if (!NAME_RE.test(area)) throw new ToolError("INPUT", `Nombre de grupo inválido: ${group}`);

    const rows = await sap.query(
      `SELECT e~funcname, t~fmode, t~utask FROM enlfdir AS e INNER JOIN tfdir AS t ON t~funcname = e~funcname ` +
        `WHERE e~area = ${sqlLiteral(area)} ORDER BY e~funcname`,
      2000,
    );
    if (!rows.values.length) {
      const g = await sap.query(`SELECT obj_name FROM tadir WHERE pgmid = 'R3TR' AND object = 'FUGR' AND obj_name = ${sqlLiteral(area)}`, 1);
      if (!g.values.length) throw new ToolError("NOT_FOUND", `No existe el grupo de funciones ${area}.`, "Si es un módulo, llama con function.");
      return `El grupo ${area} existe y no tiene módulos de función.`;
    }
    const names = rows.values.map((r) => String(r.FUNCNAME).trim());
    const lang = sapLanguage(system.language);
    // Idioma de la conexión, después inglés, después cualquiera.
    const rank = (spras: unknown) => (spras === lang ? 2 : spras === "E" ? 1 : 0);
    const texts = new Map<string, { text: string; rank: number }>();
    for (let i = 0; i < names.length; i += 50) {
      const part = names.slice(i, i + 50);
      const t = await sap.query(`SELECT funcname, spras, stext FROM tftit WHERE funcname IN ( ${part.map(sqlLiteral).join(", ")} )`, part.length * 8);
      for (const r of t.values) {
        const k = String(r.FUNCNAME).trim();
        const cur = texts.get(k);
        if (!cur || rank(r.SPRAS) > cur.rank) texts.set(k, { text: String(r.STEXT ?? ""), rank: rank(r.SPRAS) });
      }
    }
    const gt = await sap.query(`SELECT spras, areat FROM tlibt WHERE area = ${sqlLiteral(area)}`, 20);
    const groupText = String(gt.values.slice().sort((a, b) => rank(b.SPRAS) - rank(a.SPRAS))[0]?.AREAT ?? "");
    const table = tsv(
      ["módulo", "tipo", "texto"],
      rows.values.map((r) => {
        const n = String(r.FUNCNAME).trim();
        return [n, moduleKind(r.FMODE, r.UTASK), texts.get(n)?.text ?? ""];
      }),
    );
    const capped = rows.values.length >= 2000 ? "\n\nTope de 2000 módulos alcanzado: puede haber más." : "";
    return `Grupo ${area}${via}${groupText ? ` «${groupText}»` : ""}: ${rows.values.length} módulos\n\n${table}${capped}`;
  },
});
