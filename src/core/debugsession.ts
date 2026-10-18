import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ADTClient, DebugVariable } from "abap-adt-api";
import type { SystemConfig } from "./config.js";
import type { SapConnection } from "./connection.js";
import { dataClassOf, isPersonalColumn, MASK } from "./datapolicy.js";
import { ToolError } from "./errors.js";
import { stateDir } from "./telemetry.js";

/**
 * Depurador de solo lectura (Ola 3, punto 13). Una sesión por sistema y proceso: escucha al usuario de la conexión,
 * se adhiere cuando salta un punto de parada externo y deja leer pila y variables. Libre en sistemas con datos
 * `test`, con las variables personales enmascaradas en `masked`, deshabilitado en `prod`. Nunca cambia valores.
 */
export const IDE_ID = "abap-adt-dozimple";

export interface DebugSession {
  system: string;
  user: string;
  client: ADTClient;
  terminalId: string;
  startedAt: string;
  debuggeeId?: string;
  attached: boolean;
}

export interface SetBreakpoint {
  id: string;
  uri: string;
  line: number;
  object: string;
}

const sessions = new Map<string, DebugSession>();
/** Puntos de parada puestos desde este proceso, por sistema: sobreviven al cierre de la sesión para poder quitarlos. */
const breakpoints = new Map<string, SetBreakpoint[]>();

export const breakpointsOf = (systemId: string): SetBreakpoint[] => breakpoints.get(systemId.toUpperCase()) ?? [];
export function rememberBreakpoint(systemId: string, b: SetBreakpoint): void {
  breakpoints.set(systemId.toUpperCase(), [...breakpointsOf(systemId), b]);
}
export function forgetBreakpoints(systemId: string): void {
  breakpoints.delete(systemId.toUpperCase());
}

/** Id de terminal estable por máquina, como hace Eclipse: así los puntos de parada externos son «de esta máquina». */
export function terminalId(dir = stateDir()): string {
  const file = join(dir, "debugger-terminal.json");
  try {
    // Se lee directamente (sin comprobar-y-usar): si no existe o está corrupto, se regenera.
    const id = JSON.parse(readFileSync(file, "utf8")).terminalId;
    if (typeof id === "string" && id) return id;
  } catch {
    /* se regenera */
  }
  const id = randomUUID().replace(/-/g, "").toUpperCase();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ terminalId: id }), { mode: 0o600 });
  return id;
}

export function assertDebugAllowed(system: SystemConfig): void {
  if (dataClassOf(system) === "prod") {
    throw new ToolError("POLICY", `${system.id} tiene datos productivos: el depurador está deshabilitado en ese caso.`, 'Depura en un sistema de desarrollo con dataClass "test" o "masked".');
  }
}

export function getSession(systemId: string): DebugSession | undefined {
  return sessions.get(systemId.toUpperCase());
}

export async function openSession(sap: SapConnection, system: SystemConfig): Promise<DebugSession> {
  assertDebugAllowed(system);
  const cur = sessions.get(system.id.toUpperCase());
  if (cur) return cur;
  const client = await sap.openStateful();
  const s: DebugSession = { system: system.id, user: system.user.toUpperCase(), client, terminalId: terminalId(), startedAt: new Date().toISOString(), attached: false };
  sessions.set(system.id.toUpperCase(), s);
  return s;
}

const withLimit = <T>(p: Promise<T>, ms: number): Promise<T | "timeout"> => Promise.race([p.catch(() => "timeout" as const), new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms))]);

/**
 * Cierra la sesión: desengancha si hacía falta, quita el listener y cierra la conexión. Nunca lanza ni se queda
 * esperando: la sesión stateful puede estar ocupada con la escucha larga (verificado en vivo: un DELETE por esa misma
 * sesión esperaba 2 minutos), así que el listener se retira por la conexión de lectura y el logout tiene tope.
 */
export async function closeSession(systemId: string, how: "detachDebugger" | "terminateDebuggee" = "detachDebugger", via?: ADTClient): Promise<string[]> {
  const s = sessions.get(systemId.toUpperCase());
  if (!s) return [];
  sessions.delete(systemId.toUpperCase());
  const done: string[] = [];
  if (s.attached) {
    const r = await withLimit(s.client.debuggerStep(how), 20_000);
    done.push(r === "timeout" ? `no se pudo ${how === "terminateDebuggee" ? "terminar" : "desenganchar"} (sin respuesta)` : how === "terminateDebuggee" ? "programa depurado terminado" : "depurador desenganchado");
  }
  const lister = via ?? s.client;
  const d = await withLimit(lister.debuggerDeleteListener("user", s.terminalId, IDE_ID, s.user), 15_000);
  done.push(d === "timeout" ? "listener: sin respuesta al retirarlo (caduca solo)" : "listener retirado");
  await withLimit(s.client.logout(), 3_000);
  return done;
}

/** Solo para tests. */
export function resetSessionsForTests(): void {
  sessions.clear();
  breakpoints.clear();
}

export interface ShownVariable {
  id: string;
  name: string;
  type: string;
  meta: string;
  value: string;
  lines?: number;
  masked: boolean;
}

/** Valor que se puede mostrar según la clase de datos del sistema: en masked, las variables personales no. */
export function presentVariable(system: SystemConfig, v: DebugVariable): ShownVariable {
  const cls = dataClassOf(system);
  // LS_KNA1-NAME1, LV_NAME1, IV_STRAS…: se mira el último componente y también sin el prefijo de convención (LV_, IV_, GS_…).
  const extra = new Set(system.piiColumns?.map((c) => c.toUpperCase()) ?? []);
  const last = v.NAME.toUpperCase().split(/[-~>]/).pop() ?? v.NAME.toUpperCase();
  const personal = cls !== "test" && (isPersonalColumn(last, extra) || isPersonalColumn(last.replace(/^[A-Z]{1,2}_/, ""), extra));
  const complex = ["structure", "table", "dataref", "objectref", "class", "object", "boxref"].includes(v.META_TYPE);
  let value = complex ? (v.META_TYPE === "table" ? `tabla de ${v.TABLE_LINES} líneas` : `(${v.META_TYPE})`) : String(v.VALUE ?? "");
  if (personal && !complex) value = MASK;
  return { id: v.ID, name: v.NAME, type: v.ACTUAL_TYPE_NAME || v.DECLARED_TYPE_NAME || v.TECHNICAL_TYPE, meta: v.META_TYPE, value: value.length > 200 ? `${value.slice(0, 200)}…` : value, lines: v.META_TYPE === "table" ? v.TABLE_LINES : undefined, masked: personal && !complex };
}
