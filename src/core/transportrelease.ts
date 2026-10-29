import type { SapConnection } from "./connection.js";
import { sqlLiteral } from "./objects.js";
import { ctsLocks } from "./preflight.js";
import { describeOrder, isOpen, orderEntries, orderHeaders, TRFUNCTION, TRSTATUS, type OrderHeader } from "./transport.js";

/**
 * Lo que se mira antes de liberar una orden o una tarea. Los bloqueantes son daños reales, no estilo: una tarea
 * ajena sin liberar impide la orden, y un objeto cuyo bloqueo del CTS tiene otra orden se iría con los cambios sin
 * liberar de esa otra orden (R15, lo típico en un transporte de copias). La liberación solo la decide una persona:
 * nada aquí ignora bloqueos ni el ATC de liberación.
 */

/** Objetos R3TR que se revisan contra TLOCK; más allá, se dice que no se miró todo. */
export const LOCK_CHECK_CAP = 60;

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

  // R15: el bloqueo del CTS lo tiene otra orden.
  const keys = [...new Map(entries.filter((e) => e.PGMID === "R3TR").map((e) => [`${e.OBJECT} ${e.OBJ_NAME}`, { object: e.OBJECT, name: e.OBJ_NAME.trim() }])).values()];
  for (const k of keys.slice(0, LOCK_CHECK_CAP)) {
    for (const l of await ctsLocks(sap, k)) {
      if (l.order !== root) {
        blockers.push(`${k.object} ${k.name}: el bloqueo del CTS lo tiene ${l.description}. Al liberar, ${scope} se lleva lo que haya en desarrollo, incluidos los cambios sin liberar de esa orden.`);
      }
    }
  }
  if (keys.length > LOCK_CHECK_CAP) notes.push(`Solo se revisaron los bloqueos del CTS de ${LOCK_CHECK_CAP} de ${keys.length} objetos.`);

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
