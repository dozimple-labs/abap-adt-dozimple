/**
 * Genera docs/TOOLS.md desde el código: descripción, acceso, requisitos y
 * parámetros salen de cada ToolDef; grupo y créditos, del catálogo. Así la
 * referencia no se desincroniza nunca.   npm run docs
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ZodTypeAny } from "zod";
import { CORE_CREDITS, CREDITS, GROUPS } from "../core/catalog.js";
import { GROUPS_EN, KIND_EN, PROMPTS_EN, TOOLS_EN, toEn } from "../core/catalog.en.js";
import { PROMPT_META } from "../core/prompts.js";
import { loadTools } from "../core/registry.js";
import type { ToolDef } from "../core/tool.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

/** Texto seguro dentro de una celda de tabla Markdown: primero las barras invertidas, luego «|» y saltos. */
const mdCell = (s: string) => s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ");

const ACCESS: Record<string, string> = {
  read: "Solo lectura",
  exec: "Ejecuta código (solo sistemas DEV)",
  write: "Escribe (solo DEV con `allowWrite`; nunca QAS/PRD)",
  local: "Local (no conecta a SAP)",
};

/** Tipo, valor por defecto y descripción de un parámetro zod. */
/** Tipo, valor por defecto y descripción de un parámetro zod (zod 4: la definición vive en `_zod.def`). */
function describeParam(t: ZodTypeAny): { type: string; def?: string; desc: string; optional: boolean } {
  let cur: any = t;
  let optional = false;
  let def: string | undefined;
  let desc = cur.description ?? "";
  const kind = (s: any): string => s?._zod?.def?.type ?? "?";
  for (let i = 0; i < 6; i++) {
    const tn = kind(cur);
    if (tn === "optional" || tn === "nullable") optional = true;
    else if (tn === "default") {
      optional = true;
      const dv = cur._zod.def.defaultValue;
      def = JSON.stringify(typeof dv === "function" ? dv() : dv);
    } else if (tn !== "pipe" && tn !== "transform") break;
    cur = cur._zod.def.innerType ?? cur._zod.def.in ?? cur._zod.def.schema;
    desc ||= cur?.description ?? "";
  }
  const tn = kind(cur);
  let type = tn;
  if (tn === "enum") type = Object.values(cur._zod.def.entries as Record<string, string>).map((v) => `\`${v}\``).join(" \\| ");
  if (tn === "array") {
    const el = cur._zod.def.element;
    type = kind(el) === "object" ? `lista de { ${Object.keys(el.shape).join(", ")} }` : `lista de ${describeParam(el).type}`;
  }
  return { type, def, desc: mdCell(desc), optional };
}

function toolSection(d: ToolDef<any>, credits: Array<keyof typeof CREDITS>): string {
  const out: string[] = [`### \`${d.name}\` — ${d.title}`, "", d.description.replace(/\n+/g, " "), ""];
  const req: string[] = [];
  if (d.requires?.adt?.length) req.push(`endpoint ADT ${d.requires.adt.map((a) => `\`${a}\``).join(", ")}`);
  if (d.requires?.module) req.push(`módulo \`${d.requires.module}\` habilitado en el sistema`);
  if (d.requires?.sidecar) req.push(`componente \`${d.requires.sidecar}\` configurado`);
  if (d.requires?.online) req.push("búsqueda online habilitada (consulta filtrada)");
  out.push(`| | |`, `|---|---|`, `| **Acceso** | ${ACCESS[d.access]} |`);
  if (req.length) out.push(`| **Requiere** | ${req.join("; ")} |`);
  const c = credits.length
    ? credits.map((k) => `[${CREDITS[k].what}](${CREDITS[k].url}) — ${CREDITS[k].by} (${CREDITS[k].license}, ${CREDITS[k].kind})`).join("<br>")
    : "Desarrollo propio de DoZimple";
  out.push(`| **Créditos** | ${c} |`, "");

  const params = Object.entries(d.input as Record<string, ZodTypeAny>).map(([k, t]) => ({ k, ...describeParam(t) }));
  if (d.access !== "local") params.unshift({ k: "system", type: "string", def: undefined, desc: "Sistema SAP configurado. Obligatorio si hay varios y ninguno por defecto.", optional: true });
  if (d.access === "write") params.push({ k: "confirm_token", type: "string", def: undefined, desc: "Token de la vista previa. Sin él la tool no escribe: devuelve qué va a cambiar y el token, que se usa tras la conformidad del usuario (un solo uso, 10 min).", optional: true });
  if (params.length) {
    out.push("| Parámetro | Tipo | Por defecto | Descripción |", "|---|---|---|---|");
    for (const p of params) out.push(`| \`${p.k}\`${p.optional ? "" : " *"} | ${p.type} | ${p.def ?? ""} | ${p.desc} |`);
    out.push("", "\\* obligatorio", "");
  } else out.push("Sin parámetros.", "");
  if (d.output) {
    const fields = Object.entries(d.output as Record<string, ZodTypeAny>).map(([k, t]) => ({ k, ...describeParam(t) }));
    out.push("Salida estructurada (`structuredContent`, además del texto):", "", "| Campo | Tipo | Descripción |", "|---|---|---|");
    for (const f of fields) out.push(`| \`${f.k}\` | ${f.type} | ${f.desc} |`);
    out.push("");
  }
  return out.join("\n");
}

const defs = await loadTools(join(here, "..", "tools"));
const byName = new Map(defs.map((d) => [d.name, d]));
const total = defs.length;

const md: string[] = [
  "# Referencia de tools — abap-adt-doZimple",
  "",
  `Generado desde el código con \`npm run docs\`. ${total} tools en ${GROUPS.length} grupos y ${Object.keys(PROMPT_META).length} flujos guiados.`,
  "Producto de [DoZimple](https://dozimple.cl).",
  "",
  "## Índice",
  "",
  ...GROUPS.map((g) => `- [${g.title}](#${g.id}) — ${g.tools.length} tools: ${g.tools.map((t) => `\`${t.name}\``).join(", ")}`),
  "- [Flujos guiados](#flujos-guiados)",
  "- [Créditos del núcleo](#creditos-del-nucleo)",
  "",
];

for (const g of GROUPS) {
  md.push(`<a id="${g.id}"></a>`, `## ${g.title}`, "", `*${g.pitch}*`, "");
  for (const t of g.tools) {
    const d = byName.get(t.name);
    if (!d) throw new Error(`El catálogo cita ${t.name} y no existe`);
    md.push(toolSection(d, t.credits));
  }
}

md.push('<a id="flujos-guiados"></a>', "## Flujos guiados", "", "Prompts MCP: aparecen como comandos en el cliente (en Claude Code, `/mcp__abap-adt-doZimple__<nombre>`).", "");
md.push("| Flujo | Qué hace | Argumentos | Encadena |", "|---|---|---|---|");
for (const [name, p] of Object.entries(PROMPT_META)) md.push(`| \`${name}\` — ${p.title} | ${p.description} | ${p.args.map((a) => `\`${a}\``).join(", ")} | ${p.chain} |`);
md.push("", '<a id="creditos-del-nucleo"></a>', "## Créditos del núcleo", "", "Todas las tools se apoyan en:", "");
for (const k of CORE_CREDITS) md.push(`- [${CREDITS[k].what}](${CREDITS[k].url}) — ${CREDITS[k].by} (${CREDITS[k].license}, ${CREDITS[k].kind})`);
md.push("", "Licencias completas de las dependencias: [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).", "");

mkdirSync(join(root, "docs"), { recursive: true });
writeFileSync(join(root, "docs", "TOOLS.md"), md.join("\n"));
console.error(`docs/TOOLS.md: ${total} tools, ${GROUPS.length} grupos`);

// ── README: bloques generados entre marcadores, en español e inglés ─────────
type Lang = "es" | "en";
const ACCESS_SHORT: Record<Lang, Record<string, string>> = {
  es: { read: "lectura", exec: "ejecuta (DEV)", write: "escribe (DEV autorizado)", local: "local" },
  en: { read: "read", exec: "executes (DEV)", write: "writes (authorized DEV)", local: "local" },
};
/** Primera frase: termina en punto seguido de mayúscula o fin (no corta «p. ej.»). */
const firstSentence = (s: string) => {
  const t = s.replace(/\n+/g, " ").replace(/\b(p\. ej|e\.g|i\.e)\./g, "$1\u0000"); // abreviaturas: no terminan frase
  return (t.match(/^.*?[.!?](?=\s+[A-ZÁÉÍÓÚÑ¿¡«`]|\s*$)/)?.[0] ?? t).replace(/\u0000/g, ".").trim();
};

function readmeBlocks(lang: Lang): Record<string, string> {
  const en = lang === "en";
  const gTitle = (g: (typeof GROUPS)[number]) => (en ? GROUPS_EN[g.id].title : g.title);
  const gPitch = (g: (typeof GROUPS)[number]) => (en ? GROUPS_EN[g.id].pitch : g.pitch);
  const esc = mdCell;

  const groups = [
    en ? "| Group | What for | Tools |" : "| Grupo | Para qué | Tools |",
    "|---|---|---|",
    ...GROUPS.map((g) => `| [${gTitle(g)}](#g-${g.id}) | ${gPitch(g)} | ${g.tools.length} |`),
  ].join("\n");

  const tools = GROUPS.map((g) =>
    [
      `<a id="g-${g.id}"></a>`,
      `### ${gTitle(g)}`,
      "",
      `*${gPitch(g)}*`,
      "",
      en ? "| Tool | What it does | Access |" : "| Tool | Qué hace | Acceso |",
      "|---|---|---|",
      ...g.tools.map((t) => {
        const d = byName.get(t.name)!;
        const summary = en
          ? TOOLS_EN[t.name]
          : `**${/[.?!]$/.test(d.title) ? d.title : d.title + "."}** ${firstSentence(d.description)}`;
        if (!summary) throw new Error(`Falta el resumen en inglés de ${t.name} (src/core/catalog.en.ts)`);
        return `| [\`${t.name}\`](docs/TOOLS.md#${g.id}) | ${esc(summary)} | ${ACCESS_SHORT[lang][d.access]} |`;
      }),
      "",
    ].join("\n"),
  ).join("\n");

  const prompts = [
    en
      ? "They show up as commands in the MCP client (in Claude Code: `/mcp__abap-adt-doZimple__<name>`) and chain the tools"
      : "Aparecen como comandos en el cliente MCP (en Claude Code: `/mcp__abap-adt-doZimple__<nombre>`) y encadenan las tools",
    en ? "with the working rules of a senior consultant." : "con las reglas de trabajo de un consultor senior.",
    "",
    en ? "| Flow | What it does | Chain |" : "| Flujo | Qué hace | Encadena |",
    "|---|---|---|",
    ...Object.entries(PROMPT_META).map(([n, p]) => {
      const t = en ? PROMPTS_EN[n] : p;
      return `| \`${n}\` — ${t.title} | ${t.description} | ${t.chain} |`;
    }),
  ].join("\n");

  const core = en ? "all (core)" : "todas (núcleo)";
  const usedBy = new Map<string, string[]>();
  for (const g of GROUPS) for (const t of g.tools) for (const c of t.credits) usedBy.set(c, [...(usedBy.get(c) ?? []), t.name]);
  for (const c of CORE_CREDITS) usedBy.set(c, [core, ...(usedBy.get(c) ?? [])]);
  const KIND_ORDER = ["dependencia", "datos", "idea", "algoritmo"] as const;
  const credits = [
    en ? "| Project | Author / holder | License | Type | Used in |" : "| Proyecto | Autor / titular | Licencia | Tipo | Usado en |",
    "|---|---|---|---|---|",
    ...Object.entries(CREDITS)
      .sort((a, b) => KIND_ORDER.indexOf(a[1].kind) - KIND_ORDER.indexOf(b[1].kind))
      .map(([k, c]) => {
        const list = (usedBy.get(k) ?? []).map((t) => (t === core ? t : `\`${t}\``));
        const more = en ? "more" : "más";
        const and = en ? "and" : "y";
        const shown = list.length > 6 ? `${list.slice(0, 6).join(", ")} ${and} ${list.length - 6} ${more}` : list.join(", ");
        const tr = en ? toEn : (x: string) => x;
        return `| [${c.what}](${c.url}) | ${tr(c.by)} | ${tr(c.license)} | ${en ? KIND_EN[c.kind] : c.kind} | ${shown} |`;
      }),
  ].join("\n");

  return { groups, tools, prompts, credits };
}

for (const [file, lang] of [["README.md", "en"], ["README.es.md", "es"]] as const) {
  const path = join(root, file);
  let readme = readFileSync(path, "utf8");
  for (const [name, content] of Object.entries(readmeBlocks(lang))) {
    const re = new RegExp(`(<!-- ${name}:start -->)[\\s\\S]*?(<!-- ${name}:end -->)`);
    if (!re.test(readme)) throw new Error(`${file} sin marcadores ${name}`);
    readme = readme.replace(re, `$1\n${content}\n$2`);
  }
  writeFileSync(path, readme);
  console.error(`${file}: bloques generados actualizados`);
}
