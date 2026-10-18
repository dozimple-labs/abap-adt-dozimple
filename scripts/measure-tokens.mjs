#!/usr/bin/env node
// Mide lo que el MCP publica al arrancar (nombre, descripción, esquemas) con la configuración real: bytes, tokens
// aproximados (bytes/4) y las tools más pesadas. Uso: node scripts/measure-tokens.mjs [core|expert] [--json]
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const profile = process.argv.find((a) => a === "core" || a === "expert") ?? "core";
const asJson = process.argv.includes("--json");
const { Client } = await import(pathToFileURL(join(repo, "node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js")).href);
const { StdioClientTransport } = await import(pathToFileURL(join(repo, "node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js")).href);

const client = new Client({ name: "measure-tokens", version: "1" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(repo, "dist/index.js")], stderr: "ignore", env: { ...process.env, ABAP_DZ_PROFILE: profile } }));
const { tools } = await client.listTools();
await client.close();

const words = (s) => s.trim().split(/\s+/).length;
const rows = tools
  .map((t) => ({ name: t.name, words: words(t.description ?? ""), description: (t.description ?? "").length, input: JSON.stringify(t.inputSchema).length, output: t.outputSchema ? JSON.stringify(t.outputSchema).length : 0 }))
  .map((r) => ({ ...r, total: r.description + r.input + r.output }))
  .sort((a, b) => b.total - a.total);
const bytes = JSON.stringify(tools).length;
const result = {
  date: new Date().toISOString().slice(0, 10),
  profile,
  tools: tools.length,
  bytes,
  tokensApprox: Math.round(bytes / 4),
  avgDescriptionWords: Math.round(rows.reduce((a, r) => a + r.words, 0) / rows.length),
  avgInputSchemaBytes: Math.round(rows.reduce((a, r) => a + r.input, 0) / rows.length),
  heaviest: rows.slice(0, 10),
};
if (asJson) console.log(JSON.stringify(result, null, 2));
else {
  console.log(`perfil ${profile}: ${result.tools} tools · ${bytes} bytes · ≈${result.tokensApprox} tokens · descripción media ${result.avgDescriptionWords} palabras · esquema medio ${result.avgInputSchemaBytes} bytes`);
  for (const r of result.heaviest) console.log(`  ${r.name.padEnd(24)} ${String(r.total).padStart(5)}  (desc ${r.description}, in ${r.input}, out ${r.output})`);
}
