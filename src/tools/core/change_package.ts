import { z } from "zod";
import { sapExecute, sapPreview, type PackageMove } from "../../core/changepackage.js";
import { stateOf } from "../../core/confirm.js";
import type { SapConnection } from "../../core/connection.js";
import { normalizeError, ToolError } from "../../core/errors.js";
import { resolveObject, sqlLiteral, TYPE_HELP } from "../../core/objects.js";
import { assertTrkorr } from "../../core/policy.js";
import { defineTool } from "../../core/tool.js";
import { transportWarnings } from "../../core/transport.js";

/**
 * Cambiar de paquete un objeto existente: el caso típico es sacar de $TMP algo que nació como prueba y registrarlo en
 * la orden que le corresponde. Es el «Change Package Assignment» de Eclipse; la orden nunca la elige el servidor.
 */
const input = {
  object_name: z.string().min(1),
  object_type: z.string().optional().describe(TYPE_HELP),
  package: z.string().min(1).describe("Paquete de destino. Debe existir (los paquetes se crean en SE21)"),
  transport: z.string().optional().describe("Orden (o tarea) donde se registra el objeto. Obligatoria si el paquete de destino es transportable"),
};
type Args = z.objectOutputType<typeof input, z.ZodTypeAny>;

const isLocal = (pkg: string) => pkg.startsWith("$");

/** Tipo R3TR del catálogo de objetos a partir del tipo ADT (PROG/P → PROG). Un módulo o un include no tienen entrada propia. */
const TADIR_TYPE = (adt: string) => adt.slice(0, 4);
const OWN_ENTRY = new Set(["PROG/P", "CLAS/OC", "INTF/OI", "FUGR/F", "DDLS/DF", "DCLS/DL", "TABL/DT", "TABL/DS", "DTEL/DE", "DOMA/DD", "TTYP/DA", "MSAG/N", "XSLT/VT", "DDLX/EX"]);

async function plan(sap: SapConnection, a: Args): Promise<{ move: PackageMove; targetLocal: boolean }> {
  const c = await sap.adt();
  const obj = await resolveObject(c, a.object_name, a.object_type);
  if (!OWN_ENTRY.has(obj.type.toUpperCase())) {
    throw new ToolError(
      "INPUT",
      `${obj.name} (${obj.type}) no tiene paquete propio: lo hereda del objeto que lo contiene.`,
      "Cambia el paquete del programa, del grupo de funciones o de la clase que lo contiene.",
    );
  }
  const t = await sap.query(
    `SELECT devclass, srcsystem FROM tadir WHERE pgmid = 'R3TR' AND object = ${sqlLiteral(TADIR_TYPE(obj.type))} AND obj_name = ${sqlLiteral(obj.name.toUpperCase())}`,
    1,
  );
  if (!t.values.length) throw new ToolError("NOT_FOUND", `${obj.name} no tiene entrada en el catálogo de objetos (TADIR).`);
  const oldPackage = String(t.values[0].DEVCLASS).trim();
  const newPackage = a.package.trim().toUpperCase();
  if (oldPackage === newPackage) throw new ToolError("INPUT", `${obj.name} ya está en el paquete ${newPackage}.`);
  const targetLocal = isLocal(newPackage);
  let transportable = false;
  if (!targetLocal) {
    const p = await sap.query(`SELECT devclass, korrflag FROM tdevc WHERE devclass = ${sqlLiteral(newPackage)}`, 1);
    if (!p.values.length) throw new ToolError("NOT_FOUND", `El paquete ${newPackage} no existe en este sistema (los paquetes se crean en SE21).`);
    transportable = p.values[0].KORRFLAG === "X";
  }
  const transport = a.transport ? assertTrkorr(a.transport) : "";
  if (transportable && !transport) throw new ToolError("INPUT", `El paquete ${newPackage} es transportable: indica transport (la orden donde se registra el objeto).`);
  if (targetLocal && transport) throw new ToolError("INPUT", `El paquete ${newPackage} es local: no lleva orden.`);
  return { move: { name: obj.name, type: obj.type, uri: obj.uri, oldPackage, newPackage, transport }, targetLocal };
}

const moveState = (m: PackageMove) => stateOf(`${m.type}|${m.name}|${m.oldPackage}`);

export default defineTool({
  name: "change_package",
  title: "Cambiar el paquete de un objeto",
  description:
    "Cambia de paquete un objeto existente (programa, clase, interfaz, grupo de funciones, CDS, objeto de diccionario) y " +
    "lo registra en la orden indicada: sirve para sacar de $TMP algo que nació como prueba. Es el «Change Package " +
    "Assignment» de Eclipse. La vista previa incluye la validación de SAP sin cambiar nada. No mueve módulos de función " +
    "ni includes sueltos (heredan el paquete de su contenedor) y nunca elige la orden.",
  access: "write",
  requires: { adt: ["/sap/bc/adt/refactorings"] },
  input,
  async preview(a, { sap, system }) {
    const { move, targetLocal } = await plan(sap, a);
    const out = [`${move.name} (${move.type}): paquete ${move.oldPackage} → ${move.newPackage}`];
    if (targetLocal) out.push("⚠ Paquete de destino LOCAL: el objeto dejará de viajar a calidad y a productivo.");
    else if (isLocal(move.oldPackage)) out.push("El objeto pasa a ser transportable: viajará con la orden cuando se libere.");
    if (move.transport) {
      const warn = await transportWarnings(sap, move.transport, system.user);
      out.push(warn.length ? `⚠ AVISOS DE LA ORDEN ${move.transport}:\n${warn.map((w) => "  ⚠ " + w).join("\n")}` : `Orden ${move.transport}: modificable, con destino y del usuario de esta conexión.`);
    }
    try {
      const p = await sapPreview(await sap.adt(), move);
      if (p.transport && move.transport && p.transport.toUpperCase() !== move.transport) {
        out.push(`⚠ SAP propone registrar el cambio en ${p.transport}, no en ${move.transport}: el objeto está bloqueado ahí. No se seguirá adelante.`);
      } else out.push("SAP valida el cambio de paquete: correcto.");
    } catch (e) {
      throw new ToolError("SAP", `SAP rechaza el cambio de paquete de ${move.name}: ${normalizeError(e, system.id).message}`);
    }
    out.push("Solo cambia la asignación de paquete: la fuente no se toca.");
    return { text: out.join("\n"), state: moveState(move) };
  },
  async run(a, { sap, confirmedState }) {
    const { move } = await plan(sap, a);
    if (confirmedState && confirmedState !== moveState(move)) {
      return { text: `No se cambió nada: ${move.name} ya no está en el paquete que se mostró en la vista previa. Pide una vista previa nueva.`, isError: true };
    }
    const c = await sap.adt();
    const p = await sapPreview(c, move);
    if (p.transport && move.transport && p.transport.toUpperCase() !== move.transport) {
      return { text: `No se cambió nada: SAP registraría el cambio en ${p.transport}, no en ${move.transport} (el objeto está bloqueado en esa orden).`, isError: true };
    }
    await sapExecute(c, p.raw);
    // Lo que cuenta es lo que quedó en SAP, no la respuesta.
    const after = await sap.query(
      `SELECT devclass FROM tadir WHERE pgmid = 'R3TR' AND object = ${sqlLiteral(TADIR_TYPE(move.type))} AND obj_name = ${sqlLiteral(move.name.toUpperCase())}`,
      1,
    );
    const now = String(after.values[0]?.DEVCLASS ?? "").trim();
    if (now !== move.newPackage) {
      return { text: `SAP respondió sin error, pero ${move.name} sigue en el paquete ${now || "?"}. Revísalo en SE80.`, isError: true };
    }
    return `${move.name} está ahora en el paquete ${move.newPackage}${move.transport ? `, registrado en la orden ${move.transport}` : " (local)"}.`;
  },
});
