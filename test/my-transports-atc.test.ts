import { z } from "zod";
import { AdtErrorException } from "abap-adt-api";
import { describe, expect, it } from "vitest";
import { ATC_MAX_VERDICTS, runAtc } from "../src/core/atc.js";
import { isSessionExpired } from "../src/core/errors.js";
import myTransports from "../src/tools/core/my_transports.js";
import type { ToolDef } from "../src/core/tool.js";

/** Tres mejoras sacadas de revisar el ABAP Accelerator de AWS (MIT-0). Datos ficticios. */

describe("my_transports", () => {
  const def = myTransports as ToolDef<any>;
  const out = z.object(def.output!);
  const E070 = [
    { TRKORR: "DEVK900100", TRFUNCTION: "K", TRSTATUS: "D", TARSYSTEM: "QAS", AS4USER: "DEV_ME", AS4DATE: "20260920", STRKORR: "" },
    { TRKORR: "DEVK900101", TRFUNCTION: "S", TRSTATUS: "D", TARSYSTEM: "", AS4USER: "DEV_ME", AS4DATE: "20260920", STRKORR: "DEVK900100" },
    { TRKORR: "DEVK900200", TRFUNCTION: "K", TRSTATUS: "D", TARSYSTEM: "", AS4USER: "DEV_OTHER", AS4DATE: "20260925", STRKORR: "" },
    { TRKORR: "DEVK900201", TRFUNCTION: "S", TRSTATUS: "D", TARSYSTEM: "", AS4USER: "DEV_ME", AS4DATE: "20260925", STRKORR: "DEVK900200" },
  ];
  const E071 = [
    { TRKORR: "DEVK900101", PGMID: "R3TR", OBJECT: "PROG", OBJ_NAME: "ZDEMO_A" },
    { TRKORR: "DEVK900101", PGMID: "LIMU", OBJECT: "REPS", OBJ_NAME: "ZDEMO_A_F01" },
    { TRKORR: "DEVK900101", PGMID: "CORR", OBJECT: "RELE", OBJ_NAME: "DEVK900101" },
  ];
  const lits = (sql: string, col: string) => [...(new RegExp(`${col} IN \\( ([^)]*) \\)`).exec(sql)?.[1] ?? "").matchAll(/'([^']*)'/g)].map((m) => m[1]);
  const ctx = (cls: "test" | "prod" = "test") => ({
    system: { id: "DEV", role: cls === "test" ? "DEV" : "PRD", dataClass: cls, user: "DEV_ME" },
    sap: {
      query: async (sql: string) => {
        if (/FROM e071/.test(sql)) return { values: E071.filter((e) => lits(sql, "trkorr").includes(e.TRKORR)) };
        if (/FROM e07t/.test(sql)) return { values: lits(sql, "trkorr").map((t) => ({ TRKORR: t, AS4TEXT: `Texto ${t}` })) };
        if (/WHERE strkorr IN/.test(sql)) return { values: E070.filter((e) => lits(sql, "strkorr").includes(e.STRKORR)) };
        if (/WHERE trkorr IN/.test(sql)) return { values: E070.filter((e) => lits(sql, "trkorr").includes(e.TRKORR)) };
        const user = /as4user = '([^']*)'/.exec(sql)?.[1];
        if (/strkorr = ' '/.test(sql)) return { values: E070.filter((e) => e.AS4USER === user && !e.STRKORR) };
        if (/strkorr <> ' '/.test(sql)) return { values: E070.filter((e) => e.AS4USER === user && e.STRKORR) };
        return { values: [] };
      },
    },
  }) as any;
  const base = { status: "open", objects_per_task: 10, max: 30 };

  it("reúne las órdenes propias y las ajenas donde hay una tarea propia, con tareas y objetos", async () => {
    const r: any = await def.run(base, ctx());
    const s = out.parse(r.structured);
    expect(s.orders.map((o) => o.order)).toEqual(["DEVK900200", "DEVK900100"]); // más reciente primero
    const mine = s.orders.find((o) => o.order === "DEVK900100")!;
    expect(mine.tasks).toEqual([{ task: "DEVK900101", owner: "DEV_ME", status: "modificable", objects: 2, sample: ["PROG ZDEMO_A", "REPS ZDEMO_A_F01"] }]);
    expect(mine.warnings).toEqual([]);
  });

  it("avisa de una orden sin destino y de la tarea propia dentro de una orden ajena", async () => {
    const r: any = await def.run(base, ctx());
    const other = r.structured.orders.find((o: any) => o.order === "DEVK900200");
    expect(other.warnings).toEqual(["sin sistema destino: lo que se guarde en ella no viaja", "la orden es de otra persona (DEV_OTHER); aquí solo está tu tarea"]);
    expect(r.text).toMatch(/DEVK900200 .* SIN DESTINO/);
  });

  it("sin órdenes lo dice, nunca vacío", async () => {
    const r: any = await def.run({ ...base, user: "NOBODY" }, ctx());
    expect(r.text).toMatch(/NOBODY no tiene órdenes abiertas en DEV \(se consultó E070\)/);
  });

  it("con datos productivos solo el usuario de la conexión, y los demás nombres ocultos", async () => {
    await expect(def.run({ ...base, user: "DEV_OTHER" }, ctx("prod"))).rejects.toMatchObject({ kind: "POLICY" });
    const r: any = await def.run(base, ctx("prod"));
    expect(JSON.stringify(r.structured)).not.toMatch(/DEV_OTHER/);
    expect(r.text).toMatch(/‹otro usuario›/);
  });
});

describe("run_atc nunca pierde P1/P2 por el tope de SAP", () => {
  const finding = (p: number) => ({ priority: p, checkTitle: "c", messageTitle: "m", location: { uri: "/x", range: { start: { line: 1, column: 0 } } }, link: undefined, exemptionKind: "" });
  function client(total: { p1: number; p2: number; p3: number }) {
    const calls: number[] = [];
    // SAP devuelve los primeros N veredictos SIN ordenar por prioridad: aquí, los P3 primero.
    const all = [...Array(total.p3).fill(3), ...Array(total.p2).fill(2), ...Array(total.p1).fill(1)];
    let last = 0;
    return {
      calls,
      c: {
        atcCheckVariant: async () => "WL",
        createAtcRun: async (_w: string, _u: string, max: number) => {
          calls.push(max);
          last = max;
          return { id: "R", timestamp: 1, infos: [{ type: "FINDING_STATS", description: `${total.p1},${total.p2},${total.p3}` }] };
        },
        atcWorklists: async () => ({ objects: [{ name: "ZDEMO", type: "PROG/P", uri: "/x", findings: all.slice(0, last).map(finding) }] }),
      } as any,
    };
  }

  it("si el tope deja fuera P1/P2, repite pidiendo todos", async () => {
    const { c, calls } = client({ p1: 2, p2: 3, p3: 300 });
    const r = await runAtc(c, "/x", "V", 200, false);
    expect(calls).toEqual([200, 305]);
    expect(r.findings.filter((f) => f.priority === 1)).toHaveLength(2);
    expect(r.findings.filter((f) => f.priority === 2)).toHaveLength(3);
  });

  it("si ya llegaron todos los P1/P2, no repite", async () => {
    const { calls, c } = client({ p1: 1, p2: 1, p3: 10 });
    await runAtc(c, "/x", "V", 200, false);
    expect(calls).toEqual([200]);
  });

  it("la repetición respeta el tope absoluto", async () => {
    const { calls, c } = client({ p1: 3, p2: 0, p3: 9000 });
    await runAtc(c, "/x", "V", 200, false);
    expect(calls).toEqual([200, ATC_MAX_VERDICTS]);
  });
});

describe("sesión caducada también con 400 «Logon Error»", () => {
  it("un 400 con Logon Error renueva; un 400 cualquiera no", () => {
    expect(isSessionExpired(AdtErrorException.create(400, {}, "", "Logon Error"))).toBe(true);
    expect(isSessionExpired(AdtErrorException.create(400, {}, "", "Invalid parameter"))).toBe(false);
  });
});

describe("revisión 1.3.0", () => {
  it("«Session Timed Out» también es sesión caducada", () => {
    expect(isSessionExpired(AdtErrorException.create(400, {}, "", "Session Timed Out"))).toBe(true);
  });

  it("run_atc: con P1 exentos no repite la corrida y no los muestra si no se piden", async () => {
    const calls: number[] = [];
    const flags: boolean[] = [];
    const c = {
      atcCheckVariant: async () => "WL",
      createAtcRun: async (_w: string, _u: string, max: number) => (calls.push(max), { id: "R", timestamp: 1, infos: [{ type: "FINDING_STATS", description: "1,0,1" }] }),
      atcWorklists: async (_i: string, _t: number, _l: string, withExempted: boolean) => (flags.push(withExempted), {
        objects: [{ name: "ZDEMO", type: "PROG/P", uri: "/x", findings: [
          { priority: 1, checkTitle: "c", messageTitle: "exento", location: { uri: "/x", range: { start: { line: 1, column: 0 } } }, exemptionKind: "X" },
          { priority: 3, checkTitle: "c", messageTitle: "info", location: { uri: "/x", range: { start: { line: 2, column: 0 } } }, exemptionKind: "" },
        ] }],
      }),
    } as any;
    const r = await runAtc(c, "/x", "V", 200, false);
    expect(calls).toEqual([200]); // antes: el P1 exento no contaba y la corrida se repetía
    expect(flags).toEqual([true]); // la lista se pide siempre con exentos y se filtra aquí
    expect(r.findings.map((f) => f.messageTitle)).toEqual(["info"]);
    expect(r.received).toBe(2);
    const withExempted = await runAtc(c, "/x", "V", 200, true);
    expect(withExempted.findings).toHaveLength(2);
  });

  it("my_transports: si una consulta llega a su tope, lo dice y marca el resultado como incompleto", async () => {
    const def = myTransports as ToolDef<any>;
    const sap = {
      query: async (sql: string, rows: number) => {
        if (/strkorr = ' '/.test(sql)) return { values: Array.from({ length: rows }, (_, i) => ({ TRKORR: `DEVK9${String(i).padStart(5, "0")}` })) };
        if (/WHERE trkorr IN/.test(sql)) {
          const ids = [...sql.matchAll(/'(DEVK\d+)'/g)].map((m) => m[1]);
          return { values: ids.map((t) => ({ TRKORR: t, TRFUNCTION: "K", TRSTATUS: "D", TARSYSTEM: "QAS", AS4USER: "DEV_ME", AS4DATE: "20260920", STRKORR: "" })) };
        }
        return { values: [] };
      },
    };
    const r: any = await def.run({ status: "all", objects_per_task: 0, max: 5 }, { sap, system: { id: "DEV", role: "DEV", user: "DEV_ME" } } as any);
    expect(r.structured.incomplete).toEqual(["más de 500 órdenes propias"]);
    expect(r.structured.truncated).toBe(true);
    expect(r.text).toMatch(/RESULTADO INCOMPLETO \(más de 500 órdenes propias\): los totales son un mínimo/);
  });
});
