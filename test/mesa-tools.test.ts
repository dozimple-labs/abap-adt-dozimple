import { describe, expect, it } from "vitest";
import type { ToolDef } from "../src/core/tool.js";
import countRows, { countSql } from "../src/tools/core/count_rows.js";
import diagnoseMessage, { parseMessage } from "../src/tools/core/diagnose_message.js";
import foreignKeys, { foreignKeysOf } from "../src/tools/core/foreign_keys.js";
import searchTables, { variants } from "../src/tools/core/search_tables.js";

const run = (t: unknown, args: Record<string, unknown>, ctx: Record<string, unknown>) => (t as ToolDef<any>).run(args, ctx as any) as Promise<any>;
const sys = { id: "DEV", language: "ES", role: "DEV", client: "100", url: "https://x", user: "U" };

describe("diagnose_message", () => {
  it("entiende las formas en que la gente copia un mensaje", () => {
    expect(parseMessage("ZDEMO 012")).toEqual({ cls: "ZDEMO", num: "012" });
    expect(parseMessage("e:zdemo:12")).toEqual({ cls: "ZDEMO", num: "012" });
    expect(parseMessage("ZDEMO(012)")).toEqual({ cls: "ZDEMO", num: "012" });
    expect(parseMessage("ZDEMO012")).toEqual({ cls: "ZDEMO", num: "012" });
    expect(parseMessage("/DBM/COMMON 458")).toEqual({ cls: "/DBM/COMMON", num: "458" });
    expect(parseMessage("Mensaje no. 458 de la clase /DBM/COMMON")).toEqual({ cls: "/DBM/COMMON", num: "458" });
    expect(parseMessage("hola")).toBeUndefined();
  });

  function ctx(texts: Array<[string, string]>, includes: string[] = [], declaring: string[] = []) {
    const sap = {
      query: async (sql: string) => {
        if (/FROM t100 WHERE arbgb = 'ZDEMO' AND msgnr/.test(sql)) return { values: texts.map(([SPRSL, TEXT]) => ({ SPRSL, TEXT })) };
        if (/FROM t100 WHERE arbgb = 'ZDEMO'/.test(sql)) return { values: [{ MSGNR: "001" }] };
        if (/FROM cross WHERE type = 'N' AND name = 'ZDEMO               012'/.test(sql)) return { values: includes.map((INCLUDE) => ({ INCLUDE })) };
        if (/FROM cross WHERE type = 'N' AND name = 'ZDEMO'/.test(sql)) return { values: declaring.map((INCLUDE) => ({ INCLUDE })) };
        return { values: [] };
      },
      adt: async () => ({}),
    };
    return { sap, system: sys, progress: () => {} };
  }

  it("texto en el idioma de la conexión y en inglés, marcadores y quién lo emite", async () => {
    const r = await run(diagnoseMessage, { message: "ZDEMO 012", max_usages: 50 }, ctx([["S", "Pedido &1 sin tarea &2"], ["E", "Order &1 without task &2"]], ["ZDEMO_REP", "LZDEMO_APIU01"]));
    expect(r).toMatch(/S: Pedido &1 sin tarea &2/);
    expect(r).toMatch(/E: Order &1 without task &2/);
    expect(r).toMatch(/Marcadores: &1 &2/);
    expect(r).toMatch(/Sin texto largo/);
    expect(r).toMatch(/Lo emiten 2 includes: ZDEMO_REP, LZDEMO_APIU01/);
  });

  it("sin usos estáticos: lista los programas que declaran la clase, o remite a source_search", async () => {
    expect(await run(diagnoseMessage, { message: "ZDEMO 012", max_usages: 50 }, ctx([["S", "x"]], [], ["ZDEMO_DYN"]))).toMatch(/Ningún include lo emite de forma estática[\s\S]*declaran MESSAGE-ID ZDEMO[\s\S]*ZDEMO_DYN/);
    expect(await run(diagnoseMessage, { message: "ZDEMO 012", max_usages: 50 }, ctx([["S", "x"]]))).toMatch(/Ningún programa declara MESSAGE-ID ZDEMO[\s\S]*source_search\(text="ZDEMO"\)/);
  });

  it("mensaje o clase inexistentes", async () => {
    await expect(run(diagnoseMessage, { message: "ZDEMO 012", max_usages: 50 }, ctx([]))).rejects.toThrow(/existe pero no tiene el mensaje 012/);
    await expect(run(diagnoseMessage, { message: "hola", max_usages: 50 }, ctx([]))).rejects.toThrow(/No reconozco clase y número/);
  });
});

describe("search_tables", () => {
  it("prueba las variantes de capitalización y el nombre; escapa los comodines", async () => {
    let seen = "";
    const sap = { query: async (sql: string) => ((seen = sql), { values: [{ TABNAME: "ZDZ_TICKET_LOG", TABCLASS: "TRANSP", CONTFLAG: "A", DDTEXT: "Log de tickets" }] }) };
    const r = await run(searchTables, { text: "ticket", kind: "TRANSP", only_custom: true, max: 50 }, { sap, system: sys });
    expect(variants("ticket")).toEqual(["ticket", "TICKET", "Ticket"]);
    expect(seen).toMatch(/t~ddtext LIKE '%ticket%' ESCAPE '#' OR t~ddtext LIKE '%TICKET%' ESCAPE '#' OR t~ddtext LIKE '%Ticket%' ESCAPE '#' OR l~tabname LIKE '%TICKET%'/);
    expect(seen).toMatch(/l~tabclass = 'TRANSP'/);
    expect(seen).toMatch(/l~tabname LIKE 'Z%' OR l~tabname LIKE 'Y%'/);
    expect(seen).toMatch(/t~ddlanguage = 'S'/);
    expect(r).toMatch(/ZDZ_TICKET_LOG\ttabla\tA\tLog de tickets/);
    await expect(run(searchTables, { text: "tick%", kind: "all", only_custom: false, max: 50 }, { sap, system: sys })).rejects.toThrow(/Sin comodines/);
  });

  it("sin resultados: se ejecutó y no encontró", async () => {
    const sap = { query: async () => ({ values: [] }) };
    expect(await run(searchTables, { text: "nada", kind: "all", only_custom: false, max: 50 }, { sap, system: sys })).toMatch(/se ejecutó y no encontró tablas/);
  });
});

describe("foreign_keys", () => {
  const sap = {
    query: async (sql: string) => {
      if (/FROM dd02l/.test(sql)) return { values: /ZNOPE/.test(sql) ? [] : [{ TABNAME: "ZDEMO_ITEM" }] };
      if (/FROM dd08l WHERE tabname = 'ZDEMO_ITEM'/.test(sql)) return { values: [{ TABNAME: "ZDEMO_ITEM", FIELDNAME: "VBELN", CHECKTABLE: "ZDEMO_HEAD", FRKART: "KEY", CARDLEFT: "1", CARD: "CN" }] };
      if (/FROM dd05s WHERE tabname IN \( 'ZDEMO_ITEM' \)/.test(sql)) return { values: [{ TABNAME: "ZDEMO_ITEM", FIELDNAME: "VBELN", FORKEY: "MANDT", PRIMPOS: 1 }, { TABNAME: "ZDEMO_ITEM", FIELDNAME: "VBELN", FORKEY: "VBELN", PRIMPOS: 2 }] };
      if (/FROM dd03l WHERE tabname IN \( 'ZDEMO_HEAD' \)/.test(sql)) return { values: [{ TABNAME: "ZDEMO_HEAD", FIELDNAME: "MANDT", POSITION: 1 }, { TABNAME: "ZDEMO_HEAD", FIELDNAME: "VBELN", POSITION: 2 }] };
      if (/FROM dd08l WHERE checktable = 'ZDEMO_ITEM'/.test(sql)) return { values: [] };
      return { values: [] };
    },
  };

  it("hacia fuera: tabla de verificación con la condición de join campo a campo", async () => {
    const fks = await foreignKeysOf(sap, "ZDEMO_ITEM", "from");
    expect(fks).toEqual([{ table: "ZDEMO_ITEM", field: "VBELN", checkTable: "ZDEMO_HEAD", kind: "clave", cardinality: "1 : 0..n", on: [["MANDT", "MANDT"], ["VBELN", "VBELN"]] }]);
    const r = await run(foreignKeys, { table: "zdemo_item", direction: "both" }, { sap });
    expect(r).toMatch(/ZDEMO_ITEM usa 1 tablas de verificación/);
    expect(r).toMatch(/VBELN\tZDEMO_HEAD\tclave\t1 : 0\.\.n\tZDEMO_ITEM~MANDT = ZDEMO_HEAD~MANDT AND ZDEMO_ITEM~VBELN = ZDEMO_HEAD~VBELN/);
    expect(r).toMatch(/Ninguna tabla usa ZDEMO_ITEM como tabla de verificación/);
  });

  it("tabla inexistente", async () => {
    await expect(run(foreignKeys, { table: "ZNOPE", direction: "both" }, { sap })).rejects.toThrow(/no existe activa/);
  });
});

describe("count_rows", () => {
  it("construye el SELECT de recuento y rechaza entradas peligrosas", () => {
    expect(countSql("ZDEMO_LOG")).toBe("SELECT COUNT( * ) AS n FROM ZDEMO_LOG");
    expect(countSql("ZDEMO_LOG", "erdat >= '20260101'", "estado")).toBe("SELECT ESTADO, COUNT( * ) AS n FROM ZDEMO_LOG WHERE erdat >= '20260101' GROUP BY ESTADO ORDER BY n DESCENDING");
    expect(() => countSql("ZDEMO_LOG", "1 = 1; DELETE")).toThrow(/no admite/);
    expect(() => countSql("ZDEMO_LOG", undefined, "a b")).toThrow(/group_by/);
    expect(() => countSql("Z;X")).toThrow(/inválido/);
  });

  it("devuelve el total o los grupos, con las notas de la política", async () => {
    const sap = { query: async (sql: string) => (/dd26s|ddldependency/.test(sql) ? { columns: [], values: [] } : /GROUP BY/.test(sql) ? { columns: [{ name: "ESTADO" }, { name: "N" }], values: [{ ESTADO: "OK", N: 1200 }, { ESTADO: "ERR", N: 3 }] } : { columns: [{ name: "N" }], values: [{ N: 1203 }] }) };
    expect(await run(countRows, { table: "ZDEMO_LOG", max_groups: 50 }, { sap, system: sys })).toMatch(/ZDEMO_LOG: 1.203 filas\./);
    const g = await run(countRows, { table: "ZDEMO_LOG", group_by: "estado", max_groups: 50 }, { sap, system: sys });
    expect(g).toMatch(/por estado: 2 grupos\n\nESTADO\tfilas\nOK\t1.200\nERR\t3/);
  });

  it("tablas vetadas y columnas personales en WHERE se bloquean como en sql_query", async () => {
    const sap = { query: async () => ({ columns: [{ name: "N" }], values: [{ N: 1 }] }) };
    await expect(run(countRows, { table: "USR02", max_groups: 50 }, { sap, system: sys })).rejects.toThrow();
    await expect(run(countRows, { table: "VBAK", where: "ernam = 'X'", max_groups: 50 }, { sap, system: { ...sys, role: "PRD", dataClass: "prod" } })).rejects.toThrow();
  });
});

describe("diagnose_message · texto largo", () => {
  it("convierte el ITF de DOKTL en texto legible: títulos, párrafos partidos, viñetas e includes", async () => {
    const { renderDocu } = await import("../src/tools/core/diagnose_message.js");
    const txt = renderDocu([
      { format: "U1", text: "&CAUSE&" },
      { format: "AS", text: "No es posible facturar la clase de entrega &V1& con la clase de factura" },
      { format: "", text: "&V2&." },
      { format: "U1", text: "&WHAT_TO_DO&" },
      { format: "AS", text: "Verifique y corrija:" },
      { format: "B1", text: "la clase de pedido" },
      { format: "", text: "por defecto." },
      { format: "B1", text: "la clase de factura." },
      { format: "/:", text: "INCLUDE 'NA_CUST_MAINTAIN_3' OBJECT DOKU ID TX LANGUAGE S" },
    ]);
    expect(txt.split("\n")).toEqual([
      "Causa:",
      "No es posible facturar la clase de entrega &V1& con la clase de factura &V2&.",
      "Qué hacer:",
      "Verifique y corrija:",
      "• la clase de pedido por defecto.",
      "• la clase de factura.",
      "[texto estándar incluido: NA_CUST_MAINTAIN_3]",
    ]);
  });
});
