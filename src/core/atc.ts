import type { ADTClient } from "abap-adt-api";

export interface AtcFindingRef {
  n: number;
  objectName: string;
  objectType: string;
  objectUri: string;
  sourceUri: string;
  line: number;
  column: number;
  priority: number;
  checkTitle: string;
  messageTitle: string;
  docUri?: string;
  exempted: boolean;
}

export interface AtcRunOutcome {
  variant: string;
  scope: string;
  at: string;
  /** Totales por prioridad según SAP (incluye los que no caben en maxResults). */
  stats?: { p1: number; p2: number; p3: number };
  findings: AtcFindingRef[];
}

/**
 * ATC recordados por sistema Y alcance (objeto u orden), para que «el hallazgo 3» sea siempre del objeto que se
 * nombra. Antes se recordaba solo el último por sistema, y explain/finding sobre un objeto devolvían el hallazgo de
 * otro objeto analizado antes: con apariencia correcta, que es lo peor.
 */
const runs = new Map<string, AtcRunOutcome>();
const lastScope = new Map<string, string>();
const MAX_RUNS = 100;

export const objectScope = (name: string) => `OBJ:${name.trim().toUpperCase()}`;
export const transportScope = (trkorr: string) => `TR:${trkorr.trim().toUpperCase()}`;

export function rememberRun(systemId: string, scopeKey: string, r: AtcRunOutcome): void {
  const k = `${systemId.toUpperCase()}|${scopeKey}`;
  runs.delete(k); // reinsertar = más reciente
  runs.set(k, r);
  if (runs.size > MAX_RUNS) runs.delete(runs.keys().next().value!);
  lastScope.set(systemId.toUpperCase(), scopeKey);
}

/** ATC de ese alcance; sin alcance, el último del sistema (quien llama debe decir de qué objeto es). */
export function recallRun(systemId: string, scopeKey?: string): AtcRunOutcome | undefined {
  const key = scopeKey ?? lastScope.get(systemId.toUpperCase());
  return key ? runs.get(`${systemId.toUpperCase()}|${key}`) : undefined;
}

/** «hace 3 min» para que se vea si el resultado recordado es de hace un rato. */
export function runAge(r: AtcRunOutcome, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - Date.parse(r.at)) / 60_000));
  return min < 1 ? "hace menos de 1 min" : `hace ${min} min`;
}

export async function defaultVariant(c: ADTClient): Promise<string> {
  const cust = await c.atcCustomizing();
  const v = cust.properties.find((p) => p.name === "systemCheckVariant")?.value;
  return typeof v === "string" && v ? v : "DEFAULT";
}

/** Escapado XML completo (texto y atributos con comillas simples o dobles). */
const xmlEsc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/**
 * Ejecución ATC sobre varios objetos a la vez. La librería solo admite una
 * URI; en NW 7.50 una orden no sirve como conjunto («No URI-Mapping defined
 * for URI»), así que se envían sus objetos en la misma ejecución.
 */
async function createMultiRun(c: ADTClient, worklistId: string, uris: string[], maxResults: number) {
  const refs = uris.map((u) => `<adtcore:objectReference adtcore:uri="${xmlEsc(u)}"/>`).join("");
  const body =
    `<?xml version="1.0" encoding="UTF-8"?><atc:run maximumVerdicts="${maxResults}" xmlns:atc="http://www.sap.com/adt/atc">` +
    `<objectSets xmlns:adtcore="http://www.sap.com/adt/core"><objectSet kind="inclusive"><adtcore:objectReferences>${refs}` +
    `</adtcore:objectReferences></objectSet></objectSets></atc:run>`;
  const r = await c.httpClient.request(`/sap/bc/adt/atc/runs?worklistId=${encodeURIComponent(worklistId)}`, {
    method: "POST",
    headers: { Accept: "application/xml", "Content-Type": "application/xml" },
    body,
  });
  const xml = String(r.body);
  const tag = (t: string) => new RegExp(`<(?:\\w+:)?${t}>([^<]*)</(?:\\w+:)?${t}>`).exec(xml)?.[1] ?? "";
  const infos = [...xml.matchAll(/<(?:\w+:)?info>([\s\S]*?)<\/(?:\w+:)?info>/g)].map((m) => ({
    type: /<(?:\w+:)?type>([^<]*)</.exec(m[1])?.[1] ?? "",
    description: /<(?:\w+:)?description>([^<]*)</.exec(m[1])?.[1] ?? "",
  }));
  return { id: tag("worklistId"), timestamp: new Date(tag("worklistTimestamp")).getTime() / 1000, infos };
}

/** Ejecuta ATC sobre una o varias URI (objeto, paquete, orden u objetos de una orden). */
/** Máximo de veredictos que se piden a SAP al repetir una corrida para no perder P1/P2. */
export const ATC_MAX_VERDICTS = 5000;

export async function runAtc(c: ADTClient, uri: string | string[], variant: string, maxResults: number, includeExempted: boolean): Promise<AtcRunOutcome> {
  const worklistId = await c.atcCheckVariant(variant);
  const exec = (max: number) => (Array.isArray(uri) ? createMultiRun(c, worklistId, uri, max) : c.createAtcRun(worklistId, uri, max));
  let run = await exec(maxResults);
  let wl = await c.atcWorklists(run.id, run.timestamp, "99999999999999999999999999999999", includeExempted);
  let statsInfo = run.infos.find((i) => i.type === "FINDING_STATS")?.description;
  let [p1, p2, p3] = (statsInfo ?? "").split(",").map((x) => Number(x));
  // SAP recorta con maximumVerdicts ANTES de que se ordene por prioridad: con muchos hallazgos informativos, un P1
  // puede quedar fuera. Si los totales dicen que faltan P1/P2, se repite la corrida pidiendo todos (hasta el tope).
  const got = (p: number) => wl.objects.reduce((n, o) => n + o.findings.filter((f) => f.priority === p).length, 0);
  if ([p1, p2].every(Number.isFinite) && got(1) + got(2) < p1 + p2 && maxResults < ATC_MAX_VERDICTS) {
    run = await exec(Math.min(ATC_MAX_VERDICTS, p1 + p2 + (Number.isFinite(p3) ? p3 : 0)));
    wl = await c.atcWorklists(run.id, run.timestamp, "99999999999999999999999999999999", includeExempted);
    statsInfo = run.infos.find((i) => i.type === "FINDING_STATS")?.description;
    [p1, p2, p3] = (statsInfo ?? "").split(",").map((x) => Number(x));
  }
  const findings: AtcFindingRef[] = [];
  for (const o of wl.objects) {
    for (const f of o.findings) {
      findings.push({
        n: 0,
        objectName: o.name,
        objectType: o.type,
        objectUri: o.uri,
        sourceUri: f.location.uri.split("#")[0],
        line: f.location.range.start.line,
        column: f.location.range.start.column,
        priority: f.priority,
        checkTitle: f.checkTitle,
        messageTitle: f.messageTitle,
        docUri: f.link?.href,
        exempted: !!f.exemptionKind,
      });
    }
  }
  findings.sort((a, b) => a.priority - b.priority || a.objectName.localeCompare(b.objectName) || a.line - b.line);
  findings.forEach((f, i) => (f.n = i + 1));
  return {
    variant,
    scope: Array.isArray(uri) ? `${uri.length} objetos` : uri,
    at: new Date().toISOString(),
    stats: statsInfo && [p1, p2, p3].every(Number.isFinite) ? { p1, p2, p3 } : undefined,
    findings,
  };
}
