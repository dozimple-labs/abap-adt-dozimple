import { describe, expect, it } from "vitest";
import { stateOf } from "../src/core/confirm.js";
import type { ToolDef } from "../src/core/tool.js";
import pushSources from "../src/tools/core/push_sources.js";

const def = pushSources as ToolDef<any>;
const SRC: Record<string, string> = { ZA: "REPORT za.\nWRITE 1.\n", ZB: "REPORT zb.\nWRITE 2.\n" };

function setup(o: { brokenB?: boolean } = {}) {
  const written: Array<[string, string]> = [];
  const activated: string[][] = [];
  const s = {
    lock: async () => ({ LOCK_HANDLE: "H", CORRNR: "", CORRUSER: "", IS_LOCAL: "X" }),
    getObjectSource: async (u: string) => SRC[u.includes("za") ? "ZA" : "ZB"],
    setObjectSource: async (u: string, src: string) => void written.push([u.includes("za") ? "ZA" : "ZB", src]),
    unLock: async () => undefined,
  };
  const c = {
    searchObject: async (name: string) => [{ "adtcore:name": name.toUpperCase(), "adtcore:type": "PROG/P", "adtcore:uri": `/sap/bc/adt/programs/programs/${name.toLowerCase()}`, "adtcore:packageName": "$TMP" }],
    objectStructure: async () => { throw new Error("sin estructura"); },
    getObjectSource: async (u: string) => SRC[u.includes("za") ? "ZA" : "ZB"],
    syntaxCheck: async (_u: string, _m: string, src: string) => (o.brokenB && /zb/.test(src) ? [{ uri: "/x", line: 2, offset: 0, severity: "E", text: "Roto" }] : []),
    activate: async (objs: any[]) => (activated.push(objs.map((x) => x["adtcore:name"])), { success: true, messages: [], inactive: [] }),
  };
  const ctx = (confirmedState?: string) => ({ sap: { adt: async () => c, stateful: async (fn: any) => fn(s), query: async () => ({ values: [] }) }, system: { id: "DEV", user: "DEV_ME" }, confirmedState }) as any;
  return { written, activated, ctx };
}
const files = [{ object_name: "ZA", object_type: "PROG", include: "main", source: "REPORT za.\nWRITE 10.\n" }, { object_name: "ZB", object_type: "PROG", include: "main", source: "REPORT zb.\nWRITE 20.\n" }];
const combined = stateOf([stateOf(SRC.ZA), stateOf(SRC.ZB)].join("|"));

describe("push_sources", () => {
  it("vista previa consolidada: un bloque por objeto, con diff, y una sola huella combinada", async () => {
    const { ctx } = setup();
    const p: any = await def.preview!({ files, activate: true, skip_syntax_check: false }, ctx());
    expect(p.text).toMatch(/2 fuentes[\s\S]*━━ 1\/2 ━━[\s\S]*ZA \(PROG\/P\)[\s\S]*-WRITE 1\.\n\+WRITE 10\.[\s\S]*━━ 2\/2 ━━[\s\S]*ZB/);
    expect(p.state).toBe(combined);
  });
  it("guarda todos y los activa juntos", async () => {
    const { written, activated, ctx } = setup();
    const r: any = await def.run({ files, activate: true, skip_syntax_check: false }, ctx(combined));
    expect(r.isError).toBe(false);
    expect(written).toEqual([["ZA", files[0].source], ["ZB", files[1].source]]);
    expect(activated).toEqual([["ZA", "ZB"]]);
    expect(r.text).toMatch(/2 de 2 guardados[\s\S]*✓ ZA[\s\S]*✓ ZB[\s\S]*Activación conjunta de 2 objetos/);
  });
  it("si una fuente tiene errores de sintaxis, se guarda el resto y solo eso se activa", async () => {
    const { written, activated, ctx } = setup({ brokenB: true });
    const r: any = await def.run({ files, activate: true, skip_syntax_check: false }, ctx(combined));
    expect(r.isError).toBe(true);
    expect(written.map((w) => w[0])).toEqual(["ZA"]);
    expect(activated).toEqual([["ZA"]]);
    expect(r.text).toMatch(/1 de 2 guardados[\s\S]*✓ ZA[\s\S]*✗ ZB: No se escribió nada: el código nuevo tiene errores de sintaxis/);
  });
  it("no escribe nada si alguna fuente cambió tras la vista previa, ni admite duplicados", async () => {
    const { written, ctx } = setup();
    const r: any = await def.run({ files, activate: true, skip_syntax_check: false }, ctx(stateOf("otra")));
    expect(r.isError).toBe(true);
    expect(written).toEqual([]);
    await expect(def.preview!({ files: [files[0], files[0]], activate: true, skip_syntax_check: false }, ctx())).rejects.toThrow(/aparece dos veces/);
  });
});
