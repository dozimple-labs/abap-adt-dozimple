import type { ADTClient } from "abap-adt-api";
import { ToolError } from "./errors.js";

/**
 * Cambio de paquete de un objeto por el refactoring de ADT («Change Package Assignment» en Eclipse). Petición propia y
 * no la de abap-adt-api: esa función escribe en la salida estándar, que aquí es el canal MCP.
 *
 * Dos pasos de SAP: `preview` (valida y devuelve lo que cambiará, sin tocar nada) y `execute`.
 */
export interface PackageMove {
  name: string;
  /** Tipo ADT, p. ej. PROG/P. */
  type: string;
  uri: string;
  oldPackage: string;
  newPackage: string;
  transport: string;
}

const REFACTORINGS = "/sap/bc/adt/refactorings";
const REL = "http://www.sap.com/adt/relations/refactoring/changepackage";
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function generic(m: PackageMove): string {
  return (
    `<generic:genericRefactoring>` +
    `<generic:title>Change Package</generic:title>` +
    `<generic:adtObjectUri>${xml(m.uri)}</generic:adtObjectUri>` +
    `<generic:affectedObjects>` +
    `<generic:affectedObject adtcore:name="${xml(m.name)}" adtcore:packageName="${xml(m.oldPackage)}" adtcore:type="${xml(m.type)}" adtcore:uri="${xml(m.uri)}">` +
    `<generic:userContent></generic:userContent>` +
    `<generic:changePackageDelta><generic:newPackage>${xml(m.newPackage)}</generic:newPackage></generic:changePackageDelta>` +
    `</generic:affectedObject>` +
    `</generic:affectedObjects>` +
    `<generic:transport>${xml(m.transport)}</generic:transport>` +
    `<generic:ignoreSyntaxErrorsAllowed>false</generic:ignoreSyntaxErrorsAllowed>` +
    `<generic:ignoreSyntaxErrors>false</generic:ignoreSyntaxErrors>` +
    `<generic:userContent/>` +
    `</generic:genericRefactoring>`
  );
}

export function previewBody(m: PackageMove): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<changepackage:changePackageRefactoring xmlns:adtcore="http://www.sap.com/adt/core" ` +
    `xmlns:generic="http://www.sap.com/adt/refactoring/genericrefactoring" ` +
    `xmlns:changepackage="http://www.sap.com/adt/refactoring/changepackagerefactoring">` +
    `<changepackage:oldPackage>${xml(m.oldPackage)}</changepackage:oldPackage>` +
    `<changepackage:newPackage>${xml(m.newPackage)}</changepackage:newPackage>` +
    generic(m) +
    `<changepackage:userContent></changepackage:userContent>` +
    `</changepackage:changePackageRefactoring>`
  );
}

const HEADERS = { "Content-Type": "application/*", Accept: "application/*" };

/** Paso `preview` de SAP: no cambia nada. Devuelve la orden que SAP propone (o la pedida) para detectar discrepancias. */
export async function sapPreview(c: ADTClient, m: PackageMove): Promise<{ transport: string; raw: string }> {
  const r = await c.httpClient.request(REFACTORINGS, { method: "POST", qs: { step: "preview", rel: REL }, body: previewBody(m), headers: HEADERS });
  const raw = String(r.body ?? "");
  const tr = /<generic:transport>([^<]*)<\/generic:transport>/.exec(raw)?.[1]?.trim() ?? "";
  return { transport: tr, raw };
}

/** Paso `execute`: se envía tal cual lo que devolvió `preview`, como hace Eclipse. */
export async function sapExecute(c: ADTClient, previewRaw: string): Promise<void> {
  const r = await c.httpClient.request(REFACTORINGS, { method: "POST", qs: { step: "execute" }, body: previewRaw, headers: HEADERS });
  if (r.status >= 300) throw new ToolError("SAP", `SAP no cambió el paquete (HTTP ${r.status} ${r.statusText ?? ""}).`);
}
