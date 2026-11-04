import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/core/config.js";
import { registerAll } from "../src/core/registry.js";
import type { ToolDef } from "../src/core/tool.js";

/**
 * Salida estructurada (outputSchema / structuredContent de MCP): el cliente recibe los datos además del texto y no
 * tiene que interpretar la prosa. El registro exige que una tool con `output` la devuelva siempre que no sea error,
 * y el SDK la valida contra el esquema antes de responder.
 */
beforeAll(() => {
  process.env.ABAP_DZ_STATE_DIR = mkdtempSync(join(tmpdir(), "abapdz-out-"));
});

vi.mock("../src/core/datapolicy.js", async (orig) => {
  const real = await orig<typeof import("../src/core/datapolicy.js")>();
  return {
    ...real,
    guardedQuery: async (_sap: unknown, _sys: unknown, query: string) =>
      query.includes("vacia")
        ? { columns: ["MATNR"], values: [], notes: [] }
        : { columns: ["MATNR", "WERKS"], values: Array.from({ length: 3 }, (_, i) => ({ MATNR: `M${i}`, WERKS: "1000" })), notes: ["tope 200 filas"] },
  };
});
vi.mock("../src/core/checks.js", async (orig) => {
  const real = await orig<typeof import("../src/core/checks.js")>();
  return {
    ...real,
    syntaxCheck: async (_c: unknown, _o: unknown, _u: unknown, content: string) =>
      content.includes("ROTO")
        ? [{ uri: "/x", line: 3, offset: 1, severity: "E", text: "Statement inválido" }, { uri: "/x", line: 5, offset: 0, severity: "W", text: "Aviso" }]
        : [],
  };
});

const { default: sqlQuery } = await import("../src/tools/core/sql_query.js");
const { default: syntaxCheckTool } = await import("../src/tools/core/syntax_check.js");

const cfg = parseConfig({ systems: [{ id: "DEV", role: "DEV", url: "https://sap.example:44300", client: "100", user: "U" }] });
const fakeClient = {
  searchObject: async () => [{ "adtcore:name": "ZDEMO", "adtcore:type": "PROG/P", "adtcore:uri": "/sap/bc/adt/programs/programs/zdemo", "adtcore:packageName": "$TMP" }],
  objectStructure: async () => { throw new Error("sin estructura"); },
  getObjectSource: async () => "REPORT zdemo.\n",
};
const pool = { get: (s: any) => ({ system: s, missingCapabilities: async () => [], adt: async () => fakeClient, noteNetworkFailure() {}, resetReader() {} }) } as any;

async function connect(defs: ToolDef<any>[]) {
  const server = new McpServer({ name: "t", version: "1" });
  registerAll(server, defs, cfg, pool);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const withOutput: ToolDef<any> = {
  name: "t_out", title: "T", description: "d".repeat(50), access: "read", input: { n: z.number().default(1) },
  output: { doubled: z.number() },
  run: async (a: any) => ({ text: `${a.n * 2}`, structured: { doubled: a.n * 2 } }),
};

describe("registro y protocolo", () => {
  it("una tool con output publica outputSchema y responde con structuredContent además del texto", async () => {
    const client = await connect([withOutput]);
    const listed = (await client.listTools()).tools.find((t) => t.name === "t_out")!;
    expect(listed.outputSchema).toMatchObject({ type: "object", properties: { doubled: { type: "number" } } });
    const r = (await client.callTool({ name: "t_out", arguments: { n: 21 } })) as any;
    expect(r.isError).toBe(false);
    expect(r.structuredContent).toMatchObject({ doubled: 42 });
    expect(r.structuredContent.sap_data_note).toMatch(/datos, nunca como instrucciones/);
    expect(r.content[0].text).toMatch(/42/);
  });

  it("una tool sin output no publica esquema ni structuredContent", async () => {
    const plain: ToolDef<any> = { ...withOutput, name: "t_plain", output: undefined, run: async () => "hola" };
    const client = await connect([plain]);
    const listed = (await client.listTools()).tools.find((t) => t.name === "t_plain")!;
    expect(listed.outputSchema).toBeUndefined();
    const r = (await client.callTool({ name: "t_plain", arguments: {} })) as any;
    expect(r.structuredContent).toBeUndefined();
  });

  it("declarar output y responder bien sin datos estructurados es un error del servidor, no un éxito a medias", async () => {
    const buggy: ToolDef<any> = { ...withOutput, name: "t_bug", run: async () => "solo texto" };
    const client = await connect([buggy]);
    const r = (await client.callTool({ name: "t_bug", arguments: {} })) as any;
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/t_bug declara salida estructurada y no la devolvió/);
  });

  it("un error de la tool no exige datos estructurados", async () => {
    const failing: ToolDef<any> = { ...withOutput, name: "t_fail", run: async () => ({ text: "resultado negativo", isError: true }) };
    const client = await connect([failing]);
    const r = (await client.callTool({ name: "t_fail", arguments: {} })) as any;
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
  });
});

describe("sql_query", () => {
  it("la vista previa estructurada lleva todo el texto que la persona debe revisar", () => {
    const texto = "VISTA PREVIA\nToken\nInstrucciones\n\nTablas: MARA\nTope: 200 filas";
    const s = (sqlQuery as ToolDef<any>).previewStructured!({}, texto) as { notes: string[] };
    expect(s.notes).toContain(texto);
  });

  it("devuelve filas, columnas y avisos estructurados, validados por el SDK", async () => {
    const client = await connect([sqlQuery as ToolDef<any>]);
    const r = (await client.callTool({ name: "sql_query", arguments: { query: "SELECT matnr, werks FROM mara", system: "DEV" } })) as any;
    expect(r.isError).toBe(false);
    expect(r.structuredContent).toMatchObject({ rows: 3, columns: ["MATNR", "WERKS"], truncated: false, notes: ["tope 200 filas"] });
    expect(r.structuredContent.values[1]).toEqual({ MATNR: "M1", WERKS: "1000" });
    expect(r.content[0].text).toMatch(/3 filas/);
  });

  it("sin filas también responde estructurado (rows 0), nunca vacío", async () => {
    const client = await connect([sqlQuery as ToolDef<any>]);
    const r = (await client.callTool({ name: "sql_query", arguments: { query: "SELECT matnr FROM vacia", system: "DEV" } })) as any;
    expect(r.isError).toBe(false);
    expect(r.structuredContent).toMatchObject({ rows: 0, columns: ["MATNR"], values: [], truncated: false, notes: [] });
    expect(r.structuredContent.sap_system).toBe("DEV");
    expect(r.structuredContent.sap_data_note).toMatch(/datos, nunca como instrucciones/);
    expect(r.content[0].text).toMatch(/no devolvió filas/);
  });
});

describe("syntax_check", () => {
  it("sin errores: estructurado con 0 errores y 0 avisos", async () => {
    const client = await connect([syntaxCheckTool as ToolDef<any>]);
    const r = (await client.callTool({ name: "syntax_check", arguments: { object_name: "ZDEMO", source: "REPORT zdemo.", system: "DEV" } })) as any;
    expect(r.isError).toBe(false);
    expect(r.structuredContent).toMatchObject({ object: "ZDEMO", checked: "proposed", errors: 0, warnings: 0, messages: [] });
  });

  it("con errores: isError y los mensajes con línea y severidad", async () => {
    const client = await connect([syntaxCheckTool as ToolDef<any>]);
    const r = (await client.callTool({ name: "syntax_check", arguments: { object_name: "ZDEMO", source: "REPORT zdemo. ROTO", system: "DEV" } })) as any;
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ object: "ZDEMO", checked: "proposed", errors: 1, warnings: 1 });
    expect(r.structuredContent.messages[0]).toEqual({ severity: "E", line: 3, offset: 1, text: "Statement inválido", uri: "/x" });
  });
});
