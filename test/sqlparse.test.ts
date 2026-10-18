import { describe, expect, it } from "vitest";
import { parseSources } from "../src/core/sqlparse.js";

describe("parseSources · fuentes de una consulta", () => {
  it("FROM, JOIN con y sin AS, subconsultas, EXISTS y namespaces", () => {
    expect(parseSources("SELECT a~matnr FROM mara AS a INNER JOIN marc AS b ON a~matnr = b~matnr WHERE a~mtart = 'FROM X'").tables).toEqual(["MARA", "MARC"]);
    expect(parseSources("select m~matnr from mara m left outer join makt t on m~matnr = t~matnr").tables).toEqual(["MARA", "MAKT"]);
    expect(parseSources("SELECT kunnr FROM kna1 WHERE EXISTS ( SELECT * FROM knvv WHERE knvv~kunnr = kna1~kunnr )").tables).toEqual(["KNA1", "KNVV"]);
    expect(parseSources("SELECT COUNT( * ) AS n FROM ( SELECT kunnr FROM kna1 ) AS s").tables).toEqual(["KNA1"]);
    expect(parseSources("SELECT * FROM /dz/ztab").tables).toEqual(["/DZ/ZTAB"]);
  });
  it("CTE: los +nombres no son tablas base y tienen que estar declarados", () => {
    const r = parseSources("WITH +c AS ( SELECT matnr FROM mara ), +d AS ( SELECT matnr FROM +c ) SELECT * FROM +d INNER JOIN marc ON +d~matnr = marc~matnr");
    expect(r).toEqual({ tables: ["MARA", "MARC"], ctes: ["+C", "+D"] });
    expect(() => parseSources("SELECT * FROM +nada")).toThrow(/CTE \+NADA no declarado/);
    expect(() => parseSources("WITH c AS ( SELECT * FROM t000 ) SELECT * FROM c")).toThrow(/\+nombre/);
  });
  it("rechaza lo que no se puede resolver: host, dinámico, UP TO, INTO, paréntesis, varias sentencias", () => {
    expect(() => parseSources("SELECT * FROM @lt_tab")).toThrow(/variable host/);
    expect(() => parseSources("SELECT * FROM (lv_tabname)")).toThrow(/fuente dinámica/);
    expect(() => parseSources("SELECT * FROM t000 UP TO 10 ROWS")).toThrow(/UP TO/);
    expect(() => parseSources("SELECT * FROM t000 INTO TABLE @lt")).toThrow(/INTO/);
    expect(() => parseSources("SELECT * FROM t000 WHERE mandt IN ( '100'")).toThrow(/paréntesis/);
    expect(() => parseSources("SELECT * FROM t000; DELETE FROM t000")).toThrow(/varias sentencias/);
    expect(() => parseSources("SELECT * FROM WHERE x = 1")).toThrow(/no es una tabla/);
    expect(() => parseSources("SELECT * FROM")).toThrow(/nada después/);
  });
  it("los literales no cuentan aunque contengan FROM o JOIN", () => {
    expect(parseSources("SELECT * FROM tadir WHERE obj_name = 'join x from y'").tables).toEqual(["TADIR"]);
  });
});
