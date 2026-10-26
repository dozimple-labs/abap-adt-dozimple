import { createHash, randomBytes } from "node:crypto";

/**
 * Confirmación en dos fases de las escrituras cuando el cliente MCP no
 * soporta elicitación: la primera llamada devuelve la vista previa y un token
 * de un solo uso atado a tool + sistema + argumentos exactos. Si el modelo
 * cambia una coma de la fuente entre la vista previa y la escritura, el token
 * deja de valer y hay que volver a previsualizar.
 */
export const CONFIRM_TTL_MS = 20 * 60_000;

const pending = new Map<string, { digest: string; exp: number; state?: string }>();
/** Los caducados se recuerdan un rato más para distinguir «mismo cambio, solo pasó el tiempo» de «cambió algo». */
const EXPIRED_MEMORY_MS = 60 * 60_000;

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
        .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

export function argsDigest(tool: string, system: string, args: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify([tool, system.toUpperCase(), canonical(args)])).digest("hex");
}

/**
 * `state` es la huella de lo que el usuario vio en la vista previa (p. ej. el sha256 de la fuente actual en SAP):
 * la tool la compara al escribir para no aplicar un diff sobre algo que cambió entretanto.
 */
export function issueToken(tool: string, system: string, args: Record<string, unknown>, now = Date.now(), state?: string, ttlMs = CONFIRM_TTL_MS): string {
  for (const [t, p] of pending) if (p.exp + EXPIRED_MEMORY_MS <= now) pending.delete(t);
  const token = randomBytes(16).toString("hex");
  pending.set(token, { digest: argsDigest(tool, system, args), exp: now + ttlMs, state });
  return token;
}

export type TokenCheck = "ok" | "unknown" | "expired" | "mismatch";

/** Como consumeToken, y además devuelve la huella del estado que se vio en la vista previa. */
export function consumeTokenWithState(
  token: string,
  tool: string,
  system: string,
  args: Record<string, unknown>,
  now = Date.now(),
): { check: TokenCheck; state?: string; sameArgs?: boolean } {
  const p = pending.get(token);
  if (!p) return { check: "unknown" };
  pending.delete(token);
  const sameArgs = p.digest === argsDigest(tool, system, args);
  // Caducado: se devuelve la huella de lo que se mostró y si los argumentos son los mismos, para que el registro
  // pueda decir «mismo cambio, solo pasó el tiempo» en vez de obligar a releer un diff idéntico.
  if (p.exp <= now) return { check: "expired", state: p.state, sameArgs };
  return sameArgs ? { check: "ok", state: p.state } : { check: "mismatch" };
}

/** Consume el token: vale una sola vez, también cuando no coincide. */
export function consumeToken(
  token: string,
  tool: string,
  system: string,
  args: Record<string, unknown>,
  now = Date.now(),
): TokenCheck {
  return consumeTokenWithState(token, tool, system, args, now).check;
}

/** Huella de un contenido tal como se mostró: sha256 con saltos de línea normalizados. */
export function stateOf(content: string): string {
  return createHash("sha256").update(content.replace(/\r\n?/g, "\n")).digest("hex");
}
