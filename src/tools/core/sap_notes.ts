import { z } from "zod";
import type { SapConnection } from "../../core/connection.js";
import { dataClassOf, rowCap } from "../../core/datapolicy.js";
import { ToolError } from "../../core/errors.js";
import { sqlLiteral } from "../../core/objects.js";
import { tsv } from "../../core/output.js";
import { defineTool } from "../../core/tool.js";

/**
 * Estado de las notas SAP en ESTE sistema (lo que muestra SNOTE), leído de las tablas de la herramienta de notas:
 * CWBNTCUST (estado por nota), CWBNTHEAD (versión y componente) y CWBNTSTXT (título). No consulta el portal de SAP
 * ni necesita S-user: solo sabe de las notas descargadas en el sistema. Los códigos de estado no son valores fijos
 * del diccionario; su significado sale de las constantes de SAP (IF_SCWN_NA_CONSTANTS), verificadas en un 7.50.
 */

/** CWBNTCUST-PRSTATUS, «Implementation State». */
export const IMPL_STATE: Record<string, string> = {
  E: "implementada completamente",
  U: "implementada de forma incompleta",
  V: "implementada una versión anterior",
  N: "se puede implementar (no implementada)",
  O: "obsoleta",
  "-": "no se puede implementar (sin instrucción de corrección válida)",
  "": "sin determinar",
};
/** CWBNTCUST-NTSTATUS, «Processing Status». */
export const PROC_STATE: Record<string, string> = { N: "nueva", I: "en tratamiento", A: "terminada", R: "no relevante" };

const describe = (map: Record<string, string>, code: string) => map[code.trim()] ?? `código «${code}» desconocido`;
const noteKey = (n: string | number) => String(Number(n));

/** Una consulta por tramo: un IN con miles de literales supera lo que acepta la vista previa de datos ADT. */
export async function inChunks(sap: SapConnection, sql: (list: string) => string, keys: string[], size = 200): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (let i = 0; i < keys.length; i += size) out.push(...(await sap.query(sql(keys.slice(i, i + size).map(sqlLiteral).join(", ")), 5000)).values);
  return out;
}

export async function noteDetails(sap: SapConnection, notes: string[]) {
  const heads = { values: await inChunks(sap, (l) => `SELECT numm, versno, themk FROM cwbnthead WHERE numm IN ( ${l} )`, notes) };
  const latest = new Map<string, { version: number; component: string }>();
  for (const h of heads.values) {
    const k = noteKey(h.NUMM as string);
    const v = Number(h.VERSNO);
    if (!latest.has(k) || v > latest.get(k)!.version) latest.set(k, { version: v, component: String(h.THEMK ?? "").trim() });
  }
  const texts = { values: await inChunks(sap, (l) => `SELECT numm, versno, langu, stext FROM cwbntstxt WHERE numm IN ( ${l} ) AND ( langu = 'S' OR langu = 'E' )`, notes) };
  const title = new Map<string, { v: number; lang: string; text: string }>();
  for (const t of texts.values) {
    const k = noteKey(t.NUMM as string);
    const cand = { v: Number(t.VERSNO), lang: String(t.LANGU), text: String(t.STEXT ?? "").trim() };
    const cur = title.get(k);
    // Versión más alta; a igual versión, español antes que inglés.
    if (!cur || cand.v > cur.v || (cand.v === cur.v && cand.lang === "S" && cur.lang !== "S")) title.set(k, cand);
  }
  return { latest, title };
}

const NOTE = z.object({
  note: z.string(),
  downloaded: z.boolean().describe("false = la nota no está en este sistema (nunca se descargó con SNOTE)"),
  implementation: z.string().optional(),
  implementation_code: z.string().optional(),
  processing: z.string().optional(),
  version: z.number().int().optional(),
  component: z.string().optional(),
  title: z.string().optional(),
  processor: z.string().optional().describe("Usuario que la trató (solo en sistemas con datos de prueba)"),
});

export default defineTool({
  name: "sap_notes",
  title: "Notas SAP en el sistema (SNOTE)",
  description:
    "Estado de notas SAP en el sistema, como en SNOTE: descargada, implementación (completa, incompleta, versión " +
    "anterior, implementable, obsoleta, no implementable), tratamiento, versión, componente y título. Con " +
    "notes=[…] responde por notas concretas («¿está la 2198647?»); sin notas, lista las del estado pedido. Solo " +
    "notas descargadas: no consulta el portal.",
  access: "read",
  input: {
    notes: z.array(z.string().regex(/^\d{1,10}$/, "número de nota: solo dígitos")).max(200).optional(),
    implementation: z
      .array(z.enum(["E", "U", "V", "N", "O", "-"]))
      .optional()
      .describe("Sin notes: filtrar por estado de implementación (E completa, U incompleta, V versión anterior, N se puede implementar, O obsoleta, - no se puede)"),
    component: z.string().regex(/^[A-Z0-9-]{2,24}$/i).optional().describe("Sin notes: prefijo de componente, p. ej. SD-BF o MM-PUR"),
    max: z.number().int().min(1).max(1000).default(100),
  },
  output: { notes: z.array(NOTE), total: z.number().int(), truncated: z.boolean() },
  async run({ notes, implementation, component, max }, { sap, system }) {
    const showUser = dataClassOf(system) === "test";
    const cap = Math.min(max, rowCap(system));
    let custRows: Array<Record<string, unknown>>;
    let counted: number | undefined;
    if (notes?.length) {
      const r = await sap.query(`SELECT numm, ntstatus, prstatus, cwbuser FROM cwbntcust WHERE numm IN ( ${notes.map(sqlLiteral).join(", ")} )`, 1000);
      custRows = r.values;
    } else if (component) {
      // El componente está en la cabecera: se filtra ahí y luego se trae el estado de esas notas, por tramos.
      const h = await sap.query(`SELECT DISTINCT numm FROM cwbnthead WHERE themk LIKE ${sqlLiteral(`${component.toUpperCase()}%`)}`, 5000);
      const ids = h.values.map((v) => noteKey(v.NUMM as string));
      const impl = implementation?.length ? ` AND prstatus IN ( ${implementation.map(sqlLiteral).join(", ")} )` : "";
      custRows = await inChunks(sap, (l) => `SELECT numm, ntstatus, prstatus, cwbuser FROM cwbntcust WHERE numm IN ( ${l} )${impl}`, ids);
      custRows.sort((a, b) => Number(b.NUMM) - Number(a.NUMM));
    } else {
      if (!implementation?.length) throw new ToolError("INPUT", "Indica notes, o un filtro: implementation y/o component.");
      const where = `WHERE prstatus IN ( ${implementation.map(sqlLiteral).join(", ")} )`;
      const r = await sap.query(`SELECT numm, ntstatus, prstatus, cwbuser FROM cwbntcust ${where} ORDER BY numm DESCENDING`, cap + 1);
      custRows = r.values;
      counted = Number((await sap.query(`SELECT COUNT(*) AS n FROM cwbntcust ${where}`, 1)).values[0]?.N ?? custRows.length);
    }

    // Sin notas concretas solo hace falta el detalle de las que se van a mostrar.
    const shownRows = notes?.length ? custRows : custRows.slice(0, cap);
    const keys = [...new Set([...(notes ?? []).map(noteKey), ...shownRows.map((c) => noteKey(c.NUMM as string))])];
    const { latest, title } = keys.length ? await noteDetails(sap, keys) : { latest: new Map(), title: new Map() };
    const byNote = new Map(custRows.map((c) => [noteKey(c.NUMM as string), c]));

    let rows: Array<z.infer<typeof NOTE>> = (notes?.length ? notes.map(noteKey) : [...byNote.keys()]).map((k) => {
      const c = byNote.get(k);
      const h = latest.get(k);
      if (!c && !h) return { note: k, downloaded: false };
      const impl = String(c?.PRSTATUS ?? "").trim();
      return {
        note: k,
        downloaded: true,
        implementation: c ? describe(IMPL_STATE, impl) : "sin estado en SNOTE",
        implementation_code: c ? impl || " " : undefined,
        processing: c ? describe(PROC_STATE, String(c.NTSTATUS ?? "")) : undefined,
        version: h?.version,
        component: h?.component,
        title: title.get(k)?.text,
        ...(showUser && c?.CWBUSER ? { processor: String(c.CWBUSER).trim() } : {}),
      };
    });
    const total = notes?.length ? rows.length : (counted ?? custRows.length);
    const truncated = !notes?.length && total > cap;
    rows = rows.slice(0, notes?.length ? rows.length : cap);

    const structured = { notes: rows, total, truncated };
    if (!rows.length) return { text: "La consulta se hizo y ninguna nota de este sistema cumple el filtro.", structured };
    const header = ["nota", "descargada", "implementación", "tratamiento", "versión", "componente", "título", ...(showUser ? ["tratada por"] : [])];
    const table = tsv(
      header,
      rows.map((r) => [r.note, r.downloaded ? "sí" : "NO", r.implementation ?? "—", r.processing ?? "—", r.version ?? "", r.component ?? "", r.title ?? "", ...(showUser ? [r.processor ?? ""] : [])]),
    );
    const missing = rows.filter((r) => !r.downloaded).map((r) => r.note);
    return {
      text:
        `${rows.length} notas${truncated ? ` (TOPE: hay ${total}; sube max o afina el filtro)` : ""}\n\n${table}` +
        (missing.length ? `\n\nNo descargadas en este sistema: ${missing.join(", ")}. Que no esté no significa que no aplique: SNOTE solo conoce lo descargado.` : ""),
      structured,
    };
  },
});
