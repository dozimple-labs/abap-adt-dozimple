import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { AUDIT_FILE, verifyAudit, type AuditEntry } from "../src/core/audit.js";
import { parseConfig } from "../src/core/config.js";
import { guardedQuery, MASK } from "../src/core/datapolicy.js";
import { activeElevation, allowedElevations, categorize, classify, grantElevation, listElevations, resetElevationsForTests, revokeElevation } from "../src/core/elevation.js";
import { invoke } from "../src/core/registry.js";
import type { ToolDef } from "../src/core/tool.js";
import tools from "../src/tools/core/elevation.js";

const [elevateAccess, elevationStatus, revokeAccess] = tools as ToolDef<any>[];
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "abapdz-elev-"));
  process.env.ABAP_DZ_STATE_DIR = dir;
  resetElevationsForTests();
});
const base = { url: "https://sap.example:44300", client: "100", user: "DEMO_USER" };
const cfg = parseConfig({
  systems: [
    { ...base, id: "DEV", role: "DEV" },
    { ...base, id: "PRD", role: "PRD" },
    { ...base, id: "DEV_CORTO", role: "DEV", elevation: { allowed: ["SEG_ROLES"], maxMinutes: 15 } },
  ],
});
const [DEV, PRD, DEV_CORTO] = cfg.systems;
const pool = { get: (s: any) => ({ system: s, missingCapabilities: async () => [], adt: async () => ({}), noteNetworkFailure() {}, resetReader() {} }) } as any;
const entries = () => readFileSync(join(dir, AUDIT_FILE), "utf8").trim().split("\n").map((l) => JSON.parse(l) as AuditEntry);

describe("clasificación de tablas", () => {
  it("cada categoría por nombre; SECRETOS manda sobre el resto", () => {
    expect(["USR02", "RSECTAB", "SNAP", "OA2C_CLIENT"].map(classify)).toEqual(["SECRETOS", "SECRETOS", "SECRETOS", "SECRETOS"]);
    expect(["AGR_USERS", "AGR_1251", "UST04", "USR21", "USOBT_C", "TOBJ"].map(classify)).toEqual(Array(6).fill("SEG_ROLES"));
    expect(["PA0002", "PB0001", "HRP1001", "PCL2", "PA0008", "HRPY_RGDIR"].map(classify)).toEqual(["HCM_MAESTRO", "HCM_MAESTRO", "HCM_MAESTRO", "HCM_NOMINA", "HCM_NOMINA", "HCM_NOMINA"]);
    expect(["KNA1", "LFA1", "ADRC", "BUT000"].map(classify)).toEqual(Array(4).fill("PERSONAS_NEGOCIO"));
    expect(["MARA", "VBAK", "T000", "ZDEMO_TAB", "/DZ/ZTAB"].map(classify)).toEqual(Array(5).fill("NEGOCIO"));
    expect([...categorize(["mara", "agr_users", "kna1", "ust04"])]).toEqual([["SEG_ROLES", ["AGR_USERS", "UST04"]], ["PERSONAS_NEGOCIO", ["KNA1"]]]);
  });
  it("lo permitido depende del sistema: en PRD nunca HCM por defecto; configurable", () => {
    expect(allowedElevations(DEV)).toEqual(["SEG_ROLES", "HCM_MAESTRO", "HCM_NOMINA", "PERSONAS_NEGOCIO"]);
    expect(allowedElevations(PRD)).toEqual(["SEG_ROLES", "PERSONAS_NEGOCIO"]);
    expect(allowedElevations(DEV_CORTO)).toEqual(["SEG_ROLES"]);
  });
  it("la elevación caduca sola y se puede revocar", () => {
    const now = Date.now();
    grantElevation({ system: "DEV", category: "SEG_ROLES", reason: "r", until: now + 60_000, grantedBy: "U" }, now);
    expect(activeElevation("dev", "SEG_ROLES", now + 1)).toBeDefined();
    expect(activeElevation("DEV", "SEG_ROLES", now + 60_001)).toBeUndefined();
    grantElevation({ system: "DEV", category: "HCM_MAESTRO", reason: "r", until: now + 60_000, grantedBy: "U" }, now);
    expect(listElevations("DEV", now).map((e) => e.category)).toEqual(["HCM_MAESTRO"]);
    expect(revokeElevation("DEV").map((e) => e.category)).toEqual(["HCM_MAESTRO"]);
    expect(listElevations(undefined, now)).toEqual([]);
  });
});

describe("guardedQuery con categorías", () => {
  const sap = (views: Record<string, string[]> = {}) =>
    ({
      query: async (sql: string) => {
        if (/FROM dd26s/i.test(sql)) {
          const names = [...sql.matchAll(/'([^']+)'/g)].map((m) => m[1]);
          return { columns: [], values: names.flatMap((n) => (views[n] ?? []).map((t) => ({ VIEWNAME: n, TABNAME: t }))) };
        }
        if (/ddldependency/i.test(sql)) return { columns: [], values: [] };
        return { columns: [{ name: "KUNNR" }, { name: "NAME1" }], values: [{ KUNNR: "1", NAME1: "Alguien" }] };
      },
      adt: async () => ({}),
    }) as any;
  it("seguridad y HCM se bloquean sin elevación, con la pista de elevate_access; con elevación se leen y se anotan", async () => {
    await expect(guardedQuery(sap(), DEV, "SELECT * FROM agr_users", 10)).rejects.toThrow(/SEG_ROLES.*no tiene esa elevación/);
    await expect(guardedQuery(sap(), DEV, "SELECT pernr FROM pa0002", 10)).rejects.toThrow(/HCM_MAESTRO/);
    grantElevation({ system: "DEV", category: "SEG_ROLES", reason: "r", until: Date.now() + 60_000, grantedBy: "U" });
    const r = await guardedQuery(sap(), DEV, "SELECT * FROM agr_users", 10);
    expect(r.notes.join(" ")).toMatch(/acceso elevado \(SEG_ROLES\)/);
  });
  it("también a través de una vista que llega a nómina, y SECRETOS nunca", async () => {
    await expect(guardedQuery(sap({ ZV_PAGOS: ["PA0008", "T001"] }), DEV, "SELECT * FROM zv_pagos", 10)).rejects.toThrow(/PA0008.*HCM_NOMINA/);
    grantElevation({ system: "DEV", category: "HCM_NOMINA", reason: "r", until: Date.now() + 60_000, grantedBy: "U" });
    await expect(guardedQuery(sap({ ZV_PAGOS: ["PA0008", "T001"] }), DEV, "SELECT * FROM zv_pagos", 10)).resolves.toBeDefined();
    grantElevation({ system: "DEV", category: "SEG_ROLES", reason: "r", until: Date.now() + 60_000, grantedBy: "U" });
    await expect(guardedQuery(sap({ ZV_SEC: ["USR02"] }), DEV, "SELECT * FROM zv_sec", 10)).rejects.toThrow(/seguridad/);
    await expect(guardedQuery(sap(), DEV, "SELECT bname, pwdsaltedhash FROM usr02", 10)).rejects.toThrow(/seguridad/);
  });
  it("PERSONAS_NEGOCIO elevada quita el enmascarado en productivo y queda anotado", async () => {
    const masked = await guardedQuery(sap(), PRD, "SELECT kunnr, name1 FROM kna1", 10);
    expect(masked.values[0].NAME1).toBe(MASK);
    grantElevation({ system: "PRD", category: "PERSONAS_NEGOCIO", reason: "r", until: Date.now() + 60_000, grantedBy: "U" });
    const clear = await guardedQuery(sap(), PRD, "SELECT kunnr, name1 FROM kna1", 10);
    expect(clear.values[0].NAME1).toBe("Alguien");
    expect(clear.notes.join(" ")).toMatch(/acceso elevado \(PERSONAS_NEGOCIO\)/);
  });
});

describe("elevate_access, elevation_status y revoke_access", () => {
  it("dos pasos con vista previa y token; concesión, uso y revocación en el registro encadenado", async () => {
    const args = { system: "DEV", category: "HCM_MAESTRO", minutes: 30, reason: "Análisis del ticket de ejemplo" };
    const first = await invoke(elevateAccess, args, { config: cfg, pool, tools: [] });
    expect(first.isError).toBe(false);
    expect(first.text).toMatch(/VISTA PREVIA: todavía no se ha ejecutado nada[\s\S]*HCM_MAESTRO[\s\S]*30 minutos/);
    expect(activeElevation("DEV", "HCM_MAESTRO")).toBeUndefined();
    const token = first.text.match(/confirm_token="([0-9a-f]+)"/)![1];
    const second = await invoke(elevateAccess, { ...args, confirm_token: token }, { config: cfg, pool, tools: [] });
    expect(second.isError).toBe(false);
    expect(activeElevation("DEV", "HCM_MAESTRO")?.reason).toBe(args.reason);
    const status = await invoke(elevationStatus, { system: "DEV" }, { config: cfg, pool, tools: [] });
    expect(status.text).toMatch(/DEV · HCM_MAESTRO .* min restantes/);
    // una lectura bajo elevación deja elevation_used además de data_read
    const reader: ToolDef<any> = { name: "t_read", title: "t", description: "d", access: "read", input: {}, run: async (_a, ctx) => (await guardedQuery({ query: async (sql: string) => (/dd26s|ddldependency/i.test(sql) ? { columns: [], values: [] } : { columns: [{ name: "PERNR" }], values: [{ PERNR: "1" }] }), adt: async () => ({}) } as any, ctx.system, "SELECT pernr FROM pa0002", 10)).values.length + " filas" };
    await invoke(reader, { system: "DEV" }, { config: cfg, pool, tools: [] });
    const rev = await invoke(revokeAccess, { system: "DEV" }, { config: cfg, pool, tools: [] });
    expect(rev.text).toMatch(/Revocadas en DEV: HCM_MAESTRO/);
    const phases = entries().map((e) => e.phase);
    expect(phases).toEqual(["intent", "elevation_granted", "result", "data_read", "elevation_used", "elevation_revoked"]);
    expect(entries()[1]).toMatchObject({ phase: "elevation_granted", elevation: { category: "HCM_MAESTRO", reason: args.reason } });
    expect(entries()[0]).toMatchObject({ phase: "intent", confirmedBy: "token" });
    expect(entries()[3].read).toMatchObject({ categories: ["HCM_MAESTRO"], elevated: ["HCM_MAESTRO"] });
    expect(verifyAudit(readFileSync(join(dir, AUDIT_FILE), "utf8"))).toMatchObject({ ok: true, entries: 6 });
  });
  it("lo que el sistema no permite se rechaza en la vista previa", async () => {
    const prd = await invoke(elevateAccess, { system: "PRD", category: "HCM_NOMINA", minutes: 10, reason: "no debería poder" }, { config: cfg, pool, tools: [] });
    expect(prd).toMatchObject({ isError: true, kind: "POLICY" });
    expect(prd.text).toMatch(/PRD no permite elevar HCM_NOMINA/);
    const largo = await invoke(elevateAccess, { system: "DEV_CORTO", category: "SEG_ROLES", minutes: 30, reason: "demasiado tiempo" }, { config: cfg, pool, tools: [] });
    expect(largo.text).toMatch(/limita la elevación a 15 minutos/);
  });
});
