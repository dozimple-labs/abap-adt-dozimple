import { describe, expect, it } from "vitest";
import activate from "../src/tools/core/activate.js";
import { activateObject, mainProgramUri, parseActivation } from "../src/core/activation.js";
import type { ToolDef } from "../src/core/tool.js";

/** Includes de varios programas principales, reintento con referencias mínimas y lectura de la respuesta. */
const def = activate as ToolDef<any>;
const INCL = { name: "ZDEMO_RUT", type: "PROG/I", uri: "/sap/bc/adt/programs/includes/zdemo_rut" };
const ok = { success: true, messages: [] as any[], inactive: [] as any[] };

function client(mains: Array<{ name: string; uri: string }>, opts: { fail412?: boolean } = {}) {
  const calls: unknown[] = [];
  const raw: unknown[] = [];
  const c: any = {
    searchObject: async (name: string) => (name === INCL.name ? [{ "adtcore:name": INCL.name, "adtcore:type": INCL.type, "adtcore:uri": INCL.uri }] : []),
    mainPrograms: async () => mains.map((m) => ({ "adtcore:name": m.name, "adtcore:type": "PROG/P", "adtcore:uri": m.uri })),
    activate: async (...args: unknown[]) => {
      calls.push(args);
      if (opts.fail412 && Array.isArray(args[0])) throw Object.assign(new Error("Verificación de condición fallida"), { status: 412 });
      return ok;
    },
    httpClient: {
      request: async (url: string, cfg: unknown) => (raw.push([url, cfg]), { body: `<?xml version="1.0"?><chkl:messages xmlns:chkl="x"></chkl:messages>` }),
    },
  };
  const ctx = { sap: { adt: async () => c }, system: { id: "DEV", user: "DEV_ME" }, progress: () => {} } as any;
  return { c, calls, raw, ctx };
}

describe("activate · include de varios programas principales", () => {
  it("con un solo programa principal lo usa como contexto sin pedir nada", async () => {
    const { calls } = client([{ name: "ZDEMO", uri: "/sap/bc/adt/programs/programs/zdemo" }]);
    const r = await activateObject(client([{ name: "ZDEMO", uri: "/sap/bc/adt/programs/programs/zdemo" }]).c, INCL);
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("con varios y sin main_program no llama a SAP: devuelve la lista para elegir", async () => {
    const { calls, ctx } = client([
      { name: "ZDEMO", uri: "/sap/bc/adt/programs/programs/zdemo" },
      { name: "ZDEMO_JOB", uri: "/sap/bc/adt/programs/programs/zdemo_job" },
    ]);
    await expect(def.run({ object_name: INCL.name, all_inactive: false }, ctx)).rejects.toMatchObject({
      kind: "INPUT",
      message: expect.stringMatching(/2 programas principales \(ZDEMO, ZDEMO_JOB\)/),
    });
    expect(calls).toHaveLength(0);
  });

  it("con main_program activa pasando la URI del programa como contexto", async () => {
    const { calls, ctx } = client([
      { name: "ZDEMO", uri: "/sap/bc/adt/programs/programs/zdemo" },
      { name: "ZDEMO_JOB", uri: "/sap/bc/adt/programs/programs/zdemo_job" },
    ]);
    const r: any = await def.run({ object_name: INCL.name, main_program: "ZDEMO", all_inactive: false }, ctx);
    expect(calls[0]).toEqual([INCL.name, INCL.uri, "/sap/bc/adt/programs/programs/zdemo"]);
    expect(r.text).toMatch(/^ZDEMO_RUT activado\./);
  });

  it("main_program solo con object_name; acepta nombre o URI", async () => {
    const { ctx } = client([]);
    await expect(def.preview!({ all_inactive: true, main_program: "ZDEMO" }, ctx)).rejects.toMatchObject({ kind: "INPUT" });
    expect(mainProgramUri("ZDEMO_RP")).toBe("/sap/bc/adt/programs/programs/zdemo_rp");
    expect(mainProgramUri("/sap/bc/adt/programs/programs/zdemo")).toBe("/sap/bc/adt/programs/programs/zdemo");
    expect(() => mainProgramUri("a b")).toThrow();
  });
});

describe("activate · varios objetos cuando SAP responde «precondition failed»", () => {
  it("repite una vez con referencias mínimas (uri y nombre) y lee la respuesta", async () => {
    const { raw, ctx } = client([], { fail412: true });
    const c2 = {
      ...ctx,
      sap: { adt: async () => ({ ...(await ctx.sap.adt()), searchObject: async (name: string) => [{ "adtcore:name": name, "adtcore:type": "FUGR/FF", "adtcore:uri": `/sap/bc/adt/functions/groups/zg/fmodules/${name.toLowerCase()}` }] }) },
    };
    const r: any = await def.run({ objects: [{ name: "ZFM_A" }, { name: "ZFM_B" }], all_inactive: false }, c2);
    expect(raw).toHaveLength(1);
    const [url, cfg] = raw[0] as [string, any];
    expect(url).toBe("/sap/bc/adt/activation");
    expect(cfg.body).toContain('adtcore:uri="/sap/bc/adt/functions/groups/zg/fmodules/zfm_a" adtcore:name="ZFM_A"');
    expect(cfg.body).not.toContain("parentUri");
    expect(r.text).toMatch(/Los 2 objetos activados/);
  });

  it("parseActivation: mensajes con tipo, línea y objeto, e inactivos", () => {
    const xml =
      `<chkl:messages><msg type="E" line="12" objDescr="ZCL_DEMO"><shortText><txt>Método no implementado</txt></shortText></msg></chkl:messages>` +
      `<ioc:inactiveObjects><ioc:entry><ioc:object><ioc:ref adtcore:name="ZCL_DEMO" adtcore:type="CLAS/OC" adtcore:uri="/sap/bc/adt/oo/classes/zcl_demo"/></ioc:object></ioc:entry></ioc:inactiveObjects>`;
    const r = parseActivation(xml);
    expect(r.success).toBe(false);
    expect(r.messages[0]).toMatchObject({ type: "E", line: 12, objDescr: "ZCL_DEMO", shortText: "Método no implementado" });
    expect(r.inactive[0].object?.["adtcore:name"]).toBe("ZCL_DEMO");
    expect(parseActivation("").success).toBe(true);
  });
});
