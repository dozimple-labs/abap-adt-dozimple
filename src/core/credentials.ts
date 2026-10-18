import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SystemConfig } from "./config.js";
import { ToolError } from "./errors.js";

const run = promisify(execFile);

/** Servicio del llavero de macOS bajo el que se guardan las contraseñas. */
export const KEYCHAIN_SERVICE = "abap-adt-dozimple";

/** Contraseñas en memoria con caducidad: sin caché el llavero se leería en cada petición; sin límite, vivirían siempre. */
const CACHE_TTL_MS = 15 * 60_000;
const cache = new Map<string, { pwd: string; exp: number }>();

/** Modo HTTP: la contraseña de cada sesión vive solo en memoria mientras dura la sesión (password = "session:<id>"). */
const sessionPasswords = new Map<string, string>();
export function setSessionPassword(sessionId: string, pwd: string): void {
  sessionPasswords.set(sessionId, pwd);
}
export function clearSessionPassword(sessionId: string): void {
  sessionPasswords.delete(sessionId);
}
export function hasSessionPassword(sessionId: string): boolean {
  return sessionPasswords.has(sessionId);
}

/**
 * Devuelve la contraseña del sistema. Nunca se escribe en logs ni en la
 * respuesta de una tool: solo viaja a la cabecera Basic de ADT.
 */
export async function getPassword(s: SystemConfig): Promise<string> {
  const hit = cache.get(s.id);
  if (hit && hit.exp > Date.now()) return hit.pwd;
  cache.delete(s.id);

  let pwd: string | undefined;
  if (s.password.startsWith("session:")) {
    pwd = sessionPasswords.get(s.password.slice(8));
    if (!pwd) throw new ToolError("AUTH", `La sesión HTTP de ${s.id} ya no tiene credenciales: vuelve a iniciar sesión.`);
    return pwd; // sin caché: se borra con la sesión
  }
  if (s.password.startsWith("env:")) {
    pwd = process.env[s.password.slice(4)];
    if (!pwd) {
      throw new ToolError("AUTH", `La variable ${s.password.slice(4)} no está definida para el sistema ${s.id}.`);
    }
  } else {
    try {
      // macOS: llavero. Linux: Secret Service (GNOME Keyring / KWallet) vía secret-tool.
      const { stdout } =
        process.platform === "linux"
          ? await run("secret-tool", ["lookup", "service", KEYCHAIN_SERVICE, "account", s.id])
          : await run("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", s.id, "-w"]);
      pwd = stdout.replace(/\n$/, "");
      if (!pwd) throw new Error("vacía");
    } catch {
      throw new ToolError(
        "AUTH",
        `No hay contraseña para ${s.id} en el llavero. Guárdala con: scripts/set-password.sh ${s.id}`,
      );
    }
  }
  cache.set(s.id, { pwd, exp: Date.now() + CACHE_TTL_MS });
  return pwd;
}

/** Tras un 401 conviene olvidar la contraseña cacheada por si se cambió. */
export function forgetPassword(id: string): void {
  cache.delete(id);
}

/** Al cerrar el servidor: ninguna contraseña queda en memoria más de lo necesario. */
export function clearPasswords(): void {
  cache.clear();
  sessionPasswords.clear();
}
