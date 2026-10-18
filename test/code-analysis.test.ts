import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ToolDef } from "../src/core/tool.js";
import tools from "../src/tools/core/code_analysis.js";

const [codeStructure, packageDependencies, unusedMethods] = tools as ToolDef<any>[];
const SRC_A = "CLASS zcl_a DEFINITION PUBLIC.\n  PUBLIC SECTION.\n    METHODS run.\n  PRIVATE SECTION.\n    METHODS dead.\nENDCLASS.\nCLASS zcl_a IMPLEMENTATION.\n  METHOD run.\n    SELECT * FROM mara INTO TABLE @DATA(lt).\n    zcl_b=>go( ).\n  ENDMETHOD.\n  METHOD dead.\n  ENDMETHOD.\nENDCLASS.";
const SRC_B = "CLASS zcl_b DEFINITION PUBLIC.\n  PUBLIC SECTION.\n    CLASS-METHODS go.\nENDCLASS.\nCLASS zcl_b IMPLEMENTATION.\n  METHOD go.\n    CALL FUNCTION 'BAPI_X'.\n  ENDMETHOD.\nENDCLASS.";

function ctx() {
  const c = {
    searchObject: async (name: string) => [{ "adtcore:name": name, "adtcore:type": "CLAS/OC", "adtcore:uri": `/sap/bc/adt/oo/classes/${name.toLowerCase()}`, "adtcore:packageName": "ZPKG" }],
    objectStructure: async (uri: string) => ({ objectUrl: uri, links: [], metaData: {}, includes: [{ "class:includeType": "main", links: [{ href: `${uri}/source/main`, rel: "http://www.sap.com/adt/relations/source", type: "text/plain" }] }] }),
    getObjectSource: async (url: string) => (url.includes("zcl_a") ? SRC_A : SRC_B),
  };
  const sap = {
    adt: async () => c,
    query: async (sql: string) => {
      if (/FROM tdevc/i.test(sql)) return { values: [] };
      if (/FROM tadir/i.test(sql)) return { values: [{ PGMID: "R3TR", OBJECT: "CLAS", OBJ_NAME: "ZCL_A" }, { PGMID: "R3TR", OBJECT: "CLAS", OBJ_NAME: "ZCL_B" }] };
      return { values: [] };
    },
  };
  return { sap, system: { id: "DEV" } } as any;
}

describe("code_structure", () => {
  it("analiza un fragmento sin tocar SAP y valida la salida estructurada", async () => {
    const r: any = await codeStructure.run({ source: SRC_A, object_type: "CLAS", include: "main" }, { sap: { adt: async () => { throw new Error("no debe conectar"); } } } as any);
    const s = z.object(codeStructure.output!).parse(r.structured);
    expect(s.symbols.classes[0].methods.map((m) => m.name)).toEqual(["RUN", "DEAD"]);
    expect(s.references.tables).toEqual(["MARA"]);
    expect(s.unused_methods).toEqual([{ class: "ZCL_A", method: "DEAD", visibility: "private" }]);
    expect(r.text).toMatch(/Clase ZCL_A[\s\S]*private: DEAD[\s\S]*tablas: MARA[\s\S]*ZCL_A=>DEAD/);
  });
  it("sin object_name ni source, lo dice", async () => {
    await expect(codeStructure.run({ include: "main" }, ctx())).rejects.toThrow(/object_name o source/);
  });
});

describe("package_dependencies y unused_methods sobre objetos", () => {
  it("marca lo interno y lo externo y ordena los destinos más usados", async () => {
    const r: any = await packageDependencies.run({ objects: ["ZCL_A", "ZCL_B"], include_subpackages: true, max_objects: 10, top: 10 }, ctx());
    const s = z.object(packageDependencies.output!).parse(r.structured);
    expect(s.scanned).toBe(2);
    expect(s.edges).toContainEqual({ from: "ZCL_A", to: "ZCL_B", kind: "class", internal: true });
    expect(s.edges).toContainEqual({ from: "ZCL_A", to: "MARA", kind: "table", internal: false });
    expect(s.edges).toContainEqual({ from: "ZCL_B", to: "BAPI_X", kind: "function", internal: false });
    expect(r.text).toMatch(/2 objetos analizados[\s\S]*Destinos más usados/);
  });
  it("encuentra el método privado sin uso", async () => {
    const r: any = await unusedMethods.run({ objects: ["ZCL_A", "ZCL_B"], include_subpackages: true, max_objects: 10 }, ctx());
    const s = z.object(unusedMethods.output!).parse(r.structured);
    expect(s.classes_scanned).toBe(2);
    expect(s.findings).toEqual([{ class: "ZCL_A", method: "DEAD", visibility: "private" }]);
  });
});
