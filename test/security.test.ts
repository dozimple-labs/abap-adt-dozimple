import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendAudit, auditArgs, AUDIT_FILE, auditIo, verifyAudit } from "../src/core/audit.js";
import { assertPrivateFile, parseConfig, resolveSystem } from "../src/core/config.js";
import { consumeToken, CONFIRM_TTL_MS, issueToken } from "../src/core/confirm.js";
import {
  assertNoSensitiveViews, candidateNames, dataClassOf, guardedQuery, MASK, maskPii, rowCap,
} from "../src/core/datapolicy.js";
import { AdtErrorException } from "abap-adt-api";
import { ToolError } from "../src/core/errors.js";
import { assertNotSensitive } from "../src/core/policy.js";
import { annotationsFor, invoke } from "../src/core/registry.js";
import { sidecarEnv } from "../src/core/sidecar.js";
import type { ToolDef } from "../src/core/tool.js";
import runUnitTests, { SAFE_TEST_FLAGS } from "../src/tools/core/run_unit_tests.js";
import { assertSafeFragment } from "../src/tools/core/table_contents.js";
import { assertDocId } from "../src/tools/docs/docs.js";

afterEach(() => vi.restoreAllMocks());

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "abapdz-sec-"));
  process.env.ABAP_DZ_STATE_DIR = stateDir;
});

const base = { url: "https://sap.example:44300", client: "100", user: "DEMO_USER" };
const cfg = parseConfig({
  defaultSystem: "DEV",
  systems: [
    { ...base, id: "DEV", role: "DEV", allowWrite: true },
    { ...base, id: "QAS", role: "QAS" },
    { ...base, id: "PRD", role: "PRD" },
  ],
  sidecars: { docs: { command: "node", allowOnline: false } },
});
const pool = { get: (s: any) => ({ system: s, missingCapabilities: async () => [], adt: async () => ({}) }) } as any;

describe("anotaciones MCP", () => {
  const def = (access: any) => ({ name: "t", title: "T", description: "d", access, input: {}, run: async () => "" }) as ToolDef<any>;
  it("las escrituras son destructivas y no idempotentes", () => {
    expect(annotationsFor(def("write"))).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
  });
  it("las lecturas son de solo lectura e idempotentes", () => {
    expect(annotationsFor(def("read"))).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    expect(annotationsFor(def("exec"))).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });
});

describe("token de confirmación", () => {
  const args = { object_name: "ZDEMO", source: "REPORT zdemo." };
  it("vale una vez, para esos argumentos exactos", () => {
    const t = issueToken("write_source", "DEV", args);
    expect(consumeToken(t, "write_source", "dev", { source: "REPORT zdemo.", object_name: "ZDEMO" })).toBe("ok");
    expect(consumeToken(t, "write_source", "DEV", args)).toBe("unknown");
  });
  it("otro contenido, otra tool u otro sistema no valen y queman el token", () => {
    const t = issueToken("write_source", "DEV", args);
    expect(consumeToken(t, "write_source", "DEV", { ...args, source: "REPORT zdemo. \" otro" })).toBe("mismatch");
    expect(consumeToken(t, "write_source", "DEV", args)).toBe("unknown");
    const t2 = issueToken("write_source", "DEV", args);
    expect(consumeToken(t2, "activate", "DEV", args)).toBe("mismatch");
  });
  it("caduca", () => {
    const now = Date.now();
    const t = issueToken("activate", "DEV", {}, now);
    expect(consumeToken(t, "activate", "DEV", {}, now + CONFIRM_TTL_MS + 1)).toBe("expired");
  });
});

describe("escritura confirmada y auditada", () => {
  const make = () => {
    const calls: unknown[] = [];
    const def: ToolDef<any> = {
      name: "t_write", title: "Guardar demo", description: "d", access: "write", input: {},
      preview: async (a) => `se cambiará ${a.object_name}`,
      run: async (a) => (calls.push(a), `guardado ${a.object_name}`),
    };
    return { def, calls };
  };
  const audit = () => readFileSync(join(stateDir, AUDIT_FILE), "utf8");

  it("sin token: vista previa y token, sin escribir", async () => {
    const { def, calls } = make();
    const r = await invoke(def, { system: "DEV", object_name: "ZDEMO" }, { config: cfg, pool, tools: [] });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/VISTA PREVIA/);
    expect(r.text).toMatch(/se cambiará ZDEMO/);
    expect(calls).toHaveLength(0);
  });

  it("con el token de esa vista previa escribe, y deja intención y resultado encadenados", async () => {
    const { def, calls } = make();
    const src = "x".repeat(500);
    const first = await invoke(def, { system: "DEV", object_name: "ZDEMO", source: src }, { config: cfg, pool, tools: [] });
    const token = first.text.match(/confirm_token="([0-9a-f]+)"/)![1];
    const r = await invoke(def, { system: "DEV", object_name: "ZDEMO", source: src, confirm_token: token }, { config: cfg, pool, tools: [] });
    expect(r).toMatchObject({ isError: false });
    expect(calls).toEqual([{ object_name: "ZDEMO", source: src }]);
    const log = audit();
    expect(log).not.toContain(src);
    const entries = log.trim().split("\n").map((l) => JSON.parse(l));
    expect(entries.map((e) => e.phase)).toEqual(["intent", "result"]);
    expect(entries[0]).toMatchObject({ tool: "t_write", system: "DEV", sapUser: "DEMO_USER", confirmedBy: "token" });
    expect(entries[0].args.source).toMatchObject({ chars: 500 });
    expect(verifyAudit(log)).toMatchObject({ ok: true, entries: 2 });
  });

  it("si los argumentos cambian tras la vista previa, no escribe y lo audita como denegado", async () => {
    const { def, calls } = make();
    const first = await invoke(def, { system: "DEV", object_name: "ZDEMO" }, { config: cfg, pool, tools: [] });
    const token = first.text.match(/confirm_token="([0-9a-f]+)"/)![1];
    const r = await invoke(def, { system: "DEV", object_name: "ZOTRO", confirm_token: token }, { config: cfg, pool, tools: [] });
    expect(r).toMatchObject({ isError: true, kind: "POLICY" });
    expect(calls).toHaveLength(0);
    expect(JSON.parse(audit().trim())).toMatchObject({ phase: "denied", reason: "token mismatch" });
  });

  it("con elicitación: acepta → escribe; rechaza → no", async () => {
    const { def, calls } = make();
    const ok = await invoke(def, { system: "DEV", object_name: "ZDEMO" }, { config: cfg, pool, tools: [], elicit: async () => "accept" });
    expect(ok).toMatchObject({ isError: false });
    expect(calls).toHaveLength(1);
    const no = await invoke(def, { system: "DEV", object_name: "ZDEMO" }, { config: cfg, pool, tools: [], elicit: async () => "decline" });
    expect(no).toMatchObject({ isError: true, kind: "POLICY" });
    expect(calls).toHaveLength(1);
  });

  it("si la elicitación falla en el cliente, cae al token (nunca escribe sin confirmar)", async () => {
    const { def, calls } = make();
    const r = await invoke(def, { system: "DEV", object_name: "ZDEMO" }, { config: cfg, pool, tools: [], elicit: async () => { throw new Error("no soportado"); } });
    expect(r.text).toMatch(/VISTA PREVIA/);
    expect(calls).toHaveLength(0);
  });

  it("disco lleno al registrar la intención: no se escribe en SAP (fail-closed)", async () => {
    const { def, calls } = make();
    vi.spyOn(auditIo, "appendFileSync").mockImplementation(() => {
      throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    });
    const r = await invoke(def, { system: "DEV", object_name: "ZDEMO" }, { config: cfg, pool, tools: [], elicit: async () => "accept" });
    expect(r).toMatchObject({ isError: true, kind: "INTERNAL" });
    expect(r.text).toMatch(/No se ejecutó.*auditoría.*ENOSPC/s);
    expect(calls).toHaveLength(0);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("permiso denegado en la carpeta de estado: no se escribe en SAP", async () => {
    const { def, calls } = make();
    const ro = join(stateDir, "solo-lectura");
    mkdirSync(ro, { mode: 0o500 });
    process.env.ABAP_DZ_STATE_DIR = ro;
    try {
      const r = await invoke(def, { system: "DEV", object_name: "ZDEMO" }, { config: cfg, pool, tools: [], elicit: async () => "accept" });
      expect(r).toMatchObject({ isError: true, kind: "INTERNAL" });
      expect(r.text).toMatch(/EACCES|permission denied/i);
      expect(calls).toHaveLength(0);
    } finally {
      chmodSync(ro, 0o700);
    }
  });

  it("si falla solo el registro del resultado, la escritura ya hecha se informa con aviso (nunca se oculta)", async () => {
    const { def, calls } = make();
    const real = auditIo.appendFileSync;
    let n = 0;
    vi.spyOn(auditIo, "appendFileSync").mockImplementation(((...a: Parameters<typeof real>) => {
      if (++n === 2) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      return real(...a);
    }) as typeof real);
    const r = await invoke(def, { system: "DEV", object_name: "ZDEMO" }, { config: cfg, pool, tools: [], elicit: async () => "accept" });
    expect(calls).toHaveLength(1);
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/guardado ZDEMO[\s\S]*no se pudo anotar su resultado/);
  });

  it("sin registro de auditoría (ruta no escribible) no se escribe", async () => {
    const { def, calls } = make();
    const blocker = join(stateDir, "no-es-dir");
    writeFileSync(blocker, "");
    process.env.ABAP_DZ_STATE_DIR = join(blocker, "sub");
    const r = await invoke(def, { system: "DEV", object_name: "ZDEMO" }, { config: cfg, pool, tools: [], elicit: async () => "accept" });
    expect(r).toMatchObject({ isError: true });
    expect(calls).toHaveLength(0);
  });
});

describe("registro de auditoría", () => {
  const entry = (tool: string) => ({ phase: "result" as const, tool, access: "write", system: "DEV", sapUser: "U", client: "100", args: {} });
  it("detecta una entrada alterada, borrada o reordenada", () => {
    for (const t of ["a", "b", "c"]) appendAudit(entry(t), stateDir);
    const lines = readFileSync(join(stateDir, AUDIT_FILE), "utf8").trim().split("\n");
    expect(verifyAudit(lines.join("\n")).ok).toBe(true);
    expect(verifyAudit(lines.map((l, i) => (i === 1 ? l.replace('"tool":"b"', '"tool":"x"') : l)).join("\n"))).toMatchObject({ ok: false, brokenAt: 2 });
    expect(verifyAudit([lines[0], lines[2]].join("\n"))).toMatchObject({ ok: false, brokenAt: 2 });
    expect(verifyAudit([lines[1], lines[0], lines[2]].join("\n")).ok).toBe(false);
  });
  it("de los argumentos largos o compuestos guarda solo la huella", () => {
    const a = auditArgs({ transport: "DEVK900123", source: "y".repeat(300), elements: [{ id: "001", text: "Cliente" }] });
    expect(a.transport).toBe("DEVK900123");
    expect(JSON.stringify(a)).not.toMatch(/yyyy|Cliente/);
  });
});

describe("ABAP Unit", () => {
  it("pide explícitamente solo tests inofensivos y cortos", async () => {
    expect(SAFE_TEST_FLAGS).toEqual({ harmless: true, dangerous: false, critical: false, short: true, medium: false, long: false });
    let flags: unknown;
    const c = {
      searchObject: async () => [{ "adtcore:name": "ZCL_DEMO", "adtcore:type": "CLAS/OC", "adtcore:uri": "/sap/bc/adt/oo/classes/zcl_demo", "adtcore:packageName": "$TMP" }],
      unitTestRun: async (_u: string, f: unknown) => ((flags = f), []),
    };
    await (runUnitTests as ToolDef<any>).run({ object_name: "ZCL_DEMO", object_type: "CLAS" }, { sap: { adt: async () => c } } as any);
    expect(flags).toEqual(SAFE_TEST_FLAGS);
  });
});

describe("componente aislado", () => {
  it("no hereda variables del servidor ni secretos del entorno", () => {
    const env = sidecarEnv({ PATH: "/usr/bin", HOME: "/home/u", ABAP_DZ_CONFIG: "/x", SAP_PWD: "s3cr3t", GITHUB_TOKEN: "t", HTTPS_PROXY: "http://u:p@proxy" });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/u" });
  });
});

describe("docs_fetch", () => {
  it("acepta ids de la biblioteca local", () => {
    expect(() => assertDocId("/abap-docs-standard/abenselect#where", cfg)).not.toThrow();
  });
  it("rechaza ids con otra forma (URLs, recorridos de ruta, texto libre)", () => {
    for (const id of ["https://attacker.example/?q=x", "/abap-docs/../../etc/passwd", "ZDEMO_PROGRAMA con datos"]) {
      expect(() => assertDocId(id, cfg), id).toThrow(ToolError);
    }
  });
  it("los online solo con allowOnline, y pasan el filtro de datos de cliente", () => {
    expect(() => assertDocId("community-12345", cfg)).toThrow(/online está deshabilitada/);
    const on = parseConfig({ ...cfg, sidecars: { docs: { command: "node", allowOnline: true, blockTerms: ["acme"] } } });
    expect(() => assertDocId("community-12345", on)).not.toThrow();
    expect(() => assertDocId("community-url-https%3A%2F%2Fcommunity.sap.com%2Facme-zdemo_report", on)).toThrow(/POLICY|internet/);
  });
});

describe("configuración protegida", () => {
  const uid = process.getuid?.() ?? 0;
  it("rechaza systems.json modificable por grupo u otros, o de otro usuario", () => {
    expect(() => assertPrivateFile("/x/systems.json", { mode: 0o100600, uid })).not.toThrow();
    expect(() => assertPrivateFile("/x/systems.json", { mode: 0o100664, uid })).toThrow(/chmod 600/);
    expect(() => assertPrivateFile("/x/systems.json", { mode: 0o100646, uid })).toThrow(/chmod 600/);
    expect(() => assertPrivateFile("/x/systems.json", { mode: 0o100600, uid: uid + 1 })).toThrow(/otro usuario/);
  });
  it("el sistema por defecto de la variable de entorno se identifica como tal, y si no existe es error", () => {
    process.env.ABAP_DZ_DEFAULT_SYSTEM = "qas";
    try {
      expect(resolveSystem(cfg)).toMatchObject({ system: { id: "QAS" }, source: "por defecto: ABAP_DZ_DEFAULT_SYSTEM" });
      process.env.ABAP_DZ_DEFAULT_SYSTEM = "NOPE";
      expect(() => resolveSystem(cfg)).toThrow(/ABAP_DZ_DEFAULT_SYSTEM/);
    } finally {
      delete process.env.ABAP_DZ_DEFAULT_SYSTEM;
    }
  });
});

describe("datos sensibles", () => {
  it("veta secretos, prefijos OAuth y datos de personal; los literales no cuentan", () => {
    expect(() => assertNotSensitive("SELECT * FROM snap")).toThrow(/seguridad/);
    expect(() => assertNotSensitive("SELECT * FROM oa2c_client")).toThrow(/seguridad/);
    expect(() => assertNotSensitive("SELECT pernr FROM pa0002")).toThrow(/personal/);
    expect(() => assertNotSensitive("SELECT * FROM pcl2")).toThrow(/personal/);
    expect(() => assertNotSensitive("SELECT devclass FROM tadir WHERE obj_name = 'USR02'")).not.toThrow();
    // La contraseña del usuario fijo de un servicio ICF, y columnas de contraseña genéricas.
    expect(() => assertNotSensitive("SELECT icf_name, icf_passwd FROM icfservice")).toThrow(/seguridad/);
    expect(() => assertNotSensitive("SELECT * FROM zdemo WHERE password <> ''")).toThrow(/seguridad/);
    expect(() => assertNotSensitive("SELECT icf_name, icf_user FROM icfservice")).not.toThrow();
  });

  it("clase de datos y tope por rol, con sobrescritura explícita", () => {
    const [dev, qas, prd] = cfg.systems;
    expect([dataClassOf(dev), dataClassOf(qas), dataClassOf(prd)]).toEqual(["test", "prod", "prod"]);
    expect([rowCap(dev), rowCap(prd)]).toEqual([5000, 200]);
    expect(rowCap({ ...dev, dataClass: "masked" })).toBe(1000);
    expect(rowCap({ ...prd, maxRows: 20 })).toBe(20);
  });

  it("enmascara columnas personales en prod, no en test", () => {
    const rows = () => [{ KUNNR: "0000100001", NAME1: "Demo SpA", STCD1: "" }];
    const prodRows = rows();
    expect(maskPii("prod", "SELECT kunnr, name1, stcd1 FROM kna1", ["KUNNR", "NAME1", "STCD1"], prodRows)).toEqual(["NAME1", "STCD1"]);
    expect(prodRows[0]).toEqual({ KUNNR: "0000100001", NAME1: MASK, STCD1: "" });
    const testRows = rows();
    maskPii("test", "SELECT kunnr, name1 FROM kna1", ["KUNNR", "NAME1"], testRows);
    expect(testRows[0].NAME1).toBe("Demo SpA");
  });

  it("en prod una columna personal fuera del resultado (WHERE, alias) se rechaza", () => {
    expect(() => maskPii("prod", "SELECT kunnr FROM kna1 WHERE name1 LIKE 'A%'", ["KUNNR"], [])).toThrow(/columna simple/);
    expect(() => maskPii("prod", "SELECT name1 AS n FROM kna1", ["N"], [])).toThrow(/columna simple/);
    expect(() => maskPii("prod", "SELECT a~kunnr FROM kna1 AS a WHERE a~name1 = 'X'", ["KUNNR"], [])).toThrow(/columna simple/);
  });

  it("el usuario SAP de quien creó o cambió un documento también es un dato personal", () => {
    const cols = ["VBELN", "ERNAM", "ANGE_USER", "ERNAM_S", "READY_UNAME", "ZZ_ERNAM", "AS4USER", "WERKS", "USERCLASS", "RENAME"];
    const rows = [Object.fromEntries(cols.map((c) => [c, "DEMO_USER"]))];
    expect(maskPii("prod", "SELECT * FROM zdemo_order WHERE vbeln = '1'", cols, rows)).toEqual(["ERNAM", "ANGE_USER", "ERNAM_S", "READY_UNAME", "ZZ_ERNAM", "AS4USER"]);
    expect(rows[0]).toMatchObject({ VBELN: "DEMO_USER", ERNAM: MASK, ANGE_USER: MASK, ERNAM_S: MASK, WERKS: "DEMO_USER", USERCLASS: "DEMO_USER", RENAME: "DEMO_USER" });
    expect(() => maskPii("prod", "SELECT vbeln FROM zdemo_order WHERE ernam = 'DEMO_USER'", ["VBELN"], [])).toThrow(/columna simple/);
    const dev = [{ ERNAM: "DEMO_USER" }];
    expect(maskPii("test", "SELECT ernam FROM zdemo_order", ["ERNAM"], dev)).toEqual([]);
    expect(dev[0].ERNAM).toBe("DEMO_USER");
  });

  it("nombres candidatos: sin palabras clave, literales ni números", () => {
    expect(candidateNames("SELECT a~obj_name FROM tadir AS a WHERE a~devclass = 'ZDEMO' UP TO 10 ROWS")).toEqual(["OBJ_NAME", "TADIR", "DEVCLASS"]);
  });

  it("en fuentes CDS ignora anotaciones y nombres imposibles", () => {
    const ddl = "@ObjectModel.modelingPattern: #CDS_MODELING_ASSOCIATION_TARGET\n@EndUserText.label: 'Usuarios'\ndefine view entity ZI_DEMO as select from usr21 { key bname }";
    const names = candidateNames(ddl, 400);
    expect(names).toContain("USR21");
    expect(names.some((n) => n.includes("MODELING") || n === "OBJECTMODEL")).toBe(false);
  });

  /** SAP falso: responde DD26S / DDLDEPENDENCY / fuente DDL según la tabla. */
  const fakeSap = (views: Record<string, string[]>, ddl: Record<string, { entity: string; source: string }> = {}) => {
    const queried: string[] = [];
    const sap = {
      query: async (sql: string, _rows: number) => {
        queried.push(sql);
        const names = [...sql.matchAll(/'([^']+)'/g)].map((m) => m[1]);
        if (/FROM dd26s/.test(sql)) return { columns: [], values: names.flatMap((n) => (views[n] ?? []).map((t) => ({ VIEWNAME: n, TABNAME: t }))) };
        if (/FROM ddldependency/.test(sql)) return { columns: [], values: Object.entries(ddl).filter(([, d]) => names.includes(d.entity)).map(([k, d]) => ({ DDLNAME: k, OBJECTNAME: d.entity })) };
        return { columns: [{ name: "KUNNR" }, { name: "NAME1" }], values: Array.from({ length: 300 }, (_, i) => ({ KUNNR: String(i), NAME1: "Demo" })) };
      },
      adt: async () => ({ getObjectSource: async (url: string) => Object.entries(ddl).find(([k]) => url.includes(k.toLowerCase()))![1].source }),
    };
    return { sap: sap as any, queried };
  };

  it("una vista sobre USR02 se bloquea aunque la consulta no la nombre", async () => {
    const { sap } = fakeSap({ ZV_DEMO_USERS: ["USR02", "USR21"] });
    await expect(assertNoSensitiveViews(sap, "SELECT * FROM zv_demo_users")).rejects.toThrow(/ZV_DEMO_USERS.*USR02|USR02/);
  });

  it("una CDS que lee datos de personal se bloquea, también en segundo nivel", async () => {
    const { sap } = fakeSap({}, {
      ZI_DEMO_A: { entity: "ZI_DEMO_A", source: "define view entity ZI_DEMO_A as select from ZI_DEMO_B { key pernr }" },
      ZI_DEMO_B: { entity: "ZI_DEMO_B", source: "define view entity ZI_DEMO_B as select from pa0002 { key pernr }" },
    });
    await expect(assertNoSensitiveViews(sap, "SELECT pernr FROM zi_demo_a")).rejects.toThrow(/personal/);
  });

  it("si SAP no tiene DDLDEPENDENCY (release sin CDS) no bloquea por eso", async () => {
    const { sap } = fakeSap({});
    const q = sap.query;
    sap.query = async (sql: string, rows: number) => {
      if (/ddldependency/.test(sql)) throw new AdtErrorException(400, {}, "", "Cannot find 'DDLDEPENDENCY'");
      return q(sql, rows);
    };
    await expect(assertNoSensitiveViews(sap, "SELECT * FROM t000")).resolves.toBeUndefined();
  });

  it("cualquier otro fallo al resolver CDS cierra la consulta", async () => {
    const { sap } = fakeSap({});
    const q = sap.query;
    sap.query = async (sql: string, rows: number) => {
      if (/ddldependency/.test(sql)) throw new AdtErrorException(400, {}, "", "Invalid value for C(40,0)");
      return q(sql, rows);
    };
    await expect(assertNoSensitiveViews(sap, "SELECT * FROM t000")).rejects.toThrow(/no se ejecuta/);
  });

  // Regresión de un caso real (S/4HANA 2023): la CDS estándar I_USER quedaba bloqueada porque los valores de sus
  // anotaciones (#CDS_MODELING_ASSOCIATION_TARGET, 31 caracteres) llegaban al IN de DD26S-VIEWNAME, que es C(30).
  it("regresión I_USER: una CDS estándar con anotaciones largas se resuelve y no se bloquea", async () => {
    const { sap, queried } = fakeSap({}, {
      I_USER: {
        entity: "I_USER",
        source:
          "@AccessControl.authorizationCheck: #CHECK\n@ObjectModel.modelingPattern: #CDS_MODELING_ASSOCIATION_TARGET\n" +
          "@ObjectModel.supportedCapabilities: [ #CDS_MODELING_DATA_SOURCE, #SQL_DATA_SOURCE ]\n" +
          "define view entity I_USER as select from usr21 { key bname as UserID }",
      },
    });
    const q = sap.query;
    sap.query = async (sql: string, rows: number) => {
      const long = [...sql.matchAll(/'([^']+)'/g)].map((m) => m[1]).find((v) => /dd26s/.test(sql) && v.length > 30);
      if (long) throw new AdtErrorException(400, {}, "", `'${long}' is not a valid value for C(30,0)`);
      return q(sql, rows);
    };
    await expect(assertNoSensitiveViews(sap, "SELECT * FROM i_user")).resolves.toBeUndefined();
    expect(queried.some((x) => /USR21/.test(x))).toBe(true);
  });

  it("SELECT * que devuelve una columna de contraseña se bloquea sin mostrar nada", async () => {
    const sap = {
      query: async (sql: string) =>
        /dd26s|ddldependency/i.test(sql)
          ? { columns: [], values: [] }
          : { columns: [{ name: "ICF_NAME" }, { name: "ICF_PASSWD" }], values: [{ ICF_NAME: "ZDEMO", ICF_PASSWD: "x" }] },
      adt: async () => ({}),
    } as any;
    await expect(guardedQuery(sap, cfg.systems[0], "SELECT * FROM icfservice", 10)).rejects.toThrow(/columnas de credenciales \(ICF_PASSWD\)/);
  });

  it("guardedQuery aplica el tope del sistema y enmascara en PRD", async () => {
    const { sap } = fakeSap({});
    const r = await guardedQuery(sap, cfg.systems[2], "SELECT kunnr, name1 FROM kna1", 5000);
    expect(r.cap).toBe(200);
    expect(r.values[0].NAME1).toBe(MASK);
    expect(r.notes.join(" ")).toMatch(/enmascaradas.*Tope de 200/s);
  });
});

describe("table_contents", () => {
  it("el filtro no puede abrir subconsultas, comentar ni encadenar sentencias", () => {
    expect(() => assertSafeFragment("werks = '1000' AND lvorm = ''", "where")).not.toThrow();
    expect(() => assertSafeFragment("texto = 'select from union'", "where")).not.toThrow();
    for (const bad of ["1 = 1 UNION SELECT bname FROM usr02", "mandt IN ( SELECT mandt FROM t000 )", "a = 1; DELETE", "a = 1 \" comentario", "a = 'x"]) {
      expect(() => assertSafeFragment(bad, "where"), bad).toThrow(ToolError);
    }
  });
});
