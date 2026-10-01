import type { ADTClient, ActivationResult, InactiveObject } from "abap-adt-api";
import type { ResolvedObject } from "./objects.js";

export interface ActivationOutcome {
  ok: boolean;
  text: string;
}

/**
 * Activa y lo cuenta tal cual: errores, avisos y objetos que quedan
 * inactivos. Un fallo nunca se presenta como «ya estaba activo».
 */
export async function activateObject(c: ADTClient, obj: ResolvedObject): Promise<ActivationOutcome> {
  return describeActivation(await c.activate(obj.name, obj.uri), obj.name);
}

/**
 * Activa varios objetos en UNA sola activación de SAP, que es lo que resuelve dependencias mutuas (clase ↔ interfaz,
 * programa ↔ include, DDIC ↔ código): activados de uno en uno, el primero falla porque el otro aún está inactivo.
 */
export async function activateObjects(c: ADTClient, objs: InactiveObject[]): Promise<ActivationOutcome> {
  const label = objs.length === 1 ? objs[0]["adtcore:name"] : `Los ${objs.length} objetos`;
  return describeActivation(await c.activate(objs), label, objs.length > 1);
}

function describeActivation(r: ActivationResult, label: string, plural = false): ActivationOutcome {
  const errors = r.messages.filter((m) => ["E", "A", "X"].includes(m.type?.toUpperCase()));
  const lines = r.messages.map((m) => `  ${m.type}${m.line ? ` L${m.line}` : ""}  ${m.shortText}${m.objDescr ? `  [${m.objDescr}]` : ""}`);
  const inactive = r.inactive
    .map((i) => i.object?.["adtcore:name"])
    .filter(Boolean);
  const ok = r.success && errors.length === 0;
  const text =
    (ok ? `${label} ${plural ? "activados" : "activado"}.` : `${label} NO ${plural ? "se activaron" : "se activó"}.`) +
    (lines.length ? `\n\nMensajes:\n${lines.join("\n")}` : "") +
    (inactive.length ? `\n\nQuedan inactivos (actívalos juntos si dependen entre sí): ${inactive.join(", ")}` : "");
  return { ok, text };
}
