import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUDIT_FILE, type AuditEntry } from "../src/core/audit.js";
import { parseConfig } from "../src/core/config.js";
import { CONFIRM_TTL_MS, consumeTokenWithState, issueToken, stateOf } from "../src/core/confirm.js";
import { invoke } from "../src/core/registry.js";
import type { ToolDef } from "../src/core/tool.js";
import pushSources from "../src/tools/core/push_sources.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "abapdz-c21-"));
  process.env.ABAP_DZ_STATE_DIR = dir;
  vi.useRealTimers();
});
const base = { url: "https://sap.example:44300", client: "100", user: "DEMO_USER" };
const cfgOf = (confirmMinutes?: number) => parseConfig({ systems: [{ ...base, id: "DEV", role: "DEV", allowWrite: true }], tools: confirmMinutes ? { confirmMinutes } : {} });
const pool = { get: (s: any) => ({ system: s, missingCapabilities: async () => [], adt: async () => ({}), noteNetworkFailure() {}, resetReader() {} }) } as any;

describe("caducidad configurable", () => {
  it("por defecto 20 minutos; tope 60", () => {
    expect(CONFIRM_TTL_MS).toBe(20 * 60_000);
    expect(cfgOf().tools.confirmMinutes).toBe(20);
    expect(cfgOf(45).tools.confirmMinutes).toBe(45);
    expect(() => cfgOf(61)).toThrow();
  });
  it("un token caducado recuerda si los argumentos eran los mismos y lo que se mostró", () => {
    const now = Date.now();
    const t = issueToken("write_source", "DEV", { a: 1 }, now, "h1", 5 * 60_000);
    expect(consumeTokenWithState(t, "write_source", "DEV", { a: 1 }, now + 5 * 60_000 + 1)).toEqual({ check: "expired", state: "h1", sameArgs: true });
    const t2 = issueToken("write_source", "DEV", { a: 1 }, now, "h1", 5 * 60_000);
    expect(consumeTokenWithState(t2, "write_source", "DEV", { a: 2 }, now + 5 * 60_000 + 1)).toMatchObject({ check: "expired", sameArgs: false });
  });
});

describe("renovación controlada de un token caducado", () => {
  function make(sapState: { v: string }) {
    const calls: unknown[] = [];
    const def: ToolDef<any> = {
      name: "t_write", title: "Guardar demo", description: "d", access: "write", input: {},
      preview: async (a) => ({ text: `se cambiará ${a.object_name} (versión ${sapState.v})`, state: stateOf(sapState.v) }),
      run: async (a) => (calls.push(a), `guardado ${a.object_name}`),
    };
    return { def, calls };
  }
  const entries = () => readFileSync(join(dir, AUDIT_FILE), "utf8").trim().split("\n").map((l) => JSON.parse(l) as AuditEntry);

  it("mismo cambio y objeto sin cambiar: nueva vista previa corta con token nuevo; nada se escribe sin el segundo OK", async () => {
    const cfg = cfgOf(1);
    const sap = { v: "A" };
    const { def, calls } = make(sap);
    vi.useFakeTimers({ now: new Date("2026-10-26T10:00:00Z") });
    const first = await invoke(def, { system: "DEV", object_name: "ZDEMO" }, { config: cfg, pool, tools: [] });
    const token = first.text.match(/confirm_token="([0-9a-f]+)"/)![1];
    expect(first.text).toMatch(/un solo uso, 1 minutos.*Una vista previa, un OK, una escritura/);
    vi.setSystemTime(new Date("2026-10-26T10:02:00Z"));
    const again = await invoke(def, { system: "DEV", object_name: "ZDEMO", confirm_token: token }, { config: cfg, pool, tools: [] });
    expect(again.isError).toBe(false);
    expect(again.text).toMatch(/caducó \(1 minutos\) y NO se ha escrito nada[\s\S]*MISMO cambio y el objeto no cambió en SAP[\s\S]*pedirle el OK de nuevo en una línea/);
    expect(calls).toHaveLength(0);
    const token2 = again.text.match(/confirm_token="([0-9a-f]+)"/)![1];
    expect(token2).not.toBe(token);
    expect(entries().map((e) => [e.phase, e.reason])).toEqual([["denied", "token expired"]]);
    const done = await invoke(def, { system: "DEV", object_name: "ZDEMO", confirm_token: token2 }, { config: cfg, pool, tools: [] });
    expect(done.isError).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("mismo cambio pero el objeto cambió en SAP: vista previa completa y aviso de pedir el OK", async () => {
    const cfg = cfgOf(1);
    const sap = { v: "A" };
    const { def, calls } = make(sap);
    vi.useFakeTimers({ now: new Date("2026-10-26T10:00:00Z") });
    const first = await invoke(def, { system: "DEV", object_name: "ZDEMO" }, { config: cfg, pool, tools: [] });
    const token = first.text.match(/confirm_token="([0-9a-f]+)"/)![1];
    sap.v = "B";
    vi.setSystemTime(new Date("2026-10-26T10:02:00Z"));
    const again = await invoke(def, { system: "DEV", object_name: "ZDEMO", confirm_token: token }, { config: cfg, pool, tools: [] });
    expect(again.text).toMatch(/el objeto CAMBIÓ en SAP[\s\S]*versión B/);
    expect(calls).toHaveLength(0);
  });

  it("argumentos distintos con token caducado: sigue siendo error", async () => {
    const cfg = cfgOf(1);
    const { def, calls } = make({ v: "A" });
    vi.useFakeTimers({ now: new Date("2026-10-26T10:00:00Z") });
    const first = await invoke(def, { system: "DEV", object_name: "ZDEMO" }, { config: cfg, pool, tools: [] });
    const token = first.text.match(/confirm_token="([0-9a-f]+)"/)![1];
    vi.setSystemTime(new Date("2026-10-26T10:02:00Z"));
    const r = await invoke(def, { system: "DEV", object_name: "ZOTRO", confirm_token: token }, { config: cfg, pool, tools: [] });
    expect(r).toMatchObject({ isError: true, kind: "POLICY" });
    expect(r.text).toMatch(/caducó \(dura 1 minutos\)/);
    expect(calls).toHaveLength(0);
  });
});

describe("push_sources con ediciones", () => {
  const def = pushSources as ToolDef<any>;
  const SRC: Record<string, string> = { ZA: "REPORT za.\nWRITE 1.\n", ZB: "REPORT zb.\nWRITE 2.\n" };
  function setup() {
    const written: Array<[string, string]> = [];
    const s = {
      lock: async () => ({ LOCK_HANDLE: "H", CORRNR: "", CORRUSER: "", IS_LOCAL: "X" }),
      getObjectSource: async (u: string) => SRC[u.includes("za") ? "ZA" : "ZB"],
      setObjectSource: async (u: string, src: string) => void written.push([u.includes("za") ? "ZA" : "ZB", src]),
      unLock: async () => undefined,
    };
    const c = {
      searchObject: async (name: string) => [{ "adtcore:name": name.toUpperCase(), "adtcore:type": "PROG/P", "adtcore:uri": `/sap/bc/adt/programs/programs/${name.toLowerCase()}`, "adtcore:packageName": "$TMP" }],
      objectStructure: async () => { throw new Error("sin estructura"); },
      getObjectSource: async (u: string) => SRC[u.includes("za") ? "ZA" : "ZB"],
      syntaxCheck: async () => [],
      activate: async () => ({ success: true, messages: [], inactive: [] }),
    };
    const ctx = (confirmedState?: string) => ({ sap: { adt: async () => c, stateful: async (fn: any) => fn(s), query: async () => ({ values: [] }) }, system: { id: "DEV", user: "DEV_ME" }, confirmedState }) as any;
    return { written, ctx };
  }
  const files = [
    { object_name: "ZA", object_type: "PROG", include: "main", edits: [{ old_text: "WRITE 1.", new_text: "WRITE 10.", replace_all: false }] },
    { object_name: "ZB", object_type: "PROG", include: "main", source: "REPORT zb.\nWRITE 20.\n" },
  ];
  it("mezcla ediciones y fuentes completas en una sola vista previa y escritura", async () => {
    const { written, ctx } = setup();
    const p: any = await def.preview!({ files, activate: true, skip_syntax_check: false }, ctx());
    expect(p.text).toMatch(/-WRITE 1\.\n\+WRITE 10\.[\s\S]*-WRITE 2\.\n\+WRITE 20\./);
    const r: any = await def.run({ files, activate: true, skip_syntax_check: false }, ctx(p.state));
    expect(r.isError).toBe(false);
    expect(written).toEqual([["ZA", "REPORT za.\nWRITE 10.\n"], ["ZB", files[1].source]]);
  });
  it("cada archivo lleva source o edits, no los dos ni ninguno", async () => {
    const { ctx } = setup();
    await expect(def.preview!({ files: [{ object_name: "ZA", include: "main" }], activate: true, skip_syntax_check: false }, ctx())).rejects.toThrow(/source o edits/);
    await expect(def.preview!({ files: [{ ...files[0], source: "x" }], activate: true, skip_syntax_check: false }, ctx())).rejects.toThrow(/source o edits/);
  });
});
