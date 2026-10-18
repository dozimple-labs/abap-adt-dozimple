import { z } from "zod";
import { parseAbap, type ParsedAbap } from "../../core/abapparse.js";
import { pool } from "../../core/concurrency.js";
import { normalizeError, ToolError } from "../../core/errors.js";
import { CLASS_INCLUDES, resolveByTypePrefix, resolveObject, sourceUrl, TYPE_HELP } from "../../core/objects.js";
import { tsv } from "../../core/output.js";
import { defineTool, type ToolContext } from "../../core/tool.js";
import { scopeRefs, sourcesOf } from "./source_search.js";

/**
 * Análisis de código en local con abaplint (Ola 2, punto 9): estructura de un objeto, dependencias de un paquete y
 * métodos sin uso. Solo lee fuentes; nunca ejecuta nada en SAP ni envía código fuera del equipo.
 */
const METHOD = z.object({ name: z.string(), visibility: z.string(), static: z.boolean(), abstract: z.boolean(), redefinition: z.boolean() });
const CLASS = z.object({ name: z.string(), local: z.boolean(), superClass: z.string().optional(), interfaces: z.array(z.string()), methods: z.array(METHOD), attributes: z.array(z.object({ name: z.string(), visibility: z.string(), static: z.boolean() })) });
const REFS = z.object({ tables: z.array(z.string()), functions: z.array(z.string()), classes: z.array(z.string()), includes: z.array(z.string()), forms: z.array(z.string()) });
const METRICS = z.object({ lines: z.number().int(), statements: z.number().int(), comments: z.number().int(), maxNesting: z.number().int() });
const UNUSED = z.object({ class: z.string(), method: z.string(), visibility: z.string() });

function renderStructure(name: string, p: ParsedAbap): string {
  const out: string[] = [`${name}: ${p.metrics.lines} líneas · ${p.metrics.statements} sentencias · ${p.metrics.comments} comentarios · anidamiento máximo ${p.metrics.maxNesting}${p.unknownStatements ? ` · ${p.unknownStatements} sentencias no reconocidas` : ""}`];
  for (const c of p.symbols.classes) {
    out.push("", `${c.local ? "Clase local" : "Clase"} ${c.name}${c.superClass ? ` (hereda de ${c.superClass})` : ""}${c.interfaces.length ? ` · implementa ${c.interfaces.join(", ")}` : ""}`);
    for (const v of ["public", "protected", "private"] as const) {
      const ms = c.methods.filter((m) => m.visibility === v);
      if (ms.length) out.push(`  ${v}: ${ms.map((m) => `${m.name}${m.static ? " (static)" : ""}${m.abstract ? " (abstract)" : ""}${m.redefinition ? " (redef)" : ""}`).join(", ")}`);
    }
    if (c.attributes.length) out.push(`  atributos: ${c.attributes.map((a) => `${a.name} [${a.visibility[0]}${a.static ? ",s" : ""}]`).join(", ")}`);
  }
  for (const i of p.symbols.interfaces) out.push("", `Interfaz ${i.name}: ${i.methods.join(", ") || "sin métodos"}`);
  if (p.symbols.forms.length) out.push("", `Forms: ${p.symbols.forms.join(", ")}`);
  const r = p.references;
  out.push("", "Referencias:");
  out.push(`  tablas: ${r.tables.join(", ") || "ninguna"}`, `  funciones: ${r.functions.join(", ") || "ninguna"}`, `  clases: ${r.classes.join(", ") || "ninguna"}`, `  includes: ${r.includes.join(", ") || "ninguno"}`, `  forms llamados: ${r.forms.join(", ") || "ninguno"}`);
  if (p.unusedMethods.length) out.push("", "Métodos sin uso dentro de la clase (privados o protegidos):", ...p.unusedMethods.map((u) => `  ${u.class}=>${u.method} (${u.visibility}${u.visibility === "protected" ? ", puede usarlo una subclase" : ""})`));
  return out.join("\n");
}

const codeStructure = defineTool({
  name: "code_structure",
  title: "Estructura y referencias de un objeto (análisis local)",
  description:
    "Analiza en local, con abaplint, la fuente de un objeto o un fragmento (source): clases con métodos y visibilidad, " +
    "interfaces, forms, tablas que lee, funciones, clases e includes que usa, métricas y métodos privados sin uso. " +
    "No ejecuta nada en SAP. Úsala para entender un objeto sin leer toda la fuente.",
  access: "read",
  input: {
    object_name: z.string().optional(),
    object_type: z.string().optional().describe(TYPE_HELP),
    include: z.enum(CLASS_INCLUDES).default("main"),
    source: z.string().max(2_000_000).optional().describe("Fuente a analizar en vez de leerla de SAP"),
  },
  output: {
    name: z.string(),
    symbols: z.object({ classes: z.array(CLASS), interfaces: z.array(z.object({ name: z.string(), methods: z.array(z.string()) })), forms: z.array(z.string()) }),
    references: REFS,
    metrics: METRICS,
    unused_methods: z.array(UNUSED),
    unknown_statements: z.number().int(),
  },
  async run({ object_name, object_type, include, source }, { sap }) {
    let name = object_name?.trim().toUpperCase() ?? "FRAGMENTO";
    let type = object_type ?? "PROG";
    let text = source;
    if (!text) {
      if (!object_name) throw new ToolError("INPUT", "Indica object_name o source.");
      const c = await sap.adt();
      const obj = await resolveObject(c, object_name, object_type);
      name = obj.name;
      type = obj.type;
      text = await c.getObjectSource(await sourceUrl(c, obj, include));
    }
    const p = parseAbap(name, type, text);
    return { text: renderStructure(name, p), structured: { name, symbols: p.symbols, references: p.references, metrics: p.metrics, unused_methods: p.unusedMethods, unknown_statements: p.unknownStatements } };
  },
});

/** Lee y analiza las fuentes principales de un alcance (paquete u objetos), con tope y lista de omitidos. */
async function analyzeScope(ctx: ToolContext, a: { package?: string; include_subpackages: boolean; objects?: string[]; max_objects: number }, onlyClasses: boolean) {
  const scopes = [a.package, a.objects?.length ? "x" : undefined].filter(Boolean).length;
  if (scopes !== 1) throw new ToolError("INPUT", "Indica exactamente un alcance: package u objects.");
  const { sap } = ctx;
  // Solo clases: el tope se aplica a las clases, no al alcance completo (si no, 60 objetos podían contener 2 clases).
  const scope = await scopeRefs(sap, { package: a.package, include_subpackages: a.include_subpackages, objects: a.objects }, onlyClasses ? 5000 : a.max_objects);
  const classes = onlyClasses ? scope.refs.filter((r) => r.types.some((t) => t.startsWith("CLAS"))) : scope.refs;
  const refs = classes.slice(0, a.max_objects);
  const c = await sap.adt();
  const parsed = new Map<string, { type: string; p: ParsedAbap }>();
  const skipped: Array<{ object: string; reason: string }> = [];
  let done = 0;
  ctx.progress?.(`Leyendo ${refs.length} objetos de ${scope.label}…`, 0, refs.length);
  await pool(refs, 4, async (ref) => {
    ctx.signal?.throwIfAborted();
    try {
      const res = await resolveByTypePrefix(c, ref.name, onlyClasses ? ["CLAS/"] : ref.types);
      if (!res) {
        skipped.push({ object: ref.name, reason: onlyClasses ? "no es una clase" : "no se encontró con un tipo con fuente" });
        return;
      }
      const main = (await sourcesOf(c, res.uri, res.type)).find((s) => s.include === "main");
      if (!main) {
        skipped.push({ object: ref.name, reason: "sin fuente principal" });
        return;
      }
      parsed.set(ref.name.toUpperCase(), { type: res.type, p: parseAbap(ref.name, res.type, main.text) });
    } catch (e) {
      const te = normalizeError(e);
      if (te.kind === "NETWORK" || te.kind === "AUTH" || te.kind === "CANCELLED") throw te;
      skipped.push({ object: ref.name, reason: `${te.kind}: ${te.message.slice(0, 120)}` });
    } finally {
      ctx.progress?.(`${++done} de ${refs.length} objetos analizados`, done, refs.length);
    }
  });
  return { parsed, skipped, label: scope.label, total: onlyClasses ? classes.length : scope.total, truncated: onlyClasses ? classes.length > refs.length : scope.total > scope.refs.length };
}

const EDGE = z.object({ from: z.string(), to: z.string(), kind: z.enum(["table", "function", "class", "include", "form"]), internal: z.boolean() });

const packageDependencies = defineTool({
  name: "package_dependencies",
  title: "Dependencias de un paquete (análisis local)",
  timeoutMs: 180_000,
  description:
    "Grafo de dependencias de un paquete (con subpaquetes) o de una lista de objetos, analizando sus fuentes en " +
    "local: qué tablas lee cada objeto, qué funciones y clases llama, qué includes usa; marca lo interno al alcance " +
    "y lo externo, y ordena los destinos más usados. Tope de objetos; los no leídos se listan.",
  access: "read",
  input: {
    package: z.string().optional(),
    include_subpackages: z.boolean().default(true),
    objects: z.array(z.string().min(1)).max(200).optional(),
    max_objects: z.number().int().min(1).max(500).default(150),
    top: z.number().int().min(1).max(200).default(30).describe("Destinos más usados que se muestran"),
  },
  output: {
    scope: z.string(),
    scanned: z.number().int(),
    truncated: z.boolean(),
    edges: z.array(EDGE),
    most_used: z.array(z.object({ name: z.string(), kind: z.string(), count: z.number().int(), internal: z.boolean() })),
    skipped: z.array(z.object({ object: z.string(), reason: z.string() })),
  },
  async run(a, ctx) {
    const { parsed, skipped, label, truncated } = await analyzeScope(ctx, a, false);
    const internal = new Set(parsed.keys());
    const edges: Array<z.infer<typeof EDGE>> = [];
    for (const [from, { p }] of parsed) {
      const add = (kind: z.infer<typeof EDGE>["kind"], tos: string[]) => tos.forEach((to) => edges.push({ from, to, kind, internal: internal.has(to) }));
      add("table", p.references.tables);
      add("function", p.references.functions);
      add("class", p.references.classes);
      add("include", p.references.includes);
      add("form", p.references.forms.map((f) => `${from}:${f}`));
    }
    const counts = new Map<string, { kind: string; count: number; internal: boolean }>();
    for (const e of edges) {
      if (e.kind === "form") continue;
      const k = `${e.kind}:${e.to}`;
      const cur = counts.get(k) ?? { kind: e.kind, count: 0, internal: e.internal };
      cur.count++;
      counts.set(k, cur);
    }
    const most_used = [...counts].map(([k, v]) => ({ name: k.slice(k.indexOf(":") + 1), ...v })).sort((x, y) => y.count - x.count || x.name.localeCompare(y.name)).slice(0, a.top);
    const structured = { scope: label, scanned: parsed.size, truncated, edges, most_used, skipped };
    const lines = [...parsed].slice(0, 80).map(([from, { p }]) => {
      const r = p.references;
      return `${from}: ${[r.tables.length ? `tablas ${r.tables.slice(0, 6).join(", ")}${r.tables.length > 6 ? "…" : ""}` : "", r.functions.length ? `funciones ${r.functions.slice(0, 4).join(", ")}${r.functions.length > 4 ? "…" : ""}` : "", r.classes.length ? `clases ${r.classes.slice(0, 4).join(", ")}${r.classes.length > 4 ? "…" : ""}` : "", r.includes.length ? `includes ${r.includes.length}` : ""].filter(Boolean).join(" · ") || "sin referencias"}`;
    });
    const head = `${label}: ${parsed.size} objetos analizados${truncated ? " — TOPE ALCANZADO: hay más objetos (sube max_objects o acota)" : ""} · ${edges.length} dependencias`;
    const top = most_used.length ? `\n\nDestinos más usados:\n${tsv(["destino", "tipo", "usos", "interno"], most_used.map((m) => [m.name, m.kind, m.count, m.internal ? "sí" : "no"]))}` : "";
    const skip = skipped.length ? `\n\nNo se pudieron analizar (${skipped.length}):\n${skipped.map((s) => `  ${s.object}: ${s.reason}`).join("\n")}` : "";
    return { text: `${head}${top}\n\nPor objeto${parsed.size > 80 ? " (primeros 80)" : ""}:\n${lines.join("\n")}${skip}`, structured };
  },
});

const unusedMethods = defineTool({
  name: "unused_methods",
  title: "Métodos sin uso (análisis local)",
  timeoutMs: 180_000,
  description:
    "Métodos privados o protegidos que ninguna sentencia de su propia clase llama, en las clases de un paquete (con " +
    "subpaquetes) o de una lista; análisis local de la fuente con abaplint. Los protegidos pueden usarlos las " +
    "subclases: se marcan aparte. No cuenta usos dinámicos. Tope de objetos; los no leídos se listan.",
  access: "read",
  input: {
    package: z.string().optional(),
    include_subpackages: z.boolean().default(true),
    objects: z.array(z.string().min(1)).max(200).optional(),
    max_objects: z.number().int().min(1).max(500).default(150),
  },
  output: {
    scope: z.string(),
    classes_scanned: z.number().int(),
    truncated: z.boolean(),
    findings: z.array(UNUSED),
    skipped: z.array(z.object({ object: z.string(), reason: z.string() })),
  },
  async run(a, ctx) {
    const { parsed, skipped, label, truncated } = await analyzeScope(ctx, a, true);
    const findings = [...parsed.values()].flatMap(({ p }) => p.unusedMethods).sort((x, y) => x.class.localeCompare(y.class) || x.method.localeCompare(y.method));
    const structured = { scope: label, classes_scanned: parsed.size, truncated, findings, skipped };
    const head = `${label}: ${parsed.size} clases analizadas${truncated ? " — TOPE ALCANZADO: hay más objetos" : ""} · ${findings.length} métodos sin uso en su clase`;
    const body = findings.length ? "\n\n" + tsv(["clase", "método", "visibilidad"], findings.map((f) => [f.class, f.method, f.visibility === "protected" ? "protected (puede usarlo una subclase)" : f.visibility])) : "\n\nNingún método privado o protegido sin uso.";
    const skip = skipped.length ? `\n\nNo se pudieron analizar (${skipped.length}):\n${skipped.map((s) => `  ${s.object}: ${s.reason}`).join("\n")}` : "";
    return { text: `${head}${body}${skip}\n\n(Análisis estático local: no ve llamadas dinámicas ni usos desde otras clases.)`, structured };
  },
});

export default [codeStructure, packageDependencies, unusedMethods];
