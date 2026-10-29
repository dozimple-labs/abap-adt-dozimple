import { describe, expect, it } from "vitest";
import type { ToolDef } from "../src/core/tool.js";
import addTask from "../src/tools/core/add_transport_task.js";
import release from "../src/tools/core/release_transport.js";
import { lockKeyHas } from "../src/core/transportrelease.js";

const rel = release as ToolDef<any>;
const add = addTask as ToolDef<any>;

interface Row { TRKORR: string; TRFUNCTION: string; TRSTATUS: string; TARSYSTEM: string; AS4USER: string; AS4DATE: string; STRKORR: string }
const row = (trkorr: string, o: Partial<Row> = {}): Row => ({ TRKORR: trkorr, TRFUNCTION: "K", TRSTATUS: "D", TARSYSTEM: "QAS", AS4USER: "DEV_ME", AS4DATE: "20261029", STRKORR: "", ...o });

/** Doble de SAP: E070/E07T/E071/TLOCK en memoria; registra las llamadas ADT. */
function setup(rows: Row[], e071: Record<string, Array<{ PGMID: string; OBJECT: string; OBJ_NAME: string }>> = {}, tlock: Array<{ OBJECT: string; LOKEY: string; TRKORR: string }> = []) {
  const calls: string[] = [];
  const inList = (sql: string) => [...sql.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const sap = {
    query: async (sql: string) => {
      if (/FROM e07t/.test(sql)) return { values: inList(sql).map((t) => ({ TRKORR: t, AS4TEXT: "TICKET-1 - prueba" })) };
      if (/FROM e070 WHERE strkorr/.test(sql)) {
        const p = inList(sql)[0];
        return { values: rows.filter((r) => r.STRKORR === p) };
      }
      if (/FROM e070/.test(sql)) {
        const ids = inList(sql);
        return { values: rows.filter((r) => ids.includes(r.TRKORR)) };
      }
      if (/FROM e071/.test(sql)) return { values: inList(sql).flatMap((t) => e071[t] ?? []) };
      if (/FROM tlock/.test(sql)) {
        const names = inList(sql).filter((x) => x !== "#").map((x) => x.replace(/[%#]/g, ""));
        return { values: tlock.filter((l) => names.some((n) => l.LOKEY.includes(n))) };
      }
      return { values: [] };
    },
    adt: async () => ({
      transportRelease: async (tr: string) => {
        calls.push("release " + tr);
        const r = rows.find((x) => x.TRKORR === tr)!;
        r.TRSTATUS = "R";
        return [{ "chkrun:status": "released", "chkrun:statusText": "", messages: [] }];
      },
      transportAddUser: async (tr: string, user: string) => {
        calls.push(`add ${tr} ${user}`);
        rows.push(row("DEVK900099", { STRKORR: tr, AS4USER: user, TRFUNCTION: "S" }));
        return { "tm:number": tr, "tm:targetuser": user };
      },
    }),
  };
  const ctx = { sap, system: { id: "DEV", user: "DEV_ME" } } as any;
  return { calls, ctx, rows };
}

const OBJ = { PGMID: "R3TR", OBJECT: "PROG", OBJ_NAME: "ZDEMO_REP" };

describe("release_transport", () => {
  it("libera una tarea propia: la vista previa no toca SAP y dice que la orden sigue abierta", async () => {
    const s = setup([row("DEVK900001"), row("DEVK900002", { STRKORR: "DEVK900001", TRFUNCTION: "S" })], { DEVK900002: [OBJ] });
    const p: any = await rel.preview!({ transport: "devk900002" }, s.ctx);
    expect(p).toMatch(/Se liberará la tarea DEVK900002/);
    expect(p).toMatch(/la orden DEVK900001 sigue abierta/);
    expect(s.calls).toEqual([]);
    const r: any = await rel.run({ transport: "DEVK900002" }, s.ctx);
    expect(s.calls).toEqual(["release DEVK900002"]);
    expect(r).toMatch(/DEVK900002 liberada\. Estado en E070: liberada/);
  });

  it("una orden con tareas abiertas no se libera, y dice de quién son", async () => {
    const s = setup([row("DEVK900001"), row("DEVK900002", { STRKORR: "DEVK900001", TRFUNCTION: "S", AS4USER: "OTRA" })]);
    await expect(rel.preview!({ transport: "DEVK900001" }, s.ctx)).rejects.toThrow(/tarea DEVK900002 de OTRA sigue sin liberar/);
  });

  it("no libera órdenes ni tareas ajenas, ni lo ya liberado", async () => {
    await expect(rel.preview!({ transport: "DEVK900001" }, setup([row("DEVK900001", { AS4USER: "OTRA" })]).ctx)).rejects.toThrow(/es de OTRA/);
    await expect(rel.preview!({ transport: "DEVK900001" }, setup([row("DEVK900001", { TRSTATUS: "R" })]).ctx)).rejects.toThrow(/ya no está modificable/);
    await expect(rel.preview!({ transport: "DEVK900009" }, setup([]).ctx)).rejects.toThrow(/no existe/);
    await expect(rel.preview!({ transport: "ZDEMO_REP" }, setup([]).ctx)).rejects.toThrow(/no parece una orden/);
  });

  it("R15: un transporte de copias con un objeto bloqueado por otra orden no se libera", async () => {
    const s = setup(
      [row("DEVK900005", { TRFUNCTION: "T" }), row("DEVK900007", { AS4USER: "OTRA" }), row("DEVK900008", { STRKORR: "DEVK900007", TRFUNCTION: "S", AS4USER: "OTRA" })],
      { DEVK900005: [OBJ] },
      [{ OBJECT: "PROG", LOKEY: "ZDEMO_REP", TRKORR: "DEVK900008" }],
    );
    await expect(rel.preview!({ transport: "DEVK900005" }, s.ctx)).rejects.toThrow(/PROG ZDEMO_REP: el bloqueo del CTS lo tiene DEVK900007.*incluidos los cambios sin liberar/s);
  });

  it("R15 con entradas LIMU: el módulo de función va dentro de la clave del grupo", async () => {
    const s = setup(
      [row("DEVK900005", { TRFUNCTION: "T" }), row("DEVK900007", { AS4USER: "OTRA" }), row("DEVK900008", { STRKORR: "DEVK900007", TRFUNCTION: "S", AS4USER: "OTRA" })],
      { DEVK900005: [{ PGMID: "CORR", OBJECT: "MERG", OBJ_NAME: "DEVK900004 20261027 DEV_ME" }, { PGMID: "LIMU", OBJECT: "FUNC", OBJ_NAME: "ZDEMO_FM" }, { PGMID: "LIMU", OBJECT: "REPS", OBJ_NAME: "ZDEMO_REP_F01" }] },
      [
        { OBJECT: "FUGR", LOKEY: "ZDEMO_FG                  FUNCZDEMO_FM          ", TRKORR: "DEVK900008" },
        { OBJECT: "PROG", LOKEY: "ZDEMO_REP_F01                        REPOREPS", TRKORR: "DEVK900008" },
      ],
    );
    const e = await rel.preview!({ transport: "DEVK900005" }, s.ctx).catch((x) => x);
    expect(e.message).toMatch(/FUNC ZDEMO_FM: el bloqueo del CTS lo tiene DEVK900007/);
    expect(e.message).toMatch(/REPS ZDEMO_REP_F01: el bloqueo del CTS lo tiene DEVK900007/);
  });

  it("si el bloqueo lo tiene una orden propia, se libera con aviso de qué estado viaja", async () => {
    const s = setup(
      [row("DEVK900005", { TRFUNCTION: "T" }), row("DEVK900007"), row("DEVK900008", { STRKORR: "DEVK900007", TRFUNCTION: "S" })],
      { DEVK900005: [OBJ] },
      [{ OBJECT: "PROG", LOKEY: "ZDEMO_REP", TRKORR: "DEVK900008" }],
    );
    const p: any = await rel.preview!({ transport: "DEVK900005" }, s.ctx);
    expect(p).toMatch(/1 objeto\(s\) los tiene bloqueados tu orden DEVK900007 \(PROG ZDEMO_REP\): viaja su estado actual/);
  });

  it("la clave de bloqueo se compara por trozos, no por subcadena", () => {
    expect(lockKeyHas("ZDEMO_FG   FUNCZDEMO_FM   ", "ZDEMO_FM")).toBe(true);
    expect(lockKeyHas("ZDEMO_FG   PROGLZDEMO_FGF02   REPOREPS", "LZDEMO_FGF02")).toBe(true);
    expect(lockKeyHas("ZDEMO_TAB_E", "ZDEMO_TAB")).toBe(false);
    expect(lockKeyHas("ZDEMO_FG   FUNCZDEMO_FM_2", "ZDEMO_FM")).toBe(false);
  });

  it("transporte de copias limpio: dice a qué cola va y que no se importa nada", async () => {
    const s = setup([row("DEVK900005", { TRFUNCTION: "T" })], { DEVK900005: [OBJ] });
    const p: any = await rel.preview!({ transport: "DEVK900005" }, s.ctx);
    expect(p).toMatch(/transporte de copias\) se exporta y queda en la cola de QAS/);
    expect(p).toMatch(/Basis en STMS/);
    const r: any = await rel.run({ transport: "DEVK900005" }, s.ctx);
    expect(r).toMatch(/Queda en la cola de QAS/);
  });

  it("si entre la vista previa y el OK aparece un bloqueante, no se libera", async () => {
    const s = setup([row("DEVK900001")], { DEVK900001: [OBJ] });
    await rel.preview!({ transport: "DEVK900001" }, s.ctx);
    s.rows.push(row("DEVK900003", { STRKORR: "DEVK900001", TRFUNCTION: "S" }));
    await expect(rel.run({ transport: "DEVK900001" }, s.ctx)).rejects.toThrow(/Ya no se puede liberar/);
    expect(s.calls).toEqual([]);
  });
});

describe("add_transport_task", () => {
  it("añade la tarea y devuelve su número leído de E070", async () => {
    const s = setup([row("DEVK900001", { AS4USER: "OTRA" })]);
    const p: any = await add.preview!({ transport: "DEVK900001" }, s.ctx);
    expect(p).toMatch(/Se añadirá una tarea para DEV_ME/);
    expect(s.calls).toEqual([]);
    const r: any = await add.run({ transport: "DEVK900001" }, s.ctx);
    expect(s.calls).toEqual(["add DEVK900001 DEV_ME"]);
    expect(r).toMatch(/Tarea DEVK900099 añadida para DEV_ME en DEVK900001/);
  });

  it("no duplica una tarea abierta, ni añade a una tarea o a una orden liberada", async () => {
    await expect(add.preview!({ transport: "DEVK900001" }, setup([row("DEVK900001"), row("DEVK900002", { STRKORR: "DEVK900001", TRFUNCTION: "S" })]).ctx)).rejects.toThrow(/ya tiene la tarea abierta DEVK900002/);
    await expect(add.preview!({ transport: "DEVK900002" }, setup([row("DEVK900002", { STRKORR: "DEVK900001" })]).ctx)).rejects.toThrow(/es una tarea de DEVK900001/);
    await expect(add.preview!({ transport: "DEVK900001" }, setup([row("DEVK900001", { TRSTATUS: "R" })]).ctx)).rejects.toThrow(/no está modificable/);
    await expect(add.preview!({ transport: "DEVK900005" }, setup([row("DEVK900005", { TRFUNCTION: "T" })]).ctx)).rejects.toThrow(/transporte de copias: no lleva tareas/);
  });
});
