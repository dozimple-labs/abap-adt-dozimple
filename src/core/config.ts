import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

/**
 * Sistemas SAP a los que puede hablar el servidor.
 *
 * El archivo NO lleva contraseñas: `password` solo dice de dónde sacarla
 * (llavero de macOS por defecto). Así el archivo se puede versionar o
 * compartir sin revisar nada.
 */
const SystemSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_]+$/, "id: solo letras, números y _"),
  description: z.string().optional(),
  sid: z.string().regex(/^[A-Z0-9]{3}$/).optional(),
  url: z.string().url(),
  client: z.string().regex(/^\d{3}$/),
  user: z.string().min(1),
  language: z.string().length(2).default("ES"),
  role: z.enum(["DEV", "QAS", "PRD"]),
  /** Solo tiene efecto si role es DEV: QAS y PRD nunca se escriben. */
  allowWrite: z.boolean().default(false),
  /** Módulos de cliente habilitados en este sistema, p. ej. "dz-transport-risk". */
  modules: z.array(z.string()).default([]),
  /** Certificado (PEM) de la CA o del servidor, para verificar TLS en sistemas con certificado propio. */
  caFile: z.string().optional(),
  /** Último recurso: desactiva la verificación TLS. Preferir caFile. */
  allowSelfSigned: z.boolean().default(false),
  /**
   * Qué datos hay en el sistema: test (ficticios), masked (anonimizados) o
   * prod (reales). Por defecto DEV = test y QAS/PRD = prod. En masked y prod
   * se ocultan columnas personales y se limita el número de filas.
   */
  dataClass: z.enum(["test", "masked", "prod"]).optional(),
  /** Tope de filas por consulta; por defecto test 5000, masked 1000, prod 200. */
  maxRows: z.number().int().min(1).max(5000).optional(),
  password: z
    .string()
    .regex(/^(keychain|env:[A-Z0-9_]+)$/, 'password: "keychain" o "env:NOMBRE_VARIABLE"')
    .default("keychain"),
});

/**
 * MCP de terceros que corren como proceso hijo aislado y cuyas tools publica
 * este servidor (con su política). Hoy: "docs" = mcp-sap-docs.
 */
const SidecarSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  /** Si false (por defecto), ninguna consulta del usuario sale a internet. */
  allowOnline: z.boolean().default(false),
  /** Términos que nunca pueden salir en una consulta online (clientes, proyectos…). */
  blockTerms: z.array(z.string()).default([]),
});

const ConfigSchema = z.object({
  defaultSystem: z.string().optional(),
  systems: z.array(SystemSchema).min(1),
  sidecars: z.record(z.string(), SidecarSchema).default({}),
});

export type SystemConfig = z.infer<typeof SystemSchema>;
export type SidecarConfig = z.infer<typeof SidecarSchema>;
export type Config = z.infer<typeof ConfigSchema>;

export function configPath(): string {
  return process.env.ABAP_DZ_CONFIG
    ? resolve(process.env.ABAP_DZ_CONFIG)
    : join(homedir(), ".config", "abap-adt-dozimple", "systems.json");
}

export function parseConfig(raw: unknown): Config {
  const cfg = ConfigSchema.parse(raw);
  const ids = new Set<string>();
  for (const s of cfg.systems) {
    const key = s.id.toUpperCase();
    if (ids.has(key)) throw new Error(`Sistema duplicado en la configuración: ${s.id}`);
    ids.add(key);
  }
  if (cfg.defaultSystem && !ids.has(cfg.defaultSystem.toUpperCase())) {
    throw new Error(`defaultSystem "${cfg.defaultSystem}" no está en systems[]`);
  }
  return cfg;
}

export function loadConfig(path = configPath()): Config {
  if (!existsSync(path)) {
    throw new Error(
      `No existe la configuración de sistemas en ${path}. ` +
        `Copia config/systems.example.json ahí (o define ABAP_DZ_CONFIG).`,
    );
  }
  assertPrivateFile(path);
  return parseConfig(JSON.parse(readFileSync(path, "utf8")));
}

/**
 * Quien pueda escribir systems.json decide a qué sistema se conecta el
 * servidor y si puede escribir en él: tiene que ser solo del usuario.
 */
export function assertPrivateFile(path: string, st: { mode: number; uid: number } = statSync(path)): void {
  if (process.platform === "win32") return;
  if (st.mode & 0o022) {
    throw new Error(`${path} lo pueden modificar otros usuarios (permisos ${(st.mode & 0o777).toString(8)}). Corrígelo con: chmod 600 "${path}"`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) {
    throw new Error(`${path} pertenece a otro usuario (uid ${st.uid}). Debe ser tuyo y con permisos 600.`);
  }
}

/** Escritura efectiva: hace falta allowWrite y ser un sistema de desarrollo. */
export function canWrite(s: SystemConfig): boolean {
  return s.allowWrite && s.role === "DEV";
}

export type SystemSource = "parámetro" | "por defecto" | "por defecto: ABAP_DZ_DEFAULT_SYSTEM" | "único configurado";

/**
 * Qué sistema usar, y por qué. Prioridad: el parámetro de la tool, luego
 * defaultSystem (o ABAP_DZ_DEFAULT_SYSTEM). Si hay varios y ninguno está
 * indicado, se pide en vez de adivinar.
 */
export function resolveSystem(
  cfg: Config,
  requested?: string,
): { system: SystemConfig; source: SystemSource } {
  const find = (id: string) => cfg.systems.find((s) => s.id.toUpperCase() === id.trim().toUpperCase());
  if (requested && requested.trim()) {
    const s = find(requested);
    if (!s) {
      throw new Error(
        `Sistema "${requested}" no configurado. Disponibles: ${cfg.systems.map((x) => x.id).join(", ")}`,
      );
    }
    return { system: s, source: "parámetro" };
  }
  const fromEnv = process.env.ABAP_DZ_DEFAULT_SYSTEM;
  if (fromEnv) {
    const s = find(fromEnv);
    // Una variable de entorno que apunta a un sistema que no existe es un error, no un «siguiente candidato».
    if (!s) throw new Error(`ABAP_DZ_DEFAULT_SYSTEM="${fromEnv}" no está configurado. Disponibles: ${cfg.systems.map((x) => x.id).join(", ")}`);
    return { system: s, source: "por defecto: ABAP_DZ_DEFAULT_SYSTEM" };
  }
  if (cfg.defaultSystem) {
    const s = find(cfg.defaultSystem);
    if (s) return { system: s, source: "por defecto" };
  }
  if (cfg.systems.length === 1) return { system: cfg.systems[0], source: "único configurado" };
  throw new Error(
    `Hay varios sistemas y ninguno por defecto: indica "system" (${cfg.systems.map((x) => x.id).join(", ")})`,
  );
}
