import { ToolError } from "./errors.js";

/**
 * Modelo OData V2 (EDMX) a partir de tablas, estructuras o vistas del diccionario. Sirve para importarlo en un proyecto
 * de SEGW («Data Model → Import → Data Model from File») en vez de teclear cada propiedad. Lógica pura: los campos se
 * leen fuera.
 */
export interface DdicField {
  name: string;
  key: boolean;
  /** Tipo de diccionario: CHAR, NUMC, DATS, DEC… */
  datatype: string;
  length: number;
  decimals: number;
  label?: string;
}

export interface EntityDef {
  /** Nombre del tipo de entidad, p. ej. SalesOrder. */
  name: string;
  /** Nombre del conjunto; por defecto, name + "Set". */
  set?: string;
  source: string;
  fields: DdicField[];
}

export interface AssociationDef {
  name: string;
  from: string;
  to: string;
  /** Cardinalidad del extremo «to»: 1, 0..1 o *. El extremo «from» es siempre 1. */
  multiplicity: "1" | "0..1" | "*";
  /** Campos que enlazan: [campo de «from», campo de «to»]. */
  on: Array<[string, string]>;
  /** Nombre de la propiedad de navegación en «from»; por defecto, To + nombre del destino. */
  navigation?: string;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** VBELN → Vbeln, ERDAT_DOC → ErdatDoc. Es la forma que SEGW propone al importar una estructura. */
export const propertyName = (field: string) =>
  field
    .replace(/^\/[^/]+\//, "")
    .split("_")
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase())
    .join("");

/** Tipo de diccionario → atributos de la propiedad EDM. undefined = sin equivalente (no se puede exponer tal cual). */
export function edmType(f: DdicField): string | undefined {
  const len = f.length;
  switch (f.datatype.toUpperCase()) {
    case "CHAR":
    case "NUMC":
    case "LANG":
    case "UNIT":
    case "CUKY":
    case "CLNT":
    case "ACCP":
    case "LCHR":
    case "SSTR":
      return `Type="Edm.String" MaxLength="${len}"`;
    case "STRG":
      return `Type="Edm.String"`;
    case "DATS":
      return `Type="Edm.DateTime" Precision="0" sap:display-format="Date"`;
    case "TIMS":
      return `Type="Edm.Time" Precision="0"`;
    case "DEC":
    case "CURR":
    case "QUAN":
      return `Type="Edm.Decimal" Precision="${len}" Scale="${f.decimals}"`;
    case "INT1":
      return `Type="Edm.Byte"`;
    case "INT2":
      return `Type="Edm.Int16"`;
    case "INT4":
      return `Type="Edm.Int32"`;
    case "INT8":
      return `Type="Edm.Int64"`;
    case "FLTP":
      return `Type="Edm.Double"`;
    case "RAW":
      return len === 16 ? `Type="Edm.Guid"` : `Type="Edm.Binary" MaxLength="${len}"`;
    case "LRAW":
    case "RSTR":
      return `Type="Edm.Binary"`;
    default:
      return undefined;
  }
}

export interface EdmxResult {
  xml: string;
  /** Campos sin equivalente EDM, que se dejaron fuera: «ENTIDAD-CAMPO (TIPO)». */
  skipped: string[];
}

export function buildEdmx(namespace: string, entities: EntityDef[], associations: AssociationDef[] = []): EdmxResult {
  const bad = (m: string): never => {
    throw new ToolError("INPUT", m);
  };
  if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(namespace)) bad(`Namespace inválido: ${namespace}`);
  const names = new Set<string>();
  const skipped: string[] = [];
  const out: string[] = [];
  const byName = new Map<string, { def: EntityDef; props: Map<string, string> }>();

  for (const e of entities) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(e.name)) bad(`Nombre de entidad inválido: ${e.name}`);
    if (names.has(e.name)) bad(`Entidad duplicada: ${e.name}`);
    names.add(e.name);
    // El mandante no se expone: lo resuelve la sesión.
    const fields = e.fields.filter((f) => f.datatype.toUpperCase() !== "CLNT");
    const props = new Map<string, string>();
    const lines: string[] = [];
    const keys: string[] = [];
    for (const f of fields) {
      const t = edmType(f);
      const p = propertyName(f.name);
      if (!t || !p) {
        skipped.push(`${e.name}-${f.name} (${f.datatype})`);
        continue;
      }
      if ([...props.values()].includes(p)) bad(`${e.name}: los campos ${f.name} y otro dan la misma propiedad ${p}.`);
      props.set(f.name.toUpperCase(), p);
      if (f.key) keys.push(p);
      lines.push(`        <Property Name="${p}" ${t} Nullable="${f.key ? "false" : "true"}"${f.label ? ` sap:label="${xml(f.label)}"` : ""}/>`);
    }
    if (!keys.length) bad(`${e.name} (${e.source}): no tiene campos clave. Una entidad OData necesita clave: indica keys.`);
    byName.set(e.name, { def: e, props });
    out.push(
      `      <EntityType Name="${e.name}" sap:content-version="1">`,
      `        <Key>`,
      ...keys.map((k) => `          <PropertyRef Name="${k}"/>`),
      `        </Key>`,
      ...lines,
      ...associations.filter((a) => a.from === e.name).map((a) => `        <NavigationProperty Name="${a.navigation ?? "To" + a.to}" Relationship="${namespace}.${a.name}" FromRole="FromRole_${a.name}" ToRole="ToRole_${a.name}"/>`),
      `      </EntityType>`,
    );
  }

  const seenAssoc = new Set<string>();
  for (const a of associations) {
    if (seenAssoc.has(a.name) || names.has(a.name)) bad(`Nombre de asociación duplicado: ${a.name}`);
    seenAssoc.add(a.name);
    const from = byName.get(a.from);
    const to = byName.get(a.to);
    if (!from || !to) throw new ToolError("INPUT", `Asociación ${a.name}: ${!from ? a.from : a.to} no es una entidad del modelo.`);
    if (!a.on.length) bad(`Asociación ${a.name}: indica los campos que enlazan (on).`);
    const pair = a.on.map(([f, t]) => {
      const pf = from.props.get(f.toUpperCase());
      const pt = to.props.get(t.toUpperCase());
      if (!pf || !pt) bad(`Asociación ${a.name}: ${!pf ? `${a.from}-${f}` : `${a.to}-${t}`} no es un campo de la entidad.`);
      return [pf!, pt!];
    });
    out.push(
      `      <Association Name="${a.name}" sap:content-version="1">`,
      `        <End Type="${namespace}.${a.from}" Multiplicity="1" Role="FromRole_${a.name}"/>`,
      `        <End Type="${namespace}.${a.to}" Multiplicity="${a.multiplicity}" Role="ToRole_${a.name}"/>`,
      `        <ReferentialConstraint>`,
      `          <Principal Role="FromRole_${a.name}">`,
      ...pair.map(([pf]) => `            <PropertyRef Name="${pf}"/>`),
      `          </Principal>`,
      `          <Dependent Role="ToRole_${a.name}">`,
      ...pair.map(([, pt]) => `            <PropertyRef Name="${pt}"/>`),
      `          </Dependent>`,
      `        </ReferentialConstraint>`,
      `      </Association>`,
    );
  }

  const setOf = (n: string) => byName.get(n)!.def.set ?? `${n}Set`;
  out.push(
    `      <EntityContainer Name="${namespace}_Entities" m:IsDefaultEntityContainer="true" sap:supported-formats="atom json xlsx">`,
    ...entities.map((e) => `        <EntitySet Name="${setOf(e.name)}" EntityType="${namespace}.${e.name}" sap:content-version="1"/>`),
    ...associations.flatMap((a) => [
      `        <AssociationSet Name="${a.name}Set" Association="${namespace}.${a.name}" sap:content-version="1">`,
      `          <End EntitySet="${setOf(a.from)}" Role="FromRole_${a.name}"/>`,
      `          <End EntitySet="${setOf(a.to)}" Role="ToRole_${a.name}"/>`,
      `        </AssociationSet>`,
    ]),
    `      </EntityContainer>`,
  );

  const head = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<edmx:Edmx Version="1.0" xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata" xmlns:sap="http://www.sap.com/Protocols/SAPData">`,
    `  <edmx:DataServices m:DataServiceVersion="2.0">`,
    `    <Schema Namespace="${namespace}" xml:lang="es" sap:schema-version="1" xmlns="http://schemas.microsoft.com/ado/2008/09/edm">`,
  ];
  const tail = [`    </Schema>`, `  </edmx:DataServices>`, `</edmx:Edmx>`];
  return { xml: [...head, ...out, ...tail].join("\n") + "\n", skipped };
}
