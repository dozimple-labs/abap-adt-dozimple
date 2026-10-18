import * as abaplint from "@abaplint/core";
import { ToolError } from "./errors.js";

/**
 * Análisis local de una fuente ABAP con abaplint: símbolos, referencias y métricas sin ejecutar nada en SAP. Es la
 * base de code_structure, package_dependencies, unused_methods y del resumen de object_context. abaplint entiende
 * la sintaxis de cualquier release; lo que no reconoce cuenta como «issues» y no detiene el análisis.
 */
export type Visibility = "public" | "protected" | "private";

export interface MethodInfo {
  name: string;
  visibility: Visibility;
  static: boolean;
  abstract: boolean;
  redefinition: boolean;
}
export interface ClassInfo {
  name: string;
  local: boolean;
  superClass?: string;
  interfaces: string[];
  methods: MethodInfo[];
  attributes: Array<{ name: string; visibility: Visibility; static: boolean }>;
}
export interface Symbols {
  classes: ClassInfo[];
  interfaces: Array<{ name: string; methods: string[] }>;
  forms: string[];
}
export interface References {
  tables: string[];
  functions: string[];
  classes: string[];
  includes: string[];
  forms: string[];
}
export interface Metrics {
  lines: number;
  statements: number;
  comments: number;
  maxNesting: number;
}
export interface UnusedMethod {
  class: string;
  method: string;
  visibility: Visibility;
}
export interface ParsedAbap {
  symbols: Symbols;
  references: References;
  metrics: Metrics;
  unusedMethods: UnusedMethod[];
  /** Sentencias que abaplint no reconoció (sintaxis muy nueva, macros…): el resto del análisis sigue valiendo. */
  unknownStatements: number;
}

const VIS: Record<number, Visibility> = { 1: "private", 2: "protected", 3: "public" };
const vis = (v: unknown): Visibility => VIS[Number(v)] ?? "public";

function fileName(name: string, type: string): string {
  const n = name.toLowerCase().replace(/\//g, "#");
  if (type.toUpperCase().startsWith("CLAS")) return `${n}.clas.abap`;
  if (type.toUpperCase().startsWith("INTF")) return `${n}.intf.abap`;
  return `${n}.prog.abap`;
}

const OPEN = new Set(["If", "Loop", "Do", "While", "Case", "CaseType", "Try", "Form", "MethodImplementation", "FunctionModule", "Module", "At", "Provide", "SelectLoop", "LoopAtScreen"]);
const CLOSE = new Set(["EndIf", "EndLoop", "EndDo", "EndWhile", "EndCase", "EndTry", "EndForm", "EndMethod", "EndFunction", "EndModule", "EndAt", "EndProvide", "EndSelect"]);
const NOT_METHOD_USE = new Set(["MethodDef", "MethodImplementation", "ClassDefinition", "ClassImplementation", "InterfaceDef"]);
const SPECIAL_METHODS = new Set(["CONSTRUCTOR", "CLASS_CONSTRUCTOR"]);

export function parseAbap(name: string, type: string, source: string): ParsedAbap {
  const reg = new abaplint.Registry();
  reg.addFile(new abaplint.MemoryFile(fileName(name, type), source));
  reg.parse();
  const obj = reg.getFirstObject() as abaplint.ABAPObject | undefined;
  const file = obj && "getABAPFiles" in obj ? obj.getABAPFiles()[0] : undefined;
  if (!file) throw new ToolError("INTERNAL", "abaplint no pudo leer la fuente como un objeto ABAP.");
  const info = file.getInfo();

  const classes: ClassInfo[] = info.listClassDefinitions().map((c) => ({
    name: c.name.toUpperCase(),
    local: !!c.isLocal,
    superClass: c.superClassName?.toUpperCase() || undefined,
    interfaces: c.interfaces.map((i) => i.name.toUpperCase()),
    methods: c.methods.map((m) => ({ name: m.name.toUpperCase(), visibility: vis(m.visibility), static: false, abstract: !!m.isAbstract, redefinition: !!m.isRedefinition })),
    attributes: c.attributes.map((a) => ({ name: a.name.toUpperCase(), visibility: vis(a.visibility), static: String((a as { level?: unknown }).level ?? "").toLowerCase() === "static" })),
  }));
  const interfaces = info.listInterfaceDefinitions().map((i) => ({ name: i.name.toUpperCase(), methods: i.methods.map((m) => m.name.toUpperCase()) }));
  const forms = info.listFormDefinitions().map((f) => f.name.toUpperCase());

  const own = new Set(classes.map((c) => c.name));
  const tables = new Set<string>();
  const functions = new Set<string>();
  const usedClasses = new Set<string>();
  const includes = new Set<string>();
  const performs = new Set<string>();
  const methodUse = new Map<string, number>();
  let statements = 0;
  let comments = 0;
  let unknown = 0;
  let depth = 0;
  let maxNesting = 0;
  const E = abaplint.Expressions;
  const all = (s: abaplint.Nodes.StatementNode, t: Parameters<abaplint.Nodes.StatementNode["findAllExpressionsRecursive"]>[0]) => s.findAllExpressionsRecursive(t).map((e) => e.concatTokens().trim());
  // abaplint no marca los métodos estáticos en la información de clase: se leen de la sentencia CLASS-METHODS.
  const staticMethods = new Set<string>();

  for (const s of file.getStatements()) {
    const kind = s.get().constructor.name;
    if (kind === "Comment") {
      comments++;
      continue;
    }
    if (kind === "Empty") continue;
    statements++;
    if (kind === "MethodDef" && /^CLASS-METHODS\b/i.test(s.concatTokens())) for (const m of all(s, E.MethodName)) staticMethods.add(m.toUpperCase());
    if (kind === "Unknown") unknown++;
    if (OPEN.has(kind)) maxNesting = Math.max(maxNesting, ++depth);
    if (CLOSE.has(kind) && depth > 0) depth--;
    const stmt = s.concatTokens();
    // «SELECT … FROM @lt_itab» (7.52+): la fuente es una tabla interna, no una tabla de base de datos.
    for (const t of all(s, E.DatabaseTable)) if (/^[A-Za-z/]/.test(t) && !new RegExp(`@${t.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\b`, "i").test(stmt)) tables.add(t.toUpperCase());
    for (const f of all(s, E.FunctionName)) if (/^'.*'$/.test(f)) functions.add(f.slice(1, -1).toUpperCase());
    for (const c of all(s, E.ClassName)) if (!own.has(c.toUpperCase())) usedClasses.add(c.toUpperCase());
    // «TYPE REF TO zcl_x» es una referencia a clase aunque abaplint la tipe como nombre de tipo.
    for (const m of s.concatTokens().matchAll(/\bREF\s+TO\s+((?:\/[A-Z0-9_]+\/)?[A-Z][A-Z0-9_]*)/gi)) if (!own.has(m[1].toUpperCase()) && !/^(DATA|OBJECT)$/i.test(m[1])) usedClasses.add(m[1].toUpperCase());
    for (const i of all(s, E.IncludeName)) includes.add(i.toUpperCase());
    if (kind === "Perform") for (const f of all(s, E.FormName)) performs.add(f.toUpperCase());
    if (!NOT_METHOD_USE.has(kind)) for (const m of all(s, E.MethodName)) methodUse.set(m.toUpperCase(), (methodUse.get(m.toUpperCase()) ?? 0) + 1);
  }

  for (const c of classes) for (const m of c.methods) if (staticMethods.has(m.name)) m.static = true;

  const unusedMethods: UnusedMethod[] = [];
  for (const c of classes) {
    for (const m of c.methods) {
      if (m.visibility === "public" || m.abstract || m.redefinition || SPECIAL_METHODS.has(m.name) || m.name.includes("~")) continue;
      if (!methodUse.get(m.name)) unusedMethods.push({ class: c.name, method: m.name, visibility: m.visibility });
    }
  }

  return {
    symbols: { classes, interfaces, forms },
    references: { tables: [...tables].sort(), functions: [...functions].sort(), classes: [...usedClasses].sort(), includes: [...includes].sort(), forms: [...performs].sort() },
    metrics: { lines: source.split(/\r?\n/).length, statements, comments, maxNesting },
    unusedMethods,
    unknownStatements: unknown,
  };
}

/** Resumen corto para object_context: qué hay y qué toca, sin la fuente. */
export function summarize(p: ParsedAbap): string {
  const parts: string[] = [];
  for (const c of p.symbols.classes) {
    const pub = c.methods.filter((m) => m.visibility === "public").length;
    parts.push(`${c.local ? "clase local " : "clase "}${c.name}: ${c.methods.length} métodos (${pub} públicos)${c.interfaces.length ? `, implementa ${c.interfaces.join(", ")}` : ""}${c.superClass ? `, hereda de ${c.superClass}` : ""}`);
  }
  if (p.symbols.forms.length) parts.push(`${p.symbols.forms.length} forms`);
  parts.push(`${p.metrics.statements} sentencias, anidamiento máximo ${p.metrics.maxNesting}`);
  const r = p.references;
  if (r.tables.length) parts.push(`lee ${r.tables.slice(0, 12).join(", ")}${r.tables.length > 12 ? "…" : ""}`);
  if (r.functions.length) parts.push(`llama ${r.functions.slice(0, 8).join(", ")}${r.functions.length > 8 ? "…" : ""}`);
  if (r.classes.length) parts.push(`usa ${r.classes.slice(0, 8).join(", ")}${r.classes.length > 8 ? "…" : ""}`);
  if (r.includes.length) parts.push(`includes ${r.includes.slice(0, 8).join(", ")}${r.includes.length > 8 ? "…" : ""}`);
  if (p.unusedMethods.length) parts.push(`${p.unusedMethods.length} métodos privados/protegidos sin uso en la clase`);
  return parts.join(" · ");
}
