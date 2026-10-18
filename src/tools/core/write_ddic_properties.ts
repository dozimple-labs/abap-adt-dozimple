import { z } from "zod";
import { activateObject } from "../../core/activation.js";
import { stateOf } from "../../core/confirm.js";
import { describeDdicProps, parseDdicProps, type DataElementProperties, type DdicKind, type DomainProperties } from "../../core/ddicprops.js";
import { diffLines, unified } from "../../core/diff.js";
import { ToolError } from "../../core/errors.js";
import { resolveObject } from "../../core/objects.js";
import { assertTrkorr } from "../../core/policy.js";
import { defineTool, type ToolContext } from "../../core/tool.js";
import { decideTransport, orderHeaders, transportWarnings } from "../../core/transport.js";

/**
 * Dominios y elementos de datos existentes (S/4 y NW ≥ 7.51): sus propiedades se leen y escriben por ADT como un
 * documento, no como fuente. Misma puerta que write_source: vista previa con el diff de propiedades, huella de lo
 * mostrado comprobada bajo el bloqueo, orden explícita y activación.
 */
/** JSON con las claves ordenadas a todos los niveles (un replacer de lista solo conserva las de primer nivel). */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}
const canonical = (p: unknown) => JSON.stringify(sortKeys(p), null, 2);

async function current(kind: DdicKind, name: string, ctx: Pick<ToolContext, "sap">) {
  const c = await ctx.sap.adt();
  const obj = await resolveObject(c, name, kind);
  const cur = kind === "DOMA" ? await c.getDomainProperties(obj.uri) : await c.getDataElementProperties(obj.uri);
  return { c, obj, cur };
}

export default defineTool({
  name: "write_ddic_properties",
  title: "Escribir propiedades de un dominio o elemento de datos",
  description:
    "Cambia las propiedades de un dominio (tipo, longitud, salida, valores fijos) o de un elemento de datos (dominio " +
    "o tipo predefinido, etiquetas, ayuda de búsqueda) existente, por ADT en S/4 o NW ≥ 7.51. Vista previa con el " +
    "diff de propiedades y confirmación; orden explícita; activa después. En 7.50, ddic_plan.",
  access: "write",
  input: {
    object_type: z.enum(["DTEL", "DOMA"]),
    name: z.string().min(1),
    properties: z.record(z.unknown()).describe("Propiedades completas, como en create_object (ddic_properties)"),
    description: z.string().max(60).optional().describe("Texto breve nuevo; si se omite, se conserva"),
    transport: z.string().optional().describe("Orden (o tarea). Obligatoria salvo objetos locales"),
    activate: z.boolean().default(true),
  },
  async preview({ object_type, name, properties, description, transport, activate }, ctx) {
    const requested = transport ? assertTrkorr(transport) : undefined;
    let props: DomainProperties | DataElementProperties;
    try {
      props = parseDdicProps(object_type, properties);
    } catch (e) {
      throw new ToolError("INPUT", (e as Error).message);
    }
    const { obj, cur } = await current(object_type, name, ctx);
    const out = [`${obj.name} (${obj.type}) · paquete ${cur.metaData.packageName || obj.packageName || "?"} · ${cur.metaData.description}`, `Orden: ${requested ?? "ninguna indicada (solo vale para objetos locales)"} · activar después: ${activate ? "sí" : "no"}`];
    if (requested) {
      const warn = await transportWarnings(ctx.sap, requested, ctx.system.user);
      out.push(warn.length ? `⚠ AVISOS DE LA ORDEN ${requested}:\n${warn.map((w) => "  ⚠ " + w).join("\n")}` : `Orden ${requested}: modificable, con destino y del usuario de esta conexión.`);
    }
    if (description) out.push(`Descripción: «${cur.metaData.description}» → «${description}»`);
    out.push(`Ahora: ${describeDdicProps(object_type, cur.properties as DomainProperties)}`, `Nuevo: ${describeDdicProps(object_type, props)}`);
    const ops = diffLines(canonical(cur.properties), canonical(props));
    const u = ops ? unified(ops, 2) : undefined;
    out.push("", u?.hunks ? `Cambio de propiedades: +${u.added} −${u.removed}\n${u.text.split("\n").slice(0, 200).join("\n")}` : "Cambio de propiedades: ninguno (idénticas a las guardadas).");
    return { text: out.join("\n"), state: stateOf(canonical(cur.properties)) };
  },
  async run({ object_type, name, properties, description, transport, activate }, ctx) {
    const requested = transport ? assertTrkorr(transport) : undefined;
    const props = parseDdicProps(object_type, properties);
    const { c, obj, cur } = await current(object_type, name, ctx);
    const expected = ctx.confirmedState ?? stateOf(canonical(cur.properties));
    const changed = `No se escribió nada: ${obj.name} cambió en SAP después de la vista previa. Pide una vista previa nueva.`;
    if (stateOf(canonical(cur.properties)) !== expected) return { text: changed, isError: true };
    const meta = { ...cur.metaData, description: description ?? cur.metaData.description, responsible: cur.metaData.responsible || ctx.system.user };
    const saved = await ctx.sap.stateful(async (s) => {
      const lock = await s.lock(obj.uri);
      try {
        const now = object_type === "DOMA" ? await s.getDomainProperties(obj.uri) : await s.getDataElementProperties(obj.uri);
        if (stateOf(canonical(now.properties)) !== expected) return { ok: false as const, reason: changed };
        const parent = lock.CORRNR ? (await orderHeaders(ctx.sap, [lock.CORRNR])).get(lock.CORRNR)?.parent : undefined;
        const d = decideTransport(lock, requested, parent);
        if (!d.ok) return d;
        if (object_type === "DOMA") await s.setDomainProperties(obj.uri, props as DomainProperties, meta, lock.LOCK_HANDLE, d.corrNr || undefined);
        else await s.setDataElementProperties(obj.uri, props as DataElementProperties, meta, lock.LOCK_HANDLE, d.corrNr || undefined);
        return d;
      } finally {
        await s.unLock(obj.uri, lock.LOCK_HANDLE).catch(() => undefined);
      }
    });
    if (!saved.ok) return { text: saved.reason, isError: true };
    let text = `${obj.name} guardado: ${describeDdicProps(object_type, props)}. ${saved.note}`;
    if (!activate) return `${text}\nSin activar (activate=false).`;
    const act = await activateObject(c, obj);
    text += `\n\n${act.text}`;
    return { text, isError: !act.ok };
  },
});
