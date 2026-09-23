import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Caché de run_atc sobre objetos: la tool más lenta del servidor (10 s de media) se repetía sobre el mismo objeto
 * sin cambios. Se reutiliza el resultado si el objeto conserva su marca `changedAt`, la variante es la misma, la
 * petición no es más amplia y no pasó una hora. Las órdenes nunca se reutilizan.
 */
const runs: string[] = [];
vi.mock("../src/core/atc.js", async (orig) => {
  const real = await orig<typeof import("../src/core/atc.js")>();
  return {
    ...real,
    defaultVariant: async () => "DEMO_VARIANT",
    runAtc: async (_c: unknown, uri: string | string[], variant: string) => {
      const name = (Array.isArray(uri) ? uri[0] : uri).split("/").pop()!.toUpperCase();
      runs.push(name);
      return {
        variant,
        scope: String(uri),
        at: new Date().toISOString(),
        findings: [{ n: 1, objectName: name, objectType: "PROG/P", objectUri: String(uri), sourceUri: String(uri), line: 1, column: 0,
          priority: 2, checkTitle: "Check", messageTitle: `Hallazgo de ${name}`, exempted: false }],
      };
    },
  };
});

const { default: runAtcTool } = await import("../src/tools/core/run_atc.js");
const { ATC_CACHE_TTL_MS } = await import("../src/core/atc.js");

/** Cliente ADT falso con marca de cambio controlable por objeto. */
function fakeClient(changedAt: Record<string, number | "error">) {
  return {
    searchObject: async (name: string) => [
      { "adtcore:name": name, "adtcore:type": "PROG/P", "adtcore:uri": `/sap/bc/adt/programs/programs/${name.toLowerCase()}`, "adtcore:packageName": "$TMP" },
    ],
    objectStructure: async (uri: string) => {
      const v = changedAt[uri.split("/").pop()!.toUpperCase()];
      if (v === "error") throw new Error("objectStructure no disponible para este tipo");
      return { metaData: { "adtcore:changedAt": v } };
    },
  };
}
let n = 0;
const ctx = (c: unknown) => ({ sap: { adt: async () => c, query: async () => ({ values: [] }) }, system: { id: `DEMO_${++n}` } }) as any;
const base = { max_findings: 200, include_exempted: false, refresh: false };

describe("run_atc reutiliza el resultado de un objeto sin cambios", () => {
  beforeEach(() => (runs.length = 0));
  afterEach(() => vi.useRealTimers());

  it("la segunda llamada sobre el mismo objeto no ejecuta el ATC y lo dice", async () => {
    const x = ctx(fakeClient({ ZDEMO_A: 1000 }));
    const first = String(await runAtcTool.run({ object_name: "ZDEMO_A", ...base }, x));
    const second = String(await runAtcTool.run({ object_name: "ZDEMO_A", ...base }, x));
    expect(first).toMatch(/ejecutado ahora/);
    expect(second).toMatch(/resultado de hace menos de 1 min, objeto sin cambios/);
    expect(second).toMatch(/refresh=true/);
    expect(runs).toEqual(["ZDEMO_A"]);
  });

  it("si el objeto cambió (otra marca changedAt) vuelve a ejecutar", async () => {
    const marks: Record<string, number> = { ZDEMO_A: 1000 };
    const x = ctx(fakeClient(marks));
    await runAtcTool.run({ object_name: "ZDEMO_A", ...base }, x);
    marks.ZDEMO_A = 2000; // alguien guardó el objeto
    const out = String(await runAtcTool.run({ object_name: "ZDEMO_A", ...base }, x));
    expect(out).toMatch(/ejecutado ahora/);
    expect(runs).toEqual(["ZDEMO_A", "ZDEMO_A"]);
  });

  it("refresh=true ejecuta aunque nada haya cambiado", async () => {
    const x = ctx(fakeClient({ ZDEMO_A: 1000 }));
    await runAtcTool.run({ object_name: "ZDEMO_A", ...base }, x);
    await runAtcTool.run({ object_name: "ZDEMO_A", ...base, refresh: true }, x);
    expect(runs).toEqual(["ZDEMO_A", "ZDEMO_A"]);
  });

  it("otra variante, más hallazgos pedidos o incluir exentos: no vale el resultado anterior", async () => {
    const x = ctx(fakeClient({ ZDEMO_A: 1000 }));
    await runAtcTool.run({ object_name: "ZDEMO_A", ...base }, x);
    await runAtcTool.run({ object_name: "ZDEMO_A", ...base, variant: "OTRA" }, x);
    await runAtcTool.run({ object_name: "ZDEMO_A", ...base, max_findings: 500 }, x);
    await runAtcTool.run({ object_name: "ZDEMO_A", ...base, include_exempted: true }, x);
    expect(runs).toHaveLength(4);
    // Una petición MÁS ESTRECHA sí se sirve del resultado amplio.
    await runAtcTool.run({ object_name: "ZDEMO_A", ...base, include_exempted: true, max_findings: 50 }, x);
    expect(runs).toHaveLength(4);
  });

  it("pasada una hora se ejecuta de nuevo aunque el objeto no haya cambiado", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T10:00:00Z"));
    const x = ctx(fakeClient({ ZDEMO_A: 1000 }));
    await runAtcTool.run({ object_name: "ZDEMO_A", ...base }, x);
    vi.setSystemTime(new Date(Date.now() + ATC_CACHE_TTL_MS - 1000));
    await runAtcTool.run({ object_name: "ZDEMO_A", ...base }, x);
    expect(runs).toEqual(["ZDEMO_A"]);
    vi.setSystemTime(new Date(Date.now() + 2000));
    await runAtcTool.run({ object_name: "ZDEMO_A", ...base }, x);
    expect(runs).toEqual(["ZDEMO_A", "ZDEMO_A"]);
  });

  it("sin marca de cambio (el tipo no la expone) no hay caché: siempre ejecuta", async () => {
    const x = ctx(fakeClient({ ZDEMO_A: "error" }));
    await runAtcTool.run({ object_name: "ZDEMO_A", ...base }, x);
    await runAtcTool.run({ object_name: "ZDEMO_A", ...base }, x);
    expect(runs).toEqual(["ZDEMO_A", "ZDEMO_A"]);
  });

  it("dos objetos distintos no se confunden entre sí", async () => {
    const x = ctx(fakeClient({ ZDEMO_A: 1000, ZDEMO_B: 1000 }));
    await runAtcTool.run({ object_name: "ZDEMO_A", ...base }, x);
    const b = String(await runAtcTool.run({ object_name: "ZDEMO_B", ...base }, x));
    expect(b).toMatch(/ejecutado ahora/);
    expect(b).toMatch(/Hallazgo de ZDEMO_B/);
    expect(runs).toEqual(["ZDEMO_A", "ZDEMO_B"]);
  });

  it("una orden de transporte nunca se sirve de la caché", async () => {
    const c = { ...fakeClient({}), objectStructure: async () => ({ metaData: { "adtcore:changedAt": 1 } }) };
    const x = ctx(c);
    await runAtcTool.run({ transport: "DEVK900123", ...base }, x);
    await runAtcTool.run({ transport: "DEVK900123", ...base }, x);
    expect(runs).toHaveLength(2);
  });

  it("explain=N sigue usando el resultado recordado sin ejecutar", async () => {
    const c = { ...fakeClient({ ZDEMO_A: 1000 }), atcDocumentation: async () => ({ body: "<p>doc</p>" }) };
    const x = ctx(c);
    await runAtcTool.run({ object_name: "ZDEMO_A", ...base }, x);
    const out = String(await runAtcTool.run({ object_name: "ZDEMO_A", ...base, explain: 1 }, x));
    expect(out).toMatch(/hace menos de 1 min/);
    expect(runs).toEqual(["ZDEMO_A"]);
  });
});
