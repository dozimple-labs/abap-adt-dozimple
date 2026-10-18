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
  it("directorio = enlace a la app de análisis; estado por instancia con trazas activas y filtro (forma real de un 758)", async () => {
    const mk = (body: string) => ({ sap: { adt: async () => ({ httpClient: { request: async () => ({ body }) } }) }, system: sys }) as any;
    const dir = '<?xml version="1.0"?><td:traceDirectory xmlns:td="x"><td:uri>https://host:44300/ui#ABAPSystem-display?sap-client=100&amp;/domain_id=AS_ABAP</td:uri></td:traceDirectory>';
    expect(String(await sqlTraces.run({ show: "directory", top: 50 }, mk(dir)))).toMatch(/app «SQL Trace Analysis»[\s\S]*sap-client=100&\/domain_id=AS_ABAP/);
    const state = '<ts:traceStateInstanceTable xmlns:ts="x"><ts:traceStateInstance><ts:instance>host_DS4_00</ts:instance><ts:host>host</ts:host><ts:modificationUser>BASIS</ts:modificationUser><ts:modificationDateTime>2026-10-13T02:29:31Z</ts:modificationDateTime><ts:traceTypes><ts:sqlOn>true</ts:sqlOn><ts:bufOn>false</ts:bufOn><ts:rfcOn>true</ts:rfcOn></ts:traceTypes><ts:traceFilter><ts:traceUser>DEMO_USER</ts:traceUser><ts:program/></ts:traceFilter></ts:traceStateInstance></ts:traceStateInstanceTable>';
    const r = String(await sqlTraces.run({ show: "state", top: 50 }, mk(state)));
    expect(r).toMatch(/1 instancias, 1 con traza activa[\s\S]*host_DS4_00\thost\tSQL,RFC\tBASIS\t2026-10-13T02:29:31Z\ttraceUser=DEMO_USER/);
    expect(String(await sqlTraces.run({ show: "state", top: 50 }, mk("<state/>")))).toMatch(/sin instancias/);
  });
});

describe("system_messages", () => {
  it("lee TEMSG y marca el fin de vigencia", async () => {
    const sap = {
      query: async (sql: string) => {
        if (/dd26s|ddldependency/i.test(sql)) return { columns: [], values: [] };
        return { columns: ["ID", "EMTEXT", "DATCRE", "TIMCRE", "DATDEL", "TIMDEL", "AUTHOR", "APPLSERVER", "CLIENT", "LANGU"].map((name) => ({ name })), values: [{ ID: 1, EMTEXT: "Parada el sábado", DATCRE: "20261018", TIMCRE: "080000", DATDEL: "00000000", TIMDEL: "", AUTHOR: "BASIS", APPLSERVER: "", CLIENT: "", LANGU: "S" }] };
      },
      adt: async () => ({}),
    } as any;
    const r = String(await systemMessages.run({ only_active: true, max: 50 }, { sap, system: sys } as any));
    expect(r).toMatch(/1 mensajes de sistema/);
    expect(r).toMatch(/1\ttodos\ttodos\t20261018 080000\tsin fin\tBASIS\tS\tParada el sábado/);
  });
  it("si la tabla no existe lo dice como capacidad, no como vacío", async () => {
    const sap = { query: async (sql: string) => { if (/FROM temsg/i.test(sql)) throw new Error("Table TEMSG does not exist"); return { columns: [], values: [] }; }, adt: async () => ({}) } as any;
    await expect(systemMessages.run({ only_active: false, max: 10 }, { sap, system: sys } as any)).rejects.toThrow(/no expone la tabla TEMSG/);
  });
});
