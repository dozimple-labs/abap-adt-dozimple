import { isAdtError, isCsrfError, isHttpError } from "abap-adt-api";

/**
 * Tipos de fallo. La regla del servidor: un fallo NUNCA se convierte en un
 * resultado vacío ni en un «todo bien». Si no se pudo mirar, se dice.
 */
export type ErrorKind =
  | "NETWORK"     // no se llega al host (VPN, DNS, timeout)
  | "AUTH"        // credenciales o autorización
  | "NOT_FOUND"   // el objeto o endpoint no existe
  | "SAP"         // SAP respondió con un error de negocio
  | "POLICY"      // la política del servidor lo impide (escritura, PRD…)
  | "CAPABILITY"  // este release no expone el endpoint ADT necesario
  | "MODULE"      // tool de un cliente no habilitada en este sistema
  | "INPUT"       // parámetros inválidos
  | "CANCELLED"   // el cliente canceló la petición: no es un fallo del servidor
  | "INTERNAL";

export class ToolError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

const NETWORK_CODES = new Set([
  "ENETUNREACH", "EHOSTUNREACH", "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT",
  "ECONNRESET", "EAI_AGAIN", "ECONNABORTED",
]);

function errCode(e: any): string | undefined {
  return e?.code ?? e?.parent?.code ?? e?.cause?.code ?? e?.parent?.cause?.code;
}

export function normalizeError(e: unknown, systemId?: string): ToolError {
  if (e instanceof ToolError) return e;
  const any = e as any;
  // signal.throwIfAborted() entre pasos de una tool larga: cancelación del cliente, no fallo del servidor.
  if (any?.name === "AbortError") return new ToolError("CANCELLED", "Cancelado por el cliente antes de terminar.");
  const code = errCode(any);

  if (code && NETWORK_CODES.has(code)) {
    return new ToolError(
      "NETWORK",
      `No se llega a ${systemId ?? "SAP"} (${code}).`,
      "¿Está levantada la VPN de ese cliente?",
    );
  }
  if (isCsrfError(e)) {
    return new ToolError("AUTH", `Sesión o token CSRF rechazado por ${systemId ?? "SAP"}: ${sanitizeMessage(any.message)}`);
  }
  if (isHttpError(e)) {
    const st = any.status;
    if (st === 401) return new ToolError("AUTH", `Usuario o contraseña rechazados por ${systemId ?? "SAP"} (401).`);
    if (st === 403) return new ToolError("AUTH", `Sin autorización (403): ${sanitizeMessage(any.message)}`);
    if (st === 404) return new ToolError("NOT_FOUND", `No encontrado (404): ${sanitizeMessage(any.message)}`);
    return new ToolError("SAP", `HTTP ${st ?? "?"}: ${sanitizeMessage(any.message)}`);
  }
  if (isAdtError(e)) {
    const st = any.err as number;
    const msg = sanitizeMessage(any.localizedMessage || any.message || "sin mensaje", 1500);
    if (st === 401) return new ToolError("AUTH", `Usuario o contraseña rechazados (401): ${msg}`);
    if (st === 403) return new ToolError("AUTH", `Sin autorización (403): ${msg}`);
    if (st === 404) return new ToolError("NOT_FOUND", msg);
    return new ToolError("SAP", `${msg}${st ? ` (HTTP ${st})` : ""}`);
  }
  const message = sanitizeMessage(any?.message ? String(any.message) : String(e));
  return new ToolError("INTERNAL", message || "Error sin mensaje");
}

/**
 * Sesión caducada a mitad de una lectura: token CSRF rechazado, o 401 en una sesión que ya había entrado. El registro
 * la renueva y repite la lectura UNA vez; nunca una escritura (el bloqueo se perdió con la sesión).
 */
export function isSessionExpired(e: unknown): boolean {
  if (isCsrfError(e)) return true;
  const st = e as { status?: number; err?: number; message?: string } | undefined;
  if ((isHttpError(e) && st?.status === 401) || (isAdtError(e) && st?.err === 401)) return true;
  // Tras una hora sin uso, SAP puede responder 400 «Logon Error» en vez de 401 (visto en otro MCP sobre ADT).
  const is400 = (isHttpError(e) && st?.status === 400) || (isAdtError(e) && st?.err === 400);
  return is400 && /logon/i.test(String(st?.message ?? ""));
}

export function renderError(te: ToolError): string {
  const labels: Record<ErrorKind, string> = {
    NETWORK: "Sin conexión",
    AUTH: "Autenticación/autorización",
    NOT_FOUND: "No encontrado",
    SAP: "Error de SAP",
    POLICY: "Bloqueado por política",
    CAPABILITY: "No disponible en este sistema",
    MODULE: "Módulo no habilitado",
    INPUT: "Parámetros inválidos",
    CANCELLED: "Cancelado",
    INTERNAL: "Error interno",
  };
  return `${labels[te.kind]}: ${te.message}${te.hint ? `\n${te.hint}` : ""}\n` +
    `(No se completó la operación: no interpretes esto como un resultado vacío.)`;
}

/**
 * Texto de error apto para llegar al modelo (y por tanto al proveedor LLM): sin credenciales incrustadas en URLs,
 * sin cabeceras Authorization, sin marcado y con longitud acotada. Los errores de SAP o de HTTP pueden traer rutas,
 * hosts o páginas de error enteras; aquí se reducen a lo útil para diagnosticar.
 */
export function sanitizeMessage(msg: string, max = 500): string {
  const clean = String(msg)
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi, "$1[credenciales]@")
    .replace(/(authorization["']?\s*[:=]\s*["']?)(basic|bearer)\s+[A-Za-z0-9+/=._-]+/gi, "$1$2 [oculto]")
    .replace(/<[^>]{0,200}>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > max ? clean.slice(0, max) + "…" : clean;
}
