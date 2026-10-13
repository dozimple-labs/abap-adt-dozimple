import type { ADTClient, ActivationResult, InactiveObject } from "abap-adt-api";
import { ToolError } from "./errors.js";
import type { ResolvedObject } from "./objects.js";

export interface ActivationOutcome {
  ok: boolean;
  text: string;
}

/**
 * Activa y lo cuenta tal cual: errores, avisos y objetos que quedan
 * inactivos. Un fallo nunca se presenta como «ya estaba activo».
 *
 * Un include que usan varios programas principales no se puede activar sin decir cuál (SAP: «REPS … se utiliza en
 * varios programas marco»). Con un solo programa principal se usa ese; con varios hace falta `mainProgram` (nombre o
 * URI), y si falta se devuelve la lista para elegir en vez del error de SAP.
 */
export async function activateObject(c: ADTClient, obj: ResolvedObject, mainProgram?: string): Promise<ActivationOutcome> {
  const context = await includeContext(c, obj, mainProgram);
  const first = await c.activate(obj.name, obj.uri, context);
  const own = ownInactive(first, obj);
  if (!own) return describeActivation(first, obj.name);
  // SAP no activó nada y no dio ningún mensaje: devuelve como inactivos el objeto y sus subobjetos (includes de método,
  // módulos de un grupo). Es lo que hace Eclipse al pedir que se elijan; aquí se reintenta UNA vez con esa lista.
  const second = describeActivation(await activateList(c, own), obj.name);
  return second.ok ? { ok: true, text: `${second.text}\n(Segundo intento: SAP pidió activar ${obj.name} junto con sus ${own.length - 1} subobjetos inactivos.)` } : second;
}

/** Contexto de activación de un include: URI del programa principal, o undefined si no aplica. */
async function includeContext(c: ADTClient, obj: ResolvedObject, mainProgram?: string): Promise<string | undefined> {
  if (!obj.type.toUpperCase().startsWith("PROG/I")) return undefined;
  if (mainProgram) return mainProgramUri(mainProgram);
  const mains = await c.mainPrograms(obj.uri).catch(() => []);
  if (mains.length <= 1) return mains[0]?.["adtcore:uri"];
  const names = mains.map((m) => m["adtcore:name"]).join(", ");
  throw new ToolError(
    "INPUT",
    `${obj.name} es un include de ${mains.length} programas principales (${names}): SAP no lo activa sin saber en cuál.`,
    `Repite con main_program=<uno de ellos>; el código del include es el mismo para todos.`,
  );
}

export function mainProgramUri(mainProgram: string): string {
  const m = mainProgram.trim();
  if (m.startsWith("/")) return m;
  if (!/^[A-Za-z0-9_/]+$/.test(m)) throw new ToolError("INPUT", `main_program inválido: ${m}`);
  return `/sap/bc/adt/programs/programs/${encodeURIComponent(m.toLowerCase())}`;
}

/**
 * La lista para reintentar, o undefined si no procede: solo cuando no hubo errores, quedó algo inactivo y TODO lo
 * inactivo con objeto es el propio objeto o uno de sus subobjetos (nunca arrastra objetos ajenos ni borrados
 * pendientes). Las entradas sin objeto (las devuelve SAP en algunos releases) no cuentan.
 */
function ownInactive(r: ActivationResult, obj: ResolvedObject): InactiveObject[] | undefined {
  if (r.messages.some((m) => ["E", "A", "X"].includes(m.type?.toUpperCase()))) return undefined;
  const list = r.inactive.map((i) => i.object).filter((o): o is NonNullable<typeof o> => !!o && !!o["adtcore:uri"]);
  if (list.length < 2) return undefined;
  const base = obj.uri.toLowerCase();
  const mine = (o: (typeof list)[number]) => {
    const uri = (o["adtcore:uri"] ?? "").toLowerCase();
    const parent = (o["adtcore:parentUri"] ?? "").toLowerCase();
    return !o.deleted && (uri === base || uri.startsWith(`${base}/`) || parent === base);
  };
  if (!list.every(mine)) return undefined;
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
  return describeActivation(await activateList(c, objs), label, objs.length > 1);
}

/**
 * La petición de lista de la librería lleva `adtcore:type` y `adtcore:parentUri` (vacío si no se conoce); algún
 * release la rechaza con «precondition failed» (412, o 400 con ese texto) aunque la misma lista se active en Eclipse.
 * En ese caso se repite una vez con referencias mínimas (uri y nombre), que es la forma que SAP acepta para un objeto.
 */
async function activateList(c: ADTClient, objs: InactiveObject[]): Promise<ActivationResult> {
  try {
    return await c.activate(objs);
  } catch (e) {
    if (!isPrecondition(e)) throw e;
    return activateMinimal(c, objs);
  }
}

function isPrecondition(e: unknown): boolean {
  const any = e as { status?: number; err?: number; message?: string } | undefined;
  const st = any?.status ?? any?.err;
  if (st === 412) return true;
  return /precondition|condici[oó]n fallida|condición/i.test(any?.message ?? "");
}

async function activateMinimal(c: ADTClient, objs: InactiveObject[]): Promise<ActivationResult> {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const refs = objs.map((o) => `<adtcore:objectReference adtcore:uri="${esc(o["adtcore:uri"])}" adtcore:name="${esc(o["adtcore:name"])}"/>`);
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">${refs.join("")}</adtcore:objectReferences>`;
  const resp = await c.httpClient.request("/sap/bc/adt/activation", { method: "POST", qs: { method: "activate", preauditRequested: true }, body });
  return parseActivation(String(resp.body ?? ""));
}

/** Lectura mínima de la respuesta de activación (mensajes e inactivos), suficiente para contar el resultado. */
export function parseActivation(xml: string): ActivationResult {
  const attr = (s: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(s)?.[1] ?? "";
  const messages: ActivationResult["messages"] = [];
  for (const m of xml.matchAll(/<msg\b([^>]*)>([\s\S]*?)<\/msg>/g)) {
    const txt = /<txt>([\s\S]*?)<\/txt>/.exec(m[2])?.[1]?.trim();
    messages.push({
      type: attr(m[1], "type"),
      line: Number(attr(m[1], "line")) || undefined,
      objDescr: attr(m[1], "objDescr"),
      shortText: txt || "Syntax error",
    } as ActivationResult["messages"][number]);
  }
  const inactive: ActivationResult["inactive"] = [];
  for (const i of xml.matchAll(/<ioc:ref\b([^>]*)\/>/g)) {
    inactive.push({
      object: {
        "adtcore:name": attr(i[1], "adtcore:name"),
        "adtcore:type": attr(i[1], "adtcore:type"),
        "adtcore:uri": attr(i[1], "adtcore:uri"),
        "adtcore:parentUri": attr(i[1], "adtcore:parentUri"),
      },
    } as ActivationResult["inactive"][number]);
  }
  const success = inactive.length === 0 && !messages.some((m) => /[EAX]/.test(m.type ?? ""));
  return { messages, success, inactive };
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
