#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { configPath, loadConfig, startupWarnings } from "./core/config.js";
import { clearPasswords } from "./core/credentials.js";
import { ConnectionPool } from "./core/connection.js";
import { registerPrompts } from "./core/prompts.js";
import { loadTools, registerAll } from "./core/registry.js";
import { filterWarnings, resolveToolFilter } from "./core/toolfilter.js";
import { SidecarPool } from "./core/sidecar.js";

// stdout es el canal MCP: cualquier log va a stderr.
const log = (...a: unknown[]) => console.error("[abap-adt-doZimple]", ...a);
const here = dirname(fileURLToPath(import.meta.url));

/** Versión única: la de package.json (dist/index.js → ../package.json, también dentro del paquete npm). */
function packageVersion(): string {
  try {
    return JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version;
  } catch {
    return "0.0.0";
  }
}

async function main() {
  const server = new McpServer({ name: "abap-adt-doZimple", version: packageVersion() });

  let config;
  try {
    config = loadConfig();
  } catch (e) {
    // Sin configuración se arranca igual, con una sola tool que explica el
    // problema: así se ve en el cliente en vez de un servidor «caído».
    const msg = (e as Error).message;
    log(msg);
    server.registerTool(
      "sap_systems",
      { title: "Sistemas SAP", description: "Estado de la configuración de sistemas SAP." },
      async () => ({ content: [{ type: "text", text: `Configuración inválida (${configPath()}):\n${msg}` }], isError: true }),
    );
    await server.connect(new StdioServerTransport());
    return;
  }

  for (const w of startupWarnings(config)) log(`⚠ ${w}`);

  const defs = await loadTools(join(here, "tools"));
  for (const w of filterWarnings(resolveToolFilter(config), defs)) log(`ℹ ${w}`);
  const sidecars = new SidecarPool(config);
  const published = registerAll(server, defs, config, new ConnectionPool(), sidecars);
  // Los componentes auxiliares son procesos hijo: se cierran con el servidor.
  const shutdown = () => {
    clearPasswords();
    void sidecars.closeAll().finally(() => process.exit(0));
  };
  process.stdin.on("close", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  const prompts = registerPrompts(server, config);
  log(`${published.length} tools y ${prompts.length} prompts para ${config.systems.map((s) => s.id).join(", ")}`);
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  log("fallo al arrancar:", e);
  process.exit(1);
});
