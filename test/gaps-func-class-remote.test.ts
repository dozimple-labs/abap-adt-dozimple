import { describe, expect, it } from "vitest";
import { activateObject } from "../src/core/activation.js";
import { withNotes } from "../src/core/notes.js";
import { resolveObject } from "../src/core/objects.js";
import { functionInclude } from "../src/tools/transport-risk/risk_extras.js";

describe("módulo de función que la búsqueda de SAP no devuelve", () => {
  const client = (area?: string, fail = false) =>
    ({
      searchObject: async () => [],
      runQuery: async (sql: string) => {
        if (fail) throw new Error("sin vista previa de datos");
        expect(sql).toBe("SELECT area FROM enlfdir WHERE funcname = 'ZDEMO_FM_NEW'");
        return { columns: [], values: area ? [{ AREA: area }] : [] };
      },
    }) as any;

  it("se localiza por el directorio de funciones y queda anotado", async () => {
    const { result, notes } = await withNotes(() => resolveObject(client("ZDEMO_GROUP"), "zdemo_fm_new", "FUNC"));
    expect(result).toMatchObject({ name: "ZDEMO_FM_NEW", type: "FUGR/FF", uri: "/sap/bc/adt/functions/groups/zdemo_group/fmodules/zdemo_fm_new" });
    expect(notes[0]).toMatch(/directorio de funciones en el grupo ZDEMO_GROUP/);
  });

  it("si tampoco está en el directorio, sigue siendo «no existe»", async () => {
    await expect(resolveObject(client(), "ZDEMO_FM_NEW", "FUNC")).rejects.toThrow(/No existe FUNC ZDEMO_FM_NEW/);
    await expect(resolveObject(client("X", true), "ZDEMO_FM_NEW", "FUNC")).rejects.toThrow(/No existe FUNC ZDEMO_FM_NEW/);
  });

  it("solo aplica a módulos de función: un programa inexistente no consulta el directorio", async () => {
    const c = { searchObject: async () => [], runQuery: async () => { throw new Error("no debe llamarse"); } } as any;
    await expect(resolveObject(c, "ZDEMO_REP", "PROG")).rejects.toThrow(/No existe PROG ZDEMO_REP/);
  });
});

describe("activar una clase que SAP devuelve inactiva junto a su include de método", () => {
  const obj = { name: "ZCL_DEMO", type: "CLAS/OC", uri: "/sap/bc/adt/oo/classes/zcl_demo" };
  const inact = (name: string, type: string, uri: string, extra: Record<string, unknown> = {}) => ({
    object: { "adtcore:name": name, "adtcore:type": type, "adtcore:uri": uri, "adtcore:parentUri": "", ...extra },
  });
  const own = [inact("ZCL_DEMO", "CLAS/OC", obj.uri), inact("ZCL_DEMO                      CM001", "CLAS/OM", `${obj.uri}/source/main#type=CLAS%2FOM;name=RUN`)];

  function client(first: any, second: any = { success: true, messages: [], inactive: [] }) {
    const calls: unknown[][] = [];
    return { calls, c: { activate: async (...a: unknown[]) => (calls.push(a), calls.length === 1 ? first : second) } as any };
  }

  it("reintenta una vez con la lista que devolvió SAP y lo cuenta", async () => {
    const { calls, c } = client({ success: false, messages: [], inactive: own });
    const r = await activateObject(c, obj);
    expect(calls).toHaveLength(2);
    expect((calls[1][0] as any[]).map((o) => o["adtcore:type"])).toEqual(["CLAS/OC", "CLAS/OM"]);
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/ZCL_DEMO activado\.\n\(Segundo intento: .* 1 subobjetos inactivos\.\)/);
  });

  it("no reintenta si hay errores, si hay objetos ajenos o si hay un borrado pendiente", async () => {
    const withError = client({ success: false, messages: [{ type: "E", shortText: "Falta el método X" }], inactive: own });
    expect((await activateObject(withError.c, obj)).ok).toBe(false);
    expect(withError.calls).toHaveLength(1);

    const foreign = client({ success: false, messages: [], inactive: [...own, inact("ZCL_OTRA", "CLAS/OC", "/sap/bc/adt/oo/classes/zcl_otra")] });
    const r = await activateObject(foreign.c, obj);
    expect(foreign.calls).toHaveLength(1);
    expect(r.text).toMatch(/NO se activó.*\n\nQuedan inactivos/s);

    const deleted = client({ success: false, messages: [], inactive: [own[0], { object: { ...own[1].object, deleted: true } }] });
    await activateObject(deleted.c, obj);
    expect(deleted.calls).toHaveLength(1);
  });

  it("si el segundo intento falla, se devuelve su resultado tal cual", async () => {
    const { calls, c } = client({ success: false, messages: [], inactive: own }, { success: false, messages: [{ type: "E", line: 12, shortText: "Error de sintaxis" }], inactive: own });
    const r = await activateObject(c, obj);
    expect(calls).toHaveLength(2);
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/NO se activó[\s\S]*Error de sintaxis/);
  });
});

describe("remote_source · include de un módulo de función", () => {
  const sap = (row?: Record<string, unknown>) => ({ query: async () => ({ columns: [], values: row ? [row] : [] }) }) as any;

  it("traduce el módulo a L<grupo>Unn, también con namespace", async () => {
    expect(await functionInclude(sap({ PNAME: "SAPLZDEMO_GROUP", INCLUDE: "07" }), "ZDEMO_FM")).toBe("LZDEMO_GROUPU07");
    expect(await functionInclude(sap({ PNAME: "/ABC/SAPLGROUP", INCLUDE: "01" }), "/ABC/FM")).toBe("/ABC/LGROUPU01");
  });

  it("si no es un módulo (o no se puede consultar), no cambia el nombre", async () => {
    expect(await functionInclude(sap(), "ZDEMO_REPORT")).toBeUndefined();
    expect(await functionInclude({ query: async () => { throw new Error("x"); } } as any, "ZDEMO_REPORT")).toBeUndefined();
    expect(await functionInclude(sap({ PNAME: "SAPLX", INCLUDE: "01" }), "nombre con espacio")).toBeUndefined();
  });
});
