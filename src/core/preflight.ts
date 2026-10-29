import type { SapConnection } from "./connection.js";
import { sqlLiteral, type ResolvedObject } from "./objects.js";
import { describeOrder, orderHeaders } from "./transport.js";

/**
 * Lo que edit_preflight y object_context comparten: la entrada de TADIR que manda sobre un objeto y los bloqueos
 * reales del CTS (TLOCK) que decidirán a qué orden irá cualquier cambio.
 */

/** Entrada de TADIR que manda sobre el objeto (un módulo de función pertenece a su grupo). */
export async function tadirKey(sap: Pick<SapConnection, "query">, obj: ResolvedObject): Promise<{ object: string; name: string }> {
  if (obj.type.startsWith("FUGR/FF")) {
    const r = await sap.query(`SELECT area FROM enlfdir WHERE funcname = ${sqlLiteral(obj.name)}`, 1);
    if (r.values[0]?.AREA) return { object: "FUGR", name: r.values[0].AREA };
  }
  return { object: obj.type.slice(0, 4), name: obj.name };
}

export interface TadirInfo {
  devclass: string;
  srcsystem: string;
  author: string;
  found: boolean;
}

/** Paquete, sistema original y autor según el directorio de objetos. */
export async function tadirInfo(sap: Pick<SapConnection, "query">, key: { object: string; name: string }, fallbackPackage = ""): Promise<TadirInfo> {
  const r = await sap.query(
    `SELECT devclass, srcsystem, author FROM tadir WHERE pgmid = 'R3TR' AND object = ${sqlLiteral(key.object)} AND obj_name = ${sqlLiteral(key.name)}`,
    1,
  );
  const t = r.values[0];
  if (!t) return { devclass: fallbackPackage, srcsystem: "", author: "", found: false };
  return { devclass: String(t.DEVCLASS ?? fallbackPackage), srcsystem: String(t.SRCSYSTEM ?? "").trim(), author: String(t.AUTHOR ?? "").trim(), found: true };
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
export const likeEscape = (s: string) => s.replace(/[#%_]/g, (c) => "#" + c);

export interface CtsLock {
  /** Orden (padre) que tiene el bloqueo. */
  order: string;
  description: string;
}

/**
 * Bloqueos del CTS sobre el objeto: TLOCK por LOKEY, resueltos a la orden padre de la tarea que los tiene. Es lo que
 * SAP impondrá al guardar: con un bloqueo ajeno, cualquier cambio acabará en esa orden.
 */
export async function ctsLocks(sap: Pick<SapConnection, "query">, key: { object: string; name: string }): Promise<CtsLock[]> {
  const locks = await sap.query(
    `SELECT object, lokey, trkorr FROM tlock WHERE lokey LIKE ${sqlLiteral("%" + likeEscape(key.name) + "%")} ESCAPE '#'`,
    200,
  );
  const re = new RegExp(`(^|[^A-Z0-9_/])${escapeRegExp(key.name)}($|[^A-Z0-9_])`);
  const mine = locks.values.filter((l) => re.test(String(l.LOKEY).trimEnd()) || String(l.LOKEY).trimEnd().startsWith(key.name));
  const heads = await orderHeaders(sap as SapConnection, mine.map((l) => l.TRKORR));
  const parents = await orderHeaders(sap as SapConnection, [...heads.values()].map((h) => h.parent));
  const out = new Map<string, CtsLock>();
  for (const l of mine) {
    const task = heads.get(l.TRKORR);
    const order = task?.parent ? parents.get(task.parent) ?? task : task;
    const id = order?.trkorr ?? l.TRKORR;
    if (!out.has(id)) out.set(id, { order: id, description: `${order ? describeOrder(order) : id} [TLOCK ${l.OBJECT} ${String(l.LOKEY).trim()}]` });
  }
  return [...out.values()];
}
