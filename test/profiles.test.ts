import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsResultSchema, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "../src/core/config.js";
import { CORE_TOOLS, inProfile, resolveProfile } from "../src/core/profiles.js";
import { loadTools, registerAll } from "../src/core/registry.js";
import type { ToolDef } from "../src/core/tool.js";

let defs: ToolDef<any>[];
beforeAll(async () => {
  defs = await loadTools(join(__dirname, "..", "src", "tools"));
});
const base = { url: "https://sap.example:44300", client: "100", user: "U" };
const cfg = (tools: Record<string, unknown> = {}) => parseConfig({ systems: [{ ...base, id: "DEV", role: "DEV", allowWrite: true, modules: ["dz-transport-risk"] }], tools });
const pool = { get: () => ({}) } as any;

async function connect(c = cfg()) {
  const server = new McpServer({ name: "t", version: "1" });
  const reg = registerAll(server, defs, c, pool);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "1" });
  let changes = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => void changes++);
  await Promise.all([server.connect(a), client.connect(b)]);
  const names = async () => (await client.request({ method: "tools/list" }, ListToolsResultSchema)).tools.map((t) => t.name);
  return { client, reg, names, changes: () => changes };
}

describe("perfil de tools", () => {
  it("core por defecto: publica solo las de uso diario más load_tools; el resto queda diferido", async () => {
    const { reg, names } = await connect();
    expect(reg.profile).toBe("core");
    const listed = await names();
    expect(listed).toContain("get_source");
    expect(listed).toContain("load_tools");
    expect(listed).not.toContain("run_atc");
    expect(listed.length).toBeLessThanOrEqual(CORE_TOOLS.size);
    expect(reg.deferred).toContain("run_atc");
    expect(reg.published.length + reg.deferred.length).toBe(listed.length + reg.deferred.length);
  });

  it("una tool diferida no se puede llamar hasta cargarla", async () => {
    const { client } = await connect();
    const r: any = await client.callTool({ name: "run_atc", arguments: { object_name: "X" } }).catch((e) => e);
    expect(String(r?.message ?? r?.content?.[0]?.text)).toMatch(/not found|disabled|no existe|not enabled/i);
  });

  it("load_tools carga un grupo con UNA notificación, y «all» carga el resto; lo desconocido es error", async () => {
    const { client, names, changes, reg } = await connect();
    const r: any = await client.callTool({ name: "load_tools", arguments: { groups: ["calidad"] } });
    expect(r.content[0].text).toMatch(/Cargadas \d+: .*run_atc/);
    await new Promise((res) => setTimeout(res, 20));
    expect(changes()).toBe(1);
    expect(await names()).toContain("run_atc");
    const again: any = await client.callTool({ name: "load_tools", arguments: { groups: ["calidad"] } });
    expect(again.content[0].text).toMatch(/Nada que cargar/);
    const bad: any = await client.callTool({ name: "load_tools", arguments: { groups: ["nope"] } });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/No existe: nope/);
    await client.callTool({ name: "load_tools", arguments: { groups: ["all"] } });
    expect((await names()).length).toBe(reg.published.length + reg.deferred.length);
  });

  it("expert publica todo y no ofrece load_tools; ABAP_DZ_PROFILE manda sobre la configuración", async () => {
    const { reg, names } = await connect(cfg({ profile: "expert" }));
    expect(reg.deferred).toEqual([]);
    expect(await names()).not.toContain("load_tools");
    expect(resolveProfile(cfg({ profile: "expert" }), { ABAP_DZ_PROFILE: "core" })).toBe("core");
    expect(resolveProfile(cfg(), { ABAP_DZ_PROFILE: "" })).toBe("core");
  });

  it("una tool fuera del catálogo se publica siempre (no hay forma de pedirla con load_tools)", () => {
    expect(inProfile({ name: "t_out" }, "core")).toBe(true);
    expect(inProfile({ name: "run_atc" }, "core")).toBe(false);
    expect(inProfile({ name: "run_atc" }, "expert")).toBe(true);
  });

  it("el filtro only/except sigue mandando: lo excluido no se registra ni se puede cargar", async () => {
    const { reg, client } = await connect(cfg({ except: ["write"] }));
    expect(reg.published).not.toContain("write_source");
    expect(reg.deferred).not.toContain("revert_source");
    const r: any = await client.callTool({ name: "load_tools", arguments: { groups: ["revert_source"] } });
    expect(r.isError).toBe(true);
  });
});
