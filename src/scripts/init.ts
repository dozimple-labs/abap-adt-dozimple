import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { configPath, parseConfig } from "../core/config.js";
import { KEYCHAIN_SERVICE } from "../core/credentials.js";

/**
 * `abap-adt-dozimple init`: deja el servidor listo en tres pasos que antes eran seis comandos a mano. Crea (o amplía)
 * systems.json con un sistema, guarda su contraseña en el almacén de secretos del sistema operativo y registra el
 * servidor en el cliente MCP elegido. Nunca pisa una configuración existente sin --force, y nunca escribe la
 * contraseña en ningún archivo: la pide el propio llavero por teclado.
 */
export const CLIENTS = ["claude-code", "claude-desktop", "kiro", "cursor", "vscode"] as const;
export type ClientId = (typeof CLIENTS)[number];
export const SERVER_NAME = "abap-adt-doZimple";

export interface InitArgs {
  client?: ClientId;
  system?: string;
  url?: string;
  sapClient?: string;
  user?: string;
  role?: "DEV" | "QAS" | "PRD";
  sid?: string;
  language?: string;
  allowWrite: boolean;
  password: boolean;
  force: boolean;
  dryRun: boolean;
  help: boolean;
}

export const USAGE = `uso: abap-adt-dozimple init [opciones]

Crea ~/.config/abap-adt-dozimple/systems.json (o añade un sistema), guarda la contraseña en el llavero y registra el
servidor en el cliente MCP. Lo que falte se pregunta por teclado.

  --client <${CLIENTS.join("|")}>   cliente MCP donde registrar el servidor
  --system <ID>            id del sistema (p. ej. MI_DEV)       --url <https://host:44300>
  --sap-client <100>       mandante                              --user <USUARIO>
  --role <DEV|QAS|PRD>     rol (QAS y PRD son solo lectura)      --sid <DEV>  --language <ES>
  --allow-write            habilitar escritura (solo DEV)        --no-password  no pedir la contraseña
  --force                  sustituir un sistema o una entrada MCP que ya exista
  --dry-run                mostrar qué se haría sin escribir nada
`;

export function parseInitArgs(argv: string[]): InitArgs {
  const a: InitArgs = { allowWrite: false, password: true, force: false, dryRun: false, help: false };
  const take = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} necesita un valor.`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    switch (f) {
      case "--client": {
        const v = take(i++, f) as ClientId;
        if (!CLIENTS.includes(v)) throw new Error(`--client: «${v}» no es uno de ${CLIENTS.join(", ")}.`);
        a.client = v;
        break;
      }
      case "--system": a.system = take(i++, f).trim(); break;
      case "--url": a.url = take(i++, f).trim(); break;
      case "--sap-client": a.sapClient = take(i++, f).trim(); break;
      case "--user": a.user = take(i++, f).trim(); break;
      case "--role": {
        const v = take(i++, f).trim().toUpperCase();
        if (!["DEV", "QAS", "PRD"].includes(v)) throw new Error(`--role: «${v}» no es DEV, QAS ni PRD.`);
        a.role = v as InitArgs["role"];
        break;
      }
      case "--sid": a.sid = take(i++, f).trim().toUpperCase(); break;
      case "--language": a.language = take(i++, f).trim().toUpperCase(); break;
      case "--allow-write": a.allowWrite = true; break;
      case "--no-password": a.password = false; break;
      case "--force": a.force = true; break;
      case "--dry-run": a.dryRun = true; break;
      case "-h": case "--help": a.help = true; break;
      default: throw new Error(`Opción desconocida: ${f}\n${USAGE}`);
    }
  }
  return a;
}

export interface Platform {
  home: string;
  cwd: string;
  platform: NodeJS.Platform;
  appData?: string;
}

/** Dónde guarda cada cliente su lista de servidores MCP y bajo qué clave. */
export function clientConfigPath(client: ClientId, p: Platform): { path: string; key: "mcpServers" | "servers" } {
  switch (client) {
    case "claude-code": return { path: join(p.cwd, ".mcp.json"), key: "mcpServers" };
    case "vscode": return { path: join(p.cwd, ".vscode", "mcp.json"), key: "servers" };
    case "cursor": return { path: join(p.home, ".cursor", "mcp.json"), key: "mcpServers" };
    case "kiro": return { path: join(p.home, ".kiro", "settings", "mcp.json"), key: "mcpServers" };
    case "claude-desktop":
      if (p.platform === "darwin") return { path: join(p.home, "Library", "Application Support", "Claude", "claude_desktop_config.json"), key: "mcpServers" };
      if (p.platform === "win32") return { path: join(p.appData ?? join(p.home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json"), key: "mcpServers" };
      return { path: join(p.home, ".config", "Claude", "claude_desktop_config.json"), key: "mcpServers" };
  }
}

/** Entrada del servidor: el mismo Node que ejecuta este comando y el index.js instalado, sin depender del PATH. */
export function serverEntry(client: ClientId, node: string, serverPath: string): Record<string, unknown> {
  const e: Record<string, unknown> = { command: node, args: [serverPath] };
  if (client === "vscode") return { type: "stdio", ...e };
  return e;
}

export type MergeAction = "created" | "added" | "replaced" | "kept";

/** Añade (o sustituye con force) la entrada del servidor sin tocar el resto del archivo; un JSON inválido no se pisa. */
export function mergeClientConfig(existing: string | undefined, key: "mcpServers" | "servers", entry: Record<string, unknown>, force: boolean): { text: string; action: MergeAction } {
  let obj: Record<string, unknown> = {};
  let action: MergeAction = "created";
  if (existing !== undefined && existing.trim()) {
    try {
      obj = JSON.parse(existing);
    } catch {
      throw new Error("el archivo del cliente no es JSON válido: no se toca. Corrígelo y repite.");
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("el archivo del cliente no contiene un objeto JSON: no se toca.");
    action = "added";
  }
  const servers = (obj[key] && typeof obj[key] === "object" ? obj[key] : {}) as Record<string, unknown>;
  if (servers[SERVER_NAME] !== undefined) {
    if (!force) return { text: existing ?? "", action: "kept" };
    action = "replaced";
  }
  servers[SERVER_NAME] = entry;
  obj[key] = servers;
  return { text: JSON.stringify(obj, null, 2) + "\n", action };
}

export interface SystemFields {
  system: string;
  url: string;
  sapClient: string;
  user: string;
  role: "DEV" | "QAS" | "PRD";
  sid?: string;
  language?: string;
  allowWrite: boolean;
}

export function systemEntry(f: SystemFields): Record<string, unknown> {
  const e: Record<string, unknown> = {
    id: f.system.trim().toUpperCase(),
    ...(f.sid ? { sid: f.sid.trim().toUpperCase() } : {}),
    url: f.url.trim(),
    client: f.sapClient.trim(),
    user: f.user.trim().toUpperCase(),
    language: f.language ?? "ES",
    role: f.role,
    allowWrite: f.role === "DEV" && f.allowWrite,
    modules: [],
    targets: [],
  };
  parseConfig({ systems: [e] }); // mismas reglas que al arrancar: url, mandante de 3 dígitos, sid…
  return e;
}

/** Crea systems.json con el sistema, o lo añade a uno existente (sustituye solo con force). Valida el resultado. */
export function mergeSystems(existing: string | undefined, entry: Record<string, unknown>, force: boolean): { text: string; action: MergeAction } {
  let obj: { systems?: unknown[]; [k: string]: unknown } = {
    $comment: "Sin contraseñas: van al llavero (scripts/set-password.sh <id>). Permisos 600. Ver config/systems.example.json.",
    systems: [],
  };
  let action: MergeAction = "created";
  if (existing !== undefined && existing.trim()) {
    try {
      obj = JSON.parse(existing);
    } catch {
      throw new Error("systems.json no es JSON válido: no se toca. Corrígelo y repite.");
    }
    action = "added";
  }
  const systems = Array.isArray(obj.systems) ? (obj.systems as Array<Record<string, unknown>>) : [];
  const id = String(entry.id).toUpperCase();
  const i = systems.findIndex((s) => String(s?.id ?? "").toUpperCase() === id);
  if (i >= 0) {
    if (!force) return { text: existing ?? "", action: "kept" };
    systems[i] = entry;
    action = "replaced";
  } else systems.push(entry);
  obj.systems = systems;
  parseConfig(obj);
  return { text: JSON.stringify(obj, null, 2) + "\n", action };
}

export interface InitIo {
  platform: Platform;
  node: string;
  serverPath: string;
  configFile: string;
  isTTY: boolean;
  out: (line: string) => void;
  prompt: (question: string) => Promise<string>;
  /** Guarda la contraseña en el almacén del sistema operativo; devuelve el código de salida. */
  storePassword: (id: string) => number;
}

export function defaultIo(): InitIo {
  const here = dirname(new URL(import.meta.url).pathname);
  const rl = () => createInterface({ input: process.stdin, output: process.stderr });
  return {
    platform: { home: homedir(), cwd: process.cwd(), platform: process.platform, appData: process.env.APPDATA },
    node: process.execPath,
    serverPath: join(here, "..", "index.js"),
    configFile: configPath(),
    isTTY: !!process.stdin.isTTY,
    out: (l) => console.error(l),
    prompt: async (q) => {
      const r = rl();
      try {
        return (await r.question(q)).trim();
      } finally {
        r.close();
      }
    },
    storePassword: (id) => {
      const call =
        process.platform === "linux"
          ? spawnSync("secret-tool", ["store", `--label=${KEYCHAIN_SERVICE} ${id}`, "service", KEYCHAIN_SERVICE, "account", id], { stdio: "inherit" })
          : process.platform === "darwin"
            ? spawnSync("security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", id, "-w"], { stdio: "inherit" })
            : undefined;
      if (!call) return -1;
      return call.status ?? 1;
    },
  };
}

async function fill(a: InitArgs, io: InitIo): Promise<SystemFields> {
  const need = async (val: string | undefined, flag: string, question: string, def?: string): Promise<string> => {
    if (val) return val;
    if (!io.isTTY) throw new Error(`Falta ${flag} (sin terminal interactiva no se puede preguntar).\n${USAGE}`);
    const v = await io.prompt(def ? `${question} [${def}]: ` : `${question}: `);
    return v || def || "";
  };
  const system = (await need(a.system, "--system", "Id del sistema (p. ej. MI_DEV)")).toUpperCase();
  const url = await need(a.url, "--url", "URL de ADT (https://host:44300)");
  const sapClient = await need(a.sapClient, "--sap-client", "Mandante", "100");
  const user = (await need(a.user, "--user", "Usuario SAP")).toUpperCase();
  const role = (await need(a.role, "--role", "Rol (DEV, QAS o PRD)", "DEV")).toUpperCase() as SystemFields["role"];
  if (!["DEV", "QAS", "PRD"].includes(role)) throw new Error(`Rol inválido: ${role}.`);
  return { system, url, sapClient, user, role, sid: a.sid, language: a.language, allowWrite: a.allowWrite };
}

function writePrivate(path: string, text: string, dirMode: number, fileMode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: dirMode });
  if (existsSync(path)) copyFileSync(path, path + ".bak");
  writeFileSync(path, text, { mode: fileMode });
  chmodSync(path, fileMode);
}

const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : undefined);

/** Ejecuta el instalador; devuelve el código de salida. Toda la salida va por stderr (stdout queda para MCP). */
export async function runInit(argv: string[], io: InitIo = defaultIo()): Promise<number> {
  let a: InitArgs;
  try {
    a = parseInitArgs(argv);
  } catch (e) {
    io.out((e as Error).message);
    return 2;
  }
  if (a.help) {
    io.out(USAGE);
    return 0;
  }
  const say = (l: string) => io.out((a.dryRun ? "[dry-run] " : "") + l);
  try {
    // 1. systems.json
    const f = await fill(a, io);
    const entry = systemEntry(f);
    const sys = mergeSystems(read(io.configFile), entry, a.force);
    if (sys.action === "kept") say(`${io.configFile}: el sistema ${f.system} ya existe; se deja como está (usa --force para sustituirlo).`);
    else {
      if (!a.dryRun) writePrivate(io.configFile, sys.text, 0o700, 0o600);
      say(`${io.configFile}: sistema ${f.system} ${sys.action === "created" ? "creado (archivo nuevo, permisos 600)" : sys.action === "added" ? "añadido" : "sustituido"} · ${f.role}${entry.allowWrite ? " con escritura" : " solo lectura"}.`);
    }

    // 2. Contraseña: la pide el llavero, nunca este programa.
    if (!a.password) say(`Contraseña de ${f.system}: no se pidió (--no-password). Guárdala con scripts/set-password.sh ${f.system}.`);
    else if (a.dryRun) say(`Contraseña de ${f.system}: se pediría y guardaría en el almacén de secretos (${KEYCHAIN_SERVICE}).`);
    else if (!io.isTTY) say(`Contraseña de ${f.system}: sin terminal interactiva no se puede pedir. Guárdala con scripts/set-password.sh ${f.system}.`);
    else {
      io.out(`Contraseña SAP de ${f.user} en ${f.system} (la pide el almacén de secretos; no queda en ningún archivo):`);
      const code = io.storePassword(f.system);
      if (code === 0) say(`Contraseña de ${f.system} guardada en el almacén de secretos (${KEYCHAIN_SERVICE}).`);
      else if (code === -1) say(`Este sistema operativo no tiene almacén de secretos soportado: usa "password": "env:VARIABLE" en systems.json.`);
      else say(`No se guardó la contraseña (código ${code}). Repite con scripts/set-password.sh ${f.system}.`);
    }

    // 3. Cliente MCP
    if (a.client) {
      const { path, key } = clientConfigPath(a.client, io.platform);
      const merged = mergeClientConfig(read(path), key, serverEntry(a.client, io.node, io.serverPath), a.force);
      if (merged.action === "kept") say(`${path}: ya hay una entrada «${SERVER_NAME}»; se deja como está (usa --force para sustituirla).`);
      else {
        if (!a.dryRun) writePrivate(path, merged.text, 0o755, 0o644);
        say(`${path}: entrada «${SERVER_NAME}» ${merged.action === "created" ? "creada (archivo nuevo)" : merged.action === "added" ? "añadida" : "sustituida"}${existsSync(path + ".bak") && !a.dryRun ? " (copia anterior en .bak)" : ""}.`);
      }
      if (a.client === "claude-code") say("Claude Code lee .mcp.json del proyecto al arrancar: reinicia la sesión en esta carpeta.");
      if (a.client === "kiro" || a.client === "cursor" || a.client === "claude-desktop") say("Reinicia el cliente para que cargue el servidor.");
    } else say("Sin --client: registra el servidor a mano en tu cliente MCP (ver README, «Instalación»).");

    say(`Comprobación de solo lectura: node "${join(dirname(io.serverPath), "scripts", "smoke.js")}" ${f.system}`);
    return 0;
  } catch (e) {
    io.out(`init: ${(e as Error).message}`);
    return 1;
  }
}
