import { z } from "zod";
import { describe, expect, it } from "vitest";
import dumps, { GROUP_ROWS, groupDumps, parseFlist } from "../src/tools/core/dumps.js";
import type { ToolDef } from "../src/core/tool.js";

/**
 * «Los errores más frecuentes del periodo»: hueco anotado el 11-09. El feed ADT solo trae los dumps más recientes
 * (5 en un 7.50 real con miles en ST22), así que los grupos salen de la cabecera SNAP_BEG.FLIST, verificada en vivo.
 */
const def = dumps as ToolDef<any>;
const out = z.object(def.output!);

/** FLIST real (anonimizado): id de 2 + longitud de 3 + valor. */
const flist = (fields: Record<string, string>) => Object.entries(fields).map(([id, v]) => `${id}${String(v.length).padStart(3, "0")}${v}`).join("");
const row = (datum: string, uzeit: string, uname: string, fc: string, ap: string, ai = "LZDEMOU01", al = "42") => ({
  DATUM: datum, UZEIT: uzeit, UNAME: uname, FLIST: flist({ FC: fc, AP: ap, AI: ai, AL: al, XC: "CX_SY_DEMO" }),
});
const ROWS = [
  row("20260922", "094609", "USER_A", "CONVT_NO_NUMBER", "ZDEMO_REPORT", "ZDEMO_REPORT_F01", "120"),
  row("20260921", "120000", "USER_B", "CONVT_NO_NUMBER", "ZDEMO_REPORT"),
  row("20260920", "080000", "USER_A", "CONVT_NO_NUMBER", "SAPLZDEMO"),
  row("20260919", "230000", "USER_C", "TSV_TNEW_PAGE_ALLOC_FAILED", "ZDEMO_BATCH"),
  row("20260919", "010000", "USER_C", "TSV_TNEW_PAGE_ALLOC_FAILED", "ZDEMO_BATCH"),
];

describe("parseFlist", () => {
  it("decodifica id + longitud + valor y para ante basura", () => {
    expect(parseFlist(flist({ FC: "CONVT_NO_NUMBER", AP: "SAPLSTXK", AL: "3221" }))).toEqual({ FC: "CONVT_NO_NUMBER", AP: "SAPLSTXK", AL: "3221" });
    expect(parseFlist("")).toEqual({});
    expect(parseFlist("??abc")).toEqual({});
    expect(parseFlist(flist({ FC: "X" }) + "\u0000\u0000\u0000")).toEqual({ FC: "X" });
  });
});

describe("groupDumps", () => {
  it("agrupa por error con recuento, usuarios distintos, primer y último caso y dónde terminó el más reciente", () => {
    const g = groupDumps(ROWS, "error");
    expect(g.map((x) => [x.key, x.count, x.users])).toEqual([["CONVT_NO_NUMBER", 3, 2], ["TSV_TNEW_PAGE_ALLOC_FAILED", 2, 1]]);
    expect(g[0]).toMatchObject({ first: "20260920 080000", last: "20260922 094609", where: "ZDEMO_REPORT_F01 L120" });
  });

  it("por error+programa separa el mismo error en programas distintos; por día y por usuario también", () => {
    expect(groupDumps(ROWS, "error_program").map((x) => `${x.key}:${x.count}`)).toEqual([
      "CONVT_NO_NUMBER · ZDEMO_REPORT:2", "TSV_TNEW_PAGE_ALLOC_FAILED · ZDEMO_BATCH:2", "CONVT_NO_NUMBER · SAPLZDEMO:1",
    ]);
    expect(groupDumps(ROWS, "day").map((x) => `${x.key}:${x.count}`)).toEqual(["20260919:2", "20260920:1", "20260921:1", "20260922:1"]);
    expect(groupDumps(ROWS, "user").map((x) => `${x.key}:${x.count}`)).toEqual(["USER_A:2", "USER_C:2", "USER_B:1"]);
  });
});

function ctx(values: unknown[], cls: "test" | "prod" = "test") {
  const queries: string[] = [];
  const system = { id: "DEV", role: cls === "test" ? "DEV" : "PRD", dataClass: cls };
  return {
    queries,
    ctx: { sap: { query: async (sql: string) => (queries.push(sql), { values, columns: [] }), adt: async () => ({}) }, system } as any,
  };
}

describe("dumps con group_by", () => {
  it("consulta SNAP_BEG del periodo, agrupa y responde estructurado conforme al esquema", async () => {
    const { ctx: x, queries } = ctx(ROWS);
    const r: any = await def.run({ group_by: "error", days: 7, max: 20 }, x);
    expect(queries[0]).toMatch(/FROM snap_beg WHERE seqno = '000' AND datum >= '\d{8}'/);
    expect(r.text).toMatch(/5 dumps desde \d{8} \(7 días\), 2 grupos por error/);
    expect(r.text).toMatch(/3  CONVT_NO_NUMBER  · 2 usuarios · 20260920 → 20260922 · ZDEMO_REPORT_F01 L120/);
    const s = out.parse(r.structured);
    expect(s).toMatchObject({ mode: "groups", total: 5, period_days: 7, truncated: false, group_by: "error" });
    expect(s.groups![0]).toMatchObject({ key: "CONVT_NO_NUMBER", count: 3 });
  });

  it("contains filtra por error o programa antes de agrupar; user va a la consulta", async () => {
    const { ctx: x, queries } = ctx(ROWS);
    const r: any = await def.run({ group_by: "program", days: 30, max: 20, contains: "batch", user: "user_c" }, x);
    expect(queries[0]).toMatch(/uname = 'USER_C'/);
    expect(r.structured.groups).toEqual([expect.objectContaining({ key: "ZDEMO_BATCH", count: 2 })]);
  });

  it("sin filas dice que se consultó ST22 y no hay, nunca vacío", async () => {
    const { ctx: x } = ctx([]);
    const r: any = await def.run({ group_by: "error", days: 7, max: 20 }, x);
    expect(r.text).toMatch(/Sin dumps desde \d{8} \(7 días\): se consultó ST22/);
    expect(out.parse(r.structured)).toMatchObject({ mode: "groups", total: 0, groups: [] });
  });

  it("al llegar al tope de filas avisa de que puede haber más", async () => {
    const many = Array.from({ length: GROUP_ROWS }, (_, i) => row("20260922", String(100000 + i).slice(0, 6), "U", "ERR", "PROG"));
    const { ctx: x } = ctx(many);
    const r: any = await def.run({ group_by: "error", days: 7, max: 5 }, x);
    expect(r.text).toMatch(/TOPE ALCANZADO/);
    expect(r.structured.truncated).toBe(true);
  });

  it("en un sistema con datos productivos no agrupa por usuario (columna personal), y lo explica", async () => {
    const { ctx: x, queries } = ctx(ROWS, "prod");
    await expect(def.run({ group_by: "user", days: 7, max: 20 }, x)).rejects.toMatchObject({ kind: "POLICY", message: expect.stringMatching(/no se agrupa por usuario/) });
    expect(queries).toEqual([]);
    const r: any = await def.run({ group_by: "error", days: 7, max: 20 }, x); // por error sí, con el número de usuarios
    expect(r.structured.groups[0].users).toBe(2);
  });
});

describe("dumps · lista (feed) también estructurada", () => {
  it("la lista trae n, error, programa y usuario, y remite a group_by para periodos", async () => {
    const d = (error: string, program: string, author: string) => ({
      id: "x", type: "t", author, text: "<b>Short Text&nbsp;</b></td><td>texto</td>", links: [],
      categories: [{ label: "ABAP runtime error", term: error }, { label: "Terminated ABAP program", term: program }],
    });
    const x = { sap: { adt: async () => ({ dumps: async () => ({ dumps: [d("ERR_A", "ZP1", "U1"), d("ERR_B", "ZP2", "U2")] }) }) }, system: { id: "DEV", role: "DEV" } } as any;
    const r: any = await def.run({ max: 20, days: 7 }, x);
    expect(r.text).toMatch(/2 dumps .*para un periodo usa group_by/);
    expect(out.parse(r.structured)).toEqual({ mode: "list", total: 2, dumps: [{ n: 1, short_text: "texto", error: "ERR_A", program: "ZP1", user: "U1" }, { n: 2, short_text: "texto", error: "ERR_B", program: "ZP2", user: "U2" }] });
  });
});
