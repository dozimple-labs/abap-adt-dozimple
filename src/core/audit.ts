import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { auditKey, macOf, type AuditKey } from "./auditkey.js";
import { stateDir } from "./telemetry.js";

/**
 * Registro de auditoría de todo lo que modifica o ejecuta en SAP, y de toda lectura de datos de negocio (`data_read`:
 * tablas, columnas enmascaradas y filas; nunca los valores). Solo añade líneas y cada una lleva el hash de la
 * anterior: borrar o retocar una entrada rompe la cadena y `npm run audit:verify` lo detecta.
 *
 * Nunca guarda fuente, textos ni datos: de los argumentos largos o
 * compuestos queda solo su huella (sha256 y tamaño), suficiente para probar
 * qué se escribió comparando con la versión en SAP.
 */
export const AUDIT_FILE = "audit.jsonl";
const GENESIS = "0".repeat(64);
const INLINE_MAX = 120;

/** intent/result/denied: escrituras y ejecuciones. data_read: una tool devolvió datos de negocio (qué tablas, cuántas filas; nunca los valores). */
export type AuditPhase = "intent" | "result" | "denied" | "data_read";

export interface AuditInput {
  phase: AuditPhase;
  tool: string;
  access: string;
  system: string;
  sapUser: string;
  client: string;
  args: Record<string, unknown>;
  confirmedBy?: "elicitation" | "token" | "not-required";
  ok?: boolean;
  kind?: string;
  reason?: string;
  /** Solo en data_read. */
  read?: { tables: string[]; maskedColumns: string[]; rows: number; capped: boolean; queries: number };
}

export interface AuditEntry extends Omit<AuditInput, "args"> {
  seq: number;
  ts: string;
  args: Record<string, unknown>;
  prev: string;
  hash: string;
  /** HMAC-SHA256 del hash con la clave del llavero (ausente si no hay almacén de secretos). */
  mac?: string;
}

/** E/S del registro, sustituible en tests para simular disco lleno o permisos. */
export const auditIo = { appendFileSync, existsSync, mkdirSync, readFileSync, openSync, closeSync, fstatSync, readSync, statSync, rmSync };

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Argumentos aptos para el registro: valores cortos tal cual, el resto como huella. */
export function auditArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined) continue;
    if (typeof v === "string" && v.length > INLINE_MAX) {
      out[k] = { sha256: sha256(v), chars: v.length, lines: v.split("\n").length };
    } else if (v !== null && typeof v === "object") {
      const json = JSON.stringify(v);
      out[k] = { sha256: sha256(json), items: Array.isArray(v) ? v.length : Object.keys(v).length };
    } else {
      out[k] = v;
    }
  }
  return out;
}

function entryHash(e: Omit<AuditEntry, "hash">): string {
  return sha256(JSON.stringify(e));
}

/** Última entrada leyendo solo la cola del archivo (el registro no se relee entero en cada escritura). */
function lastEntry(path: string): { seq: number; hash: string } {
  if (!auditIo.existsSync(path)) return { seq: 0, hash: GENESIS };
  const fd = auditIo.openSync(path, "r");
  try {
    const size = auditIo.fstatSync(fd).size;
    if (!size) return { seq: 0, hash: GENESIS };
    for (let window = 16 * 1024; ; window *= 4) {
      const start = Math.max(0, size - window);
      const buf = Buffer.alloc(size - start);
      auditIo.readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString("utf8").trimEnd().split("\n");
      // Si la ventana empieza a mitad de una línea, la primera está cortada: vale la última si hay al menos dos.
      if (lines.length >= 2 || start === 0) {
        const last = JSON.parse(lines[lines.length - 1]) as AuditEntry;
        return { seq: last.seq, hash: last.hash };
      }
    }
  } finally {
    auditIo.closeSync(fd);
  }
}

/**
 * Bloqueo entre procesos (dos clientes MCP pueden tener cada uno su servidor): sin él, dos escrituras simultáneas
 * leerían el mismo «prev» y romperían la cadena, que sería indistinguible de una manipulación.
 */
function withLock<T>(dir: string, fn: () => T): T {
  const lock = join(dir, AUDIT_FILE + ".lock");
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      auditIo.closeSync(auditIo.openSync(lock, "wx", 0o600));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // Un bloqueo de más de 30 s es de un proceso que murió a mitad: se recupera.
      try {
        if (Date.now() - auditIo.statSync(lock).mtimeMs > 30_000) auditIo.rmSync(lock, { force: true });
      } catch {}
      if (Date.now() > deadline) throw new Error("registro de auditoría bloqueado por otro proceso");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return fn();
  } finally {
    auditIo.rmSync(lock, { force: true });
  }
}

/**
 * Añade una entrada. Lanza si no puede escribir: quien llama decide no
 * seguir (una escritura sin rastro no se hace).
 */
export function appendAudit(input: AuditInput, dir = stateDir()): AuditEntry {
  auditIo.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, AUDIT_FILE);
  return withLock(dir, () => appendLocked(path, input));
}

function appendLocked(path: string, input: AuditInput): AuditEntry {
  // La clave se obtiene (o se crea) ANTES de fechar la entrada: así la primera firmada nunca queda con una fecha
  // anterior a la de la clave, y quitarle la firma no la hace pasar por una entrada antigua.
  const key = auditKey(true);
  const prev = lastEntry(path);
  const base: Omit<AuditEntry, "hash"> = {
    seq: prev.seq + 1,
    ts: new Date().toISOString(),
    ...input,
    args: auditArgs(input.args),
    prev: prev.hash,
  };
  const hash = entryHash(base);
  const entry: AuditEntry = key ? { ...base, hash, mac: macOf(key.key, hash) } : { ...base, hash };
  auditIo.appendFileSync(path, JSON.stringify(entry) + "\n", { mode: 0o600 });
  return entry;
}

export interface AuditVerdict {
  ok: boolean;
  entries: number;
  brokenAt?: number;
  reason?: string;
  /** Entradas con firma HMAC válida (solo si se verificó con clave). */
  signed?: number;
}

/**
 * Recorre la cadena completa: secuencia, enlace con la anterior y hash propio. Con la clave, además, la firma de cada
 * entrada; y toda entrada posterior a la creación de la clave TIENE que estar firmada (quitar firmas no sirve).
 */
export function verifyAudit(text: string, key?: AuditKey | null): AuditVerdict {
  const lines = text.split("\n").filter(Boolean);
  let prev = GENESIS;
  let signed = 0;
  for (let i = 0; i < lines.length; i++) {
    let e: AuditEntry;
    try {
      e = JSON.parse(lines[i]);
    } catch {
      return { ok: false, entries: lines.length, brokenAt: i + 1, reason: "línea que no es JSON" };
    }
    const { hash, mac, ...rest } = e;
    if (e.seq !== i + 1) return { ok: false, entries: lines.length, brokenAt: i + 1, reason: `secuencia ${e.seq}, se esperaba ${i + 1}` };
    if (e.prev !== prev) return { ok: false, entries: lines.length, brokenAt: i + 1, reason: "no enlaza con la entrada anterior" };
    if (entryHash(rest) !== hash) return { ok: false, entries: lines.length, brokenAt: i + 1, reason: "contenido alterado" };
    if (key) {
      if (mac !== undefined && mac !== macOf(key.key, hash)) return { ok: false, entries: lines.length, brokenAt: i + 1, reason: "firma HMAC inválida (cadena recalculada sin la clave)" };
      if (mac === undefined && e.ts >= key.created) return { ok: false, entries: lines.length, brokenAt: i + 1, reason: "entrada sin firma posterior a la creación de la clave (firma quitada)" };
      if (mac !== undefined) signed++;
    }
    prev = hash;
  }
  return key ? { ok: true, entries: lines.length, signed } : { ok: true, entries: lines.length };
}
