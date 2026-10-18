import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/core/config.js";
import type { ToolDef } from "../src/core/tool.js";
import tools, { xmlRows } from "../src/tools/core/runtime.js";

const [abapTraces, sqlTraces, systemMessages] = tools as ToolDef<any>[];
const sys = parseConfig({ systems: [{ id: "DEV", role: "DEV", url: "https://sap.example:44300", client: "100", user: "DEMO_USER" }] }).systems[0];

describe("abap_traces", () => {
  const run = { id: "/sap/bc/adt/runtime/traces/abaptraces/ABC123", author: "DEMO_USER", title: "ZDEMO", published: new Date("2026-10-18T10:00:00Z"), updated: new Date(), authorUri: "", type: "", src: "", lang: "", links: [], extendedData: { host: "h", size: 10, runtime: 1500000, runtimeABAP: 1000000, runtimeSystem: 100000, runtimeDatabase: 400000, expiration: new Date(), system: "DEV", client: 100, isAggregated: true, objectName: "ZDEMO", state: { value: "R", text: "Listo" } } };
  const c = {
    tracesList: async (u: string) => ({ author: u, contributor: "", title: "", updated: new Date(), runs: [run] }),
    tracesHitList: async () => ({ parentLink: "", entries: [{ topDownIndex: 1, index: 1, hitCount: 3, recursionDepth: 0, description: "SELECT MARA", calledProgram: "ZDEMO", grossTime: { time: 900000, percentage: 60 }, traceEventNetTime: { time: 800000, percentage: 53.3 }, proceduralNetTime: { time: 0, percentage: 0 }, callingProgram: { context: "ZDEMO", byteCodeOffset: 0, name: "ZDEMO" } }] }),
    tracesDbAccess: async () => ({ parentLink: "", dbaccesses: [{ index: 1, tableName: "MARA", statement: "SELECT * FROM MARA", type: "OpenSQL", totalCount: 3, bufferedCount: 0, accessTime: { total: 400000, applicationServer: 10000, database: 390000, ratioOfTraceTotal: 26.7 } }], tables: [{ name: "MARA", type: "TRANSP", description: "", bufferMode: "", storageType: "", package: "" }] }),
    tracesStatements: async () => ({ withDetails: false, withSysEvents: false, count: 1, parentLink: "", statements: [{ index: 1, id: 1, description: "CALL FUNCTION", hitCount: 1, hasDetailSubnodes: false, hasProcedureLikeSubnodes: false, callerId: 0, callLevel: 1, subnodeCount: 0, directSubnodeCount: 0, directSubnodeCountProcedureLike: 0, hitlistAnchor: 0, callingProgram: { context: "ZDEMO", byteCodeOffset: 0 }, grossTime: { time: 1000, percentage: 1 }, traceEventNetTime: { time: 1000, percentage: 1 }, proceduralNetTime: { time: 0, percentage: 0 } }] }),
  };
  const ctx = { sap: { adt: async () => c }, system: sys } as any;
  it("lista las trazas del usuario de la conexión con tiempos", async () => {
    const r = String(await abapTraces.run({ show: "hitlist", top: 30 }, ctx));
    expect(r).toMatch(/1 trazas de DEMO_USER/);
    expect(r).toMatch(/ABC123\tZDEMO\tZDEMO\t2026-10-18 10:00\tListo\t1500\.0 ms\t1000\.0 ms\t400\.0 ms/);
  });
  it("detalle: hit list, accesos a BD y sentencias", async () => {
    expect(String(await abapTraces.run({ trace: "ABC123", show: "hitlist", top: 30 }, ctx))).toMatch(/800\.0 ms\t53\.3 %/);
    expect(String(await abapTraces.run({ trace: "ABC123", show: "db", top: 30 }, ctx))).toMatch(/MARA\tOpenSQL\t3\t0\t400\.0 ms/);
    expect(String(await abapTraces.run({ trace: "ABC123", show: "statements", top: 30 }, ctx))).toMatch(/CALL FUNCTION/);
    await expect(abapTraces.run({ trace: "../x", show: "hitlist", top: 30 }, ctx)).rejects.toThrow(/inválido/);
  });
});

describe("sql_traces y xmlRows", () => {
  it("convierte cualquier XML con atributos en filas, sin conocer el esquema", () => {
    const rows = xmlRows('<st05:directory xmlns:st05="x"><st05:trace id="1" user="DEMO_USER" state="active &amp; running"/><st05:trace id="2" user="OTRO"/></st05:directory>');
    expect(rows).toEqual([{ tag: "trace", attrs: { id: "1", user: "DEMO_USER", state: "active & running" } }, { tag: "trace", attrs: { id: "2", user: "OTRO" } }]);
  });
  it("muestra el directorio como tabla y avisa si viene vacío", async () => {
    const mk = (body: string) => ({ sap: { adt: async () => ({ httpClient: { request: async () => ({ body }) } }) }, system: sys }) as any;
    expect(String(await sqlTraces.run({ show: "directory", top: 50 }, mk('<d><trace id="1" user="U"/></d>')))).toMatch(/1 elementos[\s\S]*trace\t1\tU/);
    expect(String(await sqlTraces.run({ show: "state", top: 50 }, mk("<state/>")))).toMatch(/sin elementos/);
  });
});

describe("system_messages", () => {
  it("une índice y texto, y marca el fin de vigencia", async () => {
    const sap = {
      query: async (sql: string) => {
        if (/dd26s|ddldependency/i.test(sql)) return { columns: [], values: [] };
        if (/FROM temsi/i.test(sql)) return { columns: ["EMID", "EMMAND", "EMSERV", "EMDAT", "EMTIM", "EMDEL", "EMTIMDEL", "EMUNAME"].map((name) => ({ name })), values: [{ EMID: "0001", EMMAND: "", EMSERV: "", EMDAT: "20261018", EMTIM: "080000", EMDEL: "00000000", EMTIMDEL: "", EMUNAME: "BASIS" }] };
        return { columns: [], values: [{ EMID: "0001", EMTEXT: "Parada el sábado" }] };
      },
      adt: async () => ({}),
    } as any;
    const r = String(await systemMessages.run({ only_active: true, max: 50 }, { sap, system: sys } as any));
    expect(r).toMatch(/1 mensajes de sistema/);
    expect(r).toMatch(/0001\ttodos\ttodos\t20261018 080000\tsin fin\tBASIS\tParada el sábado/);
  });
  it("si la tabla no existe lo dice como capacidad, no como vacío", async () => {
    const sap = { query: async (sql: string) => { if (/FROM temsi/i.test(sql)) throw new Error("Table TEMSI does not exist"); return { columns: [], values: [] }; }, adt: async () => ({}) } as any;
    await expect(systemMessages.run({ only_active: false, max: 10 }, { sap, system: sys } as any)).rejects.toThrow(/no tiene la tabla TEMSI/);
  });
});
