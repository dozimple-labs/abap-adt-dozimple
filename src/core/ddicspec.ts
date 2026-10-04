import { z } from "zod";
import { ToolError } from "./errors.js";

/**
 * Especificación de objetos de diccionario y de funciones, y su traducción a las instrucciones del generador de DDIC
 * (programa ZDZ_DDIC_GEN, que ejecuta una persona en SE38). En NW 7.50 ADT no crea ni modifica tablas, dominios ni
 * elementos de datos; el generador usa las APIs estándar del diccionario. Aquí solo se valida y se escribe el texto:
 * nada de esto toca SAP.
 */
const NAME = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .transform((s) => s.trim().toUpperCase())
    .refine((s) => /^[A-Z][A-Z0-9_]*$/.test(s), "solo letras, dígitos y «_»");
const TEXT = (max: number) => z.string().min(1).max(max).refine((s) => !/[\t\n\r]/.test(s), "sin tabuladores ni saltos de línea");
const VALUE = z.object({
  value: z.string().min(1).max(10).refine((s) => !/[|=\t\n\r]/.test(s), "sin «|», «=» ni tabuladores"),
  text: z.string().min(1).max(60).refine((s) => !/[|=\t\n\r]/.test(s), "sin «|», «=» ni tabuladores"),
});
const PARAM = z.object({ name: NAME(30), type: NAME(30), optional: z.boolean().default(false) });

export const DDIC_SPEC = {
  package: NAME(30).describe("Paquete de los objetos nuevos"),
  task: z.string().regex(/^[A-Z0-9]{3}K\d{6}$/i, "número de tarea, p. ej. DEVK900124").transform((s) => s.toUpperCase()).describe("TAREA (no la orden) donde se registra todo. Debe ser de quien ejecutará el generador"),
  description: TEXT(60).optional().describe("Título del cambio"),
  domains: z.array(z.object({ name: NAME(30), type: NAME(4).describe("CHAR, NUMC, DATS, DEC…"), length: z.number().int().min(1).max(9999), text: TEXT(60), values: z.array(VALUE).default([]) })).default([]),
  data_elements: z.array(z.object({ name: NAME(30), domain: NAME(30), text: TEXT(60), label: TEXT(20), short_label: TEXT(10).optional().describe("Obligatoria si label pasa de 10 caracteres") })).default([]),
  tables: z
    .array(
      z.object({
        name: NAME(30),
        kind: z.enum(["table", "structure"]),
        text: TEXT(60),
        delivery_class: z.string().length(1).optional().describe("Solo tablas: A, C, L…"),
        maintenance: z.string().max(1).optional().describe("Solo tablas: X = mantenimiento permitido"),
        data_class: NAME(5).optional().describe("Solo tablas: APPL0, APPL1…"),
        size_category: z.string().regex(/^\d$/).optional().describe("Solo tablas: 0-9"),
        fields: z.array(z.object({ name: NAME(30), data_element: NAME(30), key: z.boolean().default(false) })).min(1),
      }),
    )
    .default([]),
  table_types: z.array(z.object({ name: NAME(30), row_type: NAME(30), text: TEXT(60) })).default([]),
  function_groups: z.array(z.object({ name: NAME(26), text: TEXT(40) })).default([]),
  functions: z
    .array(
      z.object({
        name: NAME(30),
        group: NAME(26),
        text: TEXT(74),
        rfc: z.boolean().default(false),
        importing: z.array(PARAM).default([]),
        exporting: z.array(PARAM).default([]),
        tables: z.array(PARAM).default([]).describe("type = estructura DDIC plana"),
      }),
    )
    .default([]),
  modify: z
    .object({
      domains: z.array(z.object({ name: NAME(30), text: TEXT(60).optional(), length: z.number().int().min(1).max(9999).optional().describe("Solo alargar"), values: z.array(VALUE).default([]).describe("Añade los nuevos y cambia el texto de los que ya están") })).default([]),
      data_elements: z.array(z.object({ name: NAME(30), domain: NAME(30).optional(), text: TEXT(60).optional(), label: TEXT(20).optional(), short_label: TEXT(10).optional() })).default([]),
      tables: z.array(z.object({ name: NAME(30), text: TEXT(60).optional(), fields: z.array(z.object({ name: NAME(30), data_element: NAME(30) })).default([]).describe("Campo nuevo = se añade al final; existente = cambia su elemento. No toca claves") })).default([]),
      table_types: z.array(z.object({ name: NAME(30), row_type: NAME(30).optional(), text: TEXT(60).optional() })).default([]),
    })
    .default({})
    .describe("Objetos que YA existen: solo se indica lo que cambia"),
};
const SPEC = z.object(DDIC_SPEC);
export type DdicSpec = z.infer<typeof SPEC>;

export interface SpecObject {
  /** Tipo R3TR (DOMA, DTEL, TABL, TTYP, FUGR) o FUNC. */
  type: string;
  name: string;
}

const own = (n: string) => n.startsWith("Z") || n.startsWith("Y");

/** Reglas que el esquema no expresa. Devuelve los objetos que se crean y los que se modifican. */
export function checkSpec(spec: DdicSpec): { created: SpecObject[]; modified: SpecObject[] } {
  const bad = (msg: string): never => {
    throw new ToolError("INPUT", `Especificación: ${msg}`);
  };
  const created: SpecObject[] = [];
  const seen = new Set<string>();
  const add = (type: string, name: string, what: string) => {
    if (!own(name)) bad(`${what} ${name} no está en el espacio de clientes (Z/Y).`);
    // Dominios, elementos, tablas y tipos tabla comparten espacio de nombres de tipos; grupos y funciones, el suyo.
    const space = type === "FUGR" || type === "FUNC" ? type : type === "DOMA" ? "DOMA" : "TYPE";
    if (seen.has(`${space}|${name}`)) bad(`${what} ${name} duplicado.`);
    seen.add(`${space}|${name}`);
    created.push({ type, name });
  };
  for (const d of spec.domains) add("DOMA", d.name, "dominio");
  for (const e of spec.data_elements) {
    add("DTEL", e.name, "elemento de datos");
    if (e.label.length > 10 && !e.short_label) bad(`elemento ${e.name}: la etiqueta «${e.label}» pasa de 10 caracteres; indica short_label.`);
  }
  for (const t of spec.tables) {
    const table = t.kind === "table";
    add("TABL", t.name, table ? "tabla" : "estructura");
    if (table && t.name.length > 16) bad(`tabla ${t.name}: ${t.name.length} caracteres, máximo 16.`);
    const names = t.fields.map((f) => f.name);
    if (new Set(names).size !== names.length) bad(`${t.name}: campos duplicados.`);
    if (!table) {
      if (t.fields.some((f) => f.key)) bad(`estructura ${t.name}: una estructura no tiene campos clave.`);
      continue;
    }
    if (!t.delivery_class || !t.data_class || !t.size_category) bad(`tabla ${t.name}: faltan delivery_class, data_class o size_category.`);
    if (t.fields[0].name !== "MANDT" || !t.fields[0].key) bad(`tabla ${t.name}: una tabla de cliente debe empezar por la clave MANDT.`);
    const firstNonKey = t.fields.findIndex((f) => !f.key);
    if (firstNonKey >= 0 && t.fields.slice(firstNonKey).some((f) => f.key)) bad(`tabla ${t.name}: los campos clave van primero y seguidos.`);
  }
  for (const t of spec.table_types) add("TTYP", t.name, "tipo tabla");
  for (const g of spec.function_groups) add("FUGR", g.name, "grupo de funciones");
  for (const f of spec.functions) {
    add("FUNC", f.name, "función");
    if (!own(f.group)) bad(`función ${f.name}: el grupo ${f.group} no es propio (Z/Y).`);
  }

  const modified: SpecObject[] = [];
  const mseen = new Set<string>();
  const existing = (type: string, o: Record<string, unknown> & { name: string }, what: string) => {
    if (!own(o.name)) bad(`modificar ${what} ${o.name}: solo objetos propios (Z/Y).`);
    if (created.some((c) => c.name === o.name && c.type === type)) bad(`modificar ${what} ${o.name}: esta misma especificación lo crea; define ahí su forma final.`);
    if (mseen.has(`${type}|${o.name}`)) bad(`modificar ${what} ${o.name}: duplicado.`);
    mseen.add(`${type}|${o.name}`);
    const changes = Object.entries(o).filter(([k, v]) => k !== "name" && v !== undefined && !(Array.isArray(v) && v.length === 0));
    if (!changes.length) bad(`modificar ${what} ${o.name}: no indica ningún cambio.`);
    modified.push({ type, name: o.name });
  };
  for (const d of spec.modify.domains) existing("DOMA", d, "dominio");
  for (const e of spec.modify.data_elements) existing("DTEL", e, "elemento");
  for (const t of spec.modify.tables) {
    existing("TABL", t, "tabla");
    const names = t.fields.map((f) => f.name);
    if (new Set(names).size !== names.length) bad(`modificar tabla ${t.name}: campos duplicados.`);
  }
  for (const t of spec.modify.table_types) existing("TTYP", t, "tipo tabla");
  if (!created.length && !modified.length) bad("no hay ningún objeto que crear ni modificar.");
  return { created, modified };
}

/** Elementos de datos y dominios que la especificación USA y no crea: deben existir en el sistema. */
export function references(spec: DdicSpec): { dataElements: string[]; domains: string[]; rowTypes: string[] } {
  const newDtel = new Set(spec.data_elements.map((e) => e.name));
  const newDoma = new Set(spec.domains.map((d) => d.name));
  const newTabl = new Set(spec.tables.map((t) => t.name));
  const dtel = new Set<string>();
  const doma = new Set<string>();
  const rows = new Set<string>();
  for (const t of [...spec.tables, ...spec.modify.tables]) for (const f of t.fields) if (!newDtel.has(f.data_element)) dtel.add(f.data_element);
  for (const e of [...spec.data_elements, ...spec.modify.data_elements]) if (e.domain && !newDoma.has(e.domain)) doma.add(e.domain);
  for (const t of [...spec.table_types, ...spec.modify.table_types]) if (t.row_type && !newTabl.has(t.row_type)) rows.add(t.row_type);
  return { dataElements: [...dtel].sort(), domains: [...doma].sort(), rowTypes: [...rows].sort() };
}

/** Las instrucciones: una por línea, campos separados por tabulador. Mismo formato que lee ZDZ_DDIC_GEN. */
export function toInstructions(spec: DdicSpec): string {
  const out: string[] = [];
  const w = (...fields: Array<string | number>) => {
    const txt = fields.map(String);
    while (txt.length > 2 && txt[txt.length - 1] === "") txt.pop();
    out.push(txt.join("\t"));
  };
  const x = (b?: boolean) => (b ? "X" : "");
  const vals = (v: Array<{ value: string; text: string }>) => v.map((i) => `${i.value}=${i.text}`).join("|");
  w("DZGEN", 1);
  w("TEXT", spec.description ?? "Generador de DDIC");
  w("PKG", spec.package);
  w("TASK", spec.task);
  for (const d of spec.domains) w("DOMA", d.name, d.type, d.length, d.text, vals(d.values));
  for (const e of spec.data_elements) w("DTEL", e.name, e.domain, e.text, e.label, e.short_label ?? e.label);
  for (const t of spec.tables) {
    const tr = t.kind === "table";
    w("TABL", t.name, tr ? "TRANSP" : "INTTAB", t.text, tr ? t.delivery_class! : "", tr ? (t.maintenance ?? "") : "", tr ? t.data_class! : "", tr ? t.size_category! : "");
    for (const f of t.fields) w("FIELD", f.name, f.data_element, x(f.key));
  }
  for (const t of spec.table_types) w("TTYP", t.name, t.row_type, "S", t.text);
  for (const g of spec.function_groups) w("FUGR", g.name, g.text);
  for (const f of spec.functions) {
    w("FUNC", f.name, f.group, f.text, x(f.rfc));
    for (const [kind, list, like] of [["I", f.importing, false], ["E", f.exporting, false], ["T", f.tables, true]] as const) {
      for (const p of list) w("PARAM", kind, p.name, p.type, x(p.optional), x(like));
    }
  }
  for (const d of spec.modify.domains) w("MDOMA", d.name, d.length ?? "", d.text ?? "", vals(d.values));
  for (const e of spec.modify.data_elements) w("MDTEL", e.name, e.domain ?? "", e.text ?? "", e.label ?? "", e.short_label ?? "");
  for (const t of spec.modify.tables) {
    w("MTABL", t.name, t.text ?? "");
    for (const f of t.fields) w("FIELD", f.name, f.data_element);
  }
  for (const t of spec.modify.table_types) w("MTTYP", t.name, t.row_type ?? "", "", t.text ?? "");
  return out.join("\n") + "\n";
}
