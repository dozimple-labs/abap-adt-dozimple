import { describe, expect, it } from "vitest";
import { z } from "zod";
import { rememberRun } from "../src/core/atc.js";
import type { ToolDef } from "../src/core/tool.js";
import objectContext from "../src/tools/core/object_context.js";

const def = objectContext as ToolDef<any>;
const Output = z.object(def.output!);

function setup(o: { usagesFail?: boolean; locked?: boolean; targets?: string[]; modules?: string[] } = {}) {
  const calls: string[] = [];
  const c = {
    searchObject: async () => [{ "adtcore:name": "ZDEMO", "adtcore:type": "PROG/P", "adtcore:uri": "/sap/bc/adt/programs/programs/zdemo", "adtcore:packageName": "ZPKG", "adtcore:description": "Demo" }],
    objectStructure: async () => { throw new Error("sin estructura"); },
    getObjectSource: async () => "REPORT zdemo.\nWRITE 1.\n",
    revisions: async () => { calls.push("revisions"); return [{ uri: "/v/00001", date: "2026-10-01", author: "DEMO_USER", version: "DEVK900123", versionTitle: "cambio" }, { uri: "/v/00002", date: "2026-09-01", author: "OTRA", version: "DEVK900100", versionTitle: "" }]; },
    usageReferences: async () => {
      calls.push("usages");
      if (o.usagesFail) throw new Error("índice no disponible");
      return [{ isResult: true, "adtcore:name": "ZCALLER", "adtcore:type": "PROG/P", packageRef: { "adtcore:name": "ZPKG" } }, { isResult: false }];
    },
  };
  const sap = {
    adt: async () => c,
    query: async (sql: string) => {
      if (/FROM tadir/.test(sql)) return { values: [{ DEVCLASS: "ZPKG", SRCSYSTEM: "DEV", AUTHOR: "DEMO_USER" }] };
      if (/FROM tlock/.test(sql)) return { values: o.locked ? [{ OBJECT: "R3TR PROG", LOKEY: "ZDEMO", TRKORR: "DEVK900124" }] : [] };
      if (/FROM e070/.test(sql)) return { values: [{ TRKORR: "DEVK900124", TRFUNCTION: "S", TRSTATUS: "D", TARSYSTEM: "", AS4USER: "OTRA", AS4DATE: "20261001", STRKORR: "DEVK900123" }, { TRKORR: "DEVK900123", TRFUNCTION: "K", TRSTATUS: "D", TARSYSTEM: "QAS", AS4USER: "OTRA", AS4DATE: "20261001", STRKORR: "" }].filter((r) => sql.includes(r.TRKORR)) };
      if (/FROM e07t/.test(sql)) return { values: [{ TRKORR: "DEVK900123", AS4TEXT: "Orden ajena" }] };
      return { values: [] };
    },
  };
  const ctx = { sap, system: { id: "DEV", sid: "DEV", user: "DEMO_USER", targets: o.targets ?? [], modules: o.modules ?? [] } } as any;
  return { ctx, calls };
}

describe("object_context", () => {
  it("depth 1: identidad, bloqueo, fuente, versiones y usos, con salida estructurada válida", async () => {
    const { ctx } = setup({ locked: true });
    const r: any = await def.run({ object_name: "zdemo", depth: 1, max_usages: 10 }, ctx);
    const s = Output.parse(r.structured);
    expect(s).toMatchObject({ name: "ZDEMO", type: "PROG/P", package: "ZPKG", responsible: "DEMO_USER", original_system: "DEV", local: false, depth: 1 });
    expect(s.locks).toEqual([{ order: "DEVK900123", description: expect.stringMatching(/DEVK900123 «Orden ajena».*TLOCK R3TR PROG ZDEMO/) }]);
    expect(s.source).toEqual({ lines: 3, includes: [] });
    expect(s.versions).toHaveLength(2);
    expect(s.versions[0]).toMatchObject({ transport: "DEVK900123", author: "DEMO_USER" });
    expect(s.usages).toEqual({ total: 1, shown: [{ name: "ZCALLER", type: "PROG/P", package: "ZPKG" }] });
    expect(s.drift).toBeNull();
    expect(s.atc).toBeNull();
    expect(s.skipped).toEqual([]);
    expect(r.text).toMatch(/BLOQUEADO en DEVK900123/);
    expect(r.text).toMatch(/Usos: 1/);
  });

  it("depth 0 no consulta versiones ni usos", async () => {
    const { ctx, calls } = setup();
    const r: any = await def.run({ object_name: "ZDEMO", depth: 0, max_usages: 10 }, ctx);
    expect(calls).toEqual([]);
    expect(r.structured.usages).toBeNull();
    expect(r.structured.versions).toEqual([]);
    expect(r.text).toMatch(/Sin bloqueo del CTS/);
  });

  it("una sección que falla se cuenta en skipped y el resto se entrega", async () => {
    const { ctx } = setup({ usagesFail: true });
    const r: any = await def.run({ object_name: "ZDEMO", depth: 1, max_usages: 10 }, ctx);
    expect(r.structured.usages).toBeNull();
    expect(r.structured.versions).toHaveLength(2);
    expect(r.structured.skipped).toEqual([expect.stringMatching(/^usos: .*índice no disponible/)]);
    expect(r.text).toMatch(/No se pudo leer:\n  • usos/);
  });

  it("depth 2: explica por qué no hay deriva y recuerda el último ATC del objeto", async () => {
    const { ctx } = setup({ targets: ["QAS"] });
    rememberRun("DEV", "OBJ:ZDEMO", { variant: "DEFAULT", scope: "x", at: new Date().toISOString(), stats: { p1: 1, p2: 2, p3: 3 }, findings: [{} as any] });
    const r: any = await def.run({ object_name: "ZDEMO", depth: 2, max_usages: 10 }, ctx);
    const s = Output.parse(r.structured);
    expect(s.atc).toMatchObject({ variant: "DEFAULT", p1: 1, p2: 2, p3: 3, findings: 1 });
    expect(s.drift).toBeNull();
    expect(s.skipped).toEqual([expect.stringMatching(/^deriva: .*módulo/)]);
  });
});
