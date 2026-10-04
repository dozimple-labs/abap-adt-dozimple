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
  const first = await c.activate(obj.name, obj.uri);
  const own = ownInactive(first, obj);
  if (!own) return describeActivation(first, obj.name);
  // SAP no activó nada y no dio ningún mensaje: devuelve como inactivos la clase y sus includes de método. Es lo que
  // hace Eclipse al pedir que se elijan; aquí se reintenta UNA vez con esa lista, que solo contiene el propio objeto.
  const second = describeActivation(await c.activate(own), obj.name);
  return second.ok ? { ok: true, text: `${second.text}\n(Segundo intento: SAP pidió activar ${obj.name} junto con sus ${own.length - 1} subobjetos inactivos.)` } : second;
}

/**
 * La lista para reintentar, o undefined si no procede: solo cuando no hubo errores, quedó algo inactivo y TODO lo
 * inactivo es el propio objeto o uno de sus subobjetos (nunca arrastra objetos ajenos ni borrados pendientes).
 */
function ownInactive(r: ActivationResult, obj: ResolvedObject): InactiveObject[] | undefined {
  if (r.messages.some((m) => ["E", "A", "X"].includes(m.type?.toUpperCase()))) return undefined;
  const list = r.inactive.map((i) => i.object).filter((o): o is NonNullable<typeof o> => !!o);
  if (!list.length || list.length !== r.inactive.length) return undefined;
  const base = obj.uri.toLowerCase();
  const mine = (o: (typeof list)[number]) => {
    const uri = (o["adtcore:uri"] ?? "").toLowerCase();
    const parent = (o["adtcore:parentUri"] ?? "").toLowerCase();
    return !o.deleted && (uri === base || uri.startsWith(`${base}/`) || parent === base);
  };
  if (!list.every(mine) || list.length < 2) return undefined;
  return list.map((o) => ({
    "adtcore:name": o["adtcore:name"],
    "adtcore:type": o["adtcore:type"],
    "adtcore:uri": o["adtcore:uri"],
    "adtcore:parentUri": o["adtcore:parentUri"] ?? "",
  }));
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
