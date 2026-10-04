import { z } from "zod";
import type { SapConnection } from "../../core/connection.js";
import { buildEdmx, type DdicField, type EntityDef } from "../../core/edmx.js";
import { ToolError } from "../../core/errors.js";
import { sqlLiteral } from "../../core/objects.js";
import { defineTool } from "../../core/tool.js";
import { sapLanguage } from "./function_modules.js";

const IDENT = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/, "letras, dígitos y «_», hasta 40");
const DDIC_NAME = z.string().regex(/^(\/[A-Za-z0-9_]+\/)?[A-Za-z0-9_]{1,30}$/, "nombre de tabla, estructura o vista").transform((s) => s.toUpperCase());
const FIELD = z.string().regex(/^[A-Za-z0-9_/]{1,30}$/).transform((s) => s.toUpperCase());

const input = {
  namespace: IDENT.describe("Namespace del esquema; en SEGW suele ser el nombre del proyecto, p. ej. ZDEMO_SRV"),
  entities: z
    .array(
      z.object({
        name: IDENT.describe("Tipo de entidad, p. ej. SalesOrder"),
        source: DDIC_NAME.describe("Tabla, estructura o vista DDIC de la que salen las propiedades"),
        set: IDENT.optional().describe("Nombre del entity set; por defecto name + Set"),
        keys: z.array(FIELD).optional().describe("Campos clave. Por defecto, los de la tabla (sin el mandante). Obligatorio en estructuras"),
        fields: z.array(FIELD).optional().describe("Solo estos campos (las claves se incluyen siempre). Por defecto, todos"),
      }),
    )
    .min(1)
    .max(30),
  associations: z
    .array(
      z.object({
        name: IDENT,
        from: IDENT.describe("Entidad principal (extremo 1)"),
        to: IDENT.describe("Entidad dependiente"),
        multiplicity: z.enum(["1", "0..1", "*"]).default("*").describe("Cardinalidad del extremo «to»"),
        on: z.array(z.tuple([FIELD, FIELD])).min(1).describe("Pares [campo de from, campo de to] que enlazan"),
        navigation: IDENT.optional().describe("Propiedad de navegación en «from»; por defecto To + destino"),
      }),
    )
    .default([]),
};

/** Campos activos de una tabla/estructura/vista, en su orden, con la etiqueta del elemento de datos. */
async function ddicFields(sap: SapConnection, source: string, lang: string): Promise<DdicField[]> {
  const r = await sap.query(
    `SELECT fieldname, position, keyflag, rollname, datatype, leng, decimals FROM dd03l WHERE tabname = ${sqlLiteral(source)} AND as4local = 'A' ORDER BY position`,
    1000,
  );
  // Las filas «.INCLUDE» / «.APPEND» son marcadores: sus campos ya vienen expandidos.
  const rows = r.values.filter((v) => !String(v.FIELDNAME).startsWith("."));
  if (!rows.length) throw new ToolError("NOT_FOUND", `${source} no existe activa en el diccionario, o no tiene campos.`);
  const rolls = [...new Set(rows.map((v) => String(v.ROLLNAME ?? "").trim()).filter(Boolean))];
  const labels = new Map<string, { text: string; rank: number }>();
  const rank = (l: unknown) => (l === lang ? 2 : l === "E" ? 1 : 0);
  for (let i = 0; i < rolls.length; i += 40) {
    const part = rolls.slice(i, i + 40);
    const t = await sap.query(`SELECT rollname, ddlanguage, scrtext_m, ddtext FROM dd04t WHERE as4local = 'A' AND rollname IN ( ${part.map(sqlLiteral).join(", ")} )`, part.length * 40);
    for (const v of t.values) {
      const k = String(v.ROLLNAME).trim();
      const text = String(v.SCRTEXT_M ?? "").trim() || String(v.DDTEXT ?? "").trim();
      const cur = labels.get(k);
      if (text && (!cur || rank(v.DDLANGUAGE) > cur.rank)) labels.set(k, { text, rank: rank(v.DDLANGUAGE) });
    }
  }
  return rows.map((v) => ({
    name: String(v.FIELDNAME).trim(),
    key: v.KEYFLAG === "X",
    datatype: String(v.DATATYPE).trim(),
    length: Number(v.LENG) || 0,
    decimals: Number(v.DECIMALS) || 0,
    label: labels.get(String(v.ROLLNAME ?? "").trim())?.text,
  }));
}

export default defineTool({
  name: "odata_model",
  title: "Modelo OData (EDMX) desde el diccionario",
  description:
    "Genera el modelo de un servicio OData V2 (fichero EDMX: entity types, entity sets, asociaciones y navegación) a " +
    "partir de tablas, estructuras o vistas del diccionario, con tipos, longitudes, claves y etiquetas reales. Es para " +
    "importarlo en un proyecto de SEGW (Data Model → Import → Data Model from File) en sistemas ECC / NW 7.50, en vez de " +
    "definir cada propiedad a mano. Solo lee el diccionario: crear el proyecto, importar, generar las clases y registrar " +
    "el servicio siguen siendo pasos manuales en SEGW y /IWFND/MAINT_SERVICE; el código de DPC_EXT se escribe después " +
    "con write_source. Para servicios de solo lectura suele bastar una vista CDS con @OData.publish.",
  access: "read",
  input,
  async run({ namespace, entities, associations }, { sap, system }) {
    const lang = sapLanguage(system.language);
    const defs: EntityDef[] = [];
    const notes: string[] = [];
    for (const e of entities) {
      let fields = await ddicFields(sap, e.source, lang);
      const has = (n: string) => fields.some((f) => f.name === n);
      for (const n of [...(e.keys ?? []), ...(e.fields ?? [])]) if (!has(n)) throw new ToolError("INPUT", `${e.name}: ${e.source} no tiene el campo ${n}.`);
      if (e.keys) fields = fields.map((f) => ({ ...f, key: e.keys!.includes(f.name) }));
      if (e.fields) fields = fields.filter((f) => f.key || e.fields!.includes(f.name));
      defs.push({ name: e.name, set: e.set, source: e.source, fields });
      notes.push(`${e.name} ← ${e.source}: ${fields.filter((f) => f.datatype !== "CLNT").length} propiedades, clave ${fields.filter((f) => f.key && f.datatype !== "CLNT").map((f) => f.name).join(" + ") || "—"}`);
    }
    const { xml, skipped } = buildEdmx(namespace, defs, associations);
    return [
      `Modelo ${namespace}: ${defs.length} entidades, ${associations.length} asociaciones.`,
      ...notes.map((n) => "  · " + n),
      ...(skipped.length ? [`Campos sin equivalente OData, no incluidos: ${skipped.join(", ")}.`] : []),
      "",
      `Guárdalo como «${namespace}.edmx» (UTF-8) e impórtalo en SEGW: Data Model → Import → Data Model from File. Después, en cada ` +
        "entidad, indica la estructura ABAP y revisa el nombre de campo ABAP de cada propiedad (la importación no los enlaza), " +
        "genera los objetos de runtime y registra el servicio. La importación en SEGW no está verificada por esta tool: revisa el resultado.",
      "",
      "--- edmx ---",
      xml.trimEnd(),
      "--- fin ---",
    ].join("\n");
  },
});
