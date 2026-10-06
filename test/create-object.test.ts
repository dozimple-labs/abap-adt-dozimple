import { describe, expect, it, vi } from "vitest";
import { stateOf } from "../src/core/confirm.js";
import type { ToolDef } from "../src/core/tool.js";

/**
 * create_object: crear objetos nuevos con las garantías de write_source. Recoge lo aprendido con abap-fs, el ABAP
 * Accelerator y los huecos anotados (idioma maestro, $TMP, orden, releer lo creado, sintaxis antes de guardar).
 * Datos ficticios.
 */
vi.mock("../src/core/checks.js", async (orig) => {
  const real = await orig<typeof import("../src/core/checks.js")>();
  return {
    ...real,
    syntaxCheck: async (_c: unknown, _o: unknown, _u: unknown, src: string) =>
      src.includes("ROTO") ? [{ uri: "/x", line: 2, offset: 0, severity: "E", text: "Statement no válido" }] : [],
  };
});
vi.mock("../src/core/activation.js", () => ({ activateObject: async () => ({ ok: true, text: "Activado sin errores." }) }));

const { default: tool, checkName } = await import("../src/tools/core/create_object.js");
const def = tool as ToolDef<any>;

const ALL = ["/sap/bc/adt/programs/programs", "/sap/bc/adt/programs/validation", "/sap/bc/adt/oo/classes", "/sap/bc/adt/oo/validation/objectname",
  "/sap/bc/adt/functions/groups", "/sap/bc/adt/functions/validation", "/sap/bc/adt/programs/includes", "/sap/bc/adt/includes/validation"];

function setup(o: { exists?: boolean; korrflag?: string; noPackage?: boolean; collections?: string[]; createFails?: string; notFoundAfter?: boolean; groupPkg?: string } = {}) {
  const created: any[] = [];
  const written: string[] = [];
  const queries: string[] = [];
  let exists = !!o.exists;
  const sap = {
    capabilities: async () => ({ known: true, collections: o.collections ?? ALL, fetchedAt: "" }),
    query: async (sql: string) => {
      queries.push(sql);
      if (/FROM trdir|FROM seoclass|FROM tfdir|FROM dd02l/.test(sql)) return { values: exists ? [{ NAME: "X" }] : [] };
      if (/object = 'FUGR'/.test(sql)) return { values: o.groupPkg ? [{ DEVCLASS: o.groupPkg }] : [] };
      if (/FROM tdevc/.test(sql)) return { values: o.noPackage ? [] : [{ DEVCLASS: "ZDEMO", KORRFLAG: o.korrflag ?? "X" }] };
      if (/FROM e070/.test(sql)) return { values: [{ TRKORR: "DEVK900123", TRFUNCTION: "K", TRSTATUS: "D", TARSYSTEM: "QAS", AS4USER: "DEV_ME", AS4DATE: "20260930", STRKORR: "" }] };
      if (/FROM e07t/.test(sql)) return { values: [] };
      return { values: [] };
    },
    adt: async () => ({
      validateNewObject: async () => ({ SEVERITY: "OK", success: true }),
      createObject: async (opts: any) => {
        created.push(opts);
        if (o.createFails) throw new Error(o.createFails);
        exists = true;
      },
      searchObject: async (name: string) =>
        o.notFoundAfter || !exists
          ? []
          : name.startsWith("ZDEMO_T")
            ? [{ "adtcore:name": name, "adtcore:type": "TABL/DT", "adtcore:uri": `/sap/bc/adt/ddic/tables/${name.toLowerCase()}`, "adtcore:packageName": "ZDEMO" }]
            : [{ "adtcore:name": name, "adtcore:type": "PROG/P", "adtcore:uri": `/sap/bc/adt/programs/programs/${name.toLowerCase()}`, "adtcore:packageName": "ZDEMO" }],
      objectStructure: async () => { throw new Error("sin estructura"); },
    }),
    stateful: async (fn: any) =>
      fn({
        lock: async () => ({ LOCK_HANDLE: "H", CORRNR: "DEVK900123" }),
        setObjectSource: async (_u: string, src: string, _h: string, corr?: string) => void written.push(`${corr}:${src}`),
        unLock: async () => undefined,
      }),
  };
  const ctx = (confirmedState?: string) => ({ sap, system: { id: "DEV", user: "DEV_ME", language: "ES" }, confirmedState }) as any;
  return { ctx, created, written, queries };
}
const base = { object_type: "PROG", name: "ZDEMO_REPORT", description: "Demo", package: "ZDEMO", transport: "DEVK900123", activate: true };

describe("create_object · reglas antes de crear", () => {
  it("solo nombres de cliente y con la longitud del tipo", () => {
    expect(checkName("PROG", "zdemo_x")).toBe("ZDEMO_X");
    expect(checkName("CLAS", "/DZ/CL_X")).toBe("/DZ/CL_X");
    expect(() => checkName("PROG", "RSDEMO")).toThrow(/espacio de nombres de cliente/);
    expect(() => checkName("FUGR", "Z" + "X".repeat(26))).toThrow(/hasta 26 caracteres/);
  });

  it("paquete transportable sin orden: no se elige una por la persona", async () => {
    const { ctx } = setup();
    await expect(def.preview!({ ...base, transport: undefined }, ctx())).rejects.toMatchObject({ kind: "INPUT", message: expect.stringMatching(/indica la orden/) });
  });

  it("sin paquete no hay $TMP por defecto; paquete local con orden es un error", async () => {
    const { ctx } = setup({ korrflag: "" });
    await expect(def.preview!({ ...base, package: undefined }, ctx())).rejects.toMatchObject({ message: expect.stringMatching(/No se usa \$TMP por defecto/) });
    await expect(def.preview!(base, ctx())).rejects.toMatchObject({ message: expect.stringMatching(/es local: sus objetos no viajan/) });
  });

  it("si ya existe, remite a write_source", async () => {
    const { ctx } = setup({ exists: true });
    await expect(def.preview!(base, ctx())).rejects.toMatchObject({ message: expect.stringMatching(/Ya existe .* usa write_source/) });
  });

  it("si el sistema no publica la creación de ese tipo por ADT, lo dice (CAPABILITY)", async () => {
    const { ctx } = setup({ collections: ["/sap/bc/adt/programs/programs"] });
    await expect(def.preview!(base, ctx())).rejects.toMatchObject({ kind: "CAPABILITY", hint: expect.stringMatching(/SAP GUI/) });
  });

  it("la vista previa muestra idioma del sistema, validación de SAP y orden, y fija el estado «no existe»", async () => {
    const { ctx } = setup();
    const p: any = await def.preview!({ ...base, source: "REPORT zdemo_report." }, ctx());
    expect(p.text).toMatch(/Crear programa \(report\) ZDEMO_REPORT «Demo»/);
    expect(p.text).toMatch(/Idioma maestro: ES \(el del sistema\)/);
    expect(p.text).toMatch(/SAP valida el nombre y el paquete/);
    expect(p.text).toMatch(/Orden DEVK900123: modificable/);
    expect(p.state).toBe(stateOf("absent|PROG|ZDEMO_REPORT"));
  });

  it("un módulo de función usa el paquete de su grupo y avisa del flag RFC", async () => {
    const { ctx } = setup({ groupPkg: "ZDEMO" });
    const p: any = await def.preview!({ ...base, object_type: "FUNC", name: "Z_DEMO_FM", package: undefined, function_group: "ZDEMO_FG" }, ctx());
    expect(p.text).toMatch(/En el grupo ZDEMO_FG \(paquete ZDEMO\)/);
    expect(p.text).toMatch(/RFC .* SE37/);
    const { ctx: noGroup } = setup();
    await expect(def.preview!({ ...base, object_type: "FUNC", name: "Z_DEMO_FM", function_group: "ZNOPE" }, noGroup())).rejects.toMatchObject({ kind: "NOT_FOUND" });
  });
});

describe("create_object · creación", () => {
  it("crea con idioma maestro del sistema, responsable y orden, relee, comprueba sintaxis, guarda y activa", async () => {
    const { ctx, created, written } = setup();
    const r: any = await def.run({ ...base, source: "REPORT zdemo_report.\nWRITE 1." }, ctx(stateOf("absent|PROG|ZDEMO_REPORT")));
    expect(created[0]).toMatchObject({ objtype: "PROG/P", name: "ZDEMO_REPORT", parentName: "ZDEMO", language: "ES", masterLanguage: "ES", responsible: "DEV_ME", transport: "DEVK900123" });
    expect(written).toEqual(["DEVK900123:REPORT zdemo_report.\nWRITE 1."]);
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/Programa \(report\) ZDEMO_REPORT creado en el paquete ZDEMO, orden DEVK900123/);
    expect(r.text).toMatch(/Activado sin errores/);
  });

  it("con errores de sintaxis no guarda la fuente y lo dice", async () => {
    const { ctx, written } = setup();
    const r: any = await def.run({ ...base, source: "REPORT x.\nROTO" }, ctx());
    expect(written).toEqual([]);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/La fuente inicial NO se guardó/);
  });

  it("si SAP dice «creado» pero el objeto no aparece al releerlo, no se da por bueno", async () => {
    const { ctx } = setup({ notFoundAfter: true });
    const r: any = await def.run(base, ctx());
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/no aparece al releerlo/);
  });

  it("si otra persona lo creó entre la vista previa y la confirmación, no se pisa", async () => {
    const { ctx, created } = setup({ exists: true });
    const r: any = await def.run(base, ctx(stateOf("absent|PROG|ZDEMO_REPORT")));
    expect(created).toEqual([]);
    expect(r.text).toMatch(/No se creó nada: ya existe/);
  });

  it("tabla de diccionario: en un 7.50 sin la colección remite a ddic_plan; en S/4 se crea con su fuente DDL", async () => {
    const ddl = "@EndUserText.label : 'Demo'\ndefine table zdemo_tlog {\n  key client : abap.clnt;\n  key id : abap.char(10);\n}";
    const args = { object_type: "TABL", name: "ZDEMO_TLOG", description: "Demo", package: "ZDEMO", transport: "DEVK900123", source: ddl, activate: true };
    const ecc = setup();
    await expect(def.preview!(args, ecc.ctx())).rejects.toMatchObject({ kind: "CAPABILITY", hint: expect.stringMatching(/ddic_plan/) });
    const s4 = setup({ collections: [...ALL, "/sap/bc/adt/ddic/tables", "/sap/bc/adt/ddic/tables/validation"] });
    const p: any = await def.preview!(args, s4.ctx());
    expect(p.text).toMatch(/Crear tabla de diccionario ZDEMO_TLOG/);
    const r: any = await def.run(args, s4.ctx(p.state));
    expect(s4.created[0]).toMatchObject({ objtype: "TABL/DT", name: "ZDEMO_TLOG", parentName: "ZDEMO", transport: "DEVK900123" });
    expect(s4.written[0]).toBe(`DEVK900123:${ddl}`);
    expect(typeof r === "string" ? r : r.text).toMatch(/creado en el paquete ZDEMO.*Fuente inicial guardada/s);
  });

  it("una tabla transparente admite 16 caracteres; una estructura, 30", () => {
    expect(() => checkName("TABL", "ZDEMO_TABLA_MUY_LARGA")).toThrow(/hasta 16/);
    expect(checkName("STRU", "ZDEMO_ESTRUCTURA_MUY_LARGA_X")).toBe("ZDEMO_ESTRUCTURA_MUY_LARGA_X");
  });

  it("es una tool de escritura con vista previa: el registro exige confirmación", () => {
    expect(def.access).toBe("write");
    expect(typeof def.preview).toBe("function");
  });
});
