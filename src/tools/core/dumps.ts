import { z } from "zod";
import type { Dump } from "abap-adt-api";
import { dataClassOf } from "../../core/datapolicy.js";
import { ToolError } from "../../core/errors.js";
import { decodeEntities, htmlToText } from "../../core/feeds.js";
import { budget } from "../../core/output.js";
import { SAP_USER_RE } from "../../core/policy.js";
import { defineTool } from "../../core/tool.js";

const decode = decodeEntities;
const stripHtml = htmlToText;

/** Campo de la tabla «Header Information» del resumen HTML del dump. */
function headerField(d: Dump, label: string): string | undefined {
  const m = d.text.match(new RegExp(`<b>${label}&nbsp;</b></td><td[^>]*>([\\s\\S]*?)</td>`));
  return m ? decode(m[1]).trim() : undefined;
}

const cat = (d: Dump, label: string) => d.categories.find((c) => c.label === label)?.term;

function summary(d: Dump, i: number): string {
  return (
    `${i}. ${headerField(d, "Date/Time")?.replace(" (System)", "") ?? "?"} · ${cat(d, "ABAP runtime error") ?? "?"} · ` +
    `${cat(d, "Terminated ABAP program") ?? "?"} · ${d.author ?? "?"}\n   ${headerField(d, "Short Text") ?? ""}`
  );
}

/**
 * Cabecera de un dump tal como la guarda ST22 en SNAP_BEG.FLIST: secuencia de «id (2) + longitud (3) + valor».
 * Solo trae metadatos (error, programa, include, línea, clase de excepción, ids), nunca valores de variables: esos
 * están en SNAP, que sigue vetada. Ids verificados en un NW 7.50 real.
 */
export function parseFlist(flist: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i + 5 <= flist.length; ) {
    const id = flist.slice(i, i + 2);
    const len = Number(flist.slice(i + 2, i + 5));
    if (!/^[A-Z0-9]{2}$/.test(id) || !Number.isInteger(len) || len < 0) break;
    out[id] = flist.slice(i + 5, i + 5 + len).trim();
    i += 5 + len;
  }
  return out;
}

const GROUP_BY = ["error", "program", "error_program", "user", "day"] as const;
type GroupBy = (typeof GROUP_BY)[number];

interface Row {
  DATUM: string;
  UZEIT: string;
  UNAME: string;
  FLIST: string;
}
interface Group {
  key: string;
  count: number;
  first: string;
  last: string;
  users: number;
  /** Un ejemplo de dónde terminó: include y línea del dump más reciente del grupo. */
  where?: string;
}

/** El tope de filas que se piden a SNAP_BEG: por encima, la respuesta dice que puede haber más. */
export const GROUP_ROWS = 5000;

function groupKey(by: GroupBy, r: Row, h: Record<string, string>): string {
  const error = h.FC || "?";
  const program = h.AP || "?";
  switch (by) {
    case "error": return error;
    case "program": return program;
    case "error_program": return `${error} · ${program}`;
    case "user": return String(r.UNAME ?? "?");
    case "day": return String(r.DATUM ?? "?");
  }
}

export function groupDumps(rows: Row[], by: GroupBy): Group[] {
  const groups = new Map<string, Group & { userSet: Set<string> }>();
  for (const r of rows) {
    const h = parseFlist(String(r.FLIST ?? ""));
    const key = groupKey(by, r, h);
    const at = `${r.DATUM} ${String(r.UZEIT ?? "").slice(0, 6)}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, count: 0, first: at, last: at, users: 0, userSet: new Set() };
      groups.set(key, g);
    }
    g.count++;
    if (at < g.first) g.first = at;
    if (at >= g.last) {
      g.last = at;
      if (h.AI) g.where = `${h.AI}${h.AL ? ` L${h.AL}` : ""}`;
    }
    g.userSet.add(String(r.UNAME ?? ""));
  }
  return [...groups.values()]
    .map(({ userSet, ...g }) => ({ ...g, users: userSet.size }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

const GROUP = z.object({
  key: z.string(),
  count: z.number().int(),
  first: z.string().describe("AAAAMMDD hhmmss del primer dump del grupo en el periodo"),
  last: z.string(),
  users: z.number().int().describe("Usuarios distintos afectados"),
  where: z.string().optional().describe("Include y línea del dump más reciente del grupo"),
});

function dayStamp(daysAgo: number, now = new Date()): string {
  const d = new Date(now.getTime() - daysAgo * 86_400_000);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

export default defineTool({
  name: "dumps",
  title: "Dumps (ST22)",
  description:
    "Dumps de ST22: fecha, error, programa, usuario y texto; filtra por usuario o texto. detail=N devuelve el dump N " +
    "completo (análisis, dónde terminó, fuente, pila). group_by (error, program, error_program, user, day) con days=N " +
    "responde «los errores más frecuentes del periodo», con primer y último caso y usuarios afectados. Lista y detalle " +
    "salen del feed ADT; los grupos, de ST22.",
  access: "read",
  requires: { adt: ["/sap/bc/adt/runtime/dumps"] },
  input: {
    user: z.string().regex(SAP_USER_RE, "usuario SAP: letras, números y _ . @ -, hasta 12").optional(),
    contains: z.string().optional().describe("Filtra por error o programa, p. ej. CALL_FUNCTION_NOT_FOUND o ZFI_REPORTE"),
    max: z.number().int().min(1).max(200).default(20),
    detail: z.number().int().min(1).optional().describe("Número de la lista para ver el dump completo"),
    group_by: z.enum(GROUP_BY).optional().describe("Agrupar los dumps del periodo: por error, programa, error+programa, usuario o día"),
    days: z.number().int().min(1).max(90).default(7).describe("Periodo hacia atrás para group_by (días)"),
  },
  output: {
    mode: z.enum(["list", "detail", "groups"]),
    total: z.number().int().describe("Dumps considerados (feed leído o filas del periodo)"),
    period_days: z.number().int().optional(),
    since: z.string().optional().describe("AAAAMMDD desde el que se contó"),
    truncated: z.boolean().optional().describe("true si el periodo tiene más dumps de los que se pudieron leer"),
    group_by: z.enum(GROUP_BY).optional(),
    groups: z.array(GROUP).optional(),
    dumps: z.array(z.object({ n: z.number().int(), error: z.string(), program: z.string(), user: z.string() })).optional(),
  },
  async run({ user, contains, max, detail, group_by, days }, { sap, system }) {
    if (group_by) {
      if (group_by === "user" && dataClassOf(system) !== "test") {
        throw new ToolError("POLICY", `En ${system.id} (datos ${dataClassOf(system)}) no se agrupa por usuario: es una columna personal. Agrupa por error o programa; el número de usuarios afectados sale igualmente.`);
      }
      const since = dayStamp(days);
      const where = [`seqno = '000'`, `datum >= '${since}'`, ...(user ? [`uname = '${user.toUpperCase()}'`] : [])].join(" AND ");
      const r = await sap.query(`SELECT datum, uzeit, uname, flist FROM snap_beg WHERE ${where} ORDER BY datum DESCENDING, uzeit DESCENDING`, GROUP_ROWS);
      const needle = contains?.toUpperCase();
      const rows = (r.values as unknown as Row[]).filter((row) => {
        if (!needle) return true;
        const h = parseFlist(String(row.FLIST ?? ""));
        return (h.FC ?? "").toUpperCase().includes(needle) || (h.AP ?? "").toUpperCase().includes(needle);
      });
      const truncated = r.values.length >= GROUP_ROWS;
      const groups = groupDumps(rows, group_by);
      const shown = groups.slice(0, max);
      const structured = { mode: "groups" as const, total: rows.length, period_days: days, since, truncated, group_by, groups: shown };
      if (!rows.length) {
        return { text: `Sin dumps desde ${since} (${days} días)${user ? ` del usuario ${user}` : ""}${contains ? ` que casen con «${contains}»` : ""}: se consultó ST22 (SNAP_BEG) y no hay filas.`, structured };
      }
      const label: Record<GroupBy, string> = { error: "error", program: "programa", error_program: "error · programa", user: "usuario", day: "día" };
      const lines = shown.map(
        (g, i) => `${String(i + 1).padStart(3)}. ${String(g.count).padStart(5)}  ${g.key}  · ${g.users} usuario${g.users === 1 ? "" : "s"} · ${g.first.slice(0, 8)} → ${g.last.slice(0, 8)}${g.where ? ` · ${g.where}` : ""}`,
      );
      return {
        text:
          `${rows.length} dumps desde ${since} (${days} días)${truncated ? ` — TOPE ALCANZADO (${GROUP_ROWS} filas): puede haber más; acota con days o contains` : ""}` +
          `, ${groups.length} grupos por ${label[group_by]} (se muestran ${shown.length})\n\n` +
          `  #  dumps  ${label[group_by]}\n${lines.join("\n")}\n\n` +
          `Siguiente: dumps(contains="<error o programa>") para ver los casos recientes y dumps(detail=N) para uno completo.`,
        structured,
      };
    }

    const c = await sap.adt();
    const feed = await c.dumps(user ? `and( equals( user, ${user.toUpperCase()} ) )` : "");
    const needle = contains?.toUpperCase();
    const list = feed.dumps.filter((d) => !needle || d.categories.some((x) => x.term.toUpperCase().includes(needle)));
    const asRow = (d: Dump, i: number) => ({ n: i + 1, error: cat(d, "ABAP runtime error") ?? "?", program: cat(d, "Terminated ABAP program") ?? "?", user: d.author ?? "?" });
    if (!list.length) {
      return {
        text: `El feed de dumps se leyó (${feed.dumps.length} en total) y ninguno casa${user ? ` con usuario ${user}` : ""}${contains ? ` y «${contains}»` : ""}. Para un periodo largo usa group_by.`,
        structured: { mode: "list" as const, total: feed.dumps.length, dumps: [] },
      };
    }
    if (detail) {
      const d = list[detail - 1];
      if (!d) throw new ToolError("INPUT", `Solo hay ${list.length} dumps en la lista.`);
      const structured = { mode: "detail" as const, total: list.length, dumps: [asRow(d, detail - 1)] };
      const self = d.links.find((l) => l.rel === "self")?.href.replace(/^adt:\/\/[^/]+/, "");
      if (!self) return { text: budget(stripHtml(d.text)), structured };
      // El recurso ofrece HTML (dump completo) o un XML índice; text/plain da 406.
      const r = await c.httpClient.request(self, { headers: { Accept: "text/html" } });
      return { text: budget(`${summary(d, detail)}\n\n${stripHtml(String(r.body))}`, undefined, "El dump completo está en ST22."), structured };
    }
    const shown = list.slice(0, max);
    return {
      text:
        `${list.length} dumps${needle || user ? " que casan" : ""} (se muestran ${shown.length}; el feed trae solo los más recientes: para un periodo usa group_by)\n\n` +
        shown.map((d, i) => summary(d, i + 1)).join("\n"),
      structured: { mode: "list" as const, total: list.length, dumps: shown.map(asRow) },
    };
  },
});
