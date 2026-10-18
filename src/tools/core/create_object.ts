import { z } from "zod";
import type { ADTClient, NewObjectOptions } from "abap-adt-api";
import { activateObject } from "../../core/activation.js";
import { isError, renderSyntax, syntaxCheck } from "../../core/checks.js";
import { stateOf } from "../../core/confirm.js";
import type { SapConnection } from "../../core/connection.js";
import { describeDdicProps, parseDdicProps, type DataElementProperties, type DomainProperties } from "../../core/ddicprops.js";
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
  /** Solo donde ADT expone el diccionario con fuente (S/4 y NW ≥ 7.51): en ECC 7.50 no existe la colección y se remite a ddic_plan. */
  TABL: { adt: "TABL/DT", label: "tabla de diccionario", maxLen: 16 },
  STRU: { adt: "TABL/DS", label: "estructura de diccionario", maxLen: 30 },
  TTYP: { adt: "TTYP/DA", label: "tipo tabla", maxLen: 30 },
  DTEL: { adt: "DTEL/DE", label: "elemento de datos", maxLen: 30 },
  DOMA: { adt: "DOMA/DD", label: "dominio", maxLen: 30 },
  /** RAP (S/4): metadatos CDS, definición de servicio, binding y definición de comportamiento. */
  DDLX: { adt: "DDLX/EX", label: "extensión de metadatos CDS (DDLX)", maxLen: 30 },
  SRVD: { adt: "SRVD/SRV", label: "definición de servicio (SRVD)", maxLen: 30 },
  SRVB: { adt: "SRVB/SVB", label: "binding de servicio OData V2 (SRVB)", maxLen: 26 },
  BDEF: { adt: "BDEF/BDO", label: "definición de comportamiento (BDEF)", maxLen: 30 },
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
  TABL: ["/sap/bc/adt/ddic/tables", "/sap/bc/adt/ddic/tables/validation"],
  STRU: ["/sap/bc/adt/ddic/structures", "/sap/bc/adt/ddic/structures/validation"],
  TTYP: ["/sap/bc/adt/ddic/tabletypes", "/sap/bc/adt/ddic/tabletypes/validation"],
  DTEL: ["/sap/bc/adt/ddic/dataelements", "/sap/bc/adt/ddic/dataelements/validation"],
  DOMA: ["/sap/bc/adt/ddic/domains", "/sap/bc/adt/ddic/domains/validation"],
  DDLX: ["/sap/bc/adt/ddic/ddlx/sources", "/sap/bc/adt/ddic/ddlx/sources/validation"],
  SRVD: ["/sap/bc/adt/ddic/srvd/sources", "/sap/bc/adt/ddic/srvd/sources/validation"],
  SRVB: ["/sap/bc/adt/businessservices/bindings", "/sap/bc/adt/businessservices/bindings/validation"],
  BDEF: ["/sap/bc/adt/bo/behaviordefinitions"],
};

/** Tipos cuyo contenido es un texto fuente (se guarda con setObjectSource) frente a los que llevan propiedades. */
const SOURCE_KINDS = new Set<Kind>(["PROG", "INCL", "CLAS", "INTF", "FUGR", "FUNC", "DDLS", "DCLS", "TABL", "STRU", "TTYP", "DDLX", "SRVD", "BDEF"]);
const PROPS_KINDS = new Set<Kind>(["DTEL", "DOMA"]);
const DDIC_KINDS = new Set<Kind>(["TABL", "STRU", "TTYP", "DTEL", "DOMA"]);


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
    TABL: [`SELECT tabname FROM dd02l WHERE tabname = ${lit}`, "tabla o estructura de diccionario"],
    STRU: [`SELECT tabname FROM dd02l WHERE tabname = ${lit}`, "tabla o estructura de diccionario"],
    TTYP: [`SELECT typename FROM dd40l WHERE typename = ${lit}`, "tipo tabla"],
    DTEL: [`SELECT rollname FROM dd04l WHERE rollname = ${lit}`, "elemento de datos"],
    DOMA: [`SELECT domname FROM dd01l WHERE domname = ${lit}`, "dominio"],
    DDLX: [`SELECT obj_name FROM tadir WHERE pgmid = 'R3TR' AND object = 'DDLX' AND obj_name = ${lit}`, "extensión de metadatos"],
    SRVD: [`SELECT obj_name FROM tadir WHERE pgmid = 'R3TR' AND object = 'SRVD' AND obj_name = ${lit}`, "definición de servicio"],
    SRVB: [`SELECT obj_name FROM tadir WHERE pgmid = 'R3TR' AND object = 'SRVB' AND obj_name = ${lit}`, "binding de servicio"],
    BDEF: [`SELECT obj_name FROM tadir WHERE pgmid = 'R3TR' AND object = 'BDEF' AND obj_name = ${lit}`, "definición de comportamiento"],
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
  if (kind === "SRVB" && !a.service_definition) throw new ToolError("INPUT", "Un binding de servicio necesita service_definition (la SRVD que publica).");
  if (PROPS_KINDS.has(kind) && a.source) throw new ToolError("INPUT", `Un ${KINDS[kind].label} no tiene fuente: sus propiedades van en ddic_properties.`);
  if (!PROPS_KINDS.has(kind) && a.ddic_properties) throw new ToolError("INPUT", "ddic_properties solo aplica a DTEL y DOMA.");
  if (PROPS_KINDS.has(kind) && a.ddic_properties) {
    try {
      parseDdicProps(kind as "DTEL" | "DOMA", a.ddic_properties);
    } catch (e) {
      throw new ToolError("INPUT", (e as Error).message);
    }
  }
  return { kind, name, description: a.description.trim(), pkg, local: !transportable, group, transport };
}

const input = {
  object_type: z.enum(Object.keys(KINDS) as [Kind, ...Kind[]]).describe(
    "PROG programa · INCL include · CLAS clase · INTF interfaz · FUGR grupo de funciones · FUNC módulo de función · DDLS vista CDS · DCLS control de acceso CDS · " +
      "S/4 o NW ≥ 7.51: TABL tabla · STRU estructura · TTYP tipo tabla · DTEL elemento de datos · DOMA dominio (con ddic_properties) · DDLX metadatos CDS · SRVD definición de servicio · SRVB binding OData V2 · BDEF definición de comportamiento",
  ),
  name: z.string().min(1).max(40),
  description: z.string().min(1).max(60).describe("Texto breve (en el idioma del sistema)"),
  package: z.string().optional().describe("Paquete de desarrollo. Obligatorio salvo FUNC (usa el del grupo). $TMP solo si se pide expresamente"),
  function_group: z.string().optional().describe("Solo FUNC: grupo de funciones donde se crea"),
  transport: z.string().optional().describe("Orden (o tarea). Obligatoria si el paquete es transportable"),
  source: z.string().optional().describe("Fuente inicial completa. Se comprueba la sintaxis antes de guardarla; una clase, entera. Tablas, estructuras y tipos tabla: sintaxis DDL de ADT (@EndUserText.label … define table ztab { key client : abap.clnt; … }). BDEF/SRVD/DDLX: su fuente RAP"),
  ddic_properties: z.record(z.unknown()).optional().describe("Solo DTEL y DOMA: propiedades como en ADT. DOMA: { typeInformation: { datatype, length, decimals }, outputInformation: { length, conversionExit, lowercase, signExists }, valueInformation: { valueTableRef, fixValues: [{ low, high, text }] } }. DTEL: { dataType: 'DOMAIN'|'PREDEFINED', typeName, dataTypeLength, dataTypeDecimals, fieldLabels: { shortFieldLabel, mediumFieldLabel, longFieldLabel, headingFieldLabel }, searchHelp }"),
  service_definition: z.string().optional().describe("Solo SRVB: definición de servicio (SRVD) que publica"),
  activate: z.boolean().default(true).describe("Activar tras guardar la fuente inicial o las propiedades"),
};
type Args = z.objectOutputType<typeof input, z.ZodTypeAny>;

async function missingCollections(sap: SapConnection, kind: Kind): Promise<string[]> {
  const caps = await sap.capabilities();
  if (!caps.known) return [];
  return COLLECTIONS[kind].filter((c) => !caps.collections.includes(c));
}

async function sapValidation(c: ADTClient, t: Target, a: Args): Promise<string> {
  if (t.kind === "BDEF") return "SAP no ofrece validación previa para definiciones de comportamiento: el nombre se comprueba al crear.";
  try {
    const opts =
      t.kind === "FUNC"
        ? { objtype: "FUGR/FF" as const, objname: t.name, description: t.description, fugrname: t.group! }
        : t.kind === "SRVB"
          ? { objtype: "SRVB/SVB" as const, objname: t.name, description: t.description, serviceBindingVersion: "ODATA\\V2" as const, serviceDefinition: a.service_definition!.trim().toUpperCase(), package: t.pkg }
          : { objtype: KINDS[t.kind].adt as "PROG/P", objname: t.name, description: t.description, packagename: t.pkg };
    const r = await c.validateNewObject(opts as Parameters<ADTClient["validateNewObject"]>[0]);
    return r.SEVERITY && r.SEVERITY !== "OK" ? `SAP avisa (${r.SEVERITY}): ${r.SHORT_TEXT ?? ""}` : "SAP valida el nombre y el paquete: correcto.";
  } catch (e) {
    throw new ToolError("SAP", `SAP rechaza crear ${t.name}: ${normalizeError(e).message}`);
  }
}

const absentState = (t: Target) => stateOf(`absent|${t.kind}|${t.name}`);

const xmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * abap-adt-api no conoce las definiciones de comportamiento: se crean como «blue source» (el formato genérico de
 * objetos con fuente que anuncia el discovery: application/vnd.sap.adt.blues.v1+xml). El tipo de implementación
 * (managed, unmanaged, projection…) lo declara la propia fuente. Verificado en vivo en un S/4 758 (HTTP 201).
 */
export const BDEF_CONTENT_TYPE = "application/vnd.sap.adt.blues.v1+xml";
export function behaviorDefinitionBody(o: { name: string; description: string; pkg: string; responsible: string; language: string }): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<blue:blueSource xmlns:blue="http://www.sap.com/wbobj/blue" xmlns:adtcore="http://www.sap.com/adt/core" ` +
    `adtcore:description="${xmlEsc(o.description)}" adtcore:name="${xmlEsc(o.name)}" adtcore:type="BDEF/BDO" adtcore:language="${o.language}" ` +
    `adtcore:masterLanguage="${o.language}" adtcore:responsible="${xmlEsc(o.responsible)}">` +
    `<adtcore:packageRef adtcore:name="${xmlEsc(o.pkg)}"/></blue:blueSource>`
  );
}

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
    "Crea un objeto nuevo en desarrollo: programa, include, clase, interfaz, grupo o módulo de función, CDS y, en " +
    "S/4 o NW ≥ 7.51, diccionario (tabla, estructura, tipo tabla, elemento de datos, dominio) y RAP (DDLX, SRVD, " +
    "SRVB, BDEF). Exige paquete y orden si es transportable. Fuente o propiedades iniciales opcionales. Vista " +
    "previa y confirmación. Para objetos existentes, write_source.",
  access: "write",
  timeoutMs: 180_000,
  input,
  async preview(a, { sap, system }) {
    const t = await resolveTarget(sap, a);
    const miss = await missingCollections(sap, t.kind);
    if (miss.length) {
      throw new ToolError(
        "CAPABILITY",
        `${system.id} no permite crear ${KINDS[t.kind].label} por ADT (faltan ${miss.join(", ")}).`,
        DDIC_KINDS.has(t.kind)
          ? "En ECC / NW 7.50 el diccionario no se crea por ADT: usa ddic_plan y el generador en SE38."
          : ["DDLX", "SRVD", "SRVB", "BDEF"].includes(t.kind)
            ? "Los objetos RAP solo existen en S/4HANA (NW ≥ 7.51)."
            : "Hay que crearlo en el SAP GUI.",
      );
    }
    const exists = await existingObject(sap, t.kind, t.name);
    if (exists) throw new ToolError("INPUT", `Ya existe un ${exists} llamado ${t.name}: para cambiarlo usa write_source.`);
    const c = await sap.adt();
    const validation = await sapValidation(c, t, a);
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
    if (t.kind === "SRVB") out.push(`Publica la definición de servicio ${a.service_definition!.trim().toUpperCase()} como OData V2 (categoría estándar). Publicarlo en el gateway (/IWFND/MAINT_SERVICE o «Publish» en Eclipse) es un paso aparte.`);
    if (t.kind === "BDEF") out.push("El tipo de implementación (managed, unmanaged, projection…) lo declara la fuente: dala en source o escríbela después con write_source.");
    if (DDIC_KINDS.has(t.kind)) out.push("Objeto de diccionario: solo donde ADT lo expone (S/4 y NW ≥ 7.51); en 7.50 usa ddic_plan.");
    if (PROPS_KINDS.has(t.kind)) {
      if (a.ddic_properties) out.push(`Propiedades: ${describeDdicProps(t.kind as "DTEL" | "DOMA", parseDdicProps(t.kind as "DTEL" | "DOMA", a.ddic_properties))}.${a.activate ? " Después se activa." : ""}`);
      else out.push("Sin ddic_properties: se crea vacío y NO se activa (un dominio o elemento sin tipo no activa). Complétalo después con write_ddic_properties.");
    } else if (a.source) {
      const lines = a.source.split("\n").length;
      out.push(
        `Fuente inicial: ${lines} líneas. Su sintaxis se comprueba con SAP en cuanto el objeto exista y ANTES de guardarla; ` +
          `si tiene errores, el objeto queda creado vacío y la fuente no se guarda.${a.activate ? " Después se activa." : " No se activa."}`,
      );
    } else if (SOURCE_KINDS.has(t.kind)) out.push("Sin fuente inicial: se crea con el esqueleto que genera SAP.");
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
      objtype: KINDS[t.kind].adt as NewObjectOptions["objtype"],
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
      if (t.kind === "BDEF") {
        await c.httpClient.request("/sap/bc/adt/bo/behaviordefinitions", {
          method: "POST",
          qs: t.transport ? { corrNr: t.transport } : undefined,
          headers: { "Content-Type": BDEF_CONTENT_TYPE, Accept: `${BDEF_CONTENT_TYPE}, application/xml, */*` },
          body: behaviorDefinitionBody({ name: t.name, description: t.description, pkg: t.pkg, responsible: system.user, language: system.language }),
        });
      } else if (t.kind === "SRVB") {
        await c.createObject({ ...options, service: a.service_definition!.trim().toUpperCase(), bindingtype: "ODATA", category: "0" } as NewObjectOptions);
      } else await c.createObject(options);
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
    if (PROPS_KINDS.has(t.kind)) {
      if (!a.ddic_properties) return `${lines.join("\n")}\nSin propiedades: queda vacío e inactivo. Complétalo con write_ddic_properties.`;
      const props = parseDdicProps(t.kind as "DTEL" | "DOMA", a.ddic_properties);
      // Los metadatos (sistema maestro, paquete con su URI…) se toman de lo que SAP acaba de crear: construirlos a
      // mano con un sistema maestro vacío devuelve «Verificación de condición fallida» (verificado en un 758).
      await sap.stateful(async (s) => {
        const cur = t.kind === "DOMA" ? await s.getDomainProperties(obj.uri) : await s.getDataElementProperties(obj.uri);
        const meta = { ...cur.metaData, description: t.description || cur.metaData.description, responsible: cur.metaData.responsible || system.user };
        const lock = await s.lock(obj.uri);
        try {
          if (t.kind === "DOMA") await s.setDomainProperties(obj.uri, props as DomainProperties, meta, lock.LOCK_HANDLE, t.transport || undefined);
          else await s.setDataElementProperties(obj.uri, props as DataElementProperties, meta, lock.LOCK_HANDLE, t.transport || undefined);
        } finally {
          await s.unLock(obj.uri, lock.LOCK_HANDLE).catch(() => undefined);
        }
      });
      lines.push(`Propiedades guardadas: ${describeDdicProps(t.kind as "DTEL" | "DOMA", props)}.`);
      if (!a.activate) return `${lines.join("\n")}\nSin activar (activate=false).`;
      const act = await activateObject(c, obj);
      lines.push(act.text);
      return { text: lines.join("\n"), isError: !act.ok };
    }
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
