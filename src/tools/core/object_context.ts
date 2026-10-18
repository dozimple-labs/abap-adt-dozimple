import { z } from "zod";
import { ADTClient, type AbapClassStructure } from "abap-adt-api";
import { parseAbap, summarize } from "../../core/abapparse.js";
import { objectScope, recallRun, runAge } from "../../core/atc.js";
import { normalizeError } from "../../core/errors.js";
import { resolveObject, sourceUrl, TYPE_HELP } from "../../core/objects.js";
import { ctsLocks, tadirInfo, tadirKey } from "../../core/preflight.js";
import { defineTool } from "../../core/tool.js";
import { versionDrift } from "../transport-risk/_drift.js";
import { RISK_MODULE } from "../transport-risk/_service.js";

/**
 * Todo lo que hace falta saber de un objeto antes de tocarlo o explicarlo, en una llamada. Sustituye la cadena
 * search_objects → get_source → edit_preflight → where_used → object_versions que costaba cinco o seis llamadas y
 * otras tantas vueltas de contexto. Cada sección que no se pueda leer se dice en `skipped`: nunca se omite en silencio.
 */
const MAX_VERSIONS = 5;

export default defineTool({
  name: "object_context",
  title: "Contexto de un objeto en una llamada",
  timeoutMs: 180_000,
  description:
    "Ficha completa de un objeto en una llamada: tipo, paquete, responsable, bloqueo CTS y orden, tamaño de la " +
    "fuente, versiones recientes, usos, deriva frente a calidad/productivo (módulo transport-risk) y último ATC " +
    "recordado. depth 0 identidad y bloqueo; 1 añade versiones y usos; 2 añade deriva y ATC. Úsala antes de " +
    "get_source, edit_preflight, where_used u object_versions por separado.",
  access: "read",
  input: {
    object_name: z.string().min(1),
    object_type: z.string().optional().describe(TYPE_HELP),
    depth: z.number().int().min(0).max(2).default(1).describe("0 identidad, bloqueo y tamaño · 1 + versiones y usos · 2 + deriva y ATC"),
    max_usages: z.number().int().min(1).max(100).default(10),
  },
  output: {
    name: z.string(),
    type: z.string(),
    package: z.string(),
    description: z.string(),
    responsible: z.string(),
    original_system: z.string(),
    local: z.boolean(),
    locks: z.array(z.object({ order: z.string(), description: z.string() })).describe("Órdenes con bloqueo CTS: cualquier cambio irá ahí"),
    source: z.object({ lines: z.number().int(), includes: z.array(z.string()) }).nullable(),
    summary: z.object({
      text: z.string(),
      classes: z.array(z.object({ name: z.string(), methods: z.number().int(), public: z.number().int() })),
      forms: z.number().int(),
      statements: z.number().int(),
      max_nesting: z.number().int(),
      tables: z.array(z.string()),
      functions: z.array(z.string()),
      classes_used: z.array(z.string()),
      includes: z.array(z.string()),
      unused_methods: z.number().int(),
    }).nullable().describe("Resumen local de la fuente (abaplint): qué hay y qué toca, sin la fuente"),
    versions: z.array(z.object({ date: z.string(), author: z.string(), transport: z.string(), title: z.string() })),
    usages: z.object({ total: z.number().int(), shown: z.array(z.object({ name: z.string(), type: z.string(), package: z.string() })) }).nullable(),
    drift: z.array(z.object({ target: z.string(), status: z.string(), detail: z.string() })).nullable(),
    atc: z.object({ at: z.string(), variant: z.string(), p1: z.number().int(), p2: z.number().int(), p3: z.number().int(), findings: z.number().int() }).nullable(),
    depth: z.number().int(),
    skipped: z.array(z.string()).describe("Secciones que no se pudieron leer, con el motivo"),
  },
  async run({ object_name, object_type, depth, max_usages }, ctx) {
    const { sap, system } = ctx;
    const c = await sap.adt();
    const obj = await resolveObject(c, object_name, object_type);
    const skipped: string[] = [];
    const attempt = async <T>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
      ctx.signal?.throwIfAborted();
      try {
        return await fn();
      } catch (e) {
        skipped.push(`${label}: ${normalizeError(e).message}`);
        return undefined;
      }
    };

    // Identidad y bloqueo (depth 0)
    const key = await tadirKey(sap, obj);
    const t = await tadirInfo(sap, key, obj.packageName ?? "");
    const local = t.devclass.startsWith("$");
    const locks = local ? [] : (await attempt("bloqueos CTS", () => ctsLocks(sap, key))) ?? [];

    let devSource: string | undefined;
    const source = await attempt("fuente", async () => {
      devSource = await c.getObjectSource(await sourceUrl(c, obj));
      let includes: string[] = [];
      if (obj.type.startsWith("CLAS")) {
        const st = (await c.objectStructure(obj.uri)) as AbapClassStructure;
        includes = [...ADTClient.classIncludes(st).keys()];
      }
      return { lines: devSource.replace(/\r\n/g, "\n").split("\n").length, includes };
    });

    // Resumen local de la fuente (depth 1): sustituye a leer la fuente entera para entender el objeto.
    let summary: {
      text: string; classes: Array<{ name: string; methods: number; public: number }>; forms: number; statements: number; max_nesting: number;
      tables: string[]; functions: string[]; classes_used: string[]; includes: string[]; unused_methods: number;
    } | null = null;
    if (depth >= 1 && devSource !== undefined) {
      summary =
        (await attempt("resumen", async () => {
          const p = parseAbap(obj.name, obj.type, devSource!);
          return {
            text: summarize(p),
            classes: p.symbols.classes.map((c) => ({ name: c.name, methods: c.methods.length, public: c.methods.filter((m) => m.visibility === "public").length })),
            forms: p.symbols.forms.length,
            statements: p.metrics.statements,
            max_nesting: p.metrics.maxNesting,
            tables: p.references.tables,
            functions: p.references.functions,
            classes_used: p.references.classes,
            includes: p.references.includes,
            unused_methods: p.unusedMethods.length,
          };
        })) ?? null;
    }

    // Versiones y usos (depth 1)
    let versions: Array<{ date: string; author: string; transport: string; title: string }> = [];
    let usages: { total: number; shown: Array<{ name: string; type: string; package: string }> } | null = null;
    if (depth >= 1) {
      versions =
        (await attempt("versiones", async () =>
          (await c.revisions(obj.uri)).slice(0, MAX_VERSIONS).map((r) => ({ date: r.date ?? "", author: r.author ?? "", transport: r.version ?? "", title: r.versionTitle ?? "" })),
        )) ?? [];
      ctx.progress?.(`Buscando usos de ${obj.name}…`);
      usages =
        (await attempt("usos", async () => {
          const refs = (await c.usageReferences(obj.uri)).filter((r) => r.isResult);
          return { total: refs.length, shown: refs.slice(0, max_usages).map((r) => ({ name: r["adtcore:name"] ?? "", type: r["adtcore:type"] ?? "", package: r.packageRef?.["adtcore:name"] ?? "" })) };
        })) ?? null;
    }

    // Deriva y ATC (depth 2)
    let drift: Array<{ target: string; status: string; detail: string }> | null = null;
    let atc: { at: string; variant: string; p1: number; p2: number; p3: number; findings: number } | null = null;
    if (depth >= 2) {
      const targets = system.targets.map((s) => s.toUpperCase());
      if (!targets.length) skipped.push("deriva: el sistema no declara targets en la configuración");
      else if (!system.modules.includes(RISK_MODULE)) skipped.push(`deriva: el sistema no tiene el módulo ${RISK_MODULE}; usa object_versions o remote_source`);
      else if (devSource === undefined) skipped.push("deriva: sin fuente de DEV no se puede comparar");
      else {
        ctx.progress?.(`Comparando con ${targets.join(", ")}…`);
        drift = (await attempt("deriva", async () => (await versionDrift(sap, system, obj, devSource!, targets)).map((d) => ({ target: d.target, status: d.status, detail: d.detail })))) ?? null;
      }
      const run = recallRun(system.id, objectScope(obj.name));
      if (run) atc = { at: run.at, variant: run.variant, p1: run.stats?.p1 ?? 0, p2: run.stats?.p2 ?? 0, p3: run.stats?.p3 ?? 0, findings: run.findings.length };
      else skipped.push("ATC: sin ejecución reciente recordada para este objeto (run_atc)");
    }

    const structured = {
      name: obj.name,
      type: obj.type,
      package: t.devclass,
      description: obj.description ?? "",
      responsible: t.author,
      original_system: t.srcsystem,
      local,
      locks,
      source,
      summary,
      versions,
      usages,
      drift,
      atc,
      depth,
      skipped,
    };

    const out: string[] = [
      `${obj.name} (${obj.type})${obj.description ? ` · ${obj.description}` : ""}`,
      t.found ? `Paquete ${t.devclass} · sistema original ${t.srcsystem} · responsable ${t.author}` : `Paquete ${t.devclass || "?"} · sin entrada R3TR ${key.object} ${key.name} en TADIR`,
    ];
    if (local) out.push("Objeto local ($): ningún cambio se registra en una orden ni viaja.");
    else if (locks.length) out.push(`BLOQUEADO en ${locks.map((l) => l.order).join(", ")}: cualquier cambio irá ahí.`, ...locks.map((l) => `  ${l.description}`));
    else out.push("Sin bloqueo del CTS: se puede elegir la orden (edit_preflight con transport para comprobarla).");
    if (source) out.push(`Fuente: ${source.lines} líneas${source.includes.length ? ` · includes: ${source.includes.join(", ")}` : ""}`);
    if (summary) out.push(`Resumen: ${summary.text}`);
    if (depth >= 1) {
      out.push("", versions.length ? `Versiones (últimas ${versions.length}):` : "Versiones: SAP no devuelve ninguna.");
      for (const v of versions) out.push(`  ${v.date}  ${v.author}  ${v.transport}  ${v.title}`);
      if (usages) {
        out.push("", usages.total ? `Usos: ${usages.total}${usages.total > usages.shown.length ? ` (se muestran ${usages.shown.length})` : ""}` : "Usos: el where-used no encontró usos estáticos.");
        for (const u of usages.shown) out.push(`  ${u.name}  ${u.type}  ${u.package}`);
      }
    }
    if (depth >= 2) {
      if (drift) out.push("", "Deriva frente a destinos:", ...drift.map((d) => `  ${d.target}: ${d.detail}`));
      if (atc) out.push("", `ATC recordado (${runAge({ at: atc.at } as any)}, variante ${atc.variant}): P1 ${atc.p1} · P2 ${atc.p2} · P3 ${atc.p3} · ${atc.findings} hallazgos listados`);
    }
    if (skipped.length) out.push("", "No se pudo leer:", ...skipped.map((s) => `  • ${s}`));
    return { text: out.join("\n"), structured };
  },
});
