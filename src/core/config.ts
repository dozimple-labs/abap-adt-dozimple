import { execFileSync } from "node:child_process";
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
  /**
   * Columnas personales propias de este cliente (campos Z o alias de CDS) que se enmascaran igual que las estándar
   * en sistemas masked/prod. El enmascarado es por nombre: lo que no esté aquí ni en la lista estándar sale en claro.
   */
  piiColumns: z.array(z.string().regex(/^[A-Za-z0-9_/]+$/)).default([]),
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

/** Nombres de tool, grupos del catálogo (p. ej. "exploracion") o tipos de acceso ("read", "write", "exec"). */
const ToolListSchema = z.array(z.string().min(1));

const ConfigSchema = z.object({
  defaultSystem: z.string().optional(),
  systems: z.array(SystemSchema).min(1),
  sidecars: z.record(SidecarSchema).default({}),
  /** Exposición selectiva: `only` deja solo lo listado, `except` quita lo listado. ABAP_DZ_TOOLS (coma) es otro `only`. */
  tools: z.object({ only: ToolListSchema.optional(), except: ToolListSchema.default([]) }).default({}),
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
  for (const s of cfg.systems) {
    // Sin verificar TLS, quien intercepte la red recibe usuario y contraseña (Basic): nunca en calidad ni productivo.
    if (s.allowSelfSigned && s.role !== "DEV") {
      throw new Error(`${s.id}: allowSelfSigned solo se admite en sistemas DEV. Para ${s.role} usa caFile con el certificado de su CA.`);
    }
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
  // En Windows no hay bits de modo ni uid: se leen las ACL (assertPrivateFileWindows).
  if (process.platform === "win32") return assertPrivateFileWindows(path);
  if (st.mode & 0o022) {
    throw new Error(`${path} lo pueden modificar otros usuarios (permisos ${(st.mode & 0o777).toString(8)}). Corrígelo con: chmod 600 "${path}"`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) {
    throw new Error(`${path} pertenece a otro usuario (uid ${st.uid}). Debe ser tuyo y con permisos 600.`);
  }
}

// ── Windows: ACL del archivo ────────────────────────────────────────────────
/** Quién puede escribir legítimamente, además del propio usuario: SYSTEM, Administradores, TrustedInstaller. */
const TRUSTED_SIDS = new Set(["S-1-5-18", "S-1-5-32-544", "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"]);
/** Derechos que permiten cambiar el contenido, los permisos o el propietario (nombres de .NET y genéricos numéricos). */
const WRITE_RIGHTS = /FullControl|Modify|Write|AppendData|CreateFiles|ChangePermissions|TakeOwnership|^(268435456|1073741824)$/;

export interface AclEntry {
  sid: string;
  rights: string;
  type: string;
}

/** Entradas que dan escritura a alguien que no es el usuario ni una identidad del sistema. */
export function aclViolations(entries: AclEntry[], userSid: string): AclEntry[] {
  return entries.filter((e) => /allow/i.test(e.type) && e.sid !== userSid && !TRUSTED_SIDS.has(e.sid) && WRITE_RIGHTS.test(e.rights));
}

/** Salida del script de PowerShell: «USER|<sid>», «OWNER|<sid>» y «ACE|<sid>|<derechos>|<tipo>». */
export function parseAclOutput(out: string): { user: string; owner: string; entries: AclEntry[] } {
  let user = "";
  let owner = "";
  const entries: AclEntry[] = [];
  for (const line of out.split(/\r?\n/)) {
    const [kind, sid, rights, type] = line.trim().split("|");
    if (kind === "USER") user = sid;
    else if (kind === "OWNER") owner = sid;
    else if (kind === "ACE" && sid) entries.push({ sid, rights: rights ?? "", type: type ?? "" });
  }
  return { user, owner, entries };
}

// La ruta llega por variable de entorno, nunca dentro del comando: sin inyección posible.
const ACL_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$a=Get-Acl -LiteralPath $env:ABAPDZ_ACL_PATH",
  "'USER|'+[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
  "'OWNER|'+(New-Object Security.Principal.NTAccount($a.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value",
  "foreach($r in $a.Access){ $s=try{$r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value}catch{$r.IdentityReference.Value}; 'ACE|'+$s+'|'+$r.FileSystemRights+'|'+$r.AccessControlType }",
].join("; ");

/**
 * systems.json define qué proceso lanza cada componente (sidecars.command): quien pueda escribirlo ejecuta código
 * con tu identidad. En Windows se exige que solo tu usuario (y el sistema) pueda modificarlo. Si la comprobación no
 * se puede hacer, no se arranca (fail-closed), salvo ABAP_DZ_SKIP_ACL_CHECK=1, que queda avisado al arrancar.
 */
export function assertPrivateFileWindows(path: string, run = (): string =>
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ACL_SCRIPT], {
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, ABAPDZ_ACL_PATH: path },
  }),
): void {
  if (process.env.ABAP_DZ_SKIP_ACL_CHECK === "1") return;
  let acl: ReturnType<typeof parseAclOutput>;
  try {
    acl = parseAclOutput(run());
  } catch (e) {
    throw new Error(`No se pudieron leer los permisos de ${path} (${(e as Error).message.split("\n")[0]}). Sin esa comprobación no se arranca; si lo asumes, define ABAP_DZ_SKIP_ACL_CHECK=1.`);
  }
  if (!acl.user) throw new Error(`No se pudo determinar el usuario actual para comprobar ${path}.`);
  if (acl.owner && acl.owner !== acl.user && !TRUSTED_SIDS.has(acl.owner)) {
    throw new Error(`${path} pertenece a otra identidad (${acl.owner}). Debe ser tuyo.`);
  }
  const bad = aclViolations(acl.entries, acl.user);
  if (bad.length) {
    throw new Error(
      `${path} lo pueden modificar otras identidades (${bad.map((b) => `${b.sid}: ${b.rights}`).join("; ")}). ` +
        `Déjalo solo para tu usuario: icacls "${path}" /inheritance:r /grant:r "%USERNAME%":F`,
    );
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

/** Avisos que se escriben por stderr en cada arranque: lo que la configuración deja más débil de lo normal. */
export function startupWarnings(cfg: Config, platform = process.platform): string[] {
  const out: string[] = [];
  for (const s of cfg.systems) {
    if (s.allowSelfSigned && !s.caFile) out.push(`${s.id}: TLS SIN VERIFICAR (allowSelfSigned). Configura caFile con el certificado de su CA.`);
  }
  if (platform === "win32" && process.env.ABAP_DZ_SKIP_ACL_CHECK === "1") {
    out.push("Windows: ABAP_DZ_SKIP_ACL_CHECK=1 desactiva la comprobación de permisos de systems.json (que define los procesos que se lanzan). Quítala en cuanto puedas.");
  }
  return out;
}
