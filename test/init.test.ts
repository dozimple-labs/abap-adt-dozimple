import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clientConfigPath, mergeClientConfig, mergeSystems, parseInitArgs, runInit, serverEntry, systemEntry, type InitIo } from "../src/scripts/init.js";

const fields = { system: "MI_DEV", url: "https://sap.example:44300", sapClient: "100", user: "DEMO_USER", role: "DEV" as const, allowWrite: false };

describe("init · argumentos", () => {
  it("lee las opciones y rechaza las desconocidas o incompletas", () => {
    const a = parseInitArgs(["--client", "kiro", "--system", "mi_dev", "--role", "dev", "--allow-write", "--no-password", "--dry-run"]);
    expect(a).toMatchObject({ client: "kiro", system: "mi_dev", role: "DEV", allowWrite: true, password: false, dryRun: true });
    expect(() => parseInitArgs(["--client", "emacs"])).toThrow(/no es uno de/);
    expect(() => parseInitArgs(["--url"])).toThrow(/necesita un valor/);
    expect(() => parseInitArgs(["--rol", "DEV"])).toThrow(/Opción desconocida/);
  });
});

describe("init · dónde registra cada cliente", () => {
  const p = { home: "/h", cwd: "/w", platform: "darwin" as const };
  it("proyecto para Claude Code y VS Code; usuario para Kiro, Cursor y Claude Desktop", () => {
    expect(clientConfigPath("claude-code", p)).toEqual({ path: "/w/.mcp.json", key: "mcpServers" });
    expect(clientConfigPath("vscode", p)).toEqual({ path: "/w/.vscode/mcp.json", key: "servers" });
    expect(clientConfigPath("kiro", p).path).toBe("/h/.kiro/settings/mcp.json");
    expect(clientConfigPath("cursor", p).path).toBe("/h/.cursor/mcp.json");
    expect(clientConfigPath("claude-desktop", p).path).toBe("/h/Library/Application Support/Claude/claude_desktop_config.json");
    expect(clientConfigPath("claude-desktop", { ...p, platform: "win32", appData: "C:\\\\Users\\\\x\\\\AppData\\\\Roaming" }).path).toMatch(/Roaming[\\/]Claude[\\/]claude_desktop_config\.json$/);
    expect(clientConfigPath("claude-desktop", { ...p, platform: "linux" }).path).toBe("/h/.config/Claude/claude_desktop_config.json");
  });
  it("la entrada usa el Node y el index.js instalados; VS Code lleva type stdio", () => {
    expect(serverEntry("kiro", "/usr/bin/node", "/pkg/dist/index.js")).toEqual({ command: "/usr/bin/node", args: ["/pkg/dist/index.js"] });
    expect(serverEntry("vscode", "/usr/bin/node", "/pkg/dist/index.js")).toMatchObject({ type: "stdio" });
  });
});

describe("init · fusión con la configuración del cliente", () => {
  const entry = { command: "node", args: ["/x/index.js"] };
  it("crea el archivo, añade sin tocar otros servidores y no pisa una entrada existente sin force", () => {
    const created = mergeClientConfig(undefined, "mcpServers", entry, false);
    expect(created.action).toBe("created");
    expect(JSON.parse(created.text)).toEqual({ mcpServers: { "abap-adt-doZimple": entry } });
    const existing = JSON.stringify({ mcpServers: { otro: { command: "x" } }, theme: "dark" });
    const added = mergeClientConfig(existing, "mcpServers", entry, false);
    expect(added.action).toBe("added");
    expect(JSON.parse(added.text)).toEqual({ mcpServers: { otro: { command: "x" }, "abap-adt-doZimple": entry }, theme: "dark" });
    const kept = mergeClientConfig(added.text, "mcpServers", { command: "nuevo" }, false);
    expect(kept.action).toBe("kept");
    expect(kept.text).toBe(added.text);
    const replaced = mergeClientConfig(added.text, "mcpServers", { command: "nuevo" }, true);
    expect(replaced.action).toBe("replaced");
    expect(JSON.parse(replaced.text).mcpServers["abap-adt-doZimple"]).toEqual({ command: "nuevo" });
  });
  it("un archivo que no es JSON válido no se toca", () => {
    expect(() => mergeClientConfig("{ roto", "mcpServers", entry, true)).toThrow(/no es JSON válido/);
    expect(() => mergeClientConfig("[1,2]", "mcpServers", entry, true)).toThrow(/no contiene un objeto/);
  });
});

describe("init · systems.json", () => {
  it("el sistema cumple las mismas reglas que al arrancar", () => {
    expect(systemEntry(fields)).toMatchObject({ id: "MI_DEV", role: "DEV", allowWrite: false, language: "ES" });
    expect(systemEntry({ ...fields, role: "PRD", allowWrite: true }).allowWrite).toBe(false);
    expect(() => systemEntry({ ...fields, url: "sap example" })).toThrow();
    expect(() => systemEntry({ ...fields, sapClient: "1000" })).toThrow();
  });
  it("crea, añade, mantiene o sustituye según exista el id", () => {
    const e = systemEntry(fields);
    const c = mergeSystems(undefined, e, false);
    expect(c.action).toBe("created");
    const added = mergeSystems(c.text, systemEntry({ ...fields, system: "MI_QAS", role: "QAS" }), false);
    expect(added.action).toBe("added");
    expect(JSON.parse(added.text).systems.map((s: any) => s.id)).toEqual(["MI_DEV", "MI_QAS"]);
    expect(mergeSystems(added.text, e, false).action).toBe("kept");
    const r = mergeSystems(added.text, systemEntry({ ...fields, system: "mi_dev", allowWrite: true }), true);
    expect(r.action).toBe("replaced");
    expect(JSON.parse(r.text).systems[0]).toMatchObject({ id: "MI_DEV", allowWrite: true });
    expect(() => mergeSystems("{ roto", e, true)).toThrow(/no es JSON válido/);
  });
});

describe("init · ejecución", () => {
  function io(overrides: Partial<InitIo> = {}): { io: InitIo; lines: string[]; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), "abapdz-init-"));
    const lines: string[] = [];
    const io: InitIo = {
      platform: { home: join(dir, "home"), cwd: join(dir, "proj"), platform: "darwin" },
      node: "/usr/local/bin/node",
      serverPath: "/pkg/dist/index.js",
      configFile: join(dir, "cfg", "systems.json"),
      isTTY: false,
      out: (l) => lines.push(l),
      prompt: async () => { throw new Error("no debe preguntar"); },
      storePassword: () => 0,
      ...overrides,
    };
    return { io, lines, dir };
  }
  const argv = ["--system", "MI_DEV", "--url", "https://sap.example:44300", "--sap-client", "100", "--user", "DEMO_USER", "--role", "DEV"];

  it("sin terminal y sin datos, explica qué falta y no escribe", async () => {
    const { io: i, lines, dir } = io();
    expect(await runInit(["--client", "kiro"], i)).toBe(1);
    expect(lines.join("\n")).toMatch(/Falta --system/);
    expect(() => statSync(join(dir, "cfg", "systems.json"))).toThrow();
  });

  it("crea systems.json con permisos 600, registra en Kiro y pide la contraseña solo con terminal", async () => {
    const { io: i, lines, dir } = io({ isTTY: true, prompt: async () => "" });
    let asked = "";
    i.storePassword = (id) => { asked = id; return 0; };
    expect(await runInit([...argv, "--client", "kiro"], i)).toBe(0);
    const cfg = JSON.parse(readFileSync(join(dir, "cfg", "systems.json"), "utf8"));
    expect(cfg.systems[0]).toMatchObject({ id: "MI_DEV", role: "DEV", allowWrite: false });
    expect(statSync(join(dir, "cfg", "systems.json")).mode & 0o777).toBe(0o600);
    expect(asked).toBe("MI_DEV");
    const kiro = JSON.parse(readFileSync(join(dir, "home", ".kiro", "settings", "mcp.json"), "utf8"));
    expect(kiro.mcpServers["abap-adt-doZimple"]).toEqual({ command: "/usr/local/bin/node", args: ["/pkg/dist/index.js"] });
    expect(lines.join("\n")).toMatch(/smoke\.js" MI_DEV/);
  });

  it("pregunta lo que falta cuando hay terminal", async () => {
    const answers = ["mi_dev", "https://sap.example:44300", "", "demo_user", ""];
    const { io: i, dir } = io({ isTTY: true, prompt: async () => answers.shift() ?? "" });
    expect(await runInit(["--no-password"], i)).toBe(0);
    const cfg = JSON.parse(readFileSync(join(dir, "cfg", "systems.json"), "utf8"));
    expect(cfg.systems[0]).toMatchObject({ id: "MI_DEV", client: "100", user: "DEMO_USER", role: "DEV" });
  });

  it("dry-run no escribe nada y lo dice; una segunda ejecución no pisa lo que hay", async () => {
    const { io: i, lines, dir } = io();
    expect(await runInit([...argv, "--client", "cursor", "--dry-run"], i)).toBe(0);
    expect(lines.every((l) => l.startsWith("[dry-run]"))).toBe(true);
    expect(() => statSync(join(dir, "cfg", "systems.json"))).toThrow();
    expect(await runInit([...argv, "--client", "cursor", "--no-password"], i)).toBe(0);
    const cursor = join(dir, "home", ".cursor", "mcp.json");
    writeFileSync(cursor, JSON.stringify({ mcpServers: { "abap-adt-doZimple": { command: "mio" }, otro: {} } }));
    chmodSync(cursor, 0o644);
    expect(await runInit([...argv, "--client", "cursor", "--no-password"], i)).toBe(0);
    expect(JSON.parse(readFileSync(cursor, "utf8")).mcpServers["abap-adt-doZimple"]).toEqual({ command: "mio" });
    expect(lines.some((l) => /ya hay una entrada/.test(l))).toBe(true);
  });
});
