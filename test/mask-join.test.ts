import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/core/config.js";
import { guardedQuery, MASK, starOverJoin } from "../src/core/datapolicy.js";

const base = { url: "https://sap.example:44300", client: "100", user: "DEMO_USER" };
const [DEV, PRD] = parseConfig({ systems: [{ ...base, id: "DEV", role: "DEV" }, { ...base, id: "PRD", role: "PRD" }] }).systems;
const sap = (columns: string[], values: Record<string, unknown>[]) =>
  ({ query: async (sql: string) => (/dd26s|ddldependency/i.test(sql) ? { columns: [], values: [] } : { columns: columns.map((name) => ({ name })), values }), adt: async () => ({}) }) as any;

describe("SELECT * sobre una unión y enmascarado", () => {
  it("detecta * y alias~* con JOIN, fuera de literales", () => {
    expect(starOverJoin("SELECT * FROM zdemo_h AS h INNER JOIN zdemo_t AS t ON h~id = t~id")).toBe(true);
    expect(starOverJoin("select h~*, t~text from zdemo_h as h join zdemo_t as t on h~id = t~id")).toBe(true);
    expect(starOverJoin("SELECT h~id, t~text FROM zdemo_h AS h JOIN zdemo_t AS t ON h~id = t~id")).toBe(false);
    expect(starOverJoin("SELECT * FROM zdemo_h WHERE txt = 'JOIN'")).toBe(false);
  });
  it("en productivo se rechaza antes de consultar; en test se permite", async () => {
    const q = "SELECT * FROM zdemo_h AS h INNER JOIN zdemo_t AS t ON h~id = t~id";
    await expect(guardedQuery(sap(["H", "T"], [{ H: "x", T: "y" }]), PRD, q, 10)).rejects.toThrow(/tiene que nombrar sus columnas/);
    await expect(guardedQuery(sap(["H", "T"], [{ H: "x", T: "y" }]), DEV, q, 10)).resolves.toBeDefined();
  });
  it("con columnas nombradas se enmascara lo personal", async () => {
    const r = await guardedQuery(sap(["ID", "CREATED_BY"], [{ ID: "1", CREATED_BY: "ALGUIEN" }]), PRD, "SELECT h~id, h~created_by FROM zdemo_h AS h INNER JOIN zdemo_t AS t ON h~id = t~id", 10);
    expect(r.values[0].CREATED_BY).toBe(MASK);
  });
  it("una columna compuesta se rechaza en productivo sin devolver datos", async () => {
    await expect(guardedQuery(sap(["H"], [{ H: { CREATED_BY: "ALGUIEN" } }]), PRD, "SELECT h FROM zdemo_h AS h", 10)).rejects.toThrow(/columnas compuestas/);
  });
});
