import { describe, expect, it } from "vitest";
import { z } from "zod";
import { checkSpec, DDIC_SPEC, references, toInstructions } from "../src/core/ddicspec.js";
import type { ToolDef } from "../src/core/tool.js";
import ddicPlan from "../src/tools/core/ddic_plan.js";

const parse = (o: Record<string, unknown>) => z.object(DDIC_SPEC).parse({ package: "zdemo_pkg", task: "devk900124", ...o });

const FULL = {
  description: "Demo",
  domains: [{ name: "ZDM_ESTADO", type: "CHAR", length: 1, text: "Estado", values: [{ value: "A", text: "Activo" }, { value: "B", text: "Baja" }] }],
  data_elements: [{ name: "ZED_ESTADO", domain: "ZDM_ESTADO", text: "Estado del registro", label: "Estado" }],
  tables: [
    {
      name: "ZDEMO_LOG", kind: "table", text: "Log demo", delivery_class: "A", data_class: "APPL1", size_category: "0",
      fields: [{ name: "MANDT", data_element: "MANDT", key: true }, { name: "ID", data_element: "SYSUUID_C", key: true }, { name: "ESTADO", data_element: "ZED_ESTADO" }],
    },
    { name: "ZES_DEMO_ROW", kind: "structure", text: "Fila demo", fields: [{ name: "ID", data_element: "SYSUUID_C" }] },
  ],
  table_types: [{ name: "ZTT_DEMO_ROW", row_type: "ZES_DEMO_ROW", text: "Filas demo" }],
  function_groups: [{ name: "ZDEMO_API", text: "API demo" }],
  functions: [{ name: "ZDEMO_RFC_GET", group: "ZDEMO_API", text: "Lee el log", rfc: true, importing: [{ name: "IV_ID", type: "SYSUUID_C", optional: true }], tables: [{ name: "ET_ROWS", type: "ZES_DEMO_ROW" }] }],
  modify: { tables: [{ name: "ZDEMO_OLD", fields: [{ name: "ORIGEN", data_element: "CHAR20" }] }], domains: [{ name: "ZDM_OLD", length: 30 }] },
};

describe("especificación de DDIC → instrucciones del generador", () => {
  it("genera el fichero línea a línea, con tabuladores y sin campos vacíos al final", () => {
    expect(toInstructions(parse(FULL)).split("\n")).toEqual([
      "DZGEN\t1",
      "TEXT\tDemo",
      "PKG\tZDEMO_PKG",
      "TASK\tDEVK900124",
      "DOMA\tZDM_ESTADO\tCHAR\t1\tEstado\tA=Activo|B=Baja",
      "DTEL\tZED_ESTADO\tZDM_ESTADO\tEstado del registro\tEstado\tEstado",
      "TABL\tZDEMO_LOG\tTRANSP\tLog demo\tA\t\tAPPL1\t0",
      "FIELD\tMANDT\tMANDT\tX",
      "FIELD\tID\tSYSUUID_C\tX",
      "FIELD\tESTADO\tZED_ESTADO",
      "TABL\tZES_DEMO_ROW\tINTTAB\tFila demo",
      "FIELD\tID\tSYSUUID_C",
      "TTYP\tZTT_DEMO_ROW\tZES_DEMO_ROW\tS\tFilas demo",
      "FUGR\tZDEMO_API\tAPI demo",
      "FUNC\tZDEMO_RFC_GET\tZDEMO_API\tLee el log\tX",
      "PARAM\tI\tIV_ID\tSYSUUID_C\tX",
      "PARAM\tT\tET_ROWS\tZES_DEMO_ROW\t\tX",
      "MDOMA\tZDM_OLD\t30",
      "MTABL\tZDEMO_OLD",
      "FIELD\tORIGEN\tCHAR20",
      "",
    ]);
  });

  it("separa lo que se crea de lo que se modifica y lo que se referencia sin crear", () => {
    const spec = parse(FULL);
    const { created, modified } = checkSpec(spec);
    expect(created.map((o) => `${o.type} ${o.name}`)).toEqual(["DOMA ZDM_ESTADO", "DTEL ZED_ESTADO", "TABL ZDEMO_LOG", "TABL ZES_DEMO_ROW", "TTYP ZTT_DEMO_ROW", "FUGR ZDEMO_API", "FUNC ZDEMO_RFC_GET"]);
    expect(modified.map((o) => `${o.type} ${o.name}`)).toEqual(["DOMA ZDM_OLD", "TABL ZDEMO_OLD"]);
    expect(references(spec)).toEqual({ dataElements: ["CHAR20", "MANDT", "SYSUUID_C"], domains: [], rowTypes: [] });
  });

  it("reglas de tablas: MANDT primero, claves seguidas, atributos técnicos, 16 caracteres", () => {
    const t = (over: Record<string, unknown>) => parse({ tables: [{ ...FULL.tables[0], ...over }] });
    expect(() => checkSpec(t({ fields: [{ name: "ID", data_element: "X", key: true }] }))).toThrow(/debe empezar por la clave MANDT/);
    expect(() => checkSpec(t({ fields: [{ name: "MANDT", data_element: "MANDT", key: true }, { name: "A", data_element: "X" }, { name: "B", data_element: "X", key: true }] }))).toThrow(/campos clave van primero y seguidos/);
    expect(() => checkSpec(t({ data_class: undefined }))).toThrow(/faltan delivery_class, data_class o size_category/);
    expect(() => checkSpec(t({ name: "ZDEMO_TABLA_MUY_LARGA" }))).toThrow(/máximo 16/);
  });

  it("solo Z/Y, sin duplicados, sin modificar lo que la misma especificación crea, y nunca vacía", () => {
    expect(() => checkSpec(parse({ domains: [{ name: "MARA_X", type: "CHAR", length: 1, text: "x" }] }))).toThrow(/espacio de clientes/);
    expect(() => checkSpec(parse({ tables: [FULL.tables[1], FULL.tables[1]] }))).toThrow(/duplicado/);
    expect(() => checkSpec(parse({ tables: [FULL.tables[1]], modify: { tables: [{ name: "ZES_DEMO_ROW", text: "otro" }] } }))).toThrow(/esta misma especificación lo crea/);
    expect(() => checkSpec(parse({ modify: { tables: [{ name: "ZDEMO_OLD" }] } }))).toThrow(/no indica ningún cambio/);
    expect(() => checkSpec(parse({}))).toThrow(/ningún objeto que crear ni modificar/);
    expect(() => checkSpec(parse({ data_elements: [{ name: "ZED_X", domain: "ZDM_X", text: "t", label: "Etiqueta muy larga" }] }))).toThrow(/indica short_label/);
  });

  it("el esquema rechaza tabuladores, separadores de valores y una orden mal escrita", () => {
    expect(() => parse({ domains: [{ name: "ZDM_X", type: "CHAR", length: 1, text: "a\tb" }] })).toThrow();
    expect(() => parse({ domains: [{ name: "ZDM_X", type: "CHAR", length: 1, text: "x", values: [{ value: "A|B", text: "x" }] }] })).toThrow();
    expect(() => z.object(DDIC_SPEC).parse({ package: "Z", task: "no-es-tarea" })).toThrow();
  });
});

describe("ddic_plan · comprobaciones contra el sistema", () => {
  /** Sistema falso: qué existe en cada tabla. */
  function sap(o: { task?: Record<string, string> | null; tadir?: string[]; dtel?: string[]; pkg?: boolean; generator?: boolean } = {}) {
    const tadir = new Set([...(o.generator === false ? [] : ["PROG|ZDZ_DDIC_GEN"]), "TABL|ZDEMO_OLD", "DOMA|ZDM_OLD", ...(o.tadir ?? [])]);
    const names = (sql: string) => [...sql.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    return {
      query: async (sql: string) => {
        if (/FROM tdevc/.test(sql)) return { values: o.pkg === false ? [] : [{ DEVCLASS: "ZDEMO_PKG" }] };
        if (/FROM e070/.test(sql)) return { values: o.task === null ? [] : [o.task ?? { TRKORR: "DEVK900124", STRKORR: "DEVK900123", TRSTATUS: "D", AS4USER: "DEV_ME" }] };
        if (/FROM tadir/.test(sql)) {
          const type = /object = '(\w+)'/.exec(sql)![1];
          return { values: names(sql).filter((n) => tadir.has(`${type}|${n}`)).map((n) => ({ OBJ_NAME: n })) };
        }
        if (/FROM tfdir/.test(sql)) return { values: [] };
        if (/FROM dd04l/.test(sql)) return { values: names(sql).filter((n) => (o.dtel ?? ["MANDT", "SYSUUID_C", "CHAR20"]).includes(n)).map((n) => ({ ROLLNAME: n })) };
        return { values: [] };
      },
    };
  }
  const run = (s: any, over: Record<string, unknown> = {}) => (ddicPlan as ToolDef<any>).run(parse({ ...FULL, ...over }), { sap: s, system: { id: "DEV", user: "DEV_ME" } } as any) as Promise<any>;

  it("todo en orden: devuelve las instrucciones", async () => {
    const r = await run(sap());
    expect(r).toMatch(/7 objetos a crear y 2 a modificar · paquete ZDEMO_PKG · tarea DEVK900124/);
    expect(r).toMatch(/sin problemas/);
    expect(r).toMatch(/--- instrucciones ---\nDZGEN\t1\n/);
  });

  it("problemas (referencias que faltan, objeto a modificar inexistente, orden en vez de tarea): no hay instrucciones", async () => {
    const r = await run(sap({ dtel: ["MANDT"], task: { TRKORR: "DEVK900124", STRKORR: "", TRSTATUS: "D", AS4USER: "DEV_ME" } }), { modify: { tables: [{ name: "ZDEMO_NOPE", text: "x" }] } });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/es una orden, no una tarea/);
    expect(r.text).toMatch(/El elemento de datos SYSUUID_C no existe activo/);
    expect(r.text).toMatch(/modify: TABL ZDEMO_NOPE no existe/);
    expect(r.text).not.toMatch(/DZGEN/);
  });

  it("avisos que no bloquean: objeto que ya existe, tarea de otra persona, generador sin instalar", async () => {
    const r = await run(sap({ tadir: ["TABL|ZDEMO_LOG"], task: { TRKORR: "DEVK900124", STRKORR: "DEVK900123", TRSTATUS: "D", AS4USER: "OTHER" }, generator: false }));
    expect(r).toMatch(/TABL ZDEMO_LOG ya existe: el generador lo omitirá/);
    expect(r).toMatch(/no es del usuario de esta conexión/);
    expect(r).toMatch(/ZDZ_DDIC_GEN no existe en este sistema/);
    expect(r).toMatch(/--- instrucciones ---/);
  });

  it("paquete inexistente o grupo de funciones que nadie crea", async () => {
    const r = await run(sap({ pkg: false }), { function_groups: [] });
    expect(r.text).toMatch(/El paquete ZDEMO_PKG no existe/);
    expect(r.text).toMatch(/El grupo de funciones ZDEMO_API no existe y la especificación no lo crea/);
  });
});
