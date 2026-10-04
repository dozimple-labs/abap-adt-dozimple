import { ADTClient, type AbapClassStructure, type SearchResult } from "abap-adt-api";
import { ToolError } from "./errors.js";
import { addNote } from "./notes.js";

/**
 * Tipos cortos que entiende la tool → tipo ADT (TADIR/WB). También se acepta
 * el tipo ADT tal cual (p. ej. "PROG/P").
 */
export const TYPE_MAP: Record<string, string> = {
  PROG: "PROG/P",
  INCL: "PROG/I",
  CLAS: "CLAS/OC",
  INTF: "INTF/OI",
  FUGR: "FUGR/F",
  FUNC: "FUGR/FF",
  DDLS: "DDLS/DF",
  DDLX: "DDLX/EX",
  DCLS: "DCLS/DL",
  TABL: "TABL/DT",
  STRU: "TABL/DS",
  VIEW: "VIEW/DV",
  DTEL: "DTEL/DE",
  DOMA: "DOMA/DD",
  TTYP: "TTYP/DA",
  MSAG: "MSAG/N",
  XSLT: "XSLT/VT",
  BDEF: "BDEF/BDO",
  SRVD: "SRVD/SRV",
  SRVB: "SRVB/SVB",
  /** Implementación de ampliación (enhancement): BAdI (ENHO/XHB), plugin de código (ENHO/XHH)… cualquier subtipo. */
  ENHO: "ENHO",
};

export const TYPE_HELP =
  "Tipo corto: " + Object.keys(TYPE_MAP).join(", ") + ". También vale el tipo ADT (p. ej. PROG/P).";

export function adtType(t?: string): string | undefined {
  if (!t) return undefined;
  const up = t.trim().toUpperCase();
  if (up.includes("/")) return up;
  const mapped = TYPE_MAP[up];
  if (!mapped) throw new ToolError("INPUT", `Tipo desconocido: ${t}. ${TYPE_HELP}`);
  return mapped;
}

const TYPE_LABEL: Record<string, string> = {
  "PROG/P": "programa",
  "PROG/I": "include",
  "TABL/DT": "tabla",
  "TABL/DS": "estructura",
  "FUGR/F": "grupo de funciones",
  "FUGR/FF": "módulo de función",
  "CLAS/OC": "clase",
  "INTF/OI": "interfaz",
};

/**
 * Mismo objeto con otro subtipo: misma familia (4 primeras letras). Los grupos de funciones nunca: un grupo y un
 * módulo son objetos distintos, y confundirlos cambia qué se lee o se escribe.
 */
export function compatibleType(requested: string, actual: string): boolean {
  const fam = (t: string) => t.slice(0, 4);
  if (fam(requested) !== fam(actual)) return false;
  if (fam(requested) === "FUGR") return requested === actual;
  return true;
}

export interface ResolvedObject {
  name: string;
  type: string;
  uri: string;
  packageName?: string;
  description?: string;
}

/**
 * Localiza un objeto por nombre exacto (y tipo si se da) vía quickSearch.
 * No adivina: si hay varios tipos con el mismo nombre y no se indicó tipo,
 * devuelve el listado para que se elija.
 */
export async function resolveObject(c: ADTClient, name: string, type?: string): Promise<ResolvedObject> {
  const wanted = name.trim().toUpperCase();
  const at = adtType(type);
  let hits: SearchResult[] = await c.searchObject(wanted, at, 50);
  // Algunos releases no filtran bien por tipo en quickSearch: se reintenta sin filtro.
  if (at && !hits.some((h) => h["adtcore:name"].toUpperCase() === wanted)) {
    hits = await c.searchObject(wanted, undefined, 100);
  }
  const sameName = hits.filter((h) => h["adtcore:name"].toUpperCase() === wanted);
  let exact = at ? sameName.filter((h) => h["adtcore:type"].toUpperCase().startsWith(at)) : sameName;
  if (exact.length === 0 && at && sameName.length) {
    // El nombre existe con otro subtipo de la misma familia (PROG → include PROG/I, TABL → estructura TABL/DS):
    // con UNA sola candidata se resuelve y se deja constancia; con varias, se sigue pidiendo el tipo.
    const compatible = sameName.filter((h) => compatibleType(at, h["adtcore:type"].toUpperCase()));
    if (compatible.length === 1) {
      const t = compatible[0]["adtcore:type"].toUpperCase();
      addNote(`se pidió ${type!.toUpperCase()} ${wanted}; en el sistema es ${t}${TYPE_LABEL[t] ? ` (${TYPE_LABEL[t]})` : ""} y se usó ese.`);
      exact = compatible;
    } else if (at === "FUGR/FF" && sameName.some((h) => h["adtcore:type"].toUpperCase() === "FUGR/F")) {
      throw new ToolError(
        "NOT_FOUND",
        `${wanted} es un grupo de funciones (FUGR/F), no un módulo de función.`,
        `Sus módulos: function_modules(group="${wanted}"). El nombre del módulo suele diferir del del grupo.`,
      );
    }
  }
  if (exact.length === 0 && at === "FUGR/FF") {
    const fm = await functionModuleByDirectory(c, wanted);
    if (fm) return fm;
  }
  if (exact.length === 0) {
    const near = hits.slice(0, 8).map((h) => `${h["adtcore:name"]} (${h["adtcore:type"]})`);
    throw new ToolError(
      "NOT_FOUND",
      `No existe ${type ? type.toUpperCase() + " " : ""}${wanted}.` + (near.length ? ` Parecidos: ${near.join(", ")}` : ""),
    );
  }
  if (exact.length > 1 && !at) {
    throw new ToolError(
      "INPUT",
      `${wanted} es ambiguo; indica object_type: ` + exact.map((h) => h["adtcore:type"]).join(", "),
    );
  }
  const h = exact[0];
  return {
    name: h["adtcore:name"],
    type: h["adtcore:type"],
    uri: h["adtcore:uri"],
    packageName: h["adtcore:packageName"],
    description: h["adtcore:description"],
  };
}

/**
 * quickSearch no devuelve un módulo de función recién creado y aún inactivo (NW 7.50): se busca su grupo en el
 * directorio de funciones (ENLFDIR) y se construye la URI, que es fija: grupo + módulo.
 */
async function functionModuleByDirectory(c: ADTClient, name: string): Promise<ResolvedObject | undefined> {
  if (!/^(\/[A-Z0-9_]+\/)?[A-Z0-9_]+$/.test(name)) return undefined;
  let area: string | undefined;
  try {
    const r = await c.runQuery(`SELECT area FROM enlfdir WHERE funcname = ${sqlLiteral(name)}`, 1, true);
    area = String((r.values[0] as Record<string, unknown> | undefined)?.AREA ?? "").trim() || undefined;
  } catch {
    return undefined;
  }
  if (!area) return undefined;
  const seg = (n: string) => encodeURIComponent(n.toLowerCase());
  addNote(`la búsqueda de SAP no devuelve ${name} (módulo nuevo o sin activar); se localizó por el directorio de funciones en el grupo ${area}.`);
  return { name, type: "FUGR/FF", uri: `/sap/bc/adt/functions/groups/${seg(area)}/fmodules/${seg(name)}` };
}

export const CLASS_INCLUDES = ["main", "definitions", "implementations", "macros", "testclasses"] as const;
export type ClassIncludeName = (typeof CLASS_INCLUDES)[number];

/** URL de la fuente del objeto (o del include de clase pedido). */
export async function sourceUrl(c: ADTClient, obj: ResolvedObject, include: ClassIncludeName = "main"): Promise<string> {
  if (obj.type.startsWith("CLAS")) {
    const st = (await c.objectStructure(obj.uri)) as AbapClassStructure;
    const url = ADTClient.classIncludes(st).get(include);
    if (!url) {
      const has = [...ADTClient.classIncludes(st).keys()].join(", ");
      throw new ToolError("NOT_FOUND", `La clase ${obj.name} no tiene include "${include}". Tiene: ${has}`);
    }
    return url;
  }
  if (include !== "main") throw new ToolError("INPUT", `"include" solo aplica a clases.`);
  if (ADTClient.isMainInclude(obj.uri)) return obj.uri;
  try {
    return ADTClient.mainInclude(await c.objectStructure(obj.uri));
  } catch {
    return `${obj.uri}/source/main`;
  }
}

/** Localiza por nombre exacto aceptando varios prefijos de tipo (p. ej. PROG/ = programa o include). */
export async function resolveByTypePrefix(c: ADTClient, name: string, prefixes: string[]): Promise<{ uri: string; type: string } | undefined> {
  const hits = await c.searchObject(name, undefined, 50);
  const h = hits.find((x) => x["adtcore:name"].toUpperCase() === name.toUpperCase() && prefixes.some((t) => x["adtcore:type"].startsWith(t)));
  return h ? { uri: h["adtcore:uri"], type: h["adtcore:type"] } : undefined;
}

/**
 * Nombre de objeto apto para una ruta ADT. encodeURIComponent no codifica «.», así que «..» sobreviviría y
 * recorrería la ruta; un nombre de repositorio ABAP solo tiene letras, dígitos, «_», «$» y namespaces «/X/».
 */
export function adtPathName(name: string): string {
  const n = name.trim();
  if (!/^(\/[A-Za-z0-9_]+\/)?[A-Za-z0-9_$]{1,40}$/.test(n)) throw new ToolError("INPUT", `Nombre de objeto inválido para una ruta ADT: ${name}`);
  return encodeURIComponent(n.toLowerCase());
}

/** Escapa un literal para ABAP SQL. */
export function sqlLiteral(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}
