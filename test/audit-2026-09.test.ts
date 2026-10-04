/**
 * Regresión de la auditoría de seguridad del 21-09-2026 (hallazgos DZ-xx). Cada test reproduce el ataque o el mal
 * uso descrito en el informe y exige que el servidor lo frene.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { appendAudit, AUDIT_FILE, verifyAudit } from "../src/core/audit.js";
import { aclViolations, assertPrivateFileWindows, parseAclOutput, parseConfig, startupWarnings } from "../src/core/config.js";
import { auditKey, resetAuditKeyForTests } from "../src/core/auditkey.js";
import { stateOf } from "../src/core/confirm.js";
import { clearPasswords, getPassword } from "../src/core/credentials.js";
import { maskPii, MASK } from "../src/core/datapolicy.js";
import { sanitizeMessage } from "../src/core/errors.js";
import { htmlToText, neutralizeMarkup } from "../src/core/feeds.js";
import { adtPathName } from "../src/core/objects.js";
import { SAP_USER_RE } from "../src/core/policy.js";
import { invoke, loadTools } from "../src/core/registry.js";
import type { ToolDef } from "../src/core/tool.js";
import { assertSafeFragment } from "../src/tools/core/table_contents.js";
import writeSource from "../src/tools/core/write_source.js";
import { assertDocId } from "../src/tools/docs/docs.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "abapdz-audit-"));
  process.env.ABAP_DZ_STATE_DIR = dir;
});
afterEach(() => vi.useRealTimers());

const base = { url: "https://sap.example:44300", client: "100", user: "DEMO_USER" };

describe("DZ-01/02 · usuario SAP en filtros de feeds ADT", () => {
  it("acepta usuarios reales y rechaza lo que reescribiría la expresión del filtro", () => {
    for (const ok of ["DEMO_USER", "demo.user", "U-01", "A@B"]) expect(SAP_USER_RE.test(ok), ok).toBe(true);
    for (const bad of ["X ) ) or( equals( user, ADMIN ) ) and( equals( x,", "A,B", "A B", "(A)", "MUY_LARGO_1234"]) {
      expect(SAP_USER_RE.test(bad), bad).toBe(false);
    }
  });
});

describe("DZ-03 · filtro de table_contents por lista blanca", () => {
  it.each([
    "werks = '1000' AND lvorm = ''",
    "matnr LIKE 'A%'",
    "erdat BETWEEN '20260101' AND '20261231'",
    "kunnr IN ( '1', '2' )",
    "loekz IS INITIAL",
    "NOT ( a = 1 OR b <> 2 )",
    "a~b = 'x' AND c >= 10.5",
    "texto = 'select from union'",
  ])("admite una condición normal: %s", (w) => expect(() => assertSafeFragment(w, "where")).not.toThrow());

  it.each([
    "1 = 1 UNION SELECT bname FROM usr02",
    "mandt IN ( SELECT mandt FROM t000 )",
    "EXISTS ( a )",
    "a = @lv_x",
    "a = 1; DELETE",
    'a = "x"',
    "a = 1 -- comentario",
    "a = 1 CLIENT SPECIFIED",
    "a = 'x",
    "( a = 1",
    "a = 1 )",
    "a = 1 ORDER BY b",
    "a = *",
  ])("rechaza: %s", (w) => expect(() => assertSafeFragment(w, "where")).toThrow());
});

describe("DZ-04 · nombres en rutas ADT", () => {
  it("rechaza recorridos y caracteres fuera de un nombre de repositorio", () => {
    expect(adtPathName("ZDEMO_CDS")).toBe("zdemo_cds");
    expect(adtPathName("/DMO/I_TRAVEL")).toBe("%2Fdmo%2Fi_travel");
    for (const bad of ["..", "../x", "a/../b", "ZDEMO X", "ZDEMO%2F..", "a.b"]) expect(() => adtPathName(bad), bad).toThrow();
  });
});

describe("DZ-07/10 · TLS y avisos de arranque", () => {
  it("allowSelfSigned solo en DEV", () => {
    expect(() => parseConfig({ systems: [{ ...base, id: "Q", role: "QAS", allowSelfSigned: true }] })).toThrow(/solo se admite en sistemas DEV/);
    expect(() => parseConfig({ systems: [{ ...base, id: "P", role: "PRD", allowSelfSigned: true }] })).toThrow(/caFile/);
    const dev = parseConfig({ systems: [{ ...base, id: "D", role: "DEV", allowSelfSigned: true }] });
    expect(startupWarnings(dev, "darwin").join(" ")).toMatch(/D: TLS SIN VERIFICAR/);
  });
  it("en Windows solo avisa si se desactivó la comprobación de ACL", () => {
    const c = parseConfig({ systems: [{ ...base, id: "D", role: "DEV" }] });
    expect(startupWarnings(c, "win32")).toEqual([]);
    process.env.ABAP_DZ_SKIP_ACL_CHECK = "1";
    try {
      expect(startupWarnings(c, "win32").join(" ")).toMatch(/ABAP_DZ_SKIP_ACL_CHECK=1 desactiva/);
    } finally {
      delete process.env.ABAP_DZ_SKIP_ACL_CHECK;
    }
    expect(startupWarnings(c, "linux")).toEqual([]);
  });
});

describe("DZ-11 · contraseña en memoria con caducidad", () => {
  it("se relee pasados 15 minutos y se borra al cerrar", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const sys = parseConfig({ systems: [{ ...base, id: "D", role: "DEV", password: "env:DEMO_PWD_TTL" }] }).systems[0];
    process.env.DEMO_PWD_TTL = "uno";
    expect(await getPassword(sys)).toBe("uno");
    process.env.DEMO_PWD_TTL = "dos";
    expect(await getPassword(sys)).toBe("uno"); // en caché
    vi.setSystemTime(Date.now() + 15 * 60_000 + 1);
    expect(await getPassword(sys)).toBe("dos"); // caducó
    process.env.DEMO_PWD_TTL = "tres";
    clearPasswords();
    expect(await getPassword(sys)).toBe("tres");
    delete process.env.DEMO_PWD_TTL;
  });
});

describe("DZ-09/12 · mensajes de error hacia el modelo", () => {
  it("quita credenciales de URLs y de cabeceras, el marcado, y acota la longitud", () => {
    const m = sanitizeMessage(`fallo en https://demo:${"s".repeat(8)}@sap.example/x <html><b>ICF</b></html> Authorization: Basic ${"Q".repeat(20)}`);
    expect(m).toContain("https://[credenciales]@sap.example/x");
    expect(m).not.toMatch(/sssssss|QQQQQQ|<html>/);
    expect(sanitizeMessage("x".repeat(2000)).length).toBeLessThanOrEqual(501);
  });
});

describe("DZ-14 · la escritura no aplica un diff sobre algo que cambió tras la vista previa", () => {
  const cfg = parseConfig({ systems: [{ ...base, id: "DEV", role: "DEV", allowWrite: true }] });
  const pool = { get: (s: any) => ({ system: s, missingCapabilities: async () => [], adt: async () => ({}) }) } as any;

  it("el registro entrega a la tool la huella de lo que se mostró (token y elicitación)", async () => {
    const seen: unknown[] = [];
    const def: ToolDef<any> = {
      name: "t_w", title: "T", description: "d".repeat(50), access: "write", input: {},
      preview: async () => ({ text: "vista previa", state: "HUELLA-A" }),
      run: async (_a, ctx) => (seen.push(ctx.confirmedState), "ok"),
    };
    const first = await invoke(def, { system: "DEV" }, { config: cfg, pool, tools: [] });
    const token = first.text.match(/confirm_token="([0-9a-f]+)"/)![1];
    await invoke(def, { system: "DEV", confirm_token: token }, { config: cfg, pool, tools: [] });
    await invoke(def, { system: "DEV" }, { config: cfg, pool, tools: [], elicit: async () => "accept" });
    expect(seen).toEqual(["HUELLA-A", "HUELLA-A"]);
  });

  it("write_source no escribe si la fuente en SAP ya no es la de la vista previa", async () => {
    let written = false;
    const s = {
      lock: async () => ({ LOCK_HANDLE: "H", CORRNR: "", CORRUSER: "", IS_LOCAL: "X" }),
      getObjectSource: async () => "REPORT zdemo.\n* cambio de otra persona\n",
      setObjectSource: async () => void (written = true),
      unLock: async () => undefined,
    };
    const c = {
      searchObject: async () => [{ "adtcore:name": "ZDEMO", "adtcore:type": "PROG/P", "adtcore:uri": "/sap/bc/adt/programs/programs/zdemo", "adtcore:packageName": "$TMP" }],
      objectStructure: async () => { throw new Error("sin estructura"); },
      // Al empezar todavía es la versión de la vista previa: el cambio ajeno llega justo antes del bloqueo.
      getObjectSource: async () => "REPORT zdemo.\n",
    };
    const ctx = { sap: { adt: async () => c, stateful: async (fn: any) => fn(s), query: async () => ({ values: [] }) }, confirmedState: stateOf("REPORT zdemo.\n") } as any;
    const r: any = await (writeSource as ToolDef<any>).run(
      { object_name: "ZDEMO", object_type: "PROG", include: "main", source: "REPORT zdemo.\nWRITE 1.\n", activate: false, skip_syntax_check: true },
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/cambió en SAP después de la vista previa/);
    expect(written).toBe(false);
  });
});

describe("DZ-16 · toda tool exec decide expresamente si pide confirmación", () => {
  it("ninguna exec queda sin decidir", async () => {
    const defs = await loadTools(join(__dirname, "..", "src", "tools"));
    const undecided = defs.filter((d) => d.access === "exec" && typeof d.confirm !== "boolean").map((d) => d.name);
    expect(undecided).toEqual([]);
  });
});

describe("DZ-18 · columnas personales propias del cliente", () => {
  it("se enmascaran igual que las estándar, y tampoco valen en WHERE", () => {
    const rows = [{ ID: "1", ZNOMBRE_CLIENTE: "Demo SpA" }];
    expect(maskPii("prod", "SELECT id, znombre_cliente FROM zdemo", ["ID", "ZNOMBRE_CLIENTE"], rows, ["ZNOMBRE_CLIENTE"])).toEqual(["ZNOMBRE_CLIENTE"]);
    expect(rows[0].ZNOMBRE_CLIENTE).toBe(MASK);
    expect(() => maskPii("prod", "SELECT id FROM zdemo WHERE znombre_cliente = 'x'", ["ID"], [], ["ZNOMBRE_CLIENTE"])).toThrow(/columna simple/);
    expect(parseConfig({ systems: [{ ...base, id: "P", role: "PRD", piiColumns: ["ZNOMBRE_CLIENTE"] }] }).systems[0].piiColumns).toEqual(["ZNOMBRE_CLIENTE"]);
  });
});

describe("DZ-20/24 · registro de auditoría: bloqueo entre procesos y lectura de la cola", () => {
  const e = (tool: string) => ({ phase: "result" as const, tool, access: "write", system: "DEV", sapUser: "U", client: "100", args: {} });

  it("con miles de entradas la cadena sigue íntegra y la última se lee de la cola", () => {
    for (let i = 0; i < 1500; i++) appendAudit(e(`t${i}`), dir);
    const last = appendAudit(e("final"), dir);
    expect(last.seq).toBe(1501);
    expect(verifyAudit(readFileSync(join(dir, AUDIT_FILE), "utf8"))).toMatchObject({ ok: true, entries: 1501 });
  });

  it("recupera un bloqueo abandonado por un proceso que murió", () => {
    const lock = join(dir, AUDIT_FILE + ".lock");
    writeFileSync(lock, "");
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(lock, old, old);
    expect(appendAudit(e("tras-bloqueo"), dir).seq).toBe(1);
  });
});

describe("DZ-27 · marcado que revive al decodificar entidades", () => {
  it("se neutraliza, y los «<» del texto normal se conservan", () => {
    expect(htmlToText("&lt;script&gt;x&lt;/script&gt;")).not.toMatch(/<script|<\/script/);
    expect(htmlToText("<p>IF a &lt; b.</p>")).toContain("IF a < b.");
    expect(neutralizeMarkup("<b>x</b> y a < b")).toBe("‹b>x‹/b> y a < b");
  });
});

describe("DZ-28 · ids online de docs_fetch validados ya decodificados", () => {
  const cfg = parseConfig({ systems: [{ ...base, id: "D", role: "DEV" }], sidecars: { docs: { command: "node", allowOnline: true } } });
  it("admite las formas reales", () => {
    for (const ok of ["sap-help-abc123_x", "sap-help-abc123~2025.001", "community-12345", "community-url-https%3A%2F%2Fcommunity.sap.com%2Ft5%2Fblog%2F123"]) {
      expect(() => assertDocId(ok, cfg), ok).not.toThrow();
    }
  });
  it("rechaza URLs de otro host codificadas y formas raras", () => {
    for (const bad of ["sap-help-https:%2f%2fatacante.example%2fx", "community-url-https%3A%2F%2Fatacante.example%2Fx", "community-12a", "sap-help-a b"]) {
      expect(() => assertDocId(bad, cfg), bad).toThrow();
    }
  });
});

// El esquema real de los filtros de usuario usa SAP_USER_RE (DZ-01/02).
it("DZ-01/02 · el esquema de dumps y gateway_errors rechaza un usuario hostil", async () => {
  const defs = await loadTools(join(__dirname, "..", "src", "tools"));
  for (const name of ["dumps", "gateway_errors"]) {
    const schema = z.object(defs.find((d) => d.name === name)!.input);
    expect(schema.safeParse({ user: "X ) ) or( equals( user, ADMIN )" }).success, name).toBe(false);
    expect(schema.safeParse({ user: "DEMO_USER" }).success, name).toBe(true);
  }
});

describe("DZ-19 · registro de auditoría firmado con HMAC (clave en el llavero)", () => {
  const e = (tool: string) => ({ phase: "result" as const, tool, access: "write", system: "DEV", sapUser: "U", client: "100", args: {} });
  const read = () => readFileSync(join(dir, AUDIT_FILE), "utf8");
  /** Lo que haría un atacante sin la clave: borrar una entrada y recalcular seq, prev y hash de todas. */
  function rewriteWithout(text: string, drop: number, keepMac: boolean): string {
    const lines = text.trim().split("\n").map((l) => JSON.parse(l)).filter((_: unknown, i: number) => i !== drop);
    let prev = "0".repeat(64);
    return lines
      .map((x: any, i: number) => {
        const { hash, mac, ...rest } = x;
        const base = { ...rest, seq: i + 1, prev };
        const h = createHash("sha256").update(JSON.stringify(base)).digest("hex");
        prev = h;
        return JSON.stringify(keepMac ? { ...base, hash: h, mac } : { ...base, hash: h });
      })
      .join("\n");
  }

  beforeEach(() => resetAuditKeyForTests());

  it("cada entrada nueva va firmada y la verificación con clave las da por buenas", () => {
    for (const t of ["a", "b", "c"]) appendAudit(e(t), dir);
    const v = verifyAudit(read(), auditKey(false));
    expect(v).toMatchObject({ ok: true, entries: 3, signed: 3 });
  });

  it("una reescritura completa sin la clave ya no pasa: firmas que no cuadran", () => {
    for (const t of ["a", "b", "c"]) appendAudit(e(t), dir);
    const forged = rewriteWithout(read(), 1, true);
    expect(verifyAudit(forged).ok).toBe(true); // sin clave, la cadena sola no lo ve…
    expect(verifyAudit(forged, auditKey(false))).toMatchObject({ ok: false, reason: expect.stringMatching(/firma HMAC inválida/) }); // …con clave, sí
  });

  it("quitar la firma de la PRIMERA entrada firmada también se detecta (fecha nunca anterior a la clave)", () => {
    appendAudit(e("primera"), dir);
    const [first] = read().trim().split("\n").map((l) => JSON.parse(l));
    expect(first.ts >= auditKey(false)!.created).toBe(true);
  });

  it("quitar las firmas tampoco: toda entrada posterior a la clave tiene que llevarla", () => {
    for (const t of ["a", "b"]) appendAudit(e(t), dir);
    const stripped = rewriteWithout(read(), 99, false);
    expect(verifyAudit(stripped, auditKey(false))).toMatchObject({ ok: false, reason: expect.stringMatching(/sin firma/) });
  });

  it("las entradas anteriores a la clave (registro antiguo) se aceptan solo encadenadas", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    process.env.ABAP_DZ_AUDIT_KEYSTORE = "none";
    appendAudit(e("antigua"), dir);
    vi.setSystemTime(Date.now() + 60_000); // la clave se crea después, como al actualizar un equipo con registro previo
    process.env.ABAP_DZ_AUDIT_KEYSTORE = "memory";
    resetAuditKeyForTests();
    appendAudit(e("nueva"), dir);
    expect(verifyAudit(read(), auditKey(false))).toMatchObject({ ok: true, entries: 2, signed: 1 });
  });
});

describe("DZ-10 · permisos de systems.json en Windows (ACL por SID)", () => {
  const ME = "S-1-5-21-1-2-3-1001";
  const out = (aces: string[], owner = ME) => [`USER|${ME}`, `OWNER|${owner}`, ...aces.map((a) => `ACE|${a}`)].join("\r\n");

  it("solo tu usuario y las identidades del sistema: pasa", () => {
    const ok = out([`${ME}|FullControl|Allow`, "S-1-5-18|FullControl|Allow", "S-1-5-32-544|FullControl|Allow", "S-1-5-32-545|ReadAndExecute, Synchronize|Allow"]);
    expect(() => assertPrivateFileWindows("C:\\\\demo\\\\systems.json", () => ok)).not.toThrow();
    expect(aclViolations(parseAclOutput(ok).entries, ME)).toEqual([]);
  });

  it.each([
    ["Everyone con modificación", "S-1-1-0|Modify, Synchronize|Allow"],
    ["Usuarios con escritura", "S-1-5-32-545|Write, ReadAndExecute, Synchronize|Allow"],
    ["Usuarios autenticados con control total genérico", "S-1-5-11|268435456|Allow"],
  ])("rechaza %s", (_n, ace) => {
    expect(() => assertPrivateFileWindows("C:\\\\demo\\\\systems.json", () => out([`${ME}|FullControl|Allow`, ace]))).toThrow(/lo pueden modificar otras identidades/);
  });

  it("una denegación no cuenta como permiso, y otro propietario sí se rechaza", () => {
    expect(() => assertPrivateFileWindows("x", () => out([`${ME}|FullControl|Allow`, "S-1-1-0|Write|Deny"]))).not.toThrow();
    expect(() => assertPrivateFileWindows("x", () => out([`${ME}|FullControl|Allow`], "S-1-5-21-9-9-9-500"))).toThrow(/pertenece a otra identidad/);
  });

  it("si no se pueden leer los permisos, no arranca (fail-closed)", () => {
    expect(() => assertPrivateFileWindows("x", () => { throw new Error("powershell no disponible"); })).toThrow(/Sin esa comprobación no se arranca/);
  });
});
