import { describe, expect, it } from "vitest";
import activate from "../src/tools/core/activate.js";
import type { ToolDef } from "../src/core/tool.js";

/** activate con varios objetos: una sola activación, sin borrados pendientes y sin activar una lista distinta de la vista. */
const def = activate as ToolDef<any>;

const URI: Record<string, [string, string]> = {
  ZCL_DEMO: ["CLAS/OC", "/sap/bc/adt/oo/classes/zcl_demo"],
  ZIF_DEMO: ["INTF/OI", "/sap/bc/adt/oo/interfaces/zif_demo"],
  ZDEMO_REP: ["PROG/P", "/sap/bc/adt/programs/programs/zdemo_rep"],
};

function setup(inactive: Array<{ name: string; type: string; uri: string; user?: string; deleted?: boolean; tr?: string }> = [], result = { success: true, messages: [] as any[], inactive: [] as any[] }) {
  const calls: unknown[] = [];
  const c = {
    searchObject: async (name: string) => {
      const u = URI[name];
      return u ? [{ "adtcore:name": name, "adtcore:type": u[0], "adtcore:uri": u[1], "adtcore:packageName": "$TMP" }] : [];
    },
    inactiveObjects: async () =>
      inactive.map((i) => ({
        object: { "adtcore:name": i.name, "adtcore:type": i.type, "adtcore:uri": i.uri, "adtcore:parentUri": "", user: i.user ?? "DEV_ME", deleted: !!i.deleted },
        transport: i.tr ? { "adtcore:name": i.tr } : undefined,
      })),
    activate: async (...args: unknown[]) => (calls.push(args), result),
  };
  const ctx = (confirmedState?: string) => ({ sap: { adt: async () => c }, system: { id: "DEV", user: "DEV_ME" }, confirmedState, progress: () => {} }) as any;
  return { calls, ctx };
}

describe("activate · varios objetos", () => {
  it("activa la lista en UNA sola llamada a SAP, con nombre, tipo y URI de cada objeto", async () => {
    const { calls, ctx } = setup();
    const r: any = await def.run({ objects: [{ name: "ZCL_DEMO" }, { name: "ZIF_DEMO" }], all_inactive: false }, ctx());
    expect(calls).toHaveLength(1);
    const [list] = calls[0] as any[];
    expect(list.map((o: any) => `${o["adtcore:name"]}|${o["adtcore:type"]}|${o["adtcore:uri"]}`)).toEqual([
      "ZCL_DEMO|CLAS/OC|/sap/bc/adt/oo/classes/zcl_demo",
      "ZIF_DEMO|INTF/OI|/sap/bc/adt/oo/interfaces/zif_demo",
    ]);
    expect(r.text).toMatch(/^Los 2 objetos activados\./);
  });

  it("all_inactive: solo los del usuario de la conexión, filtrables por orden, y nunca los borrados pendientes", async () => {
    const { calls, ctx } = setup([
      { name: "ZCL_DEMO", type: "CLAS/OC", uri: URI.ZCL_DEMO[1], tr: "DEVK900123" },
      { name: "ZIF_DEMO", type: "INTF/OI", uri: URI.ZIF_DEMO[1], tr: "DEVK900123" },
      { name: "ZDEMO_OLD", type: "PROG/P", uri: "/sap/bc/adt/programs/programs/zdemo_old", tr: "DEVK900123", deleted: true },
      { name: "ZDEMO_REP", type: "PROG/P", uri: URI.ZDEMO_REP[1], tr: "DEVK900999" },
      { name: "ZDEMO_AJENO", type: "PROG/P", uri: "/x", user: "OTHER", tr: "DEVK900123" },
    ]);
    const p: any = await def.preview!({ all_inactive: true, transport: "DEVK900123" }, ctx());
    expect(p.text).toMatch(/Se activarán juntos 2 objetos \(inactivos de DEV_ME en la orden DEVK900123\)/);
    expect(p.text).toMatch(/1 borrados pendientes NO se activan .*ZDEMO_OLD/);
    expect(p.text).not.toMatch(/ZDEMO_AJENO|ZDEMO_REP/);
    const r: any = await def.run({ all_inactive: true, transport: "DEVK900123" }, ctx(p.state));
    expect((calls[0] as any[])[0].map((o: any) => o["adtcore:name"])).toEqual(["ZCL_DEMO", "ZIF_DEMO"]);
    expect(r.text).toMatch(/No se activaron 1 borrados pendientes: ZDEMO_OLD/);
  });

  it("si la lista cambió entre la vista previa y la confirmación, no activa nada", async () => {
    const before = setup([{ name: "ZCL_DEMO", type: "CLAS/OC", uri: URI.ZCL_DEMO[1] }]);
    const p: any = await def.preview!({ all_inactive: true }, before.ctx());
    const after = setup([
      { name: "ZCL_DEMO", type: "CLAS/OC", uri: URI.ZCL_DEMO[1] },
      { name: "ZIF_DEMO", type: "INTF/OI", uri: URI.ZIF_DEMO[1] },
    ]);
    const r: any = await def.run({ all_inactive: true }, after.ctx(p.state));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/la lista de objetos cambió desde la vista previa/);
    expect(after.calls).toHaveLength(0);
  });

  it("errores de SAP: no se presenta como éxito y se listan los mensajes y lo que queda inactivo", async () => {
    const { ctx } = setup([], {
      success: false,
      messages: [{ type: "E", line: 12, shortText: "Método no implementado", objDescr: "ZCL_DEMO" }],
      inactive: [{ object: { "adtcore:name": "ZCL_DEMO" } }],
    });
    const r: any = await def.run({ objects: [{ name: "ZCL_DEMO" }, { name: "ZIF_DEMO" }], all_inactive: false }, ctx());
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Los 2 objetos NO se activaron/);
    expect(r.text).toMatch(/E L12 {2}Método no implementado {2}\[ZCL_DEMO\]/);
    expect(r.text).toMatch(/Quedan inactivos .*ZCL_DEMO/);
  });

  it("exactamente un modo; transport solo con all_inactive; sin nada que activar lo dice", async () => {
    const { ctx } = setup();
    await expect(def.preview!({ all_inactive: false }, ctx())).rejects.toMatchObject({ kind: "INPUT" });
    await expect(def.preview!({ object_name: "ZCL_DEMO", all_inactive: true }, ctx())).rejects.toMatchObject({ kind: "INPUT" });
    await expect(def.preview!({ object_name: "ZCL_DEMO", transport: "DEVK900123", all_inactive: false }, ctx())).rejects.toMatchObject({ kind: "INPUT" });
    await expect(def.preview!({ all_inactive: true }, ctx())).rejects.toMatchObject({ kind: "INPUT", message: expect.stringMatching(/No hay nada que activar/) });
  });

  it("un objeto sigue funcionando como antes", async () => {
    const { calls, ctx } = setup();
    const r: any = await def.run({ object_name: "ZDEMO_REP", all_inactive: false }, ctx());
    expect(calls[0]).toEqual(["ZDEMO_REP", URI.ZDEMO_REP[1]]);
    expect(r.text).toMatch(/^ZDEMO_REP activado\./);
  });
});
