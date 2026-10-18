import { describe, expect, it } from "vitest";
import { parseAbap, summarize } from "../src/core/abapparse.js";

const CLASS = `CLASS zcl_demo DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES zif_x.
    CLASS-METHODS build RETURNING VALUE(ro) TYPE REF TO zcl_demo.
    METHODS run IMPORTING iv_a TYPE i RETURNING VALUE(rv_b) TYPE string.
  PROTECTED SECTION.
    METHODS hook.
  PRIVATE SECTION.
    DATA mv_x TYPE i.
    CLASS-DATA gv_y TYPE i.
    METHODS helper.
    METHODS unused_one.
ENDCLASS.
CLASS zcl_demo IMPLEMENTATION.
  METHOD build.
  ENDMETHOD.
  METHOD run.
    SELECT SINGLE matnr FROM mara INTO @DATA(lv) WHERE matnr = iv_a.
    IF lv IS NOT INITIAL.
      LOOP AT lt_x INTO DATA(ls).
        CALL FUNCTION 'RFC_READ_TABLE' EXPORTING query_table = 'T000'.
      ENDLOOP.
    ENDIF.
    helper( ).
    zcl_other=>static( ).
    DATA lo TYPE REF TO zcl_third.
    lo->go( ).
    INCLUDE zinc_demo.
  ENDMETHOD.
  METHOD hook.
  ENDMETHOD.
  METHOD helper.
  ENDMETHOD.
  METHOD unused_one.
  ENDMETHOD.
  METHOD zif_x~do.
  ENDMETHOD.
ENDCLASS.`;

describe("parseAbap", () => {
  const p = parseAbap("ZCL_DEMO", "CLAS/OC", CLASS);
  it("símbolos: clase, métodos con visibilidad y estáticos, atributos, interfaces", () => {
    const c = p.symbols.classes[0];
    expect(c.name).toBe("ZCL_DEMO");
    expect(c.interfaces).toEqual(["ZIF_X"]);
    expect(c.methods.map((m) => `${m.name}:${m.visibility}${m.static ? ":s" : ""}`)).toEqual(["BUILD:public:s", "RUN:public", "HOOK:protected", "HELPER:private", "UNUSED_ONE:private"]);
    expect(c.attributes).toEqual([{ name: "MV_X", visibility: "private", static: false }, { name: "GV_Y", visibility: "private", static: true }]);
  });
  it("referencias: tablas, funciones literales, clases ajenas e includes", () => {
    expect(p.references).toEqual({ tables: ["MARA"], functions: ["RFC_READ_TABLE"], classes: ["ZCL_OTHER", "ZCL_THIRD"], includes: ["ZINC_DEMO"], forms: [] });
  });
  it("métricas y métodos sin uso (privados y protegidos; no los públicos ni los de interfaz)", () => {
    expect(p.metrics.maxNesting).toBe(3); // method > if > loop
    expect(p.metrics.statements).toBeGreaterThan(20);
    expect(p.unusedMethods).toEqual([{ class: "ZCL_DEMO", method: "HOOK", visibility: "protected" }, { class: "ZCL_DEMO", method: "UNUSED_ONE", visibility: "private" }]);
  });
  it("un programa con forms y PERFORM", () => {
    const q = parseAbap("ZDEMO", "PROG/P", "REPORT zdemo.\nPERFORM init.\nSELECT * FROM t000 INTO TABLE @DATA(lt).\nFORM init.\nENDFORM.\nFORM nunca.\nENDFORM.");
    expect(q.symbols.forms).toEqual(["INIT", "NUNCA"]);
    expect(q.references.forms).toEqual(["INIT"]);
    expect(q.references.tables).toEqual(["T000"]);
  });
  it("el resumen cabe en una línea y cuenta lo esencial", () => {
    expect(summarize(p)).toMatch(/clase ZCL_DEMO: 5 métodos \(2 públicos\), implementa ZIF_X · \d+ sentencias, anidamiento máximo 3 · lee MARA · llama RFC_READ_TABLE · usa ZCL_OTHER, ZCL_THIRD · includes ZINC_DEMO · 2 métodos/);
  });
});
