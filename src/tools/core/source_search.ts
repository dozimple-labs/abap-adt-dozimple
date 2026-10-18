import { z } from "zod";
import { ADTClient, type AbapClassStructure } from "abap-adt-api";
import { pool } from "../../core/concurrency.js";
import type { SapConnection } from "../../core/connection.js";
import { normalizeError, ToolError } from "../../core/errors.js";
import { resolveByTypePrefix, sqlLiteral } from "../../core/objects.js";
import { packageObjects, packageTree } from "../../core/packages.js";
import { assertTrkorr } from "../../core/policy.js";
import { sourceObjectsOf, type SourceObjectRef } from "../../core/revisions.js";
import { defineTool } from "../../core/tool.js";
import { orderEntries, orderHeaders } from "../../core/transport.js";

/**
 * Búsqueda de texto en el código fuente de un alcance acotado (paquete, orden u objetos). ADT tiene un endpoint de
 * búsqueda de texto (`informationsystem/textsearch`), pero en NW 7.50 no existe: responde 404 y no figura en el
 * discovery. Así que se leen las fuentes del alcance y se busca aquí. Sirve donde where_used no llega: el índice de
 * referencias de un sistema convertido puede no cubrir el código Z.
 */

const MAX_PATTERN = 200;
const MAX_LINE = 200;

/** Programa principal e includes de un grupo de funciones, con namespace: /DZ/GRP → /DZ/SAPLGRP y /DZ/LGRP. */
export function groupNames(group: string): { main: string; includePrefix: string } {
  const g = group.trim().toUpperCase();
  const m = /^(\/[^/]+\/)(.+)$/.exec(g);
  return m ? { main: `${m[1]}SAPL${m[2]}`, includePrefix: `${m[1]}L${m[2]}` } : { main: `SAPL${g}`, includePrefix: `L${g}` };
}

/**
 * Un grupo de funciones se busca en sus módulos (TFDIR) y en sus includes propios (TOP, F, O, I…), no en los U (son
 * los módulos) ni en los generados con «$». ADT tipa esos includes como FUGR/I, no PROG/I (verificado en 7.50).
 */
async function expandGroup(sap: SapConnection, group: string): Promise<SourceObjectRef[]> {
  const { main, includePrefix } = groupNames(group);
  const fms = await sap.query(`SELECT funcname FROM tfdir WHERE pname = ${sqlLiteral(main)}`, 500);
  const incs = await sap.query(
    `SELECT name FROM trdir WHERE name LIKE ${sqlLiteral(`${includePrefix}%`)} AND name NOT LIKE ${sqlLiteral(`${includePrefix}U%`)}`,
    500,
  );
  return [
    ...fms.values.map((v) => ({ name: String(v.FUNCNAME).trim(), types: ["FUGR/FF"], from: [`R3TR FUGR ${group}`] })),
    ...incs.values
      .map((v) => String(v.NAME).trim())
      .filter((n) => !n.includes("$"))
      .map((name) => ({ name, types: ["FUGR/I", "PROG/"], from: [`R3TR FUGR ${group}`] })),
  ];
}

async function scopeRefs(sap: SapConnection, a: { package?: string; include_subpackages: boolean; transport?: string; objects?: string[] }, max: number) {
  let rows: Array<{ PGMID: string; OBJECT: string; OBJ_NAME: string }>;
  let label: string;
  if (a.package) {
    const root = a.package.trim().toUpperCase();
    const { packages } = await packageTree(sap, root, a.include_subpackages);
    rows = await packageObjects(sap, packages, 5000);
    label = `paquete ${root}${a.include_subpackages && packages.length > 1 ? ` y ${packages.length - 1} subpaquetes` : ""}`;
  } else if (a.transport) {
    const tr = assertTrkorr(a.transport);
    const head = (await orderHeaders(sap, [tr])).get(tr);
    if (!head) throw new ToolError("NOT_FOUND", `La orden ${tr} no existe en este sistema.`);
    const root = head.parent || tr;
    rows = await orderEntries(sap, root);
    label = `orden ${root}${root !== tr ? ` (pediste la tarea ${tr})` : ""}`;
  } else {
    // Lista explícita: cada nombre se resuelve con cualquier tipo con fuente.
    const refs = a.objects!.map((n) => ({ name: n.trim().toUpperCase(), types: ["PROG/", "CLAS/", "INTF/", "FUGR/FF", "DDLS/"], from: ["objects"] }));
    return { refs: refs.slice(0, max), total: refs.length, label: `${refs.length} objetos indicados` };
  }
  const { source, other } = sourceObjectsOf(rows);
  const groups = other.filter((o) => o.startsWith("R3TR FUGR ")).map((o) => o.slice("R3TR FUGR ".length));
  const refs = [...source];
  for (const g of groups) refs.push(...(await expandGroup(sap, g)));
  return { refs: refs.slice(0, max), total: refs.length, label };
}

/** Fuentes de un objeto: una sola, salvo clases (main y sus includes locales, los que existan). */
async function sourcesOf(c: ADTClient, uri: string, type: string): Promise<Array<{ include: string; text: string }>> {
  if (!type.startsWith("CLAS")) {
    const url = ADTClient.isMainInclude(uri) ? uri : `${uri}/source/main`;
    return [{ include: "main", text: await c.getObjectSource(url) }];
  }
  const includes = ADTClient.classIncludes((await c.objectStructure(uri)) as AbapClassStructure);
  const out: Array<{ include: string; text: string }> = [];
  for (const inc of ["main", "definitions", "implementations", "testclasses"] as const) {
    const url = includes.get(inc);
    if (url) out.push({ include: inc, text: await c.getObjectSource(url) });
  }
  return out;
}

function matcher(text: string, regex: boolean): (line: string) => boolean {
  if (text.length > MAX_PATTERN) throw new ToolError("INPUT", `El patrón tiene ${text.length} caracteres; el máximo es ${MAX_PATTERN}.`);
  if (!regex) {
    const needle = text.toUpperCase();
    return (line) => line.toUpperCase().includes(needle);
  }
  let re: RegExp;
  try {
    re = new RegExp(text, "i");
  } catch (e) {
    throw new ToolError("INPUT", `Expresión regular inválida: ${(e as Error).message}`);
  }
  return (line) => re.test(line);
}

const isComment = (line: string) => line.startsWith("*") || line.trimStart().startsWith('"');

const HIT = z.object({ object: z.string(), type: z.string(), include: z.string(), line: z.number().int(), text: z.string() });

export default defineTool({
  name: "source_search",
  title: "Buscar texto en el código",
  description:
    "Busca texto o expresión regular en el código de un paquete (con subpaquetes), una orden o una lista de " +
    "objetos; devuelve objeto, include, línea y texto. Donde where_used no llega: llamadas dinámicas, literales, " +
    "código Z sin índice. Lee cada fuente: exige alcance y tiene tope de objetos; los que no se pudieron leer se " +
    "listan aparte.",
  access: "read",
  timeoutMs: 180_000,
  input: {
    text: z.string().min(2).describe("Texto a buscar (sin distinguir mayúsculas), p. ej. RV_FLOW o 'CALL FUNCTION'"),
    regex: z.boolean().default(false).describe("Tratar text como expresión regular (máx. 200 caracteres)"),
    package: z.string().optional().describe("Alcance: paquete de desarrollo"),
    include_subpackages: z.boolean().default(true),
    transport: z.string().optional().describe("Alcance: orden (o tarea) de transporte"),
    objects: z.array(z.string().min(1)).max(200).optional().describe("Alcance: lista de objetos por nombre"),
    ignore_comments: z.boolean().default(false).describe("No contar líneas de comentario"),
    // ~0,8 s por objeto medido en un 7.50 con 4 lecturas en paralelo: 150 objetos caben en el tiempo máximo de la tool.
    max_objects: z.number().int().min(1).max(1000).default(150),
    max_hits: z.number().int().min(1).max(2000).default(300),
  },
  output: {
    scope: z.string(),
    objects_in_scope: z.number().int(),
    scanned: z.number().int().describe("Objetos leídos"),
    truncated: z.boolean().describe("true si el alcance tenía más objetos que max_objects o más coincidencias que max_hits"),
    hits: z.array(HIT),
    skipped: z.array(z.object({ object: z.string(), reason: z.string() })).describe("Objetos que no se pudieron leer"),
  },
  async run(a, ctx) {
    const scopes = [a.package, a.transport, a.objects?.length ? "x" : undefined].filter(Boolean).length;
    if (scopes !== 1) {
      throw new ToolError("INPUT", "Indica exactamente un alcance: package, transport u objects. Buscar en todo el repositorio no es viable leyendo fuentes.");
    }
    const match = matcher(a.text, a.regex);
    const { sap } = ctx;
    const { refs, total, label } = await scopeRefs(sap, a, a.max_objects);
    const c = await sap.adt();

    const hits: Array<z.infer<typeof HIT>> = [];
    const skipped: Array<{ object: string; reason: string }> = [];
    let done = 0;
    let scanned = 0;
    ctx.progress?.(`Leyendo ${refs.length} objetos de ${label}…`, 0, refs.length);
    await pool(refs, 4, async (ref) => {
      ctx.signal?.throwIfAborted();
      try {
        const res = await resolveByTypePrefix(c, ref.name, ref.types);
        if (!res) {
          skipped.push({ object: ref.name, reason: "no se encontró con un tipo con fuente" });
          return;
        }
        for (const src of await sourcesOf(c, res.uri, res.type)) {
          src.text.split(/\r?\n/).forEach((line, i) => {
            if (hits.length >= a.max_hits || (a.ignore_comments && isComment(line)) || !match(line)) return;
            hits.push({ object: ref.name, type: res.type, include: src.include, line: i + 1, text: line.trim().slice(0, MAX_LINE) });
          });
        }
        scanned++;
      } catch (e) {
        const te = normalizeError(e);
        if (te.kind === "NETWORK" || te.kind === "AUTH" || te.kind === "CANCELLED") throw te;
        skipped.push({ object: ref.name, reason: `${te.kind}: ${te.message.slice(0, 120)}` });
      } finally {
        ctx.progress?.(`${++done} de ${refs.length} objetos leídos`, done, refs.length);
      }
    });

    hits.sort((x, y) => x.object.localeCompare(y.object) || x.include.localeCompare(y.include) || x.line - y.line);
    const truncated = total > refs.length || hits.length >= a.max_hits;
    const structured = { scope: label, objects_in_scope: total, scanned, truncated, hits, skipped };
    const head =
      `«${a.text}»${a.regex ? " (regex)" : ""} en ${label}: ${hits.length} coincidencias en ${new Set(hits.map((h) => h.object)).size} objetos · ` +
      `${scanned} de ${total} objetos leídos` +
      (total > refs.length ? ` — TOPE ALCANZADO: ${total - refs.length} objetos sin leer (sube max_objects o acota el alcance)` : "") +
      (hits.length >= a.max_hits ? ` — tope de ${a.max_hits} coincidencias: puede haber más` : "");
    const lines = hits.map((h) => `${h.object}${h.include !== "main" ? ` (${h.include})` : ""} L${h.line}: ${h.text}`);
    const skip = skipped.length ? `\n\nNo se pudieron leer (${skipped.length}):\n${skipped.map((s) => `  ${s.object}: ${s.reason}`).join("\n")}` : "";
    if (!hits.length) return { text: `${head}.\nSe leyó el código y no aparece.${skip}`, structured };
    return { text: `${head}\n\n${lines.join("\n")}${skip}`, structured };
  },
});
