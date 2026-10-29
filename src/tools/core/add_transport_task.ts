import { z } from "zod";
import type { SapConnection } from "../../core/connection.js";
import { ToolError } from "../../core/errors.js";
import { SAP_USER_RE } from "../../core/policy.js";
import { defineTool } from "../../core/tool.js";
import { describeOrder, isOpen, orderHeaders, TRSTATUS } from "../../core/transport.js";
import { sqlLiteral } from "../../core/objects.js";

const TRKORR_RE = /^[A-Z0-9]{3}K\d{6}$/;

async function inspect(sap: SapConnection, order: string, user: string) {
  const h = (await orderHeaders(sap, [order])).get(order);
  if (!h) throw new ToolError("NOT_FOUND", `${order} no existe en este sistema.`);
  if (h.parent?.trim()) throw new ToolError("INPUT", `${order} es una tarea de ${h.parent}: las tareas se añaden a la orden.`);
  if (!isOpen(h.trstatus)) throw new ToolError("INPUT", `${order} no está modificable (${TRSTATUS[h.trstatus] ?? h.trstatus}).`);
  const rows = await sap.query(`SELECT trkorr, as4user, trstatus FROM e070 WHERE strkorr = ${sqlLiteral(order)}`, 500);
  const own = rows.values.filter((r) => String(r.AS4USER).trim().toUpperCase() === user && isOpen(String(r.TRSTATUS)));
  return { h, tasks: rows.values, own };
}

export default defineTool({
  name: "add_transport_task",
  title: "Añadir tarea a una orden",
  description:
    "Añade a una orden abierta una tarea para un usuario (por defecto, el de la conexión), como «Añadir usuario» en " +
    "SE09. Sirve para trabajar en la orden de otra persona sin crear una orden nueva. La vista previa muestra la orden " +
    "y sus tareas, y avisa si ese usuario ya tiene una tarea abierta en ella. No libera nada.",
  access: "write",
  requires: { adt: ["/sap/bc/adt/cts/transports"] },
  input: {
    transport: z.string().min(10).max(20).describe("Orden (no tarea) a la que se añade la tarea"),
    user: z.string().regex(SAP_USER_RE).optional().describe("Usuario SAP de la tarea (por defecto, el de la conexión)"),
  },
  async preview({ transport, user }, { sap, system }) {
    const order = transport.trim().toUpperCase();
    if (!TRKORR_RE.test(order)) throw new ToolError("INPUT", `«${transport}» no parece una orden de transporte (XXXK999999).`);
    const who = (user ?? system.user).trim().toUpperCase();
    const { h, tasks, own } = await inspect(sap, order, who);
    if (own.length) throw new ToolError("INPUT", `${who} ya tiene la tarea abierta ${own[0].TRKORR} en ${order}: úsala, no hace falta otra.`);
    const list = tasks.length ? tasks.map((t) => `  ${t.TRKORR} · ${t.AS4USER} · ${TRSTATUS[t.TRSTATUS] ?? t.TRSTATUS}`).join("\n") : "  (ninguna)";
    return `Se añadirá una tarea para ${who} en:\n  ${describeOrder(h)}\nTareas actuales:\n${list}\nNo se libera nada.`;
  },
  async run({ transport, user }, { sap, system }) {
    const order = transport.trim().toUpperCase();
    const who = (user ?? system.user).trim().toUpperCase();
    const { own } = await inspect(sap, order, who);
    if (own.length) throw new ToolError("INPUT", `${who} ya tiene la tarea abierta ${own[0].TRKORR} en ${order}.`);
    const c = await sap.adt();
    await c.transportAddUser(order, who);
    // La respuesta de ADT no trae el número de la tarea: se lee de E070.
    const task = (await inspect(sap, order, who)).own[0]?.TRKORR;
    if (!task) return { text: `SAP respondió sin error, pero no aparece ninguna tarea abierta de ${who} en ${order}. Revísalo en SE09.`, isError: true };
    return `Tarea ${task} añadida para ${who} en ${order}.`;
  },
});
