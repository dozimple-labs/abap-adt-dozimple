import { z } from "zod";
import type { ADTClient } from "abap-adt-api";

/** Los tipos no se exportan desde la raíz de la librería: se derivan de las firmas del cliente. */
export type DomainProperties = Parameters<ADTClient["setDomainProperties"]>[1];
export type DataElementProperties = Parameters<ADTClient["setDataElementProperties"]>[1];

/**
 * Propiedades de dominios y elementos de datos tal como las escribe ADT (S/4 y NW ≥ 7.51). Se validan antes de
 * tocar SAP para que un error de forma no deje un objeto a medias.
 */
export const DomainPropsSchema = z.object({
  typeInformation: z.object({
    datatype: z.string().min(1).describe("Tipo ABAP del diccionario: CHAR, NUMC, DATS, DEC, INT4…"),
    length: z.number().int().min(0),
    decimals: z.number().int().min(0).default(0),
  }),
  outputInformation: z
    .object({
      length: z.number().int().min(0).optional(),
      style: z.string().optional(),
      conversionExit: z.string().optional(),
      signExists: z.boolean().default(false),
      lowercase: z.boolean().default(false),
      ampmFormat: z.boolean().default(false),
    })
    .prefault({}),
  valueInformation: z
    .object({
      valueTableRef: z.string().default(""),
      appendExists: z.boolean().default(false),
      fixValues: z.array(z.object({ low: z.string(), high: z.string().optional(), text: z.string().optional() })).optional(),
    })
    .optional(),
});

export const DataElementPropsSchema = z.object({
  typeName: z.string().min(1).describe("Dominio (dataType DOMAIN) o tipo predefinido (dataType PREDEFINED)"),
  dataType: z.string().min(1).describe("DOMAIN · PREDEFINED · REFTYPE"),
  dataTypeLength: z.number().int().min(0).default(0),
  dataTypeDecimals: z.number().int().min(0).optional(),
  fieldLabels: z.object({
    shortFieldLabel: z.string().max(10),
    shortFieldLength: z.number().int().optional(),
    mediumFieldLabel: z.string().max(20),
    mediumFieldLength: z.number().int().optional(),
    longFieldLabel: z.string().max(40),
    longFieldLength: z.number().int().optional(),
    headingFieldLabel: z.string().max(55),
    headingFieldLength: z.number().int().optional(),
  }),
  searchHelp: z.string().optional(),
  searchHelpParameter: z.string().optional(),
  setGetParameter: z.string().optional(),
  defaultComponentName: z.string().optional(),
  deactivateInputHistory: z.boolean().optional(),
  changeDocument: z.boolean().optional(),
  leftToRightDirection: z.boolean().optional(),
  deactivateBIDIFiltering: z.boolean().optional(),
});

export type DdicKind = "DTEL" | "DOMA";

export function parseDdicProps(kind: DdicKind, raw: unknown): DomainProperties | DataElementProperties {
  const r = (kind === "DOMA" ? DomainPropsSchema : DataElementPropsSchema).safeParse(raw);
  if (!r.success) {
    const why = r.error.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("; ");
    throw new Error(`ddic_properties de ${kind} inválidas: ${why}`);
  }
  if (kind === "DOMA") {
    const d = r.data as z.infer<typeof DomainPropsSchema>;
    return { typeInformation: d.typeInformation, outputInformation: { length: d.outputInformation.length ?? d.typeInformation.length, ...d.outputInformation }, valueInformation: d.valueInformation } as DomainProperties;
  }
  return r.data as DataElementProperties;
}

/** Resumen legible para la vista previa. */
export function describeDdicProps(kind: DdicKind, p: DomainProperties | DataElementProperties): string {
  if (kind === "DOMA") {
    const d = p as DomainProperties;
    const fix = d.valueInformation?.fixValues?.length ? ` · ${d.valueInformation.fixValues.length} valores fijos` : "";
    const vt = d.valueInformation?.valueTableRef ? ` · tabla de valores ${d.valueInformation.valueTableRef}` : "";
    return `${d.typeInformation.datatype} ${d.typeInformation.length}${d.typeInformation.decimals ? `,${d.typeInformation.decimals}` : ""} · salida ${d.outputInformation.length}${d.outputInformation.conversionExit ? ` · exit ${d.outputInformation.conversionExit}` : ""}${d.outputInformation.lowercase ? " · minúsculas" : ""}${d.outputInformation.signExists ? " · con signo" : ""}${vt}${fix}`;
  }
  const e = p as DataElementProperties;
  return `${e.dataType} ${e.typeName}${e.dataTypeLength ? ` ${e.dataTypeLength}${e.dataTypeDecimals ? `,${e.dataTypeDecimals}` : ""}` : ""} · etiquetas «${e.fieldLabels.shortFieldLabel}» / «${e.fieldLabels.mediumFieldLabel}» / «${e.fieldLabels.longFieldLabel}» / «${e.fieldLabels.headingFieldLabel}»${e.searchHelp ? ` · ayuda ${e.searchHelp}` : ""}`;
}
