import type { SystemConfig } from "./config.js";
import type { SapConnection } from "./connection.js";
import { normalizeError, ToolError } from "./errors.js";
import { adtPathName, sqlLiteral } from "./objects.js";
import { assertNotSensitive, assertSelectOnly, rejectSensitive, SENSITIVE_COLUMNS, sensitiveHits, sqlWords } from "./policy.js";

/**
 * Gobierno de los datos de negocio que devuelven sql_query y table_contents.
 * Las consultas internas de las tools (E070, TADIR…) no pasan por aquí: no
 * traen datos personales y necesitan todas sus filas.
 */
export type DataClass = "test" | "masked" | "prod";

export const dataClassOf = (s: SystemConfig): DataClass => s.dataClass ?? (s.role === "DEV" ? "test" : "prod");

const DEFAULT_CAP: Record<DataClass, number> = { test: 5000, masked: 1000, prod: 200 };
export const rowCap = (s: SystemConfig): number => s.maxRows ?? DEFAULT_CAP[dataClassOf(s)];

/**
 * Columnas con datos personales en las tablas estándar (deudores, acreedores,
 * direcciones, bancos, interlocutores). Se reconocen por nombre: una Z con
 * otro nombre no se detecta, por eso el tope de filas sigue aplicando.
 */
export const PII_COLUMNS = new Set([
  "NAME1", "NAME2", "NAME3", "NAME4", "NAME_FIRST", "NAME_LAST", "NAME_LST2", "NAMEMIDDLE", "NAME_CO", "NICKNAME",
  "NAME_ORG1", "NAME_ORG2", "MC_NAME1", "MC_NAME2", "SORTL", "MCOD1", "MCOD2",
  "STRAS", "STREET", "STR_SUPPL1", "STR_SUPPL2", "STR_SUPPL3", "HOUSE_NUM1", "PSTLZ", "POST_CODE1", "PFACH", "PO_BOX",
  "TELF1", "TELF2", "TELFX", "TELBX", "TEL_NUMBER", "TEL_EXTENS", "FAX_NUMBER", "MOB_NUMBER", "SMTP_ADDR", "E_MAIL",
  "STCD1", "STCD2", "STCD3", "STCD4", "STCD5", "STCEG", "TAXNUM",
  "BANKN", "BKONT", "IBAN", "KOINH", "ACCNAME", "CCNUM",
  "GBDAT", "BIRTHDT", "GBORT", "PERID", "IDNUMBER",
]);
export const MASK = "‹oculto›";

/**
 * Columnas con el usuario SAP de una persona (quién creó, cambió, aprobó). Identifican a un empleado igual que un
 * nombre, y las tablas de negocio las traen con sufijos y prefijos propios (ERNAM_S, ANGE_USER, ZZ_ERNAM): por eso
 * se reconocen por patrón y no solo por lista.
 */
const USER_ID_COLUMNS = new Set([
  "ERNAM", "AENAM", "UNAME", "USNAM", "USERNAME", "BNAME", "XUBNAME", "AS4USER", "TDFUSER", "TDLUSER", "ERNAME", "AENAME",
  "CRUSER", "CHUSER", "CREATED_BY", "CHANGED_BY", "LAST_CHANGED_BY", "CRNAM", "CHNAM",
]);
const USER_ID_RE = /^(ZZ?_?)?(ERNAM|AENAM|UNAME|USNAM|ERNAME|AENAME)(_[A-Z0-9]+)?$|_(USER|UNAME|USNAM|ERNAM|AENAM)$/;

/** ¿La columna lleva un dato personal? Lista estándar, usuario SAP por patrón, o las propias del cliente. */
export function isPersonalColumn(name: string, extra?: ReadonlySet<string>): boolean {
  const n = name.toUpperCase();
  return PII_COLUMNS.has(n) || USER_ID_COLUMNS.has(n) || USER_ID_RE.test(n) || !!extra?.has(n);
}

/**
 * En sistemas masked/prod una columna personal solo puede salir como columna
 * simple, para enmascararla. Usarla en un WHERE, un alias o una expresión
 * dejaría deducir su valor sin que aparezca en el resultado.
 */
export function maskPii(cls: DataClass, sql: string, columns: string[], rows: Record<string, unknown>[], extra: string[] = []): string[] {
  if (cls === "test") return [];
  const own = new Set(extra.map((c) => c.toUpperCase()));
  const cols = new Set(columns.map((c) => c.toUpperCase()));
  const mentioned = new Set(sqlWords(sql).flatMap((w) => w.split("~")).filter((w) => isPersonalColumn(w, own)));
  const hidden = [...mentioned].filter((w) => !cols.has(w));
  if (hidden.length) {
    throw new ToolError(
      "POLICY",
      `En un sistema con datos ${cls === "prod" ? "productivos" : "enmascarados"}, las columnas personales (${hidden.join(", ")}) ` +
        `solo pueden pedirse como columna simple del SELECT: no en WHERE, alias ni expresiones.`,
      "Filtra por la clave (KUNNR, LIFNR, PARTNER…) y deja que la columna salga enmascarada, o consulta un sistema de test.",
    );
  }
  const masked = columns.filter((c) => isPersonalColumn(c, own));
  for (const row of rows) for (const c of masked) if (row[c] !== "" && row[c] !== null && row[c] !== undefined) row[c] = MASK;
  return masked;
}

const KEYWORDS = new Set(
  ("SELECT FROM WHERE AND OR NOT IN AS JOIN INNER LEFT RIGHT OUTER CROSS ON GROUP BY ORDER HAVING DISTINCT COUNT SUM " +
    "MIN MAX AVG CASE WHEN THEN ELSE END LIKE BETWEEN IS NULL ASC DESC UNION ALL EXISTS WITH UP TO ROWS SINGLE ESCAPE " +
    "COALESCE CAST CONCAT SUBSTRING LENGTH UPPER LOWER ABS ROUND FLOOR CEIL DIV MOD CLIENT SPECIFIED FIELDS DEFINE VIEW " +
    "ENTITY ASSOCIATION PROJECTION KEY ROOT CHILD PARENT COMPOSITION TRUE FALSE ABAP ENDUSER").split(" "),
);

/** Palabras que pueden ser nombres de tabla, vista o entidad CDS. */
export function candidateNames(text: string, limit = 80): string[] {
  const out = new Set<string>();
  const code = text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*$/gm, " ")
    .replace(/@[^\n]*/g, " ") // anotaciones CDS: sus valores (#CDS_MODELING_…) no son tablas
    .replace(/#[A-Za-z0-9_]+/g, " ");
  for (const w of sqlWords(code).flatMap((x) => x.split("~"))) {
    // 40 = longitud máxima de una entidad CDS; una tabla o vista clásica no pasa de 30.
    if (w.length < 3 || w.length > 40 || KEYWORDS.has(w) || /^\d/.test(w) || !/^([A-Z]|\/[A-Z0-9]+\/)[A-Z0-9_]*$/.test(w)) continue;
    out.add(w);
    if (out.size >= limit) break;
  }
  return [...out];
}

const MAX_EXAMINED = 1500;
const chunks = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** Resultado por nombre: nombres base vetados que esconde (vacío = limpio). Por conexión y proceso. */
const deepCache = new WeakMap<object, Map<string, string[]>>();

/**
 * Una vista (DD26S) o una entidad CDS puede leer USR02 sin nombrarla. Se
 * resuelve hasta 3 niveles: vistas de base de datos y de mantenimiento por
 * DD26S; CDS por DDLDEPENDENCY + palabras de su fuente DDL.
 */
export async function assertNoSensitiveViews(sap: SapConnection, sql: string, depth = 3): Promise<void> {
  let cache = deepCache.get(sap);
  if (!cache) deepCache.set(sap, (cache = new Map()));
  let frontier = candidateNames(sql).filter((n) => !cache.has(n));
  const origin = new Map<string, string>(); // nombre descubierto → nombre de la consulta que lo arrastra
  for (const n of frontier) origin.set(n, n);

  let examined = frontier.length;
  for (let level = 0; level < depth && frontier.length; level++) {
    const found = new Map<string, Set<string>>(); // nombre → nombres base
    const add = (parent: string, child: string) => {
      if (!found.has(parent)) found.set(parent, new Set());
      found.get(parent)!.add(child.toUpperCase());
    };
    for (const chunk of chunks(frontier, 60)) {
      const classic = chunk.filter((n) => n.length <= 30); // DD26S-VIEWNAME es C(30): un literal más largo lo rechaza SAP
      if (classic.length) {
        const views = await sap.query(`SELECT viewname, tabname FROM dd26s WHERE viewname IN ( ${classic.map(sqlLiteral).join(", ")} )`, 5000);
        for (const v of views.values) add(String(v.VIEWNAME).trim(), String(v.TABNAME).trim());
      }
      let ddls: { values: Record<string, any>[] } = { values: [] };
      try {
        ddls = await sap.query(`SELECT ddlname, objectname FROM ddldependency WHERE objectname IN ( ${chunk.map(sqlLiteral).join(", ")} )`, 2000);
      } catch (e) {
        const te = normalizeError(e);
        // Solo un release sin CDS (la tabla no existe) permite seguir; cualquier otro fallo cierra.
        if (!(te.kind === "SAP" && /DDLDEPENDENCY/i.test(te.message))) {
          throw new ToolError("POLICY", `No se pudo comprobar qué CDS intervienen en la consulta (${te.message}): no se ejecuta sin esa comprobación.`);
        }
      }
      const byDdl = new Map<string, string[]>();
      for (const d of ddls.values) {
        const ddl = String(d.DDLNAME).trim();
        byDdl.set(ddl, [...(byDdl.get(ddl) ?? []), String(d.OBJECTNAME).trim()]);
      }
      if (byDdl.size) {
        const c = await sap.adt();
        for (const [ddl, objs] of byDdl) {
          let src: string;
          try {
            src = await c.getObjectSource(`/sap/bc/adt/ddic/ddl/sources/${adtPathName(ddl)}/source/main`);
          } catch (e) {
            throw new ToolError("POLICY", `No se pudo comprobar qué tablas lee la CDS ${ddl} (${normalizeError(e).message}): la consulta no se ejecuta sin esa comprobación.`);
          }
          for (const o of objs) for (const w of candidateNames(src, 400)) if (w !== o && w !== ddl) add(o, w);
        }
      }
    }

    const next: string[] = [];
    for (const [parent, children] of found) {
      const root = origin.get(parent) ?? parent;
      const hits = sensitiveHits(children);
      if (hits.secrets.length || hits.hr.length) rejectSensitive(hits, `${root}${root !== parent ? ` → ${parent}` : ""}`);
      for (const ch of children) {
        if (!origin.has(ch) && !cache.has(ch)) {
          origin.set(ch, root);
          next.push(ch);
        }
      }
    }
    examined += next.length;
    if (examined > MAX_EXAMINED) {
      throw new ToolError("POLICY", `La consulta arrastra más de ${MAX_EXAMINED} tablas y vistas: demasiado para comprobar que no lee datos vetados.`, "Consulta las tablas base directamente.");
    }
    frontier = next;
  }
  // Solo se recuerdan como limpios los nombres de la consulta: si algo hubiera saltado, ya habríamos lanzado.
  for (const n of candidateNames(sql)) cache.set(n, []);
}

export interface GuardedResult {
  columns: string[];
  values: Record<string, any>[];
  cap: number;
  capped: boolean;
  notes: string[];
}

/** Toda consulta de datos del usuario pasa por aquí: veto, vistas, tope y enmascarado. */
export async function guardedQuery(sap: SapConnection, system: SystemConfig, sql: string, requestedRows: number): Promise<GuardedResult> {
  const q = assertSelectOnly(sql);
  assertNotSensitive(q);
  await assertNoSensitiveViews(sap, q);
  const cls = dataClassOf(system);
  const cap = Math.min(requestedRows, rowCap(system));
  const r = await sap.query(q, cap);
  const columns = r.columns.map((c) => c.name);
  // «SELECT *» no nombra las columnas: el veto se aplica también a lo que DEVUELVE SAP. Si llega alguna vetada, se
  // descarta el resultado entero antes de mostrar nada.
  const vetoed = columns.filter((c) => SENSITIVE_COLUMNS.includes(c.toUpperCase()));
  if (vetoed.length) {
    r.values.length = 0;
    throw new ToolError(
      "POLICY",
      `Consulta bloqueada: el resultado incluye columnas de credenciales (${vetoed.join(", ")}). Pide las columnas concretas que necesitas, sin esas.`,
    );
  }
  const notes: string[] = [];
  const masked = maskPii(cls, q, columns, r.values, system.piiColumns ?? []);
  if (masked.length) notes.push(`Columnas personales enmascaradas (sistema con datos ${cls === "prod" ? "productivos" : "enmascarados"}): ${masked.join(", ")}.`);
  const capped = r.values.length >= cap;
  if (capped) {
    notes.push(
      cap < requestedRows
        ? `Tope de ${cap} filas de ${system.id} (datos ${cls}) alcanzado: puede haber más. Agrega o filtra en vez de pedir más filas.`
        : `Tope de ${cap} filas alcanzado: puede haber más.`,
    );
  }
  return { columns, values: r.values, cap, capped, notes };
}
