import { z } from "zod";
import { ToolError } from "../../core/errors.js";
import { defineTool } from "../../core/tool.js";
import { callRiskService, RISK_MODULE, sidParam } from "./_service.js";

/** Analizador de riesgo de transportes (DoZimple Transport Risk). */
export default defineTool({
  name: "analyze_transport_risk",
  title: "Riesgo de transporte",
  description:
    "Dice si una orden, o un pase de varias separadas por coma, es segura para calidad o productivo: tareas sin " +
    "liberar, importación, dependencias que no viajan, acceso posicional, bloqueos CTS, cola. Primera llamada sin " +
    "include_source. Un pase se analiza junto, no orden a orden. queue_system analiza la cola completa de un " +
    "destino.",
  access: "read",
  requires: { module: RISK_MODULE },
  input: {
    transport_id: z.string().optional().describe("Orden o lista separada por coma: DEVK900123,DEVK900124"),
    check_mode: sidParam("Contra qué sistema comparar: DEV (el propio) o el SID del destino. Si el usuario no lo dice, pregúntalo").default("DEV"),
    include_source: z.boolean().default(false),
    include_where_used: z.boolean().default(false).describe("Solo si la orden lleva tablas o estructuras: es lo más caro"),
    queue_system: sidParam("Analizar la cola de importación de este destino en vez de órdenes").optional(),
    queue_max: z.number().int().min(1).optional(),
  },
  async run(args, { system }) {
    const ids = String(args.transport_id ?? "")
      .split(/[,;\s]+/)
      .map((t) => t.trim().toUpperCase())
      .filter(Boolean)
      .join(",");
    if (args.queue_system) {
      return callRiskService(system, { mode: args.check_mode, queue: args.queue_system, max: args.queue_max?.toString() });
    }
    if (!ids) throw new ToolError("INPUT", "Indica transport_id, o queue_system para analizar la cola de un destino.");
    return callRiskService(system, {
      mode: args.check_mode,
      trkorr: ids,
      source: args.include_source ? "X" : undefined,
      where_used: args.include_where_used ? "X" : undefined,
    });
  },
});
