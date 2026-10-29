import { z } from "zod";
import { ToolError } from "../../core/errors.js";
import { defineTool } from "../../core/tool.js";
import { TRSTATUS, orderHeaders } from "../../core/transport.js";
import { assessRelease, describeAssessment } from "../../core/transportrelease.js";

const TRKORR_RE = /^[A-Z0-9]{3}K\d{6}$/;

export default defineTool({
  name: "release_transport",
  title: "Liberar tarea u orden",
  description:
    "Libera una tarea u orden propia (workbench, customizing o transporte de copias), solo cuando la persona lo pide. " +
    "La vista previa dice a qué cola va y qué lo impide: tareas sin liberar, orden ajena o un bloqueo del CTS de otra " +
    "orden (R15). Nunca ignora bloqueos ni el ATC y no importa nada (eso es STMS). Antes, analyze_transport_risk.",
  access: "write",
  requires: { adt: ["/sap/bc/adt/cts/transports"] },
  input: {
    transport: z.string().min(10).max(20).describe("Tarea u orden a liberar (p. ej. DEVK900123)"),
  },
  async preview({ transport }, { sap, system }) {
    const id = transport.trim().toUpperCase();
    if (!TRKORR_RE.test(id)) throw new ToolError("INPUT", `«${transport}» no parece una orden de transporte (XXXK999999).`);
    const a = await assessRelease(sap, id, system.user);
    if (!a) throw new ToolError("NOT_FOUND", `${id} no existe en este sistema.`);
    if (a.blockers.length) {
      throw new ToolError("POLICY", `No se puede liberar ${id}:\n${a.blockers.map((b) => "  ✗ " + b).join("\n")}\n\n${describeAssessment(a)}`);
    }
    return `Se liberará ${a.isTask ? "la tarea" : "la orden"} ${id}.\n\n${describeAssessment(a)}\n\nUna liberación no se deshace.`;
  },
  async run({ transport }, { sap, system }) {
    const id = transport.trim().toUpperCase();
    // Entre la vista previa y el OK pudo cambiar algo: se vuelve a mirar.
    const a = await assessRelease(sap, id, system.user);
    if (!a) throw new ToolError("NOT_FOUND", `${id} no existe en este sistema.`);
    if (a.blockers.length) throw new ToolError("POLICY", `Ya no se puede liberar ${id}:\n${a.blockers.map((b) => "  ✗ " + b).join("\n")}`);

    const c = await sap.adt();
    const reports = await c.transportRelease(id);
    const msgs = reports.flatMap((r) => r.messages.map((m) => `  [${m["chkrun:type"]}] ${m["chkrun:shortText"]}`));
    const failed = reports.filter((r) => r["chkrun:status"] !== "released");
    const after = (await orderHeaders(sap, [id])).get(id);
    const state = after ? (TRSTATUS[after.trstatus] ?? after.trstatus) : "desconocido";
    const detail = msgs.length ? `\n\nMensajes de SAP:\n${msgs.join("\n")}` : "";
    if (failed.length || (after && after.trstatus === "D")) {
      const why = failed.map((r) => r["chkrun:statusText"]).filter(Boolean).join("; ");
      return { text: `SAP no liberó ${id}${why ? `: ${why}` : ""}. Estado en E070: ${state}.${detail}`, isError: true };
    }
    const queue = !a.isTask && a.order.tarsystem?.trim() ? ` Queda en la cola de ${a.order.tarsystem.trim()}; la importación la hace Basis.` : "";
    return `${id} liberada. Estado en E070: ${state}.${queue}${detail}`;
  },
});
