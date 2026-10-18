import { describe, expect, it, vi } from "vitest";
import { stateOf } from "../src/core/confirm.js";
import { parseDdicProps } from "../src/core/ddicprops.js";
import type { ToolDef } from "../src/core/tool.js";

vi.mock("../src/core/checks.js", async (orig) => ({ ...(await orig<typeof import("../src/core/checks.js")>()), syntaxCheck: async () => [] }));
vi.mock("../src/core/activation.js", () => ({ activateObject: async () => ({ ok: true, text: "Activado sin errores." }) }));
const { default: createTool, behaviorDefinitionBody } = await import("../src/tools/core/create_object.js");
const { default: writeProps } = await import("../src/tools/core/write_ddic_properties.js");
const create = createTool as ToolDef<any>;
const wprops = writeProps as ToolDef<any>;

const COLLS = ["/sap/bc/adt/ddic/dataelements", "/sap/bc/adt/ddic/dataelements/validation", "/sap/bc/adt/ddic/domains", "/sap/bc/adt/ddic/domains/validation", "/sap/bc/adt/bo/behaviordefinitions", "/sap/bc/adt/businessservices/bindings", "/sap/bc/adt/businessservices/bindings/validation", "/sap/bc/adt/ddic/srvd/sources", "/sap/bc/adt/ddic/srvd/sources/validation"];
const DOMA = { typeInformation: { datatype: "CHAR", length: 10, decimals: 0 }, outputInformation: { lowercase: true }, valueInformation: { valueTableRef: "", fixValues: [{ low: "A", text: "Alta" }] } };
const DTEL = { dataType: "DOMAIN", typeName: "ZDO_DEMO", dataTypeLength: 10, fieldLabels: { shortFieldLabel: "Dem", mediumFieldLabel: "Demo", longFieldLabel: "Demo largo", headingFieldLabel: "Demo" } };

function setup(type: string, uriBase: string, preExisting = false) {
  const created: any[] = [];
  const posts: any[] = [];
  const set: any[] = [];
  let exists = preExisting;
  const sap = {
    capabilities: async () => ({ known: true, collections: COLLS, fetchedAt: "" }),
    query: async (sql: string) => {
      if (/FROM dd04l|FROM dd01l|FROM dd40l|object = 'BDEF'|object = 'SRVB'|object = 'SRVD'/.test(sql)) return { values: exists ? [{ X: "1" }] : [] };
      if (/FROM tdevc/.test(sql)) return { values: [{ DEVCLASS: "ZDEMO", KORRFLAG: "X" }] };
      if (/FROM e070/.test(sql)) return { values: [{ TRKORR: "DEVK900123", TRFUNCTION: "K", TRSTATUS: "D", TARSYSTEM: "QAS", AS4USER: "DEV_ME", AS4DATE: "20260930", STRKORR: "" }] };
      return { values: [] };
    },
    adt: async () => ({
      validateNewObject: async () => ({ SEVERITY: "OK", success: true }),
      createObject: async (opts: any) => { created.push(opts); exists = true; },
      httpClient: { request: async (path: string, opts: any) => { posts.push({ path, ...opts }); exists = true; return { body: "" }; } },
      searchObject: async (name: string) => (exists ? [{ "adtcore:name": name, "adtcore:type": type, "adtcore:uri": `${uriBase}/${name.toLowerCase()}`, "adtcore:packageName": "ZDEMO" }] : []),
      objectStructure: async () => { throw new Error("sin estructura"); },
      getDomainProperties: async () => ({ metaData: { name: "ZDO_DEMO", description: "Dominio demo", language: "ES", masterLanguage: "ES", masterSystem: "", responsible: "DEV_ME", packageName: "ZDEMO" }, properties: { typeInformation: { datatype: "CHAR", length: 5, decimals: 0 }, outputInformation: { length: 5, signExists: false, lowercase: false, ampmFormat: false } } }),
    }),
    stateful: async (fn: any) => fn({
      lock: async () => ({ LOCK_HANDLE: "H", CORRNR: "DEVK900123", CORRUSER: "", IS_LOCAL: "" }),
      unLock: async () => undefined,
      setDomainProperties: async (...a: any[]) => void set.push(["DOMA", ...a]),
      setDataElementProperties: async (...a: any[]) => void set.push(["DTEL", ...a]),
      getDomainProperties: async () => ({ metaData: { name: "ZDO_DEMO", description: "Dominio demo", language: "ES", masterLanguage: "ES", masterSystem: "", responsible: "DEV_ME", packageName: "ZDEMO" }, properties: { typeInformation: { datatype: "CHAR", length: 5, decimals: 0 }, outputInformation: { length: 5, signExists: false, lowercase: false, ampmFormat: false } } }),
    }),
  };
  const ctx = (confirmedState?: string) => ({ sap, system: { id: "DEV", user: "DEV_ME", language: "ES", sid: "DEV" }, confirmedState }) as any;
  return { ctx, created, posts, set };
}
const base = { description: "Demo", package: "ZDEMO", transport: "DEVK900123", activate: true, implementation_type: "managed" };

describe("ddic_properties", () => {
  it("valida la forma antes de tocar SAP y completa la salida del dominio", () => {
    const d: any = parseDdicProps("DOMA", DOMA);
    expect(d.outputInformation).toMatchObject({ length: 10, lowercase: true, signExists: false });
    expect(() => parseDdicProps("DTEL", { dataType: "DOMAIN" })).toThrow(/ddic_properties de DTEL inválidas: typeName/);
    expect(() => parseDdicProps("DTEL", { ...DTEL, fieldLabels: { ...DTEL.fieldLabels, shortFieldLabel: "demasiado larga" } })).toThrow(/shortFieldLabel/);
  });
});

describe("create_object · diccionario y RAP", () => {
  it("dominio: crea, escribe las propiedades bajo bloqueo con la orden y activa", async () => {
    const { ctx, created, set } = setup("DOMA/DD", "/sap/bc/adt/ddic/domains");
    const args = { ...base, object_type: "DOMA", name: "ZDO_DEMO", ddic_properties: DOMA };
    const p: any = await create.preview!(args, ctx());
    expect(p.text).toMatch(/Crear dominio ZDO_DEMO[\s\S]*Propiedades: CHAR 10 · salida 10 · minúsculas · 1 valores fijos/);
    const r: any = await create.run(args, ctx(p.state));
    expect(created[0]).toMatchObject({ objtype: "DOMA/DD", name: "ZDO_DEMO", transport: "DEVK900123" });
    expect(set[0][0]).toBe("DOMA");
    expect(set[0][2]).toMatchObject({ typeInformation: { datatype: "CHAR", length: 10 } });
    expect(set[0][5]).toBe("DEVK900123");
    expect(r.text).toMatch(/Propiedades guardadas[\s\S]*Activado/);
  });
  it("elemento de datos sin propiedades: avisa de que queda vacío; con fuente, lo rechaza", async () => {
    const { ctx } = setup("DTEL/DE", "/sap/bc/adt/ddic/dataelements");
    const p: any = await create.preview!({ ...base, object_type: "DTEL", name: "ZDE_DEMO" }, ctx());
    expect(p.text).toMatch(/Sin ddic_properties: se crea vacío y NO se activa/);
    await expect(create.preview!({ ...base, object_type: "DTEL", name: "ZDE_DEMO", source: "x" }, ctx())).rejects.toThrow(/no tiene fuente/);
    await expect(create.preview!({ ...base, object_type: "DOMA", name: "ZDO_X", ddic_properties: { typeInformation: {} } }, ctx())).rejects.toThrow(/inválidas/);
  });
  it("binding: exige la definición de servicio y la pasa a la creación", async () => {
    const { ctx, created } = setup("SRVB/SVB", "/sap/bc/adt/businessservices/bindings");
    await expect(create.preview!({ ...base, object_type: "SRVB", name: "ZUI_DEMO_O2" }, ctx())).rejects.toThrow(/service_definition/);
    const args = { ...base, object_type: "SRVB", name: "ZUI_DEMO_O2", service_definition: "zui_demo" };
    const p: any = await create.preview!(args, ctx());
    expect(p.text).toMatch(/Publica la definición de servicio ZUI_DEMO como OData V2/);
    await create.run(args, ctx(p.state));
    expect(created[0]).toMatchObject({ objtype: "SRVB/SVB", service: "ZUI_DEMO", bindingtype: "ODATA", category: "0" });
  });
  it("definición de comportamiento: petición ADT directa con el tipo de implementación", async () => {
    const { ctx, posts } = setup("BDEF/BDO", "/sap/bc/adt/bo/behaviordefinitions");
    const args = { ...base, object_type: "BDEF", name: "ZI_DEMO", implementation_type: "projection" };
    const p: any = await create.preview!(args, ctx());
    expect(p.text).toMatch(/Tipo de implementación: projection/);
    await create.run(args, ctx(p.state));
    expect(posts[0].path).toBe("/sap/bc/adt/bo/behaviordefinitions");
    expect(posts[0].qs).toEqual({ corrNr: "DEVK900123" });
    expect(posts[0].body).toMatch(/bdef:implementationType="projection"[\s\S]*packageRef adtcore:name="ZDEMO"/);
    expect(behaviorDefinitionBody({ name: "Z<X", description: 'a"b', pkg: "P", responsible: "U", language: "ES", implementationType: "managed" })).toMatch(/adtcore:description="a&quot;b"[\s\S]*adtcore:name="Z&lt;X"/);
  });
});

describe("write_ddic_properties", () => {
  it("vista previa con el diff de propiedades, y escritura bajo bloqueo con huella comprobada", async () => {
    const { ctx, set } = setup("DOMA/DD", "/sap/bc/adt/ddic/domains", true);
    const args = { object_type: "DOMA", name: "ZDO_DEMO", properties: DOMA, transport: "DEVK900123", activate: true };
    const p: any = await wprops.preview!(args, ctx());
    expect(p.text).toMatch(/Ahora: CHAR 5[\s\S]*Nuevo: CHAR 10[\s\S]*Cambio de propiedades: \+/);
    const r: any = await wprops.run(args, ctx(p.state));
    expect(r.isError).toBe(false);
    expect(set[0][0]).toBe("DOMA");
    expect(set[0][5]).toBe("DEVK900123");
    const stale: any = await wprops.run(args, ctx(stateOf("otra")));
    expect(stale.isError).toBe(true);
    expect(stale.text).toMatch(/cambió en SAP/);
  });
});
