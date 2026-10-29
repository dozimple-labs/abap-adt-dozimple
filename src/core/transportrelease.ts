import type { SapConnection } from "./connection.js";
import { sqlLiteral } from "./objects.js";
import { likeEscape } from "./preflight.js";
import { describeOrder, isOpen, orderEntries, orderHeaders, TRFUNCTION, TRSTATUS, type OrderHeader } from "./transport.js";

/**
 * Lo que se mira antes de liberar una orden o una tarea. Los bloqueantes son daños reales, no estilo: una tarea
 * ajena sin liberar impide la orden, y un objeto cuyo bloqueo del CTS tiene otra orden se iría con los cambios sin
 * liberar de esa otra orden (R15, lo típico en un transporte de copias). La liberación solo la decide una persona:
 * nada aquí ignora bloqueos ni el ATC de liberación.
 */

/** Objetos que se revisan contra TLOCK; más allá, se dice que no se miró todo. */
export const LOCK_CHECK_CAP = 60;

/**
 * ¿Aparece el objeto en la clave de un bloqueo? La clave de TLOCK no es solo el nombre: un módulo de función o un
 * include de grupo van dentro de la clave del grupo («ZGRUPO   FUNCZMODULO», «… PROGLZGRUPOF01  REPOREPS»), así que
 * se compara cada trozo de la clave con el nombre, solo o tras un tipo de cuatro letras.
 */
export function lockKeyHas(lokey: string, name: string): boolean {
  return lokey.trim().split(/\s+/).some((t) => t === name || (t.length === name.length + 4 && t.endsWith(name) && /^[A-Z]{4}$/.test(t.slice(0, 4))));
}

/** Bloqueos del CTS de unos objetos (R3TR o LIMU), resueltos a la orden que los tiene. */
async function locksOf(sap: SapConnection, names: string[]): Promise<Map<string, OrderHeader[]>> {
  const hits: Array<{ name: string; trkorr: string }> = [];
  for (let i = 0; i < names.length; i += 10) {
    const part = names.slice(i, i + 10);
    const where = part.map((n) => `lokey LIKE ${sqlLiteral("%" + likeEscape(n) + "%")} ESCAPE '#'`).join(" OR ");
    const r = await sap.query(`SELECT lokey, trkorr FROM tlock WHERE ${where}`, 500);
    for (const l of r.values) for (const n of part) if (lockKeyHas(String(l.LOKEY), n)) hits.push({ name: n, trkorr: String(l.TRKORR) });
  }
  const heads = await orderHeaders(sap, hits.map((h) => h.trkorr));
  const parents = await orderHeaders(sap, [...heads.values()].map((h) => h.parent).filter(Boolean));
  const out = new Map<string, OrderHeader[]>();
  for (const h of hits) {
    const task = heads.get(h.trkorr);
    const order = task?.parent ? parents.get(task.parent) ?? task : task;
    if (!order) continue;
    const list = out.get(h.name) ?? [];
    if (!list.some((o) => o.trkorr === order.trkorr)) list.push(order);
    out.set(h.name, list);
  }
  return out;
}

export interface ReleaseAssessment {
  target: OrderHeader;
  /** La orden padre si se libera una tarea; la propia orden si no. */
  order: OrderHeader;
  isTask: boolean;
  tasks: OrderHeader[];
  objects: number;
  blockers: string[];
  notes: string[];
}

const same = (a: string, b: string) => a.trim().toUpperCase() === b.trim().toUpperCase();

export async function assessRelease(sap: SapConnection, trkorr: string, myUser: string): Promise<ReleaseAssessment | undefined> {
  const id = trkorr.trim().toUpperCase();
  const target = (await orderHeaders(sap, [id])).get(id);
  if (!target) return undefined;
  const isTask = !!target.parent?.trim();
  const order = isTask ? (await orderHeaders(sap, [target.parent])).get(target.parent) ?? target : target;
  const root = order.trkorr;

  const taskRows = await sap.query(`SELECT trkorr FROM e070 WHERE strkorr = ${sqlLiteral(root)}`, 500);
  const tasks = [...(await orderHeaders(sap, taskRows.values.map((v) => v.TRKORR as string))).values()];
  const blockers: string[] = [];
  const notes: string[] = [];

  if (!isOpen(target.trstatus)) blockers.push(`${id} ya no está modificable (${TRSTATUS[target.trstatus] ?? target.trstatus}): no hay nada que liberar.`);
  if (!same(target.owner, myUser)) {
    blockers.push(`${id} es de ${target.owner}, no del usuario de esta conexión: la libera su responsable.`);
  }
  if (!isTask) {
    for (const t of tasks.filter((t) => isOpen(t.trstatus))) {
      blockers.push(
        same(t.owner, myUser)
          ? `La tarea ${t.trkorr} sigue sin liberar: libérala antes (release_transport con ${t.trkorr}).`
          : `La tarea ${t.trkorr} de ${t.owner} sigue sin liberar: tiene que liberarla ${t.owner} antes que la orden.`,
      );
    }
  }

  const scope = isTask ? id : root;
  const entries = isTask
    ? (await sap.query(`SELECT pgmid, object, obj_name FROM e071 WHERE trkorr = ${sqlLiteral(id)}`, 5000)).values as unknown as Array<{ PGMID: string; OBJECT: string; OBJ_NAME: string }>
    : await orderEntries(sap, root);
  if (!entries.length) notes.push(`${scope} no tiene objetos: la liberación no transporta nada.`);

  // R15: el bloqueo del CTS lo tiene otra orden. Las entradas LIMU cuentan: un transporte de copias suele llevarlas.
  const objs = [...new Map(entries.filter((e) => e.PGMID === "R3TR" || e.PGMID === "LIMU").map((e) => [e.OBJ_NAME.trim(), `${e.OBJECT} ${e.OBJ_NAME.trim()}`])).entries()];
  const locks = await locksOf(sap, objs.slice(0, LOCK_CHECK_CAP).map(([n]) => n));
  // Si la orden que bloquea es de otra persona, se llevarían su trabajo sin liberar: no se libera. Si es propia
  // (la copia de la orden en curso para probar en calidad), es el uso normal: se avisa de qué estado viaja.
  const ownLocks = new Map<string, string[]>();
  for (const [name, label] of objs.slice(0, LOCK_CHECK_CAP)) {
    for (const o of (locks.get(name) ?? []).filter((o) => o.trkorr !== root)) {
      if (same(o.owner, myUser)) ownLocks.set(o.trkorr, [...(ownLocks.get(o.trkorr) ?? []), label]);
      else blockers.push(`${label}: el bloqueo del CTS lo tiene ${describeOrder(o)}. Al liberar, ${scope} se lleva lo que haya en desarrollo, incluidos los cambios sin liberar de ${o.owner}.`);
    }
  }
  for (const [tr, labels] of ownLocks) {
    notes.push(`${labels.length} objeto(s) los tiene bloqueados tu orden ${tr} (${labels.slice(0, 3).join(", ")}${labels.length > 3 ? "…" : ""}): viaja su estado actual en desarrollo, también lo que aún no esté activado o terminado.`);
  }
  if (objs.length > LOCK_CHECK_CAP) notes.push(`Solo se revisaron los bloqueos del CTS de ${LOCK_CHECK_CAP} de ${objs.length} objetos.`);

  if (isTask) {
    notes.push(`Liberar la tarea no transporta nada: la orden ${root} sigue abierta.`);
  } else if (!order.tarsystem?.trim()) {
    notes.push(`${root} no tiene sistema destino: se libera, pero no llega a ninguna cola de importación.`);
  } else {
    notes.push(
      `Al liberar, ${root} (${TRFUNCTION[order.trfunction] ?? order.trfunction}) se exporta y queda en la cola de ${order.tarsystem.trim()}. ` +
        "No se importa nada: eso lo hace Basis en STMS.",
    );
  }
  return { target, order, isTask, tasks, objects: entries.length, blockers, notes };
}

export function describeAssessment(a: ReleaseAssessment): string {
  const lines = [`${a.isTask ? "Tarea" : "Orden"}: ${describeOrder(a.target)}`];
  if (a.isTask) lines.push(`De la orden: ${describeOrder(a.order)}`);
  lines.push(`Objetos: ${a.objects}`);
  if (!a.isTask && a.tasks.length) {
    lines.push("Tareas:", ...a.tasks.map((t) => `  ${t.trkorr} · ${t.owner} · ${TRSTATUS[t.trstatus] ?? t.trstatus}`));
  }
  if (a.notes.length) lines.push("", "Tener en cuenta:", ...a.notes.map((n) => "  · " + n));
  return lines.join("\n");
}
