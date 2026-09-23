import { z } from "zod";
import type { ADTClient } from "abap-adt-api";
import {
  defaultVariant, objectChangedAt, objectScope, recallRun, rememberRun, reusable, runAge, runAtc, transportScope, type AtcRunOutcome,
} from "../../core/atc.js";
import type { SapConnection } from "../../core/connection.js";
import { normalizeError, ToolError } from "../../core/errors.js";
import { decodeEntities, htmlToText } from "../../core/feeds.js";
import { sourceObjectsOf } from "../../core/revisions.js";
import { budget } from "../../core/output.js";
import { resolveByTypePrefix, resolveObject, sqlLiteral, TYPE_HELP } from "../../core/objects.js";
import { assertTrkorr } from "../../core/policy.js";
import { defineTool, type ToolContext } from "../../core/tool.js";

const decode = decodeEntities;
const strip = htmlToText;

interface Target {
  key: string;
  uri: string;
  scope: string;
  transport?: string;
}

interface RunOpts {
  variant?: string;
  max_findings: number;
  include_exempted: boolean;
  refresh?: boolean;
}

/**
 * Ejecuta el ATC del alcance y lo recuerda bajo ese alcance. Sobre un objeto, si hay un resultado de menos de una
 * hora con la misma variante y el objeto no cambió desde entonces (marca `changedAt` de ADT), se devuelve ese en vez
 * de ejecutar otra vez: es la tool más lenta del servidor y la que más se repite sobre lo mismo. Las órdenes no se
 * reutilizan nunca: su contenido cambia sin que cambie ningún objeto.
 */
async function execute(c: ADTClient, sap: SapConnection, systemId: string, t: Target, o: RunOpts, ctx?: ToolContext): Promise<AtcRunOutcome> {
  const variant = o.variant ?? (await defaultVariant(c));
  // La marca se lee ANTES de ejecutar: si alguien guarda el objeto durante el ATC, la marca vieja invalida la caché.
  const changedAt = t.transport ? undefined : await objectChangedAt(c, t.uri);
  if (changedAt !== undefined && !o.refresh) {
    const prev = recallRun(systemId, t.key);
    if (prev && prev.changedAt === changedAt && reusable(prev, variant, o)) return { ...prev, fromCache: true };
  }
  let res: AtcRunOutcome;
  ctx?.progress?.(`ATC de ${t.scope} con la variante ${variant}…`);
  try {
    res = await runAtc(c, t.uri, variant, o.max_findings, o.include_exempted);
    res.scope = t.scope;
  } catch (e) {
    // NW 7.50 no acepta una orden como conjunto ATC («No URI-Mapping defined for URI»):
    // se ejecuta sobre los objetos de la orden, en una sola corrida.
    const te = normalizeError(e);
    if (!t.transport || te.kind !== "SAP" || !/URI-Mapping|500/i.test(te.message)) throw te;
    const tr = t.transport;
    const tasks = await sap.query(`SELECT trkorr FROM e070 WHERE strkorr = ${sqlLiteral(tr)}`, 500);
    const ids = [tr, ...tasks.values.map((v) => v.TRKORR as string)];
    const rows = await sap.query(`SELECT pgmid, object, obj_name FROM e071 WHERE trkorr IN ( ${ids.map(sqlLiteral).join(", ")} )`, 5000);
    const { source, ddic } = sourceObjectsOf(rows.values as any);
    const refs = [
      ...source.map((s) => ({ name: s.name, types: s.types })),
      ...ddic.map((d) => ({ name: d.split(" ").slice(1).join(" "), types: [d.split(" ")[0].slice(0, 4) + "/"] })),
    ];
    const uris = (await Promise.all(refs.map((r) => resolveByTypePrefix(c, r.name, r.types)))).filter(Boolean).map((r) => r!.uri);
    if (!uris.length) throw new ToolError("NOT_FOUND", `La orden ${tr} no contiene objetos que el ATC pueda revisar.`);
    ctx?.signal?.throwIfAborted();
    ctx?.progress?.(`Este release no admite la orden como conjunto: ATC sobre sus ${uris.length} objetos en una corrida…`);
    res = await runAtc(c, uris, variant, o.max_findings, o.include_exempted);
    res.scope = `orden ${tr} (sus ${uris.length} objetos: este release no admite la orden como conjunto ATC)`;
  }
  res.variant = variant;
  res.includeExempted = o.include_exempted;
  res.maxFindings = o.max_findings;
  res.changedAt = changedAt;
  rememberRun(systemId, t.key, res);
  return res;
}

export default defineTool({
  name: "run_atc",
  timeoutMs: 180_000,
  title: "Ejecutar ATC",
  description:
    "Ejecuta el ATC sobre un objeto o una orden de transporte y lista los hallazgos numerados (prioridad, línea, " +
    "check, mensaje), con los totales P1/P2/P3 que da SAP. El resultado queda recordado POR OBJETO U ORDEN: " +
    "explain=N con object_name (o transport) trae la documentación del hallazgo N de ESE objeto (nota SAP, " +
    "supresión) sin re-ejecutar si ya se analizó, y lo ejecuta si no. atc_quickfix(finding=N) usa la misma memoria. " +
    "Sobre un objeto sin cambios desde el último ATC (menos de 1 h, misma variante) devuelve ese resultado y lo dice; " +
    "refresh=true fuerza una ejecución nueva.",
  access: "read",
  requires: { adt: ["/sap/bc/adt/atc/runs"] },
  input: {
    object_name: z.string().optional(),
    object_type: z.string().optional().describe(TYPE_HELP),
    transport: z.string().optional().describe("En vez de un objeto: todos los objetos de esta orden"),
    variant: z.string().optional().describe("Variante ATC; por defecto la del sistema"),
    priorities: z.array(z.number().int().min(1).max(4)).optional().describe("Filtrar la lista, p. ej. [1,2]"),
    max_findings: z.number().int().min(1).max(1000).default(200),
    include_exempted: z.boolean().default(false),
    refresh: z.boolean().default(false).describe("Ejecutar aunque haya un resultado reciente del mismo objeto sin cambios"),
    explain: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Documentación del hallazgo N del ATC del objeto u orden indicados (sin ellos: del último ATC, y lo dice)"),
  },
  async run(a, ctx) {
    const { sap, system } = ctx;
    const c = await sap.adt();

    // El alcance (objeto u orden nombrados) se resuelve antes que nada: explain=N es SIEMPRE de ese alcance.
    let target: Target | undefined;
    if (a.transport) {
      const tr = assertTrkorr(a.transport);
      target = { key: transportScope(tr), uri: `/sap/bc/adt/cts/transportrequests/${tr}`, scope: `orden ${tr}`, transport: tr };
    } else if (a.object_name) {
      const obj = await resolveObject(c, a.object_name, a.object_type);
      target = { key: objectScope(obj.name), uri: obj.uri, scope: `${obj.name} (${obj.type})` };
    }
    const opts: RunOpts = { variant: a.variant, max_findings: a.max_findings, include_exempted: a.include_exempted, refresh: a.refresh };

    if (a.explain) {
      let run = target ? recallRun(system.id, target.key) : recallRun(system.id);
      let ranNow = false;
      if (!run && target) {
        run = await execute(c, sap, system.id, target, opts, ctx);
        ranNow = true;
      }
      if (!run) throw new ToolError("INPUT", "No hay un ATC previo en esta sesión: indica object_name o transport.");
      const origin = `ATC de ${run.scope} · variante ${run.variant} · ${ranNow ? "ejecutado ahora" : runAge(run)}`;
      const f = run.findings.find((x) => x.n === a.explain);
      if (!f) throw new ToolError("INPUT", `El ${origin} tiene ${run.findings.length} hallazgos: no existe el ${a.explain}.`);
      if (!f.docUri) return `${origin}\nEl hallazgo ${f.n} no trae documentación.`;
      const r = await c.atcDocumentation(f.docUri);
      return budget(`${origin}\nHallazgo ${f.n}: ${f.checkTitle} — ${decode(f.messageTitle)}\n${f.objectName} L${f.line}\n\n${strip(String(r.body))}`);
    }

    if (!target) throw new ToolError("INPUT", "Indica object_name o transport.");
    const res = await execute(c, sap, system.id, target, opts, ctx);

    const shown = res.findings.filter((f) => !a.priorities || a.priorities.includes(f.priority));
    const byPrio = [1, 2, 3, 4].map((p) => res.findings.filter((f) => f.priority === p).length);
    const stats = res.stats ? `SAP: P1 ${res.stats.p1} · P2 ${res.stats.p2} · P3 ${res.stats.p3}` : `P1 ${byPrio[0]} · P2 ${byPrio[1]} · P3 ${byPrio[2]}`;
    // Se compara con lo recibido de SAP (exentos incluidos), no con lo mostrado: los exentos filtrados no son un recorte.
    const received = res.received ?? res.findings.length;
    const capped = res.stats && res.stats.p1 + res.stats.p2 + res.stats.p3 > received
      ? `\nSAP devolvió ${received} de ${res.stats.p1 + res.stats.p2 + res.stats.p3} veredictos (los P1/P2 están todos): sube max_findings para ver el resto.`
      : "";
    const origin = res.fromCache
      ? `resultado de ${runAge(res)}, objeto sin cambios desde entonces (refresh=true para ejecutar de nuevo)`
      : "ejecutado ahora";
    if (!res.findings.length) return `ATC de ${res.scope} (variante ${res.variant}, ${origin}): no hay hallazgos${a.include_exempted ? "" : " sin excepción"}.`;

    const lines = shown.map(
      (f) => `${String(f.n).padStart(3)}. P${f.priority} ${f.objectName} L${f.line}  [${f.checkTitle}] ${decode(f.messageTitle)}${f.exempted ? " (con excepción)" : ""}`,
    );
    return (
      `ATC de ${res.scope} · variante ${res.variant} · ${origin} · ${stats}${capped}\n` +
      `${a.priorities ? `Filtrado a P${a.priorities.join("/P")}: ${shown.length}\n` : ""}\n${lines.join("\n")}\n\n` +
      `Siguiente: run_atc(object_name, explain=N) para la documentación del check; atc_quickfix(object_name, finding=N) para ver correcciones.`
    );
  },
});
