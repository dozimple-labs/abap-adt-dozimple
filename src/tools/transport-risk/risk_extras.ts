import { z } from "zod";
import type { SapConnection } from "../../core/connection.js";
import { addNote } from "../../core/notes.js";
import { sqlLiteral } from "../../core/objects.js";
import { assertTrkorr } from "../../core/policy.js";
import { defineTool } from "../../core/tool.js";
import { callRiskService, RISK_MODULE, sidParam } from "./_service.js";

/**
 * El resto de modos del servicio /sap/bc/zdz_risk (DoZimple Transport Risk).
 * Todos son de solo lectura y devuelven JSON.
 */
const months = z.number().int().min(0).max(120).optional().describe("Ventana en meses; 0 = todo el historial");

const importHealth = defineTool({
  name: "import_health",
  title: "Salud de importaciones",
  description:
    "Salud de las importaciones de un destino (calidad o productivo): responde «¿cómo van los pases a productivo?». " +
    "Códigos de retorno: 0 limpio, 4 avisos (normal), ≥8 errores.",
  access: "read",
  requires: { module: RISK_MODULE },
  input: { target: sidParam("Destino a revisar"), max: z.number().int().min(1).max(500).optional() },
  run: ({ target, max }, { system }) => callRiskService(system, { mode: "DEV", health: target, max: max?.toString() }),
});

const failureRanking = defineTool({
  name: "failure_ranking",
  title: "Objetos que más fallan al importar",
  description:
    "Ranking de objetos por historial de fallos de importación en un destino. Sirve para saber qué objetos " +
    "vigilar en un pase y dónde se concentra el riesgo.",
  access: "read",
  requires: { module: RISK_MODULE },
  input: { target: sidParam("Destino"), months },
  run: ({ target, months: m }, { system }) => callRiskService(system, { mode: "DEV", ranking: target, months: m?.toString() }),
});

const changeAudit = defineTool({
  name: "change_audit",
  title: "Evidencia de auditoría de cambios",
  description:
    "Evidencia para una auditoría de gestión de cambios en un destino: qué entró, con qué ticket, de qué " +
    "iniciativa y origen. `tickets`, `iniciativas` y `origenes` son lo que la organización declara y el sistema no " +
    "puede deducir (p. ej. tickets «CHG,INC,^RFC»; iniciativas «10001=Proyecto demo,^BC=Basis»).",
  access: "read",
  requires: { module: RISK_MODULE },
  input: {
    target: sidParam("Destino auditado"),
    months,
    tickets: z.string().optional(),
    iniciativas: z.string().optional(),
    origenes: z.string().optional(),
  },
  run: (a, { system }) =>
    callRiskService(system, {
      mode: "DEV",
      audit: a.target,
      months: a.months?.toString(),
      tickets: a.tickets,
      iniciativas: a.iniciativas,
      origenes: a.origenes,
    }),
});

const objectHistory = defineTool({
  name: "object_transport_history",
  title: "Historial de transportes de un objeto",
  description:
    "Qué órdenes han tocado un objeto, cuándo, y cuáles llegaron ya al destino. Útil para «¿esto ya está en productivo?» " +
    "y para encontrar la orden que introdujo un cambio.",
  access: "read",
  requires: { module: RISK_MODULE },
  input: {
    object: z.string().min(1).describe("Nombre del objeto"),
    object_type: z.string().optional().describe("Tipo E071 (REPS, CLAS, FUNC, TABL…). Por defecto REPS"),
    target: sidParam("Destino contra el que mirar qué llegó"),
  },
  run: ({ object, object_type, target }, { system }) =>
    callRiskService(system, { mode: "DEV", history: target, object: object.toUpperCase(), type: object_type?.toUpperCase() }),
});

/**
 * El servicio lee fuentes por nombre de programa o include; un módulo de función vive en L<grupo>Unn. Se resuelve con
 * TFDIR de desarrollo (PNAME = SAPL<grupo>, con namespace delante si lo hay). undefined si el nombre no es un módulo.
 */
export async function functionInclude(sap: Pick<SapConnection, "query">, name: string): Promise<string | undefined> {
  if (!/^(\/[A-Z0-9_]+\/)?[A-Z0-9_]+$/.test(name)) return undefined;
  let row: Record<string, unknown> | undefined;
  try {
    row = (await sap.query(`SELECT pname, include FROM tfdir WHERE funcname = ${sqlLiteral(name)}`, 1)).values[0];
  } catch {
    return undefined;
  }
  const pname = String(row?.PNAME ?? "").trim();
  const nn = String(row?.INCLUDE ?? "").trim();
  const m = /^(\/[A-Z0-9_]+\/)?SAPL(.+)$/.exec(pname);
  if (!m || !/^\d{2}$/.test(nn)) return undefined;
  return `${m[1] ?? ""}L${m[2]}U${nn}`;
}

const remoteSource = defineTool({
  name: "remote_source",
  title: "Fuente en el destino",
  description:
    "La fuente de un objeto TAL COMO ESTÁ en calidad o productivo, leída por el canal de TMS (como «Traer versiones remotas»). " +
    "Compárala con get_source en DEV para ver qué cambia de verdad con un pase. Admite el nombre de un módulo de " +
    "función: se traduce a su include (L<grupo>Unn) con el directorio de funciones de desarrollo.",
  access: "read",
  requires: { module: RISK_MODULE },
  input: { object: z.string().min(1), target: sidParam("Sistema del que traer la fuente") },
  async run({ object, target }, { system, sap }) {
    const name = object.trim().toUpperCase();
    const include = await functionInclude(sap, name);
    if (include) addNote(`${name} es un módulo de función: se trae su include ${include} (número de include según desarrollo; si en el destino el grupo tiene otro orden, puede ser otro módulo).`);
    return callRiskService(system, { mode: "DEV", remote_source: target, object: include ?? name });
  },
});

const sourceCheck = defineTool({
  name: "transport_source_check",
  title: "Código de una orden contra el destino",
  description:
    "Compara el código de los objetos de una orden con el del destino: objetos que no existen allí (R3.4) y deriva " +
    "de versión — firmas, campos o parámetros distintos que no viajan en la orden (R3.5). Necesita el agente en el " +
    "destino con S_RFC: si viene `comprobaciones_fallidas`, NO se comprobó (no es «sin riesgos»).",
  access: "read",
  requires: { module: RISK_MODULE },
  input: { transport_id: z.string(), target: sidParam("Destino") },
  run: ({ transport_id, target }, { system }) =>
    callRiskService(system, { mode: "DEV", srccheck: target, trkorr: assertTrkorr(transport_id, "transport_id") }),
});

export default [importHealth, failureRanking, changeAudit, objectHistory, remoteSource, sourceCheck];
