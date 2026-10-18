import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ADTClient, createSSLConfig, session_types, type QueryResult } from "abap-adt-api";
import type { SystemConfig } from "./config.js";
import { forgetPassword, getPassword } from "./credentials.js";
import { normalizeError, ToolError } from "./errors.js";
import { normalizeValue, wrapSql } from "./sql.js";

const CACHE_DIR = join(homedir(), ".cache", "abap-adt-dozimple");
const DISCOVERY_TTL_MS = 7 * 24 * 3600 * 1000;
const REQUEST_TIMEOUT_MS = 120_000;
/** Circuit breaker: N fallos de red en la ventana abren el circuito durante CIRCUIT_OPEN_MS. */
const CIRCUIT_FAILURES = 3;
const CIRCUIT_WINDOW_MS = 60_000;
const CIRCUIT_OPEN_MS = 60_000;

/**
 * TLS: con caFile se verifica contra ese certificado (lo correcto para un
 * sistema con certificado propio); allowSelfSigned desactiva la verificación
 * y queda como último recurso, avisado en sap_systems.
 */
export function tlsOptions(s: SystemConfig): { httpsAgent?: import("node:https").Agent } {
  if (s.caFile) return createSSLConfig(false, readFileSync(s.caFile, "utf8"));
  if (s.allowSelfSigned) return createSSLConfig(true);
  return {};
}

export interface Capabilities {
  /** Colecciones ADT que publica el sistema (href). Vacío si no se pudo leer. */
  collections: string[];
  fetchedAt: string;
  /** false si el discovery falló: entonces no se bloquea nada por capacidad. */
  known: boolean;
}

/**
 * Conexión perezosa a un sistema. Un cliente sin estado para lecturas y uno
 * nuevo con sesión stateful para cada operación de escritura (bloqueo,
 * guardado, desbloqueo), que se cierra al terminar para soltar el enqueue.
 */
export class SapConnection {
  private reader?: Promise<ADTClient>;
  private caps?: Promise<Capabilities>;
  private basisRelease?: Promise<string | undefined>;
  private networkFailures: number[] = [];
  private openUntil = 0;

  constructor(readonly system: SystemConfig) {}

  /** Olvida el cliente de lectura (sesión caducada): la siguiente llamada vuelve a entrar. */
  resetReader(): void {
    const old = this.reader;
    this.reader = undefined;
    old?.then((c) => c.logout()).catch(() => undefined);
  }

  /**
   * Tres fallos de red en un minuto abren el circuito: durante un minuto ninguna tool intenta nada contra este
   * sistema y responde al instante. Un sistema caído (VPN, host) dejaba de responder 120 s por cada llamada.
   */
  noteNetworkFailure(now = Date.now()): void {
    this.networkFailures = this.networkFailures.filter((t) => now - t < CIRCUIT_WINDOW_MS);
    this.networkFailures.push(now);
    if (this.networkFailures.length >= CIRCUIT_FAILURES) {
      this.openUntil = now + CIRCUIT_OPEN_MS;
      this.networkFailures = [];
    }
  }

  /** Segundos que faltan para volver a intentar, o 0 si el circuito está cerrado. */
  circuitOpenFor(now = Date.now()): number {
    return this.openUntil > now ? Math.ceil((this.openUntil - now) / 1000) : 0;
  }

  /** Cierra el circuito a mano (sap_systems con check): se vuelve a intentar ya. */
  resetCircuit(): void {
    this.openUntil = 0;
    this.networkFailures = [];
  }

  private assertCircuitClosed(): void {
    const s = this.circuitOpenFor();
    if (s) {
      throw new ToolError(
        "NETWORK",
        `${this.system.id} no respondió ${CIRCUIT_FAILURES} veces seguidas: no se vuelve a intentar durante ${s} s.`,
        "sap_systems(check=true) lo reintenta ahora mismo.",
      );
    }
  }

  private async newClient(): Promise<ADTClient> {
    const s = this.system;
    const password = await getPassword(s);
    const options = { ...tlsOptions(s), timeout: REQUEST_TIMEOUT_MS };
    return new ADTClient(s.url.replace(/\/$/, ""), s.user, password, s.client, s.language, options);
  }

  private async login(c: ADTClient): Promise<ADTClient> {
    try {
      await c.login();
      return c;
    } catch (e) {
      const te = normalizeError(e, this.system.id);
      if (te.kind === "AUTH") forgetPassword(this.system.id);
      throw te;
    }
  }

  /** Cliente de lectura, reutilizado entre llamadas. */
  async adt(): Promise<ADTClient> {
    this.assertCircuitClosed();
    if (!this.reader) {
      this.reader = this.newClient().then((c) => this.login(c));
      this.reader.catch(() => (this.reader = undefined));
    }
    return this.reader;
  }

  /**
   * Sesión stateful que vive más de una llamada (depurador): quien la abre la cierra con logout(). Para
   * operaciones de una sola llamada, stateful(fn).
   */
  async openStateful(): Promise<ADTClient> {
    this.assertCircuitClosed();
    const c = await this.login(await this.newClient());
    c.stateful = session_types.stateful;
    return c;
  }

  /** Ejecuta fn con una sesión stateful propia y la cierra siempre. */
  async stateful<T>(fn: (c: ADTClient) => Promise<T>): Promise<T> {
    const c = await this.openStateful();
    try {
      return await fn(c);
    } finally {
      try {
        await c.logout();
      } catch {
        /* la sesión ya estaba cerrada */
      }
    }
  }

  async query(sql: string, rows = 100): Promise<QueryResult> {
    const c = await this.adt();
    const r = await c.runQuery(wrapSql(sql), rows, true);
    for (const row of r.values) for (const k of Object.keys(row)) row[k] = normalizeValue(row[k]);
    return r;
  }

  /** Release de SAP_BASIS (750, 758…), o undefined si no se pudo leer. */
  release(): Promise<string | undefined> {
    if (!this.basisRelease) {
      this.basisRelease = this.query("SELECT release FROM cvers WHERE component = 'SAP_BASIS'", 1)
        .then((r) => (r.values[0]?.RELEASE as string | undefined)?.trim())
        .catch(() => {
          // Un fallo pasajero (VPN caída un instante) no deja el dato en blanco para siempre: se reintenta después.
          this.basisRelease = undefined;
          return undefined;
        });
    }
    return this.basisRelease;
  }

  capabilities(refresh = false): Promise<Capabilities> {
    if (!this.caps || refresh) this.caps = this.loadCapabilities(refresh);
    return this.caps;
  }

  private async loadCapabilities(refresh: boolean): Promise<Capabilities> {
    const file = join(CACHE_DIR, `discovery-${this.system.id.toUpperCase()}.json`);
    if (!refresh && existsSync(file)) {
      try {
        const cached = JSON.parse(readFileSync(file, "utf8")) as Capabilities;
        if (Date.now() - Date.parse(cached.fetchedAt) < DISCOVERY_TTL_MS) return cached;
      } catch {
        /* caché corrupta: se vuelve a leer */
      }
    }
    try {
      const c = await this.adt();
      const disc = await c.adtDiscovery();
      const collections = [...new Set(disc.flatMap((w) => w.collection.map((col) => col.href)))].sort();
      const caps: Capabilities = { collections, fetchedAt: new Date().toISOString(), known: true };
      mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
      writeFileSync(file, JSON.stringify(caps, null, 1), { mode: 0o600 });
      return caps;
    } catch (e) {
      const te = normalizeError(e, this.system.id);
      // Sin red o sin credenciales no hay nada que decidir: se propaga.
      if (te.kind === "NETWORK" || te.kind === "AUTH") throw te;
      return { collections: [], fetchedAt: new Date().toISOString(), known: false };
    }
  }

  /**
   * Colecciones requeridas que el discovery NO lista. Es una pista, no un
   * veto: el discovery no enumera todo (en un S/4 2023 /runtime/dumps funciona y no
   * aparece). Solo un 404 real confirma que falta.
   */
  async missingCapabilities(required: string[]): Promise<string[]> {
    const caps = await this.capabilities();
    if (!caps.known) return [];
    return required.filter((r) => !caps.collections.some((h) => h === r || h.startsWith(r + "/")));
  }

  /** Error CAPABILITY con evidencia: SAP respondió 404 y el discovery tampoco lo lista. */
  async capabilityError(missing: string[]): Promise<ToolError> {
    const rel = await this.release();
    return new ToolError(
      "CAPABILITY",
      `${this.system.id}${rel ? ` (SAP_BASIS ${rel})` : ""} respondió 404 en ${missing.join(", ")}, ` +
        `que tampoco figura en su discovery ADT: este sistema no tiene esa función.`,
    );
  }
}

export class ConnectionPool {
  private readonly pool = new Map<string, SapConnection>();

  get(system: SystemConfig): SapConnection {
    const key = system.id.toUpperCase();
    let c = this.pool.get(key);
    if (!c) {
      c = new SapConnection(system);
      this.pool.set(key, c);
    }
    return c;
  }
}
