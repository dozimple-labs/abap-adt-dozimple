import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/core/config.js";
import { breakpointsOf, getSession, presentVariable, resetSessionsForTests, terminalId } from "../src/core/debugsession.js";
import type { ToolDef } from "../src/core/tool.js";
import tools from "../src/tools/core/debugger.js";

const [bps, listen, vars, step, stop] = tools as ToolDef<any>[];
const base = { url: "https://sap.example:44300", client: "100", user: "DEMO_USER" };
const cfg = parseConfig({ systems: [{ ...base, id: "DEV", role: "DEV" }, { ...base, id: "DEV_MASK", role: "DEV", dataClass: "masked" }, { ...base, id: "DEV_PROD", role: "DEV", dataClass: "prod" }] });
const [DEV, DEV_MASK, DEV_PROD] = cfg.systems;

beforeEach(() => {
  process.env.ABAP_DZ_STATE_DIR = mkdtempSync(join(tmpdir(), "abapdz-dbg-"));
  resetSessionsForTests();
});

function fakeClient(o: { hit?: any; conflict?: boolean } = {}) {
  const calls: string[] = [];
  const v = (id: string, name: string, value: string, meta = "simple", lines = 0) => ({ ID: id, NAME: name, VALUE: value, META_TYPE: meta, ACTUAL_TYPE_NAME: "C", DECLARED_TYPE_NAME: "C", TECHNICAL_TYPE: "C", TABLE_LINES: lines, HEX_VALUE: "00", KIND: "", INSTANTIATION_KIND: "", ACCESS_KIND: "", PARAMETER_KIND: "", READ_ONLY: "", LENGTH: 1, TABLE_BODY: "", IS_VALUE_INCOMPLETE: "", IS_EXCEPTION: "", INHERITANCE_LEVEL: 0, INHERITANCE_CLASS: "" });
  const client = {
    debuggerListeners: async () => (o.conflict ? { localizedMessage: { text: "Ya escucha OTRA_PERSONA" }, message: { text: "x" }, conflictText: "c", namespace: "", type: "", ideUser: "", "com.sap.adt.communicationFramework.subType": "", "T100KEY-ID": "", "T100KEY-NO": 0 } : undefined),
    debuggerListen: async () => (calls.push("listen"), o.hit ?? new Promise(() => undefined)),
    debuggerDeleteListener: async () => void calls.push("deleteListener"),
    debuggerAttach: async (_m: string, id: string) => (calls.push(`attach:${id}`), { reachedBreakpoints: [], isSteppingPossible: true, isTerminationPossible: true, actions: [] }),
    debuggerStackTrace: async () => ({ isRfc: false, isSameSystem: true, serverName: "s", debugCursorStackIndex: 0, stack: [{ stackPosition: 1, programName: "ZDEMO", includeName: "ZDEMO", line: 12, eventType: "FORM", eventName: "INIT", systemProgram: false }, { stackPosition: 2, programName: "SAPMSSY0", includeName: "", line: 1, eventType: "", eventName: "", systemProgram: true }] }),
    debuggerChildVariables: async (parents?: string[]) => ({ hierarchies: [], variables: parents?.[0] === "LS" ? [v("LS-KUNNR", "LS-KUNNR", "1"), v("LS-NAME1", "LS-NAME1", "Alguien")] : [v("LV_A", "LV_A", "7"), v("LS", "LS", "", "structure"), v("LT", "LT", "", "table", 3), v("LV_NAME1", "LV_NAME1", "Alguien")] }),
    debuggerVariables: async (ids: string[]) => ids.map((id) => ({ "LV_A": v("LV_A", "LV_A", "7"), LS: v("LS", "LS", "", "structure"), LT: v("LT", "LT", "", "table", 3), LV_NAME1: v("LV_NAME1", "LV_NAME1", "Alguien"), "LS-KUNNR": v("LS-KUNNR", "LS-KUNNR", "1"), "LS-NAME1": v("LS-NAME1", "LS-NAME1", "Alguien") } as any)[id]).filter(Boolean),
    debuggerStep: async (k: string) => { calls.push(`step:${k}`); if (k === "stepContinue") throw new Error("Debuggee ended"); return { isDebuggeeChanged: false, isSteppingPossible: true, isTerminationPossible: true, reachedBreakpoints: [{ id: "BP1" }], settings: {}, actions: [] }; },
    debuggerSetBreakpoints: async (_m: string, _t: string, _i: string, _c: string, list: string[]) => (calls.push(`bp:${list.join(",")}`), list.map((u, i) => (i === 1 ? { kind: "line", clientId: "x", errorMessage: "línea sin sentencia", nonAbapFlavour: "" } : { id: `BP${i + 1}`, clientId: "x", kind: "line", uri: { uri: u }, type: "", name: "", nonAbapFlavour: "" }))),
    debuggerDeleteBreakpoints: async () => void calls.push("deleteBp"),
    logout: async () => void calls.push("logout"),
  };
  return { client, calls };
}
function ctx(system = DEV, fake = fakeClient()) {
  const reader = {
    searchObject: async (name: string) => [{ "adtcore:name": name.toUpperCase(), "adtcore:type": "PROG/P", "adtcore:uri": `/sap/bc/adt/programs/programs/${name.toLowerCase()}`, "adtcore:packageName": "ZDEMO" }],
    objectStructure: async () => { throw new Error("sin estructura"); },
    debuggerDeleteListener: async () => void fake.calls.push("deleteListener:reader"),
    debuggerDeleteBreakpoints: async () => void fake.calls.push("deleteBp:reader"),
  };
  return { ctx: { sap: { adt: async () => reader, openStateful: async () => fake.client }, system } as any, ...fake };
}

describe("depurador · política y presentación", () => {
  it("con datos productivos está deshabilitado; en masked enmascara variables personales; en test no", async () => {
    await expect(listen.run({ timeout_s: 5, max_variables: 10 }, ctx(DEV_PROD).ctx)).rejects.toThrow(/datos productivos/);
    const pv = (sys: any) => presentVariable(sys, { ID: "LV_NAME1", NAME: "LV_NAME1", VALUE: "Alguien", META_TYPE: "simple", ACTUAL_TYPE_NAME: "C" } as any);
    expect(pv(DEV_MASK)).toMatchObject({ value: "‹oculto›", masked: true });
    expect(pv(DEV)).toMatchObject({ value: "Alguien", masked: false });
    expect(presentVariable(DEV, { ID: "LT", NAME: "LT", VALUE: "", META_TYPE: "table", TABLE_LINES: 3 } as any).value).toBe("tabla de 3 líneas");
  });
  it("el id de terminal es estable por máquina", () => {
    expect(terminalId()).toBe(terminalId());
  });
});

describe("depurador · flujo completo con cliente falso", () => {
  const hit = { DEBUGGEE_ID: "D1", DEBUGGEE_USER: "DEMO_USER", PRG_CURR: "ZDEMO", INCL_CURR: "ZDEMO", LINE_CURR: 12, DBGEE_KIND: "DIALOG", IS_ATTACH_IMPOSSIBLE: false, IS_SAME_SERVER: true, CLIENT: 100, TERMINAL_ID: "", IDE_ID: "", RFCDEST: "", APPLSERVER: "", SYSID: "DEV", SYSNR: 0, DBGKEY: "", TSTMP: 0, DUMPID: "", DUMPDATE: "", DUMPTIME: "", DUMPHOST: "", DUMPMODNO: 0, LISTENER_CTX_ID: "", APPSERVER: "", CAN_ADT_CROSS_SERVER: false, INSTANCE_NAME: "", HOST: "", DUMP_ID: "", DUMP_DATE: "", DUMP_TIME: "", DUMP_HOST: "", DUMP_UNAME: "", DUMP_MODNO: 0, DUMP_CLIENT: "", DUMP_URI: "", URI: {} as any, TYPE: "", NAME: "", PARENT_URI: "", PACKAGE_NAME: "", DESCRIPTION: "" };
  it("puntos de parada: vista previa, puesta con resultado por línea, y clear", async () => {
    const t = ctx();
    const args = { action: "set", breakpoints: [{ object_name: "zdemo", line: 12 }, { object_name: "zdemo", line: 13 }] };
    const p: any = await bps.preview!(args, t.ctx);
    expect(p.text).toMatch(/ZDEMO \(PROG\/P\) línea 12[\s\S]*línea 13/);
    const r: any = await bps.run(args, t.ctx);
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/1 de 2 puntos de parada puestos[\s\S]*✓ ZDEMO línea 12 \(id BP1\)[\s\S]*✗ ZDEMO línea 13: línea sin sentencia/);
    expect(t.calls[0]).toBe("bp:/sap/bc/adt/programs/programs/zdemo/source/main#start=12,/sap/bc/adt/programs/programs/zdemo/source/main#start=13");
    expect(breakpointsOf("DEV")).toHaveLength(1);
    // tras cerrar la sesión, los puntos de parada siguen recordados y se quitan por la conexión de lectura
    await stop.run({ terminate: false }, t.ctx);
    expect(getSession("DEV")).toBeUndefined();
    expect(String(await bps.run({ action: "clear", breakpoints: [] }, t.ctx))).toMatch(/Quitados 1/);
    expect(t.calls).toContain("deleteBp:reader");
    expect(breakpointsOf("DEV")).toHaveLength(0);
    await expect(bps.preview!(args, ctx(DEV_MASK).ctx)).rejects.toThrow(/dataClass test/);
  });
  it("listen: se adhiere y muestra pila y variables; step vuelve a mostrarlas; continue cierra la sesión", async () => {
    const t = ctx(DEV, fakeClient({ hit }));
    const r = String(await listen.run({ timeout_s: 5, max_variables: 10 }, t.ctx));
    expect(r).toMatch(/Adherido a ZDEMO \(ZDEMO línea 12\)[\s\S]*▶\t1\tZDEMO[\s\S]*LV_A\tC\t7[\s\S]*LT\tC\ttabla de 3 líneas/);
    expect(t.calls).toEqual(["listen", "attach:D1"]);
    const v = String(await vars.run({ names: ["LV_A"], children_of: "LS", stack: false, max_variables: 10 }, t.ctx));
    expect(v).toMatch(/LV_A\tC\t7[\s\S]*Componentes de LS \(2\)[\s\S]*LS-NAME1\tC\tAlguien/);
    const s = String(await step.run({ step: "over", max_variables: 10 }, t.ctx));
    expect(s).toMatch(/Punto de parada alcanzado: BP1[\s\S]*Pila/);
    const c = String(await step.run({ step: "continue", max_variables: 10 }, t.ctx));
    expect(c).toMatch(/El programa terminó o SAP soltó la sesión tras «continue»/);
    expect(getSession("DEV")).toBeUndefined();
    expect(t.calls).toContain("logout");
  });
  it("listen: sin programa en el tiempo dado lo dice y retira la escucha; con conflicto de otro depurador avisa", async () => {
    const t = ctx(DEV, fakeClient());
    const r = String(await listen.run({ timeout_s: 5, max_variables: 10 }, { ...t.ctx }));
    expect(r).toMatch(/sin que ningún programa.*listener retirado/);
    expect(t.calls).toContain("deleteListener:reader");
    expect(t.calls).toContain("logout");
    await expect(listen.run({ timeout_s: 5, max_variables: 10 }, ctx(DEV_MASK, fakeClient({ conflict: true })).ctx)).rejects.toThrow(/Otro depurador ya escucha/);
    await expect(vars.run({ stack: true, max_variables: 10 }, ctx(DEV_MASK).ctx)).rejects.toThrow(/debug_listen primero/);
    expect(String(await stop.run({ terminate: false }, t.ctx))).toMatch(/cerrada|No había/);
  }, 15_000);
});
