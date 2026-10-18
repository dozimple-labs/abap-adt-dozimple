import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "../src/core/config.js";
import { hasSessionPassword } from "../src/core/credentials.js";
import { loadTools } from "../src/core/registry.js";
import { parseBasicAuth, parseServeArgs, sessionConfig, startHttp, type HttpHandle } from "../src/http.js";

const cfg = parseConfig({ systems: [{ id: "DEV", role: "DEV", url: "https://sap.example:44300", client: "100", user: "TECNICO" }] });
const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;
let h: HttpHandle;
let url: string;
const logs: string[] = [];

beforeAll(async () => {
  process.env.ABAP_DZ_STATE_DIR = mkdtempSync(join(tmpdir(), "abapdz-http-"));
  const defs = await loadTools(new URL("../src/tools", import.meta.url).pathname);
  h = await startHttp(cfg, defs, undefined, { host: "127.0.0.1", port: 0, path: "/mcp", maxSessions: 2, idleMinutes: 60, log: (...a) => logs.push(a.join(" ")) }, "test");
  url = `http://127.0.0.1:${h.address.port}/mcp`;
});
afterAll(async () => h.close());

describe("modo HTTP · identidad por persona", () => {
  it("analiza la cabecera Basic y la configuración de sesión lleva el usuario de la persona", () => {
    expect(parseBasicAuth(basic("ana", "s3cr"))).toEqual({ user: "ANA", password: "s3cr" });
    expect(parseBasicAuth("Bearer x")).toBeUndefined();
    expect(parseBasicAuth(basic("usuario demasiado largo", "x"))).toBeUndefined();
    const sc = sessionConfig(cfg, "S1", "ANA");
    expect(sc.systems[0]).toMatchObject({ id: "DEV", user: "ANA" });
    expect(sc.systems[0].password).toBe("session:S1");
    expect(cfg.systems[0].user).toBe("TECNICO");
  });
  it("sin identidad responde 401; otra ruta 404; un GET sin sesión 400", async () => {
    const r = await fetch(url, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toMatch(/Basic/);
    expect((await fetch(`http://127.0.0.1:${h.address.port}/otra`, { headers: { Authorization: basic("ana", "x") } })).status).toBe(404);
    expect((await fetch(url, { headers: { Authorization: basic("ana", "x") } })).status).toBe(400);
  });
  it("una sesión por persona: lista tools, la contraseña vive solo mientras dura la sesión y otra identidad no puede usarla", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: basic("ana", "s3cr") } } });
    const client = new Client({ name: "t", version: "1" });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("sap_systems");
    const sid = transport.sessionId!;
    expect(hasSessionPassword(sid)).toBe(true);
    expect(h.sessions()).toBe(1);
    const other = await fetch(url, { method: "POST", headers: { Authorization: basic("beto", "x"), "mcp-session-id": sid, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }) });
    expect(other.status).toBe(403);
    const stale = await fetch(url, { method: "POST", headers: { Authorization: basic("ana", "s3cr"), "mcp-session-id": "no-existe", "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: "{}" });
    expect(stale.status).toBe(404);
    await transport.terminateSession();
    await client.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(hasSessionPassword(sid)).toBe(false);
    expect(h.sessions()).toBe(0);
    expect(logs.some((l) => /abierta para ANA/.test(l))).toBe(true);
    expect(logs.join("\n")).not.toMatch(/s3cr/);
  });
  it("respeta el máximo de sesiones", async () => {
    const open = async (u: string) => {
      const t = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: basic(u, "x") } } });
      const c = new Client({ name: "t", version: "1" });
      await c.connect(t);
      return { t, c };
    };
    const a = await open("uno");
    const b = await open("dos");
    await expect(open("tres")).rejects.toThrow(/503|Máximo/);
    await a.t.terminateSession();
    await b.t.terminateSession();
  });
  it("opciones de serve: entorno y argumentos, y nunca fuera de loopback sin TLS", async () => {
    expect(parseServeArgs(["--port", "3000", "--path", "/sap-mcp"], {})).toMatchObject({ host: "127.0.0.1", port: 3000, path: "/sap-mcp" });
    expect(parseServeArgs([], { ABAP_DZ_HTTP_HOST: "0.0.0.0", ABAP_DZ_HTTP_CERT: "c.pem", ABAP_DZ_HTTP_KEY: "k.pem" })).toMatchObject({ host: "0.0.0.0", tls: { certFile: "c.pem", keyFile: "k.pem" } });
    expect(() => parseServeArgs(["--cert", "c.pem"], {})).toThrow(/van juntos/);
    await expect(startHttp(cfg, [], undefined, { host: "0.0.0.0", port: 0, path: "/mcp", maxSessions: 1, idleMinutes: 1, log: () => undefined })).rejects.toThrow(/sin TLS/);
  });
});
