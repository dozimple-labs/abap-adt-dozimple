import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Config } from "./core/config.js";
import { ConnectionPool } from "./core/connection.js";
import { clearSessionPassword, setSessionPassword } from "./core/credentials.js";
import { registerPrompts } from "./core/prompts.js";
import { registerAll } from "./core/registry.js";
import type { SidecarPool } from "./core/sidecar.js";
import type { ToolDef } from "./core/tool.js";

/**
 * Modo HTTP con identidad por persona (Ola 3, punto 14). Cada sesión MCP (Streamable HTTP) lleva en cada petición
 * la identidad SAP de quien la usa (`Authorization: Basic usuario:contraseña`), y el servidor habla con SAP COMO
 * ESA PERSONA: su usuario en las conexiones, en los bloqueos, en las órdenes y en el registro de auditoría. No se
 * guarda ninguna contraseña en disco: vive en memoria mientras dura la sesión y se borra al cerrarla. stdio sigue
 * siendo el modo individual; este es el modo de equipo detrás de TLS.
 */
export interface HttpOptions {
  host: string;
  port: number;
  path: string;
  tls?: { certFile: string; keyFile: string };
  /** Solo para pruebas: escuchar fuera de loopback sin TLS. Nunca en producción. */
  allowInsecureRemote?: boolean;
  maxSessions: number;
  idleMinutes: number;
  log: (...a: unknown[]) => void;
}

export const DEFAULT_HTTP: Omit<HttpOptions, "log"> = { host: "127.0.0.1", port: 2235, path: "/mcp", maxSessions: 50, idleMinutes: 60 };

export const isLoopback = (host: string) => ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host);

export function parseBasicAuth(header: string | undefined): { user: string; password: string } | undefined {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/.exec(header ?? "");
  if (!m) return undefined;
  const raw = Buffer.from(m[1], "base64").toString("utf8");
  const i = raw.indexOf(":");
  if (i <= 0) return undefined;
  const user = raw.slice(0, i).trim().toUpperCase();
  const password = raw.slice(i + 1);
  if (!/^[A-Za-z0-9_.@-]{1,12}$/.test(user) || !password) return undefined;
  return { user, password };
}

/** La configuración de la sesión: los mismos sistemas, pero con el usuario de la persona y su contraseña en memoria. */
export function sessionConfig(cfg: Config, sessionId: string, user: string): Config {
  return { ...cfg, systems: cfg.systems.map((s) => ({ ...s, user, password: `session:${sessionId}` })) };
}

interface Session {
  id: string;
  user: string;
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastUsed: number;
}

async function readBody(req: IncomingMessage, max = 4 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new Error("cuerpo demasiado grande");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function reply(res: ServerResponse, status: number, body: object, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

export interface HttpHandle {
  close(): Promise<void>;
  address: { host: string; port: number; path: string; tls: boolean };
  sessions(): number;
}

export async function startHttp(config: Config, defs: readonly ToolDef<any>[], sidecars: SidecarPool | undefined, opts: HttpOptions, version = "0.0.0"): Promise<HttpHandle> {
  if (!isLoopback(opts.host) && !opts.tls && !opts.allowInsecureRemote) {
    throw new Error(`Escuchar en ${opts.host} sin TLS expondría usuarios y contraseñas SAP en claro: indica --cert y --key, o --host 127.0.0.1 detrás de un proxy TLS.`);
  }
  const sessions = new Map<string, Session>();
  const { log } = opts;
  let boundPort = opts.port; // el real se conoce tras listen (0 = cualquiera libre)

  async function closeSession(id: string, why: string): Promise<void> {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    clearSessionPassword(id);
    await s.transport.close().catch(() => undefined);
    log(`sesión ${id.slice(0, 8)}… de ${s.user} cerrada (${why}); ${sessions.size} activas`);
  }

  async function newSession(user: string, password: string): Promise<Session> {
    const id = randomUUID();
    setSessionPassword(id, password);
    const cfg = sessionConfig(config, id, user);
    const server = new McpServer({ name: "abap-adt-doZimple", version });
    registerAll(server, defs, cfg, new ConnectionPool(), sidecars);
    registerPrompts(server, cfg);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => id,
      onsessionclosed: (sid) => void closeSession(sid, "cerrada por el cliente"),
      ...(isLoopback(opts.host) ? { enableDnsRebindingProtection: true, allowedHosts: [`localhost:${boundPort}`, `127.0.0.1:${boundPort}`, `[::1]:${boundPort}`, "localhost", "127.0.0.1"] } : {}),
    });
    const s: Session = { id, user, transport, server, lastUsed: Date.now() };
    sessions.set(id, s);
    await server.connect(transport);
    log(`sesión ${id.slice(0, 8)}… abierta para ${user}; ${sessions.size} activas`);
    return s;
  }

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname !== opts.path) return reply(res, 404, { error: "no existe" });
      const auth = parseBasicAuth(req.headers.authorization);
      if (!auth) return reply(res, 401, { error: "Identidad SAP requerida: Authorization: Basic usuario:contraseña en cada petición." }, { "WWW-Authenticate": 'Basic realm="abap-adt-dozimple", charset="UTF-8"' });
      const sid = req.headers["mcp-session-id"];
      const existing = typeof sid === "string" ? sessions.get(sid) : undefined;
      if (typeof sid === "string" && !existing) return reply(res, 404, { error: "Sesión desconocida o caducada: inicia otra." });
      if (existing && existing.user !== auth.user) return reply(res, 403, { error: "La identidad de la petición no es la de la sesión." });
      if (!existing && req.method !== "POST") return reply(res, 400, { error: "Sin sesión: la primera petición es el POST de initialize." });
      const body = req.method === "POST" ? await readBody(req) : undefined;
      let s = existing;
      if (!s) {
        if (sessions.size >= opts.maxSessions) return reply(res, 503, { error: `Máximo de ${opts.maxSessions} sesiones alcanzado.` });
        s = await newSession(auth.user, auth.password);
      }
      s.lastUsed = Date.now();
      await s.transport.handleRequest(req, res, body);
    } catch (e) {
      log("petición fallida:", (e as Error).message);
      if (!res.headersSent) reply(res, 400, { error: (e as Error).message });
      else res.end();
    }
  };

  const server: Server = opts.tls
    ? createHttpsServer({ cert: readFileSync(opts.tls.certFile), key: readFileSync(opts.tls.keyFile) }, handler)
    : createHttpServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port;
  boundPort = port;
  const sweeper = setInterval(() => {
    const limit = Date.now() - opts.idleMinutes * 60_000;
    for (const [id, s] of sessions) if (s.lastUsed < limit) void closeSession(id, `inactiva ${opts.idleMinutes} min`);
  }, 60_000);
  sweeper.unref();
  log(`modo HTTP: ${opts.tls ? "https" : "http"}://${opts.host}:${port}${opts.path} · identidad por persona (Basic) · máx. ${opts.maxSessions} sesiones · inactividad ${opts.idleMinutes} min`);
  return {
    address: { host: opts.host, port, path: opts.path, tls: !!opts.tls },
    sessions: () => sessions.size,
    async close() {
      clearInterval(sweeper);
      for (const id of [...sessions.keys()]) await closeSession(id, "servidor cerrado");
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** Opciones de la línea de órdenes y del entorno (ABAP_DZ_HTTP_HOST, _PORT, _PATH, _CERT, _KEY, _MAX_SESSIONS, _IDLE_MINUTES). */
export function parseServeArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): Omit<HttpOptions, "log"> {
  const o: Omit<HttpOptions, "log"> = { ...DEFAULT_HTTP };
  if (env.ABAP_DZ_HTTP_HOST) o.host = env.ABAP_DZ_HTTP_HOST;
  if (env.ABAP_DZ_HTTP_PORT) o.port = Number(env.ABAP_DZ_HTTP_PORT);
  if (env.ABAP_DZ_HTTP_PATH) o.path = env.ABAP_DZ_HTTP_PATH;
  if (env.ABAP_DZ_HTTP_CERT && env.ABAP_DZ_HTTP_KEY) o.tls = { certFile: env.ABAP_DZ_HTTP_CERT, keyFile: env.ABAP_DZ_HTTP_KEY };
  if (env.ABAP_DZ_HTTP_MAX_SESSIONS) o.maxSessions = Number(env.ABAP_DZ_HTTP_MAX_SESSIONS);
  if (env.ABAP_DZ_HTTP_IDLE_MINUTES) o.idleMinutes = Number(env.ABAP_DZ_HTTP_IDLE_MINUTES);
  let cert: string | undefined;
  let key: string | undefined;
  const take = (i: number, f: string) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${f} necesita un valor.`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    switch (f) {
      case "--host": o.host = take(i++, f); break;
      case "--port": o.port = Number(take(i++, f)); break;
      case "--path": o.path = take(i++, f); break;
      case "--cert": cert = take(i++, f); break;
      case "--key": key = take(i++, f); break;
      case "--max-sessions": o.maxSessions = Number(take(i++, f)); break;
      case "--idle-minutes": o.idleMinutes = Number(take(i++, f)); break;
      case "--allow-insecure-remote": o.allowInsecureRemote = true; break;
      default: throw new Error(`Opción desconocida para serve: ${f}`);
    }
  }
  if ((cert && !key) || (!cert && key)) throw new Error("--cert y --key van juntos.");
  if (cert && key) o.tls = { certFile: cert, keyFile: key };
  if (!o.path.startsWith("/")) throw new Error("--path debe empezar por /.");
  if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65535) throw new Error("--port inválido.");
  if (!Number.isInteger(o.maxSessions) || o.maxSessions < 1 || !Number.isInteger(o.idleMinutes) || o.idleMinutes < 1) throw new Error("--max-sessions e --idle-minutes deben ser enteros positivos.");
  return o;
}
