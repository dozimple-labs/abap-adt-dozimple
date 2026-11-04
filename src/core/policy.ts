import { canWrite, type Config, type SystemConfig } from "./config.js";
import { ToolError } from "./errors.js";
import type { Access } from "./tool.js";

/** Lanza POLICY si la tool no puede correr en ese sistema. */
export function assertAccess(access: Access, s: SystemConfig): void {
  if (access === "write" && !canWrite(s)) {
    throw new ToolError(
      "POLICY",
      s.role !== "DEV"
        ? `${s.id} es ${s.role}: este servidor nunca escribe fuera de desarrollo.`
        : `${s.id} no tiene la escritura habilitada.`,
      s.role === "DEV" ? `Para habilitarla, pon "allowWrite": true en su entrada de systems.json.` : undefined,
    );
  }
  if (access === "exec" && s.role !== "DEV") {
    throw new ToolError("POLICY", `${s.id} es ${s.role}: solo se ejecuta código en sistemas de desarrollo.`);
  }
}

/** ¿Admite la lista writePackages este paquete? Sin lista, todos. Comparación sin mayúsculas; * vale por cualquier texto. */
export function packageAllowed(s: Pick<SystemConfig, "writePackages">, pkg: string | undefined): boolean {
  if (!s.writePackages) return true;
  if (!pkg) return false;
  const name = pkg.trim().toUpperCase();
  return s.writePackages.some((pattern) => {
    const re = pattern.toUpperCase().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${re}$`).test(name);
  });
}

/** Lanza POLICY si writePackages no cubre el paquete. Si el paquete no se conoce, no se escribe. */
export function assertPackageAllowed(s: SystemConfig, pkg: string | undefined, object: string): void {
  if (packageAllowed(s, pkg)) return;
  throw new ToolError(
    "POLICY",
    pkg
      ? `${s.id} no permite escribir en el paquete ${pkg.trim().toUpperCase()} (objeto ${object}).`
      : `${s.id} limita la escritura por paquete y no se pudo saber el paquete de ${object}: no se escribe.`,
    `Paquetes permitidos: ${s.writePackages!.join(", ") || "ninguno"}. Se cambia en writePackages de systems.json.`,
  );
}

/**
 * La vista previa de datos de ADT solo admite lecturas, pero se valida
 * igualmente para dar un error claro antes de ir a SAP.
 */
export function assertSelectOnly(sql: string): string {
  const q = sql.trim().replace(/\.$/, "");
  if (!/^(select|with)\b/i.test(q)) {
    throw new ToolError("INPUT", "Solo se admiten consultas SELECT (o WITH).");
  }
  if (q.includes(";")) {
    throw new ToolError("INPUT", "Una sola sentencia, sin «;».");
  }
  return q;
}

/**
 * Material de credenciales que el servidor no lee nunca, aunque el usuario SAP
 * tenga autorización: hashes de contraseñas, almacén seguro (donde viven las
 * claves de los destinos RFC), PSE con claves privadas, secretos OAuth, ACL de
 * usuarios y dumps (SNAP guarda valores de variables en memoria). Un agente no
 * lo necesita, y una respuesta de tool puede acabar en un log, un ticket o un
 * proveedor de LLM. La configuración sin secretos (RFCDES, RFCSYSACL, AGR_*)
 * sí se puede leer: la usa el análisis de Basis.
 */
export const SENSITIVE_TABLES = [
  "USR02", "USH02", "USRPWDHISTORY", "USH02_ARC_TMP",
  "RSECTAB", "RSECACTB",
  "SSF_PSE_D", "SSF_PSE_H", "SSF_PSE_L",
  "USRACL", "SNAP",
];
export const SENSITIVE_PREFIXES = ["OA2C_"];
/**
 * Columnas con contraseñas o sus hashes, en cualquier tabla: además de las de USR02, la contraseña del usuario de
 * inicio de sesión fijo de un servicio ICF (ICFSERVICE-ICF_PASSWD) y nombres genéricos de columna de contraseña.
 */
export const SENSITIVE_COLUMNS = ["PWDSALTEDHASH", "BCODE", "PASSCODE", "ICF_PASSWD", "PASSWD", "PASSWORD"];

/** Datos de personal (infotipos, clusters de nómina): categoría especial, nunca por este servidor. */
export const HR_TABLE_RE = /^(PA\d{4}|PB\d{4}|PCL[1-5]|HRPY_[A-Z0-9_]+)$/;

/** Qué palabras de una consulta (o de una definición de vista) son material vetado. */
export function sensitiveHits(words: Iterable<string>): { secrets: string[]; hr: string[] } {
  const secrets = new Set<string>();
  const hr = new Set<string>();
  for (const raw of words) {
    const w = raw.toUpperCase();
    if (SENSITIVE_TABLES.includes(w) || SENSITIVE_COLUMNS.includes(w) || SENSITIVE_PREFIXES.some((p) => w.startsWith(p))) secrets.add(w);
    else if (HR_TABLE_RE.test(w)) hr.add(w);
  }
  return { secrets: [...secrets], hr: [...hr] };
}

export function sqlWords(sql: string): string[] {
  return sql.replace(/'(?:[^']|'')*'/g, " ").toUpperCase().match(/[A-Z0-9_/]+/g) ?? [];
}

export function rejectSensitive(hits: { secrets: string[]; hr: string[] }, via?: string): void {
  const how = via ? ` a través de ${via}` : "";
  if (hits.secrets.length) {
    throw new ToolError(
      "POLICY",
      `Consulta bloqueada: toca datos de seguridad${how} (${hits.secrets.join(", ")}). Este servidor no lee credenciales, ` +
        `hashes, almacén seguro, claves privadas ni dumps.`,
      "Si necesitas el estado de un usuario (bloqueo, validez), usa SU01 o pide la columna concreta a Basis; para dumps, la tool dumps.",
    );
  }
  if (hits.hr.length) {
    throw new ToolError(
      "POLICY",
      `Consulta bloqueada: datos de personal${how} (${hits.hr.join(", ")}). Este servidor no lee infotipos ni nómina.`,
      "Para la estructura, ddic_type_info o get_source sobre la tabla (definición, no datos).",
    );
  }
}

export function assertNotSensitive(sql: string): void {
  rejectSensitive(sensitiveHits(sqlWords(sql)));
}

const GENERIC_LABELS = new Set(["com", "net", "org", "sap", "corp", "local", "cloud", "hana", "ondemand", "intra", "internal", "prod", "dev"]);

/** Términos que identifican a clientes o sistemas, deducidos de la configuración. */
export function sensitiveTerms(cfg: Config, extra: string[] = []): string[] {
  const terms = new Set<string>(extra.map((t) => t.toLowerCase()).filter((t) => t.length >= 3));
  for (const s of cfg.systems) {
    terms.add(s.id.toLowerCase());
    if (s.sid) terms.add(s.sid.toLowerCase());
    terms.add(s.user.toLowerCase());
    try {
      const labels = new URL(s.url).hostname.split(".").slice(1, -1);
      for (const l of labels) if (l.length >= 4 && !GENERIC_LABELS.has(l.toLowerCase())) terms.add(l.toLowerCase());
    } catch {
      /* URL ya validada por el esquema */
    }
  }
  return [...terms];
}

/** Tokens que parecen objetos de cliente, namespaces u órdenes de transporte. */
export function customTokens(query: string): string[] {
  return (query.match(/[A-Za-z0-9_/]+/g) ?? []).filter(
    (t) =>
      /^[zy][a-z0-9]*_[a-z0-9_]*$/i.test(t) || // ZDEMO_REPORT_01, zcl_x
      /^[zy][a-z]{1,4}\d{2,}[a-z0-9_]*$/i.test(t) || // ZFI001, ZMM012F01
      /^\/[a-z0-9]{2,}\/\w+/i.test(t) || // /NSP/ALGO
      /^[a-z0-9]{3}k\d{6}$/i.test(t), // DEVK900123
  );
}

/**
 * Última barrera antes de que una consulta salga a internet (búsqueda online
 * de documentación): sin objetos de cliente, sistemas, usuarios ni nombres de
 * cliente. No sustituye el criterio del usuario: lo respalda.
 */
export function assertPublicQuery(query: string, cfg: Config, blockTerms: string[] = []): void {
  const lower = query.toLowerCase();
  const hits = [
    ...customTokens(query),
    ...sensitiveTerms(cfg, blockTerms).filter((t) => new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}($|[^a-z0-9])`).test(lower)),
  ];
  if (hits.length) {
    throw new ToolError(
      "POLICY",
      `La consulta saldría a internet con datos del cliente o del sistema (${[...new Set(hits)].join(", ")}).`,
      "Reformúlala con el concepto técnico (p. ej. «MATNR length extension BAPI»), sin nombres Z, órdenes, sistemas ni clientes; o búscala sin online.",
    );
  }
}

/**
 * Usuario SAP: hasta 12 caracteres (USR02-BNAME). Se interpola en filtros de feeds ADT (dumps, errores de Gateway):
 * paréntesis, comas o espacios podrían reescribir la expresión del filtro, así que solo se admite esta forma.
 */
export const SAP_USER_RE = /^[A-Za-z0-9_.@-]{1,12}$/;

export const TRKORR_RE = /^[A-Z0-9]{3}K\d{6}$/;

export function assertTrkorr(t: string, label = "transport"): string {
  const up = t.trim().toUpperCase();
  if (!TRKORR_RE.test(up)) throw new ToolError("INPUT", `${label}: "${t}" no es un número de orden (p. ej. DEVK900123).`);
  return up;
}
