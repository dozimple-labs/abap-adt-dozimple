import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { AUDIT_FILE, type AuditEntry } from "../src/core/audit.js";
import { parseConfig } from "../src/core/config.js";
import { guardedQuery, readPreview } from "../src/core/datapolicy.js";
import { invoke } from "../src/core/registry.js";
import type { ToolDef } from "../src/core/tool.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "abapdz-prodread-"));
  process.env.ABAP_DZ_STATE_DIR = dir;
});

const base = { url: "https://sap.example:44300", client: "100", user: "DEMO_USER" };
const cfg = parseConfig({ systems: [{ ...base, id: "DEV", role: "DEV" }, { ...base, id: "PRD", role: "PRD" }, { ...base, id: "PRD_LIBRE", role: "PRD", confirmProdReads: false }] });
const pool = { get: (s: any) => ({ system: s, missingCapabilities: async () => [], adt: async () => ({}), noteNetworkFailure() {}, resetReader() {} }) } as any;
const make = () => {
  const calls: unknown[] = [];
  const def: ToolDef<any> = {
    name: "t_data", title: "Lee datos", description: "d", access: "read", confirmReads: true, input: {},
    preview: async (a, ctx) => readPreview(ctx.system, a.query, 50),
    run: async (a) => (calls.push(a), "KUNNR\n1"),
  };
  return { def, calls };
};
const entries = () => readFileSync(join(dir, AUDIT_FILE), "utf8").trim().split("\n").map((l) => JSON.parse(l) as AuditEntry);

describe("lecturas de datos productivos con confirmación", () => {
  it("en PRD la primera llamada devuelve la vista previa (tablas y tope) sin leer, y la segunda con el token lee y queda auditada", async () => {
    const { def, calls } = make();
    const first = await invoke(def, { system: "PRD", query: "SELECT kunnr FROM kna1 AS a INNER JOIN knvv AS b ON a~kunnr = b~kunnr" }, { config: cfg, pool, tools: [] });
    expect(first.isError).toBe(false);
    expect(first.text).toMatch(/VISTA PREVIA: todavía no se ha leído nada/);
    expect(first.text).toMatch(/KNA1, KNVV · hasta 50 filas/);
    expect(calls).toHaveLength(0);
    const token = first.text.match(/confirm_token="([0-9a-f]+)"/)![1];
    const second = await invoke(def, { system: "PRD", query: "SELECT kunnr FROM kna1 AS a INNER JOIN knvv AS b ON a~kunnr = b~kunnr", confirm_token: token }, { config: cfg, pool, tools: [] });
    expect(second.isError).toBe(false);
    expect(calls).toHaveLength(1);
    expect(entries().map((e) => [e.phase, e.access, e.confirmedBy])).toEqual([["intent", "read", "token"], ["result", "read", "token"]]);
  });

  it("en DEV, o con confirmProdReads false, lee directamente", async () => {
    const { def, calls } = make();
    await invoke(def, { system: "DEV", query: "SELECT * FROM t000" }, { config: cfg, pool, tools: [] });
    await invoke(def, { system: "PRD_LIBRE", query: "SELECT * FROM t000" }, { config: cfg, pool, tools: [] });
    expect(calls).toHaveLength(2);
  });

  it("la elicitación pregunta por la lectura, no por una escritura", async () => {
    const { def, calls } = make();
    let asked = "";
    const r = await invoke(def, { system: "PRD", query: "SELECT * FROM t000" }, { config: cfg, pool, tools: [], elicit: async (m) => ((asked = m), "accept") });
    expect(r.isError).toBe(false);
    expect(asked).toMatch(/¿Confirmas esta lectura de datos productivos\?/);
    expect(calls).toHaveLength(1);
  });
});

describe("vista previa con esquema de salida", () => {
  it("toda tool con output y confirmación (confirmReads o confirm) define previewStructured", async () => {
    const { loadTools } = await import("../src/core/registry.js");
    const defs = await loadTools(new URL("../src/tools", import.meta.url).pathname);
    const bad = defs.filter((d) => d.output && (d.confirmReads || d.confirm === true || d.access === "write") && !d.previewStructured).map((d) => d.name);
    expect(bad).toEqual([]);
  });
  it("sql_query en PRD devuelve la vista previa con contenido estructurado válido", async () => {
    const { default: sqlQuery } = await import("../src/tools/core/sql_query.js");
    const { z } = await import("zod");
    const r = await invoke(sqlQuery as ToolDef<any>, { system: "PRD", query: "SELECT * FROM t000", max_rows: 5 }, { config: cfg, pool, tools: [] });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/VISTA PREVIA/);
    expect(() => z.object((sqlQuery as ToolDef<any>).output!).parse(r.structured)).not.toThrow();
    expect((r.structured as any).notes[0]).toMatch(/no se ha ejecutado/);
  });
});

describe("guardedQuery · análisis de fuentes", () => {
  const sap = { query: async (sql: string) => (/dd26s|ddldependency/i.test(sql) ? { columns: [], values: [] } : { columns: [{ name: "MANDT" }], values: [{ MANDT: "100" }] }), adt: async () => ({}) } as any;
  it("rechaza una consulta cuyas fuentes no se pueden determinar y acepta la equivalente explícita", async () => {
    await expect(guardedQuery(sap, cfg.systems[0], "SELECT * FROM (lv_tab)", 10)).rejects.toThrow(/No se puede determinar qué tablas lee/);
    await expect(guardedQuery(sap, cfg.systems[0], "SELECT * FROM t000 UP TO 5 ROWS", 10)).rejects.toThrow(/UP TO/);
    await expect(guardedQuery(sap, cfg.systems[0], "SELECT * FROM t000", 10)).resolves.toMatchObject({ values: [{ MANDT: "100" }] });
  });
  it("el veto de tablas sensibles también pasa por las fuentes analizadas", async () => {
    await expect(guardedQuery(sap, cfg.systems[0], "SELECT * FROM t000 INNER JOIN usr02 ON t000~mandt = usr02~mandt", 10)).rejects.toThrow(/seguridad/);
  });
});
