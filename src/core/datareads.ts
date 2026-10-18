import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Qué datos leyó una tool: tablas, columnas enmascaradas y cuántas filas salieron. Nunca los valores. Es la materia
 * prima del evento `data_read` del registro de auditoría y, después, del módulo de acceso elevado: quién leyó qué,
 * de qué sistema y cuándo.
 */
export interface DataRead {
  tables: string[];
  maskedColumns: string[];
  rows: number;
  capped: boolean;
  /** Categorías de datos presentes (SEG_ROLES, HCM_*, PERSONAS_NEGOCIO) y las que se leyeron con elevación. */
  categories?: string[];
  elevated?: string[];
}

const store = new AsyncLocalStorage<DataRead[]>();

/** Recoge las lecturas de datos que ocurran dentro de fn (sql_query, table_contents, count_rows…). */
export async function withDataReads<T>(fn: () => Promise<T>): Promise<{ result: T; reads: DataRead[] }> {
  const reads: DataRead[] = [];
  const result = await store.run(reads, fn);
  return { result, reads };
}

/** La política de datos la llama en cada consulta de datos de negocio. Fuera de una tool (tests, scripts) no hace nada. */
export function noteDataRead(read: DataRead): void {
  store.getStore()?.push(read);
}

/** Una tool puede consultar varias veces: en el registro queda una sola entrada con la unión. */
export function mergeReads(reads: DataRead[]): DataRead & { queries: number; categories: string[]; elevated: string[] } {
  const tables = new Set<string>();
  const masked = new Set<string>();
  const categories = new Set<string>();
  const elevated = new Set<string>();
  let rows = 0;
  let capped = false;
  for (const r of reads) {
    r.tables.forEach((t) => tables.add(t));
    r.maskedColumns.forEach((c) => masked.add(c));
    r.categories?.forEach((c) => categories.add(c));
    r.elevated?.forEach((c) => elevated.add(c));
    rows += r.rows;
    capped ||= r.capped;
  }
  return { tables: [...tables].sort(), maskedColumns: [...masked].sort(), rows, capped, queries: reads.length, categories: [...categories].sort(), elevated: [...elevated].sort() };
}

const NOT_A_TABLE = new Set(["SELECT", "WITH", "DISTINCT", "SINGLE", "FROM", "JOIN", "WHERE", "ON", "AS", "INNER", "LEFT", "RIGHT", "OUTER", "CROSS", "UNION", "ALL"]);

/**
 * Tablas, vistas o entidades que nombra una consulta: lo que sigue a FROM y a JOIN (sin literales ni alias). Una
 * subconsulta («FROM ( SELECT …») no aporta nombre en esa posición; sus propias FROM/JOIN sí se recogen.
 */
export function tablesOf(sql: string): string[] {
  const words = sql.replace(/'(?:[^']|'')*'/g, " ").toUpperCase().match(/[A-Z0-9_/]+|[(),]/g) ?? [];
  const out = new Set<string>();
  for (let i = 0; i < words.length - 1; i++) {
    if (words[i] !== "FROM" && words[i] !== "JOIN") continue;
    const next = words[i + 1];
    if (NOT_A_TABLE.has(next) || !/^[A-Z/]/.test(next)) continue;
    out.add(next);
  }
  return [...out];
}
