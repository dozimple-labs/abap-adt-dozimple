import { z } from "zod";
import type { ADTClient, NewObjectOptions } from "abap-adt-api";
import { activateObject } from "../../core/activation.js";
import { isError, renderSyntax, syntaxCheck } from "../../core/checks.js";
import { stateOf } from "../../core/confirm.js";
import type { SapConnection } from "../../core/connection.js";
import { normalizeError, ToolError } from "../../core/errors.js";
import { resolveObject, sourceUrl, sqlLiteral, type ResolvedObject } from "../../core/objects.js";
import { assertTrkorr } from "../../core/policy.js";
import { defineTool } from "../../core/tool.js";
import { transportWarnings } from "../../core/transport.js";

/**
 * Crear objetos ABAP nuevos en desarrollo, con las mismas garantías que write_source: vista previa, confirmación
 * humana, orden explícita, registro de auditoría y solo en sistemas DEV con escritura habilitada.
 *
 * Lecciones que recoge (de abap-fs, del ABAP Accelerator de AWS y de lo anotado con report_gap):
 * - Idioma maestro = el del sistema configurado. La librería y el Accelerator crean en EN por defecto.
 * - Nunca $TMP por defecto ni orden elegida por el servidor: el paquete y la orden los dice la persona.
 * - Solo tipos con código fuente. Elementos de datos, dominios y tablas por ADT crean un «cascarón» sin tipo que no
 *   se activa (y en NW 7.50 tablas y paquetes ni siquiera se pueden crear por ADT).
 * - Tras crear se relee el objeto: abap-fs llegó a responder «creado» con un módulo de función que luego nadie podía
 *   abrir. Si no aparece, se dice.
 * - La fuente inicial se comprueba con la sintaxis real de SAP ANTES de guardarla y se guarda entera en un solo
 *   guardado (una clase escrita por trozos no activa: «Implementation missing for method X»).
 * - El flag RFC de un módulo de función no viaja en la fuente: se avisa de que va en SE37.
 */

const KINDS = {
  PROG: { adt: "PROG/P", label: "programa (report)", maxLen: 30 },
  INCL: { adt: "PROG/I", label: "include", maxLen: 30 },
  CLAS: { adt: "CLAS/OC", label: "clase", maxLen: 30 },
  INTF: { adt: "INTF/OI", label: "interfaz", maxLen: 30 },
  FUGR: { adt: "FUGR/F", label: "grupo de funciones", maxLen: 26 },
  FUNC: { adt: "FUGR/FF", label: "módulo de función", maxLen: 30 },
  DDLS: { adt: "DDLS/DF", label: "vista CDS (DDL)", maxLen: 30 },
  DCLS: { adt: "DCLS/DL", label: "control de acceso CDS (DCL)", maxLen: 30 },
} as const;
type Kind = keyof typeof KINDS;

/** Colecciones ADT exactas que debe publicar el sistema para crear cada tipo (creación y validación). */
const COLLECTIONS: Record<Kind, string[]> = {
  PROG: ["/sap/bc/adt/programs/programs", "/sap/bc/adt/programs/validation"],
  INCL: ["/sap/bc/adt/programs/includes", "/sap/bc/adt/includes/validation"],
  CLAS: ["/sap/bc/adt/oo/classes", "/sap/bc/adt/oo/validation/objectname"],
  INTF: ["/sap/bc/adt/oo/interfaces", "/sap/bc/adt/oo/validation/objectname"],
  FUGR: ["/sap/bc/adt/functions/groups", "/sap/bc/adt/functions/validation"],
  FUNC: ["/sap/bc/adt/functions/groups", "/sap/bc/adt/functions/validation"],
  DDLS: ["/sap/bc/adt/ddic/ddl/sources", "/sap/bc/adt/ddic/ddl/validation"],
  DCLS: ["/sap/bc/adt/acm/dcl/sources", "/sap/bc/adt/acm/dcl/validation"],
};

/** Espacio de nombres de cliente: Z o Y, o un namespace /XXX/ registrado. */
const CUSTOMER_NAME = /^(?:[ZY][A-Z0-9_]*|\/[A-Z0-9_]{1,10}\/[A-Z0-9_]+)$/;

export function checkName(kind: Kind, raw: string): string {
  const name = raw.trim().toUpperCase();
  if (!CUSTOMER_NAME.test(name)) throw new ToolError("INPUT", `«${name}» no está en el espacio de nombres de cliente (Z*, Y* o /NAMESPACE/).`);
  if (name.length > KINDS[kind].maxLen) throw new ToolError("INPUT", `Un ${KINDS[kind].label} admite hasta ${KINDS[kind].maxLen} caracteres; «${name}» tiene ${name.length}.`);
  return name;
}

/** ¿Existe ya un objeto con ese nombre en el espacio de nombres que comparte ese tipo? */
export async function existingObject(sap: SapConnection, kind: Kind, name: string): Promise<string | undefined> {
  const lit = sqlLiteral(name);
  const probe: Record<Kind, [string, string]> = {
    PROG: [`SELECT name FROM trdir WHERE name = ${lit}`, "programa o include"],
    INCL: [`SELECT name FROM trdir WHERE name = ${lit}`, "programa o include"],
    CLAS: [`SELECT clsname FROM seoclass WHERE clsname = ${lit}`, "clase o interfaz"],
    INTF: [`SELECT clsname FROM seoclass WHERE clsname = ${lit}`, "clase o interfaz"],
    FUGR: [`SELECT obj_name FROM tadir WHERE pgmid = 'R3TR' AND object = 'FUGR' AND obj_name = ${lit}`, "grupo de funciones"],
    FUNC: [`SELECT funcname FROM tfdir WHERE funcname = ${lit}`, "módulo de función"],
    DDLS: [`SELECT obj_name FROM tadir WHERE pgmid = 'R3TR' AND object = 'DDLS' AND obj_name = ${lit}`, "vista CDS"],
    DCLS: [`SELECT obj_name FROM tadir WHERE pgmid = 'R3TR' AND object = 'DCLS' AND obj_name = ${lit}`, "control de acceso CDS"],
  };
  const [sql, what] = probe[kind];
  return (await sap.query(sql, 1)).values.length ? what : undefined;
}

interface Target {
  kind: Kind;
  name: string;
  description: string;
  pkg: string;
  local: boolean;
  group?: string;
  transport?: string;
}

/** Paquete (o, para un módulo de función, el paquete de su grupo) y regla de orden: transportable exige orden. */
async function resolveTarget(sap: SapConnection, a: Args): Promise<Target> {
  const kind = a.object_type;
  const name = checkName(kind, a.name);
  let pkg: string;
  let group: string | undefined;
  if (kind === "FUNC") {
    if (!a.function_group) throw new ToolError("INPUT", "Un módulo de función necesita function_group: el grupo donde se crea.");
    group = a.function_group.trim().toUpperCase();
    const g = await sap.query(`SELECT devclass FROM tadir WHERE pgmid = 'R3TR' AND object = 'FUGR' AND obj_name = ${sqlLiteral(group)}`, 1);
    if (!g.values.length) throw new ToolError("NOT_FOUND", `El grupo de funciones ${group} no existe: créalo antes con object_type=FUGR.`);
    pkg = String(g.values[0].DEVCLASS).trim();
  } else {
    if (!a.package) throw new ToolError("INPUT", "Indica package: el paquete donde se crea el objeto. No se usa $TMP por defecto.");
    pkg = a.package.trim().toUpperCase();
  }
  const local = pkg === "$TMP" || pkg.startsWith("$");
  let transportable = false;
  if (!local) {
    const p = await sap.query(`SELECT devclass, korrflag FROM tdevc WHERE devclass = ${sqlLiteral(pkg)}`, 1);
    if (!p.values.length) throw new ToolError("NOT_FOUND", `El paquete ${pkg} no existe en este sistema (los paquetes se crean en SE21).`);
    transportable = p.values[0].KORRFLAG === "X";
  }
  const transport = a.transport ? assertTrkorr(a.transport) : undefined;
  if (transportable && !transport) throw new ToolError("INPUT", `El paquete ${pkg} es transportable: indica la orden (transport). El servidor nunca elige la orden por ti.`);
  if (!transportable && transport) throw new ToolError("INPUT", `El paquete ${pkg} es local: sus objetos no viajan y no llevan orden. Quita transport o usa un paquete transportable.`);
  return { kind, name, description: a.description.trim(), pkg, local: !transportable, group, transport };
}

const input = {
  object_type: z.enum(Object.keys(KINDS) as [Kind, ...Kind[]]).describe(
    "PROG programa · INCL include · CLAS clase · INTF interfaz · FUGR grupo de funciones · FUNC módulo de función · DDLS vista CDS · DCLS control de acceso CDS",
  ),
  name: z.string().min(1).max(40),
  description: z.string().min(1).max(60).describe("Texto breve (en el idioma del sistema)"),
  package: z.string().optional().describe("Paquete de desarrollo. Obligatorio salvo FUNC (usa el del grupo). $TMP solo si se pide expresamente"),
  function_group: z.string().optional().describe("Solo FUNC: grupo de funciones donde se crea"),
  transport: z.string().optional().describe("Orden (o tarea). Obligatoria si el paquete es transportable"),
  source: z.string().optional().describe("Fuente inicial completa. Se comprueba la sintaxis antes de guardarla; una clase, entera"),
  activate: z.boolean().default(true).describe("Activar tras guardar la fuente inicial"),
};
type Args = z.objectOutputType<typeof input, z.ZodTypeAny>;

async function missingCollections(sap: SapConnection, kind: Kind): Promise<string[]> {
  const caps = await sap.capabilities();
  if (!caps.known) return [];
  return COLLECTIONS[kind].filter((c) => !caps.collections.includes(c));
}

async function sapValidation(c: ADTClient, t: Target): Promise<string> {
  try {
    const opts =
      t.kind === "FUNC"
        ? { objtype: "FUGR/FF" as const, objname: t.name, description: t.description, fugrname: t.group! }
        : { objtype: KINDS[t.kind].adt as "PROG/P", objname: t.name, description: t.description, packagename: t.pkg };
    const r = await c.validateNewObject(opts);
    return r.SEVERITY && r.SEVERITY !== "OK" ? `SAP avisa (${r.SEVERITY}): ${r.SHORT_TEXT ?? ""}` : "SAP valida el nombre y el paquete: correcto.";
  } catch (e) {
    throw new ToolError("SAP", `SAP rechaza crear ${t.name}: ${normalizeError(e).message}`);
  }
}

const absentState = (t: Target) => stateOf(`absent|${t.kind}|${t.name}`);

async function readBack(c: ADTClient, t: Target): Promise<ResolvedObject | undefined> {
  for (let i = 0; i < 2; i++) {
    try {
      return await resolveObject(c, t.name, t.kind);
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return undefined;
}

export default defineTool({
  name: "create_object",
  title: "Crear objeto ABAP",
  description:
    "Crea un objeto ABAP nuevo en un sistema de desarrollo: programa, include, clase, interfaz, grupo de funciones, " +
    "módulo de función, vista CDS o control de acceso CDS. Exige paquete y, si es transportable, la orden (nunca elige " +
    "una por su cuenta). Opcional: fuente inicial, que se comprueba con la sintaxis de SAP antes de guardarse, y " +
    "activación. Primero muestra una vista previa (validación de SAP, orden, idioma) y solo crea tras la confirmación. " +
    "Para modificar objetos que ya existen, write_source.",
  access: "write",
  timeoutMs: 180_000,
  input,
  async preview(a, { sap, system }) {
    const t = await resolveTarget(sap, a);
    const miss = await missingCollections(sap, t.kind);
    if (miss.length) {
      throw new ToolError("CAPABILITY", `${system.id} no permite crear un ${KINDS[t.kind].label} por ADT (faltan ${miss.join(", ")}). Hay que crearlo en el SAP GUI.`);
    }
    const exists = await existingObject(sap, t.kind, t.name);
    if (exists) throw new ToolError("INPUT", `Ya existe un ${exists} llamado ${t.name}: para cambiarlo usa write_source.`);
    const c = await sap.adt();
    const validation = await sapValidation(c, t);
    const out = [
      `Crear ${KINDS[t.kind].label} ${t.name} «${t.description}»`,
      t.kind === "FUNC" ? `En el grupo ${t.group} (paquete ${t.pkg})` : `En el paquete ${t.pkg}`,
      `Idioma maestro: ${system.language} (el del sistema) · responsable: ${system.user}`,
      validation,
    ];
    if (t.local) out.push("⚠ Paquete LOCAL: el objeto no viajará a calidad ni a productivo.");
    else {
      const warn = await transportWarnings(sap, t.transport!, system.user);
      out.push(warn.length ? `⚠ AVISOS DE LA ORDEN ${t.transport}:\n${warn.map((w) => "  ⚠ " + w).join("\n")}` : `Orden ${t.transport}: modificable, con destino y del usuario de esta conexión.`);
    }
    if (a.source) {
      const lines = a.source.split("\n").length;
      out.push(
        `Fuente inicial: ${lines} líneas. Su sintaxis se comprueba con SAP en cuanto el objeto exista y ANTES de guardarla; ` +
          `si tiene errores, el objeto queda creado vacío y la fuente no se guarda.${a.activate ? " Después se activa." : " No se activa."}`,
      );
    } else out.push("Sin fuente inicial: se crea con el esqueleto que genera SAP.");
    if (t.kind === "FUNC") out.push("Si debe ser RFC (remote-enabled), esa marca no viaja en la fuente: se pone en SE37.");
    return { text: out.join("\n"), state: absentState(t) };
  },
  async run(a, { sap, system, confirmedState }) {
    const t = await resolveTarget(sap, a);
    // Lo confirmado fue «no existe»: si alguien lo creó entretanto, no se pisa.
    const exists = await existingObject(sap, t.kind, t.name);
    if (exists || (confirmedState && confirmedState !== absentState(t))) {
      return { text: `No se creó nada: ya existe un ${exists ?? "objeto"} ${t.name} (se creó después de la vista previa).`, isError: true };
    }
    const c = await sap.adt();
    const options: NewObjectOptions = {
      objtype: KINDS[t.kind].adt,
      name: t.name,
      parentName: t.kind === "FUNC" ? t.group! : t.pkg,
      parentPath: t.kind === "FUNC" ? `/sap/bc/adt/functions/groups/${encodeURIComponent(t.group!.toLowerCase())}` : `/sap/bc/adt/packages/${encodeURIComponent(t.pkg)}`,
      description: t.description,
      responsible: system.user,
      transport: t.transport,
      language: system.language,
      masterLanguage: system.language,
    };
    let createError: string | undefined;
    try {
      await c.createObject(options);
    } catch (e) {
      createError = normalizeError(e, system.id).message;
    }
    const obj = await readBack(c, t);
    if (!obj) {
      return {
        text: createError
          ? `No se creó ${t.name}: ${createError}`
          : `SAP respondió que creó ${t.name}, pero el objeto no aparece al releerlo. Revísalo en SE80 antes de reintentar.`,
        isError: true,
      };
    }
    const lines = [
      `${KINDS[t.kind].label[0].toUpperCase()}${KINDS[t.kind].label.slice(1)} ${obj.name} creado en ${t.kind === "FUNC" ? `el grupo ${t.group}` : `el paquete ${t.pkg}`}` +
        `${t.transport ? `, orden ${t.transport}` : " (local)"}.`,
    ];
    if (createError) lines.push(`Nota: SAP devolvió «${createError}», pero el objeto existe al releerlo.`);
    if (!a.source) return lines.join("\n");

    const url = await sourceUrl(c, obj);
    const msgs = await syntaxCheck(c, obj, url, a.source);
    if (msgs.some(isError)) {
      lines.push(`La fuente inicial NO se guardó: tiene errores de sintaxis. El objeto queda creado con el esqueleto de SAP.\n${renderSyntax(msgs)}`);
      return { text: lines.join("\n"), isError: true };
    }
    await sap.stateful(async (s) => {
      const lock = await s.lock(obj.uri);
      try {
        await s.setObjectSource(url, a.source!, lock.LOCK_HANDLE, t.transport || undefined);
      } finally {
        await s.unLock(obj.uri, lock.LOCK_HANDLE).catch(() => undefined);
      }
    });
    lines.push(`Fuente inicial guardada (${a.source.split("\n").length} líneas, sintaxis sin errores${msgs.length ? `, ${msgs.length} avisos` : ""}).`);
    if (!a.activate) return `${lines.join("\n")}\nSin activar (activate=false).`;
    const act = await activateObject(c, obj);
    lines.push(act.text);
    return { text: lines.join("\n"), isError: !act.ok };
  },
});
