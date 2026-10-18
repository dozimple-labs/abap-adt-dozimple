#!/usr/bin/env node
// Harness del protocolo de prueba comparativa (docs/benchmarks/PROTOCOLO.md): ejecuta las diez tareas contra un
// sistema con este MCP y escribe el JSON de resultados; con --compare, imprime la tabla entre dos JSON.
//   node scripts/benchmark.mjs <SISTEMA> [--runs 3] [--label etiqueta] [--tasks 1,2,3] [--out ruta]
//   node scripts/benchmark.mjs --compare a.json b.json
// Objetos por entorno (nunca en el repositorio): BENCH_OBJECT, BENCH_TRANSPORT, BENCH_MESSAGE, BENCH_TABLE.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
};

if (argv[0] === "--compare") {
  compare(JSON.parse(readFileSync(argv[1], "utf8")), JSON.parse(readFileSync(argv[2], "utf8")));
  process.exit(0);
}

const system = argv.find((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1]?.startsWith("--") !== true);
if (!system) {
  console.error("uso: node scripts/benchmark.mjs <SISTEMA> [--runs 3] [--label etiqueta] [--tasks 1,2] [--out ruta] | --compare a.json b.json");
  process.exit(2);
}
const runs = Number(flag("--runs", "3"));
const label = flag("--label", `${system.toLowerCase()}-dozimple`);
const only = flag("--tasks", "")
  .split(",")
  .filter(Boolean)
  .map(Number);
const env = { object: process.env.BENCH_OBJECT, transport: process.env.BENCH_TRANSPORT, message: process.env.BENCH_MESSAGE, table: process.env.BENCH_TABLE ?? "T000" };

const { Client } = await import(pathToFileURL(join(repo, "node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js")).href);
const { StdioClientTransport } = await import(pathToFileURL(join(repo, "node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js")).href);
const client = new Client({ name: "benchmark", version: "1" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(repo, "dist/index.js")], stderr: "ignore" }));
const { tools } = await client.listTools();
const catalogTokens = Math.round(JSON.stringify(tools).length / 4);
const version = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version;
const has = (t) => tools.some((x) => x.name === t);

/** Las diez tareas del protocolo: secuencia mínima y comprobación del resultado esperado. */
const TASKS = [
  { id: 1, name: "Localizar y explicar un objeto", needs: ["object"], calls: () => [["search_objects", { query: env.object, max_results: 5 }], ["get_source", { object_name: env.object, line_count: 80 }]], expect: (texts) => texts[1].includes("líneas") },
  { id: 2, name: "Contexto antes de tocar", variant: "object_context", needs: ["object"], calls: () => [["object_context", { object_name: env.object, depth: 1 }]], expect: (t) => /Paquete/.test(t[0]) },
  { id: 2, name: "Contexto antes de tocar", variant: "cadena", needs: ["object"], calls: () => [["edit_preflight", { object_name: env.object }], ["where_used", { object_name: env.object, max_results: 10 }], ["object_versions", { object_name: env.object }]], expect: (t) => /Veredicto/.test(t[0]) },
  { id: 3, name: "Diagnosticar un mensaje", needs: ["message"], calls: () => [["diagnose_message", { message: env.message }]], expect: (t) => !/No encontrado/.test(t[0]) },
  { id: 4, name: "Revisar una orden", needs: ["transport"], calls: () => [["transport_contents", { transport: env.transport, max_objects: 50 }], ["transport_diff", { transport: env.transport, summary_only: true }]], expect: (t) => /objetos|objeto/.test(t[0]) },
  { id: 5, name: "Cambiar una línea con confirmación (solo vista previa)", needs: ["object"], write: true, calls: () => [["edit_source", { object_name: env.object, edits: [{ old_text: "REPORT", new_text: "REPORT" }], activate: false }]], expect: (t) => /VISTA PREVIA|iguales/.test(t[0]) },
  { id: 6, name: "ATC de un objeto", needs: ["object"], calls: () => [["run_atc", { object_name: env.object }]], expect: (t) => /P1|hallazgos|sin hallazgos/i.test(t[0]) },
  { id: 7, name: "Consultar datos con política", calls: () => [["count_rows", { table: env.table }], ["sql_query", { query: `SELECT * FROM ${env.table}`, max_rows: 20 }]], expect: (t) => /filas/.test(t[1]) },
  { id: 8, name: "Dumps recientes", calls: () => [["dumps", { max: 5 }]], expect: (t) => !/Sin conexión/.test(t[0]) },
  { id: 9, name: "Documentación del lenguaje", local: true, calls: () => [["docs_search", { query: "inline declaration", k: 3 }]], expect: (t) => t[0].length > 50 },
  { id: 10, name: "Mis órdenes abiertas", calls: () => [["my_transports", {}]], expect: (t) => /orden|órdenes/i.test(t[0]) },
];

async function call(tool, args, local) {
  const t0 = Date.now();
  let r;
  try {
    r = await client.callTool({ name: tool, arguments: local ? args : { system, ...args } }, undefined, { timeout: 180_000 });
  } catch (e) {
    return { ms: Date.now() - t0, text: `sin respuesta: ${e.message}`, isError: true };
  }
  return { ms: Date.now() - t0, text: r.content?.map((c) => c.text ?? "").join("\n") ?? "", isError: !!r.isError };
}

// Las tools fuera del perfil core se cargan una vez, como haría un agente, y ese coste se anota aparte.
const wanted = new Set(TASKS.flatMap((t) => t.calls().map(([n]) => n)));
const missing = [...wanted].filter((n) => !has(n));
let loadMs = 0;
if (missing.length && has("load_tools")) {
  const r = await call("load_tools", { groups: ["all"] }, true);
  loadMs = r.ms;
}
const listed = (await client.listTools()).tools.map((t) => t.name);

const results = [];
for (const task of TASKS) {
  if (only.length && !only.includes(task.id)) continue;
  const entry = { id: task.id, name: task.name, variant: task.variant, calls: 0, ms: 0, chars: 0, tokens: 0, ok: false, firstTry: false, wrongTool: 0, errors: 0, runs: [] };
  const missingEnv = (task.needs ?? []).filter((k) => !env[k]);
  const toolsOk = task.calls().every(([n]) => listed.includes(n));
  if (missingEnv.length) entry.skipped = `falta BENCH_${missingEnv[0].toUpperCase()}`;
  else if (!toolsOk) entry.skipped = `tool no disponible: ${task.calls().map(([n]) => n).find((n) => !listed.includes(n))}`;
  if (entry.skipped) {
    results.push(entry);
    console.error(`– ${task.id} ${task.name}${task.variant ? ` [${task.variant}]` : ""}: no aplica (${entry.skipped})`);
    continue;
  }
  for (let i = 0; i < runs; i++) {
    const t0 = Date.now();
    const texts = [];
    let errors = 0;
    for (const [tool, args] of task.calls()) {
      const r = await call(tool, args, task.local);
      texts.push(r.text);
      if (r.isError) errors++;
    }
    const chars = texts.reduce((a, t) => a + t.length, 0);
    let ok = false;
    try {
      ok = !!task.expect(texts) && errors === 0;
    } catch {
      ok = false;
    }
    entry.runs.push({ ms: Date.now() - t0, chars, errors, ok });
  }
  const med = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  entry.calls = task.calls().length;
  entry.ms = med(entry.runs.map((r) => r.ms));
  entry.chars = med(entry.runs.map((r) => r.chars));
  entry.tokens = Math.round(entry.chars / 4);
  entry.errors = med(entry.runs.map((r) => r.errors));
  entry.ok = entry.runs.every((r) => r.ok);
  entry.firstTry = entry.ok; // la secuencia es fija: si acierta, acierta a la primera
  results.push(entry);
  console.error(`${entry.ok ? "✓" : "✗"} ${task.id} ${task.name}${task.variant ? ` [${task.variant}]` : ""}: ${entry.calls} llamadas · ${entry.ms} ms · ≈${entry.tokens} tokens${entry.errors ? ` · ${entry.errors} errores` : ""}`);
}
await client.close();

const out = {
  date: new Date().toISOString().slice(0, 10),
  label,
  server: { name: "abap-adt-doZimple", version, profile: process.env.ABAP_DZ_PROFILE ?? "core", catalogTokens, loadToolsMs: loadMs },
  system: { id: system },
  runs,
  tasks: results.map(({ runs: _r, ...t }) => t),
};
const outPath = flag("--out", join(repo, "docs", "benchmarks", `run-${out.date}-${label}.json`));
writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
console.error(`\nEscrito ${outPath} · catálogo al arrancar ≈${catalogTokens} tokens`);

function compare(a, b) {
  const key = (t) => `${t.id}${t.variant ? `/${t.variant}` : ""}`;
  const bm = new Map(b.tasks.map((t) => [key(t), t]));
  console.log(`tarea\t${a.label}: llamadas/ms/tokens/ok\t${b.label}: llamadas/ms/tokens/ok`);
  for (const t of a.tasks) {
    const o = bm.get(key(t));
    const cell = (x) => (!x || x.skipped ? "no aplica" : `${x.calls}/${x.ms}/${x.tokens}/${x.ok ? "sí" : "no"}`);
    console.log(`${key(t)} ${t.name}\t${cell(t)}\t${cell(o)}`);
  }
  console.log(`catálogo al arrancar\t≈${a.server.catalogTokens}\t≈${b.server.catalogTokens}`);
}
