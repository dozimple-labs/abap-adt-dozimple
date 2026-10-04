import { z } from "zod";
import type { SapConnection } from "../../core/connection.js";
import { checkSpec, DDIC_SPEC, references, toInstructions, type DdicSpec, type SpecObject } from "../../core/ddicspec.js";
import { sqlLiteral } from "../../core/objects.js";
import { defineTool } from "../../core/tool.js";

/** Programa que ejecuta las instrucciones en SAP. Es un componente de DoZimple que no se distribuye con este repositorio. */
export const GENERATOR_PROGRAM = "ZDZ_DDIC_GEN";

const inList = (names: string[]) => names.map(sqlLiteral).join(", ");

async function existing(sap: SapConnection, sql: (list: string) => string, names: string[], column: string): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < names.length; i += 40) {
    const part = names.slice(i, i + 40);
    const r = await sap.query(sql(inList(part)), part.length * 2);
    for (const v of r.values) found.add(String(v[column]).trim());
  }
  return found;
}

const tadir = (object: string) => (list: string) => `SELECT obj_name FROM tadir WHERE pgmid = 'R3TR' AND object = '${object}' AND obj_name IN ( ${list} )`;

/** Los objetos de la lista que ya están en el sistema. */
async function present(sap: SapConnection, objs: SpecObject[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const type of [...new Set(objs.map((o) => o.type))]) {
    const names = objs.filter((o) => o.type === type).map((o) => o.name);
    const found =
      type === "FUNC"
        ? await existing(sap, (l) => `SELECT funcname FROM tfdir WHERE funcname IN ( ${l} )`, names, "FUNCNAME")
        : await existing(sap, tadir(type), names, "OBJ_NAME");
    for (const n of found) out.add(`${type}|${n}`);
  }
  return out;
}

export interface PlanChecks {
  problems: string[];
  warnings: string[];
}

export async function checkAgainstSystem(sap: SapConnection, spec: DdicSpec, created: SpecObject[], modified: SpecObject[], user: string): Promise<PlanChecks> {
  const problems: string[] = [];
  const warnings: string[] = [];

  const gen = await sap.query(tadir("PROG")(sqlLiteral(GENERATOR_PROGRAM)), 1);
  if (!gen.values.length) {
    warnings.push(`El programa ${GENERATOR_PROGRAM} no existe en este sistema: las instrucciones no se pueden ejecutar hasta instalarlo (componente de DoZimple, no incluido aquí).`);
  }

  const pkg = await sap.query(`SELECT devclass FROM tdevc WHERE devclass = ${sqlLiteral(spec.package)}`, 1);
  if (!pkg.values.length) problems.push(`El paquete ${spec.package} no existe (los paquetes se crean en SE21).`);

  const task = (await sap.query(`SELECT trkorr, strkorr, trstatus, as4user FROM e070 WHERE trkorr = ${sqlLiteral(spec.task)}`, 1)).values[0];
  if (!task) problems.push(`La tarea ${spec.task} no existe.`);
  else if (!String(task.STRKORR ?? "").trim()) problems.push(`${spec.task} es una orden, no una tarea: el generador necesita la tarea.`);
  else if (task.TRSTATUS !== "D") problems.push(`La tarea ${spec.task} no es modificable.`);
  else if (String(task.AS4USER).trim().toUpperCase() !== user.toUpperCase()) {
    warnings.push(`La tarea ${spec.task} no es del usuario de esta conexión: el generador solo la acepta si la ejecuta su propietario.`);
  }

  const have = await present(sap, [...created, ...modified]);
  for (const o of created) if (have.has(`${o.type}|${o.name}`)) warnings.push(`${o.type} ${o.name} ya existe: el generador lo omitirá (no lo cambia). Para cambiarlo, ponlo en modify.`);
  for (const o of modified) if (!have.has(`${o.type}|${o.name}`)) problems.push(`modify: ${o.type} ${o.name} no existe en el sistema.`);

  const newGroups = new Set(spec.function_groups.map((g) => g.name));
  const groups = [...new Set(spec.functions.map((f) => f.group))].filter((g) => !newGroups.has(g));
  if (groups.length) {
    const found = await existing(sap, tadir("FUGR"), groups, "OBJ_NAME");
    for (const g of groups) if (!found.has(g)) problems.push(`El grupo de funciones ${g} no existe y la especificación no lo crea.`);
  }

  const ref = references(spec);
  if (ref.dataElements.length) {
    const found = await existing(sap, (l) => `SELECT rollname FROM dd04l WHERE as4local = 'A' AND rollname IN ( ${l} )`, ref.dataElements, "ROLLNAME");
    for (const n of ref.dataElements) if (!found.has(n)) problems.push(`El elemento de datos ${n} no existe activo y la especificación no lo crea.`);
  }
  if (ref.domains.length) {
    const found = await existing(sap, (l) => `SELECT domname FROM dd01l WHERE as4local = 'A' AND domname IN ( ${l} )`, ref.domains, "DOMNAME");
    for (const n of ref.domains) if (!found.has(n)) problems.push(`El dominio ${n} no existe activo y la especificación no lo crea.`);
  }
  if (ref.rowTypes.length) {
    const found = await existing(sap, (l) => `SELECT tabname FROM dd02l WHERE as4local = 'A' AND tabname IN ( ${l} )`, ref.rowTypes, "TABNAME");
    for (const n of ref.rowTypes) if (!found.has(n)) problems.push(`El tipo de fila ${n} no existe activo y la especificación no lo crea.`);
  }
  return { problems, warnings };
}

export default defineTool({
  name: "ddic_plan",
  title: "Preparar objetos de diccionario (NW 7.50)",
  description:
    "Para sistemas donde ADT no crea ni modifica tablas, estructuras, dominios, elementos de datos ni tipos tabla " +
    "(ECC / NW 7.50): valida una especificación de objetos nuevos y de cambios (añadir campos, valores, textos), comprueba " +
    "contra el sistema el paquete, la tarea, los nombres y todo lo que referencia, y devuelve el fichero de instrucciones " +
    `que una persona ejecuta en SE38 con el programa ${GENERATOR_PROGRAM} (primero en simulación). Esta tool NO modifica SAP: ` +
    "solo lee y prepara. También cubre grupos y módulos de función con su interfaz y la marca RFC.",
  access: "read",
  input: DDIC_SPEC,
  async run(a, { sap, system }) {
    const spec = z.object(DDIC_SPEC).parse(a) as DdicSpec;
    const { created, modified } = checkSpec(spec);
    const { problems, warnings } = await checkAgainstSystem(sap, spec, created, modified, system.user);
    const head = `${created.length} objetos a crear y ${modified.length} a modificar · paquete ${spec.package} · tarea ${spec.task}`;
    if (problems.length) {
      return {
        text: `${head}\n\nNO se generan instrucciones: hay ${problems.length} problemas.\n${problems.map((p) => "  ✗ " + p).join("\n")}` + (warnings.length ? `\n\nAvisos:\n${warnings.map((w) => "  ⚠ " + w).join("\n")}` : ""),
        isError: true,
      };
    }
    const text = toInstructions(spec);
    return [
      head,
      warnings.length ? `\nAvisos:\n${warnings.map((w) => "  ⚠ " + w).join("\n")}` : "\nComprobado contra el sistema: paquete, tarea, nombres y referencias, sin problemas.",
      `\nGuarda lo que sigue TAL CUAL (con sus tabuladores, UTF-8) en un fichero «<nombre>.dzgen.txt». Después una persona ejecuta ` +
        `${GENERATOR_PROGRAM} en SE38, elige el fichero, lo lanza primero con la simulación marcada, revisa el listado y lo repite sin ella. ` +
        `Los cambios que alargan campos de tablas con datos piden marcar P_DBADJ; los que acortan o cambian de tipo se rechazan.`,
      "\n--- instrucciones ---",
      text.trimEnd(),
      "--- fin ---",
    ].join("\n");
  },
});
