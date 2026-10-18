import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUDIT_FILE, auditIo, verifyAudit, type AuditEntry } from "../src/core/audit.js";
import { parseConfig } from "../src/core/config.js";
import { guardedQuery } from "../src/core/datapolicy.js";
import { mergeReads, noteDataRead, tablesOf, withDataReads } from "../src/core/datareads.js";
import { invoke } from "../src/core/registry.js";
import type { ToolDef } from "../src/core/tool.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "abapdz-dataread-"));
  process.env.ABAP_DZ_STATE_DIR = dir;
});
afterEach(() => vi.restoreAllMocks());

describe("data_read · qué tablas nombra una consulta", () => {
  it("FROM y JOIN, sin literales ni alias; subconsultas y CTE incluidas", () => {
    expect(tablesOf("SELECT a~matnr FROM mara AS a INNER JOIN marc AS b ON a~matnr = b~matnr WHERE a~mtart = 'FROM X'")).toEqual(["MARA", "MARC"]);
    expect(tablesOf("select * from /dz/ztab where x = 'join y'")).toEqual(["/DZ/ZTAB"]);
    expect(tablesOf("SELECT COUNT( * ) FROM ( SELECT kunnr FROM kna1 ) AS s")).toEqual(["KNA1"]);
    expect(tablesOf("WITH +c AS ( SELECT matnr FROM mara ) SELECT * FROM +c")).toEqual(["MARA", "C"]);
  });
  it("une varias lecturas de una misma tool", () => {
    expect(mergeReads([{ tables: ["T000"], maskedColumns: [], rows: 3, capped: false }, { tables: ["KNA1", "T000"], maskedColumns: ["NAME1"], rows: 200, capped: true }])).toEqual({
      tables: ["KNA1", "T000"], maskedColumns: ["NAME1"], rows: 203, capped: true, queries: 2, categories: [], elevated: [],
    });
  });
});

describe("data_read · la política de datos anota cada consulta", () => {
  const system = parseConfig({ systems: [{ id: "PRD", role: "PRD", url: "https://sap.example:44300", client: "300", user: "U", maxRows: 2 }] }).systems[0];
  const sap = {
    query: async (sql: string) =>
      /FROM dd26s|FROM ddldependency/.test(sql)
        ? { columns: [], values: [] }
        : { columns: [{ name: "KUNNR" }, { name: "NAME1" }], values: [{ KUNNR: "1", NAME1: "Alguien" }, { KUNNR: "2", NAME1: "Otro" }] },
    adt: async () => ({}),
  } as any;
  it("tablas, columnas enmascaradas, filas y tope; nunca los valores", async () => {
    const { reads } = await withDataReads(() => guardedQuery(sap, system, "SELECT kunnr, name1 FROM kna1", 100));
    expect(reads).toEqual([{ tables: ["KNA1"], maskedColumns: ["NAME1"], rows: 2, capped: true, categories: ["PERSONAS_NEGOCIO"], elevated: [] }]);
    expect(JSON.stringify(reads)).not.toMatch(/Alguien/);
  });
  it("fuera de una tool no anota nada y no falla", () => {
    expect(() => noteDataRead({ tables: ["T000"], maskedColumns: [], rows: 1, capped: false })).not.toThrow();
  });
});

describe("data_read · el registro la encadena antes de entregar el resultado", () => {
  const cfg = parseConfig({ systems: [{ id: "DEV", role: "DEV", url: "https://sap.example:44300", client: "100", user: "DEMO_USER" }] });
  const pool = { get: (s: any) => ({ system: s, missingCapabilities: async () => [], adt: async () => ({}), noteNetworkFailure() {}, resetReader() {} }) } as any;
  const def: ToolDef<any> = {
    name: "t_read", title: "Lee", description: "d", access: "read", input: {},
    run: async () => {
      noteDataRead({ tables: ["KNA1"], maskedColumns: [], rows: 3, capped: false });
      noteDataRead({ tables: ["KNVV"], maskedColumns: [], rows: 1, capped: false });
      return "Alguien\tOtro";
    },
  };
  const entries = () => readFileSync(join(dir, AUDIT_FILE), "utf8").trim().split("\n").map((l) => JSON.parse(l) as AuditEntry);

  it("una entrada data_read por llamada, con la unión de tablas y la huella de los argumentos", async () => {
    const r = await invoke(def, { system: "DEV", query: "SELECT * FROM kna1 WHERE name1 = 'Alguien'".padEnd(130, " ") }, { config: cfg, pool, tools: [] });
    expect(r.isError).toBe(false);
    const es = entries();
    expect(es).toHaveLength(1);
    expect(es[0]).toMatchObject({ phase: "data_read", tool: "t_read", system: "DEV", sapUser: "DEMO_USER", read: { tables: ["KNA1", "KNVV"], rows: 4, queries: 2 } });
    expect(es[0].args.query).toMatchObject({ chars: 130 }); // argumento largo: solo huella
    expect(readFileSync(join(dir, AUDIT_FILE), "utf8")).not.toMatch(/Alguien/);
    expect(verifyAudit(readFileSync(join(dir, AUDIT_FILE), "utf8"))).toMatchObject({ ok: true, entries: 1 });
  });

  it("una tool que no lee datos de negocio no deja entrada", async () => {
    const plain: ToolDef<any> = { ...def, name: "t_plain", run: async () => "hola" };
    await invoke(plain, { system: "DEV" }, { config: cfg, pool, tools: [] });
    expect(() => entries()).toThrow();
  });

  it("si no se puede anotar, el resultado no se entrega (fail-closed)", async () => {
    vi.spyOn(auditIo, "appendFileSync").mockImplementation(() => { throw new Error("disco lleno"); });
    const r = await invoke(def, { system: "DEV" }, { config: cfg, pool, tools: [] });
    expect(r.isError).toBe(true);
    expect(r.kind).toBe("INTERNAL");
    expect(r.text).toMatch(/no se pudo anotar la lectura/);
    expect(r.text).not.toMatch(/Alguien/);
  });
});
