import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/core/config.js";
import { assertPackageAllowed, packageAllowed } from "../src/core/policy.js";
import type { ToolDef } from "../src/core/tool.js";
import changePackage from "../src/tools/core/change_package.js";
import dumps from "../src/tools/core/dumps.js";

const base = { url: "https://sap.example", client: "100", user: "DEV_ME", role: "DEV" as const, allowWrite: true };
const sys = (writePackages?: string[]) => ({ id: "DEV", writePackages }) as any;

describe("writePackages", () => {
  it("sin lista permite todo y una lista vacía no permite nada", () => {
    expect(packageAllowed({}, "ZDEMO")).toBe(true);
    expect(packageAllowed({}, undefined)).toBe(true);
    expect(packageAllowed({ writePackages: [] }, "ZDEMO")).toBe(false);
  });

  it("compara el nombre completo, sin mayúsculas, y * es el único comodín", () => {
    const s = { writePackages: ["zdemo*", "$TMP", "/DEMO/BASE"] };
    for (const ok of ["ZDEMO", "zdemo_a", "$tmp", "/demo/base"]) expect(packageAllowed(s, ok), ok).toBe(true);
    for (const no of ["XZDEMO", "$TMP2", "/DEMO/BASE2", "ZOTRO"]) expect(packageAllowed(s, no), no).toBe(false);
    expect(packageAllowed({ writePackages: ["Z.EMO"] }, "ZDEMO")).toBe(false);
  });

  it("si limita y no se conoce el paquete, no escribe", () => {
    expect(() => assertPackageAllowed(sys(["ZDEMO*"]), undefined, "ZDEMO_REP")).toThrow(/no se pudo saber el paquete/);
    expect(() => assertPackageAllowed(sys(["ZDEMO*"]), "ZOTRO", "ZDEMO_REP")).toThrow(/no permite escribir en el paquete ZOTRO/);
    expect(() => assertPackageAllowed(sys(["ZDEMO*"]), "ZDEMO_A", "ZDEMO_REP")).not.toThrow();
  });

  it("la configuración lo acepta por sistema y rechaza nombres raros", () => {
    const cfg = parseConfig({ systems: [{ ...base, id: "DEV", writePackages: ["ZDEMO*"] }] } as any);
    expect(cfg.systems[0].writePackages).toEqual(["ZDEMO*"]);
    expect(() => parseConfig({ systems: [{ ...base, id: "DEV", writePackages: ["Z DEMO"] }] } as any)).toThrow();
  });
});

describe("change_package con writePackages", () => {
  const def = changePackage as ToolDef<any>;
  const c = { searchObject: async () => [{ "adtcore:name": "ZDEMO_REP", "adtcore:type": "PROG/P", "adtcore:uri": "/sap/bc/adt/programs/programs/zdemo_rep", "adtcore:packageName": "ZDEMO_A" }] };
  const sap = {
    adt: async () => c,
    query: async (sql: string) => {
      if (/FROM tadir/.test(sql)) return { values: [{ DEVCLASS: "ZDEMO_A", SRCSYSTEM: "DEV" }] };
      if (/FROM tdevc/.test(sql)) return { values: [{ DEVCLASS: "ZOTRO", KORRFLAG: "X" }] };
      return { values: [] };
    },
  };
  const args = { object_name: "ZDEMO_REP", object_type: "PROG", package: "ZOTRO", transport: "DEVK900123" };

  it("rechaza mover a un paquete fuera de la lista, en vista previa y al ejecutar", async () => {
    const ctx = { sap, system: { id: "DEV", user: "DEV_ME", writePackages: ["ZDEMO*"] } } as any;
    await expect(def.preview!(args, ctx)).rejects.toThrow(/no permite escribir en el paquete ZOTRO/);
    await expect(def.run(args, ctx)).rejects.toThrow(/no permite escribir en el paquete ZOTRO/);
  });
});

describe("dumps con detail", () => {
  const def = dumps as ToolDef<any>;
  const html = (date: string, text: string) => `<td><b>Date/Time&nbsp;</b></td><td class="x">${date} (System)</td><td><b>Short Text&nbsp;</b></td><td class="x">${text}</td>`;
  const dump = {
    text: html("04.11.2026 10:00:00", "Texto breve"),
    author: "USER_A",
    categories: [{ label: "ABAP runtime error", term: "DEMO_ERROR" }, { label: "Terminated ABAP program", term: "ZDEMO_REP" }],
    links: [{ rel: "self", href: "adt://DEV/sap/bc/adt/runtime/dump/1" }],
  };
  const c = {
    dumps: async () => ({ dumps: [dump] }),
    httpClient: { request: async () => ({ body: "<p>Caller IP 192.0.2.1</p><p>Active Calls</p>" }) },
  };
  const ctx = { sap: { adt: async () => c }, system: { id: "DEV", user: "DEV_ME" } } as any;

  it("lleva el dump completo también en la salida estructurada", async () => {
    const r: any = await def.run({ detail: 1, max: 20, days: 7 }, ctx);
    expect(r.structured.text).toContain("Caller IP 192.0.2.1");
    expect(r.structured.text).toBe(r.text);
  });

  it("lee la cabecera también con el formato de 7.50, sin &nbsp;", async () => {
    const plano = { ...dump, text: "<tr><td><b>Date/Time</b></td><td> 04.11.2026 11:00:00 (System) </td></tr><tr><td><b>Short Text</b></td><td> Otro texto </td></tr>" };
    const x = { ...ctx, sap: { adt: async () => ({ ...c, dumps: async () => ({ dumps: [plano] }) }) } };
    const r: any = await def.run({ max: 20, days: 7 }, x);
    expect(r.structured.dumps[0]).toMatchObject({ date: "04.11.2026 11:00:00", short_text: "Otro texto" });
    expect(r.text).toContain("04.11.2026 11:00:00");
  });

  it("la lista suma fecha y texto breve", async () => {
    const r: any = await def.run({ max: 20, days: 7 }, ctx);
    expect(r.structured.dumps[0]).toMatchObject({ date: "04.11.2026 10:00:00", short_text: "Texto breve", error: "DEMO_ERROR" });
    expect(r.structured.text).toBeUndefined();
  });
});
