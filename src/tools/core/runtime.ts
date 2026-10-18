import { z } from "zod";
import { dataClassOf, guardedQuery } from "../../core/datapolicy.js";
import { decodeEntities } from "../../core/feeds.js";
import { ToolError } from "../../core/errors.js";
import { tsv } from "../../core/output.js";
import { SAP_USER_RE } from "../../core/policy.js";
import { defineTool } from "../../core/tool.js";

/**
 * Runtime de solo lectura: trazas ABAP (SAT) ya grabadas, directorio de trazas SQL (ST05) y mensajes de sistema
 * (SM02). Activar o borrar trazas es escritura y queda fuera a propósito: aquí solo se lee lo que ya existe.
 */
const ms = (us: number) => `${(us / 1000).toFixed(1)} ms`;
const pct = (p: number) => `${p.toFixed(1)} %`;

const abapTraces = defineTool({
  name: "abap_traces",
  title: "Trazas ABAP (SAT)",
  timeoutMs: 120_000,
  description:
    "Trazas de rendimiento ABAP (SAT) ya grabadas en el sistema: lista las del usuario (o de otro) con tiempos de " +
    "ABAP, sistema y base de datos; con trace=<id> muestra la hit list (qué consume tiempo), los accesos a base de " +
    "datos o las sentencias. Solo lectura: no activa ni borra trazas (eso se hace en SAT o Eclipse).",
  access: "read",
  requires: { adt: ["/sap/bc/adt/runtime/traces/abaptraces"] },
  input: {
    user: z.string().regex(SAP_USER_RE).optional().describe("Usuario SAP cuyas trazas listar; por defecto el de la conexión"),
    trace: z.string().optional().describe("Id de una traza de la lista para ver su detalle"),
    show: z.enum(["hitlist", "db", "statements"]).default("hitlist").describe("Con trace: hit list, accesos a BD o sentencias"),
    top: z.number().int().min(1).max(500).default(30),
  },
  async run({ user, trace, show, top }, { sap, system }) {
    const c = await sap.adt();
    if (!trace) {
      const who = user ?? system.user;
      const r = await c.tracesList(who);
      if (!r.runs.length) return `No hay trazas ABAP grabadas para ${who} en ${system.id}.`;
      const rows = r.runs
        .slice()
        .sort((a, b) => (b.published?.getTime?.() ?? 0) - (a.published?.getTime?.() ?? 0))
        .slice(0, top)
        .map((t) => {
          const x = t.extendedData;
          const id = t.id.replace(/^.*\/abaptraces\//, "");
          return [id, t.title, x.objectName, t.published instanceof Date ? t.published.toISOString().slice(0, 16).replace("T", " ") : "", x.state?.text ?? x.state?.value ?? "", ms(x.runtime), ms(x.runtimeABAP), ms(x.runtimeDatabase), ms(x.runtimeSystem), x.isAggregated ? "sí" : "no"];
        });
      return `${r.runs.length} trazas de ${who} en ${system.id}${r.runs.length > top ? ` (se muestran ${top})` : ""}\n\n` +
        tsv(["id", "título", "objeto", "fecha", "estado", "total", "abap", "bd", "sistema", "agregada"], rows) +
        `\n\nDetalle: abap_traces(trace="<id>", show="hitlist" | "db" | "statements").`;
    }
    if (!/^[A-Za-z0-9_:.\-]{1,120}$/.test(trace)) throw new ToolError("INPUT", `Id de traza inválido: ${trace}`);
    if (show === "db") {
      const r = await c.tracesDbAccess(trace);
      if (!r.dbaccesses.length) return `Traza ${trace}: sin accesos a base de datos registrados.`;
      const rows = r.dbaccesses
        .slice()
        .sort((a, b) => b.accessTime.total - a.accessTime.total)
        .slice(0, top)
        .map((d) => [d.tableName, d.type, d.totalCount, d.bufferedCount, ms(d.accessTime.total), ms(d.accessTime.database), pct(d.accessTime.ratioOfTraceTotal), d.callingProgram?.name ?? d.callingProgram?.context ?? "", d.statement.replace(/\s+/g, " ").slice(0, 120)]);
      const tables = r.tables.slice(0, 20).map((t) => `${t.name} (${t.type}${t.bufferMode ? `, buffer ${t.bufferMode}` : ""})`).join(", ");
      return `Traza ${trace}: ${r.dbaccesses.length} accesos a BD${r.dbaccesses.length > top ? ` (se muestran ${top} por tiempo)` : ""}\n\n` +
        tsv(["tabla", "tipo", "ejecuciones", "en buffer", "tiempo", "en bd", "% traza", "desde", "sentencia"], rows) + (tables ? `\n\nTablas: ${tables}` : "");
    }
    if (show === "statements") {
      const r = await c.tracesStatements(trace, { withDetails: false, withSystemEvents: false });
      if (!r.statements.length) return `Traza ${trace}: sin sentencias.`;
      const rows = r.statements.slice(0, top).map((s) => [s.index, s.callLevel, s.hitCount, ms(s.grossTime.time), pct(s.grossTime.percentage), ms(s.traceEventNetTime.time), s.callingProgram?.name ?? s.callingProgram?.context ?? "", s.description.slice(0, 120)]);
      return `Traza ${trace}: ${r.count} sentencias${r.count > top ? ` (se muestran ${top})` : ""}\n\n` + tsv(["#", "nivel", "veces", "bruto", "% bruto", "neto", "programa", "sentencia"], rows);
    }
    const r = await c.tracesHitList(trace);
    if (!r.entries.length) return `Traza ${trace}: hit list vacía.`;
    const rows = r.entries
      .slice()
      .sort((a, b) => b.traceEventNetTime.time - a.traceEventNetTime.time)
      .slice(0, top)
      .map((e) => [e.index, e.hitCount, ms(e.traceEventNetTime.time), pct(e.traceEventNetTime.percentage), ms(e.grossTime.time), e.callingProgram?.name ?? e.callingProgram?.context ?? "", e.calledProgram, e.description.slice(0, 120)]);
    return `Traza ${trace}: ${r.entries.length} entradas de la hit list${r.entries.length > top ? ` (se muestran ${top} por tiempo neto)` : ""}\n\n` +
      tsv(["#", "veces", "neto", "% neto", "bruto", "programa", "llamado", "descripción"], rows);
  },
});

/** Elementos hoja con texto de un XML (<ts:sqlOn>false</ts:sqlOn>): nombre sin prefijo → texto. Agrupa por elemento contenedor repetido. */
export function xmlLeafGroups(xml: string, groupTag: string): Array<Record<string, string>> {
  const groups: Array<Record<string, string>> = [];
  const re = new RegExp(`<(?:[\\w-]+:)?${groupTag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${groupTag}>`, "g");
  for (const g of xml.matchAll(re)) {
    const leaf: Record<string, string> = {};
    for (const m of g[1].matchAll(/<(?:[\w-]+:)?([\w-]+)(?:\s[^>]*)?>([^<]*)<\/(?:[\w-]+:)?\1>/g)) leaf[m[1]] = decodeEntities(m[2]).trim();
    groups.push(leaf);
  }
  return groups;
}

/** Elementos con atributos de un XML cuyo esquema no conocemos de antemano: una fila por elemento. */
export function xmlRows(xml: string): Array<{ tag: string; attrs: Record<string, string> }> {
  const out: Array<{ tag: string; attrs: Record<string, string> }> = [];
  for (const m of xml.matchAll(/<([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"]*")+)\s*\/?>/g)) {
    const attrs: Record<string, string> = {};
    for (const a of m[2].matchAll(/([\w:.-]+)="([^"]*)"/g)) if (!/^xmlns(:|$)/.test(a[1])) attrs[a[1].replace(/^[\w]+:/, "")] = decodeEntities(a[2]);
    if (Object.keys(attrs).length) out.push({ tag: m[1].replace(/^[\w]+:/, ""), attrs });
  }
  return out;
}

const sqlTraces = defineTool({
  name: "sql_traces",
  title: "Trazas SQL (ST05)",
  description:
    "Estado de la traza de ST05 por instancia (SQL, buffer, enqueue, RFC, HTTP: activa o no, quién la cambió y con " +
    "qué filtro) y el enlace a la app de análisis, por ADT en S/4HANA y NW ≥ 7.51. Solo lectura: no activa ni " +
    "desactiva la traza. En ECC 7.50 no existe y la tool lo dice.",
  access: "read",
  requires: { adt: ["/sap/bc/adt/st05/trace/directory"] },
  input: {
    show: z.enum(["directory", "state"]).default("directory"),
    top: z.number().int().min(1).max(500).default(50),
  },
  async run({ show, top }, { sap, system }) {
    const c = await sap.adt();
    const get = async (path: string) => String((await c.httpClient.request(path, { method: "GET", headers: { Accept: "application/xml, */*" } })).body);
    if (show === "directory") {
      // Verificado en un S/4 758: el directorio no lista trazas, solo el enlace a la app Fiori de análisis.
      const xml = await get("/sap/bc/adt/st05/trace/directory");
      const link = /<(?:\w+:)?uri>([^<]*)<\/(?:\w+:)?uri>/.exec(xml)?.[1];
      const rows = xmlRows(xml);
      if (link) return `ST05 en ${system.id}: ADT no lista las trazas grabadas; las analiza la app «SQL Trace Analysis»:\n${decodeEntities(link)}\nEl estado de la grabación por instancia: sql_traces(show="state").`;
      if (!rows.length) return `${system.id}: ST05 respondió sin trazas ni enlace en el directorio.`;
      const cols = [...new Set(rows.flatMap((x) => Object.keys(x.attrs)))].slice(0, 14);
      return `ST05 directorio en ${system.id}: ${rows.length} elementos\n\n` + tsv(["elemento", ...cols], rows.slice(0, top).map((x) => [x.tag, ...cols.map((k) => x.attrs[k] ?? "")]));
    }
    const xml = await get("/sap/bc/adt/st05/trace/state");
    const inst = xmlLeafGroups(xml, "traceStateInstance");
    if (!inst.length) return `${system.id}: ST05 respondió sin instancias en el estado.`;
    const on = (i: Record<string, string>) => ["sqlOn", "bufOn", "enqOn", "rfcOn", "httpOn", "apcOn", "amcOn", "authOn"].filter((k) => i[k] === "true").map((k) => k.replace(/On$/, "").toUpperCase());
    const filt = (i: Record<string, string>) => ["traceUser", "transactionCode", "program", "rfcFunction", "url", "wpId"].filter((k) => i[k]).map((k) => `${k}=${i[k]}`).join(" ");
    const rows = inst.slice(0, top).map((i) => [i.instance ?? "", i.host ?? "", on(i).join(",") || "ninguna", i.modificationUser || "", i.modificationDateTime || "", filt(i) || "sin filtro"]);
    const active = inst.filter((i) => on(i).length).length;
    return `ST05 en ${system.id}: ${inst.length} instancias, ${active} con traza activa\n\n` + tsv(["instancia", "host", "trazas activas", "cambiado por", "cuándo", "filtro"], rows);
  },
});

const systemMessages = defineTool({
  name: "system_messages",
  title: "Mensajes de sistema (SM02)",
  description:
    "Mensajes de sistema de SM02 (aviso de parada, mantenimiento…): texto, mandante, servidor, vigencia y quién lo " +
    "creó, leídos de la tabla TEMSG. Solo lectura. Si el release guarda los mensajes de otra forma, la tool lo dice " +
    "en vez de devolver vacío.",
  access: "read",
  input: {
    only_active: z.boolean().default(true).describe("Solo los vigentes hoy"),
    max: z.number().int().min(1).max(200).default(50),
  },
  async run({ only_active, max }, { sap, system }) {
    // TEMSG (verificada en NW 7.50): ID, EMTEXT, DATCRE/TIMCRE, DATDEL/TIMDEL, AUTHOR, APPLSERVER, CLIENT, LANGU. TEMSI es solo el contador.
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const where = only_active ? ` WHERE datcre <= '${today}' AND ( datdel >= '${today}' OR datdel = '00000000' )` : "";
    let r;
    try {
      r = await guardedQuery(sap, system, `SELECT id, emtext, datcre, timcre, datdel, timdel, author, applserver, client, langu FROM temsg${where} ORDER BY datcre DESCENDING, timcre DESCENDING`, max);
    } catch (e) {
      const msg = (e as Error).message;
      if (/TEMSG|no existe|not exist|unknown|desconocid/i.test(msg)) throw new ToolError("CAPABILITY", `${system.id} no expone la tabla TEMSG de mensajes de sistema como se esperaba (${msg}).`, "Consulta SM02 en el SAP GUI.");
      throw e;
    }
    if (!r.values.length) return `${system.id}: no hay mensajes de sistema${only_active ? " vigentes" : ""}.`;
    const rows = r.values.map((v) => [v.ID, v.CLIENT || "todos", String(v.APPLSERVER ?? "").trim() || "todos", `${v.DATCRE} ${v.TIMCRE}`, v.DATDEL && v.DATDEL !== "00000000" ? `${v.DATDEL} ${v.TIMDEL ?? ""}` : "sin fin", v.AUTHOR, v.LANGU, String(v.EMTEXT ?? "").trimEnd().slice(0, 200)]);
    const note = dataClassOf(system) !== "test" ? "\n\n(El usuario creador sale enmascarado por la política de datos del sistema.)" : "";
    return `${r.values.length} mensajes de sistema en ${system.id}${r.capped ? " (tope alcanzado)" : ""}\n\n` + tsv(["id", "mandante", "servidor", "desde", "hasta", "creado por", "idioma", "texto"], rows) + note;
  },
});

export default [abapTraces, sqlTraces, systemMessages];
