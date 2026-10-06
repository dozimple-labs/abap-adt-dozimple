import { z } from "zod";
import { normalizeError } from "../../core/errors.js";
import { resolveObject, sqlLiteral, TYPE_HELP, type ResolvedObject } from "../../core/objects.js";
import { assertTrkorr } from "../../core/policy.js";
import { describeOrder, isOpen, orderHeaders, transportWarnings } from "../../core/transport.js";
import { defineTool } from "../../core/tool.js";
import type { SapConnection } from "../../core/connection.js";
import { sourceUrl } from "../../core/objects.js";
import { driftVerdict, versionDrift } from "../transport-risk/_drift.js";
import { RISK_MODULE } from "../transport-risk/_service.js";

/** Entrada de TADIR que manda sobre el objeto (un FM pertenece a su grupo). */
async function tadirKey(sap: SapConnection, obj: ResolvedObject): Promise<{ object: string; name: string }> {
  if (obj.type.startsWith("FUGR/FF")) {
    const r = await sap.query(`SELECT area FROM enlfdir WHERE funcname = ${sqlLiteral(obj.name)}`, 1);
    if (r.values[0]?.AREA) return { object: "FUGR", name: r.values[0].AREA };
  }
  return { object: obj.type.slice(0, 4), name: obj.name };
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const likeEscape = (s: string) => s.replace(/[#%_]/g, (c) => "#" + c);

export default defineTool({
  name: "edit_preflight",
  title: "Antes de editar: ¿a qué orden irá?",
  description:
    "Dice, ANTES de modificar un objeto, en qué orden acabará el cambio y por qué: bloqueo del CTS (TLOCK) de otra " +
    "orden, objeto local ($TMP), reparación (sistema original distinto), o si está libre y qué órdenes tienes abiertas. " +
    "Con el módulo dz-transport-risk compara además la fuente de DEV con la de calidad y productivo (deriva de versión: " +
    "lo que el pase arrastraría o pisaría). Úsala siempre antes de write_source o de editar a mano en un sistema ajeno.",
  access: "read",
  input: {
    object_name: z.string().min(1),
    object_type: z.string().optional().describe(TYPE_HELP),
    transport: z.string().optional().describe("Orden en la que QUIERES guardar, para comprobar si es posible"),
    compare_with: z.array(z.string().regex(/^[A-Za-z0-9]{3}$/)).optional().describe("SIDs con los que comparar la versión de DEV (por defecto, los «targets» del sistema en la configuración; solo con el módulo dz-transport-risk)"),
  },
  async run({ object_name, object_type, transport, compare_with }, ctx) {
    const { sap, system } = ctx;
    const c = await sap.adt();
    const obj = await resolveObject(c, object_name, object_type);
    const wanted = transport ? assertTrkorr(transport) : undefined;
    const key = await tadirKey(sap, obj);
    const out: string[] = [`${obj.name} (${obj.type})` + (key.name !== obj.name ? ` · pertenece a ${key.object} ${key.name}` : "")];
    const verdict: string[] = [];

    // 1. Directorio: paquete y sistema original.
    const tadir = await sap.query(
      `SELECT devclass, srcsystem, author FROM tadir WHERE pgmid = 'R3TR' AND object = ${sqlLiteral(key.object)} AND obj_name = ${sqlLiteral(key.name)}`,
      1,
    );
    const t = tadir.values[0];
    const devclass: string = t?.DEVCLASS ?? obj.packageName ?? "";
    if (t) out.push(`Paquete ${devclass} · sistema original ${t.SRCSYSTEM} · autor ${t.AUTHOR}`);
    else out.push(`Sin entrada R3TR ${key.object} ${key.name} en TADIR.`);
    const isLocal = devclass.startsWith("$");

    // 2. Qué dice el propio CTS (lo mismo que el diálogo de orden de Eclipse).
    let info: Awaited<ReturnType<typeof c.transportInfo>> | undefined;
    if (!isLocal) {
      try {
        info = await c.transportInfo(obj.uri, devclass, "I");
      } catch (e) {
        out.push(`No se pudo consultar el CTS: ${normalizeError(e).message}`);
      }
    }

    // 3. Bloqueos reales del CTS.
    const locks = await sap.query(
      `SELECT object, lokey, trkorr FROM tlock WHERE lokey LIKE ${sqlLiteral("%" + likeEscape(key.name) + "%")} ESCAPE '#'`,
      200,
    );
    const re = new RegExp(`(^|[^A-Z0-9_/])${escapeRegExp(key.name)}($|[^A-Z0-9_])`);
    const mine = locks.values.filter((l) => re.test(String(l.LOKEY).trimEnd()) || String(l.LOKEY).trimEnd().startsWith(key.name));
    const heads = await orderHeaders(sap, mine.map((l) => l.TRKORR));
    const parents = await orderHeaders(sap, [...heads.values()].map((h) => h.parent));
    const lockOrders = new Map<string, string>(); // orden padre → descripción
    for (const l of mine) {
      const task = heads.get(l.TRKORR);
      const order = task?.parent ? parents.get(task.parent) ?? task : task;
      const id = order?.trkorr ?? l.TRKORR;
      if (!lockOrders.has(id)) lockOrders.set(id, `${order ? describeOrder(order) : id} [TLOCK ${l.OBJECT} ${String(l.LOKEY).trim()}]`);
    }
    if (lockOrders.size) out.push("", "Bloqueos del CTS:", ...[...lockOrders.values()].map((d) => "  " + d));

    // 4. Veredicto.
    const sid = system.sid ?? (info?.TRANSPORTS?.[0]?.TRKORR ?? info?.LOCKS?.HEADER?.TRKORR ?? [...heads.keys()][0])?.slice(0, 3);
    if (isLocal) verdict.push("Objeto local: el cambio no se registra en ninguna orden y no viaja.");
    if (t && sid && t.SRCSYSTEM && t.SRCSYSTEM !== sid && !isLocal) {
      verdict.push(
        `REPARACIÓN: el sistema original es ${t.SRCSYSTEM}, no ${sid}. El cambio se registra en una tarea de reparación: ` +
          `si su orden no tiene destino no sale del sistema, y si viaja, lo pisará cualquier transporte que llegue desde ` +
          `${t.SRCSYSTEM}. Si ${sid} debe ser el original: SE03 → Cambiar sistema original.`,
      );
    }
    if (lockOrders.size) {
      const ids = [...lockOrders.keys()];
      verdict.push(`BLOQUEADO en ${ids.join(", ")}: cualquier cambio irá obligatoriamente ahí.`);
      if (wanted && !ids.includes(wanted)) verdict.push(`No podrás guardar en ${wanted}.`);
    } else if (!isLocal) {
      const all = info?.TRANSPORTS ?? [];
      const cands = all.slice(0, 10).map((x) => `${x.TRKORR} «${x.AS4TEXT}» (${x.AS4USER})`);
      verdict.push("Sin bloqueo del CTS: puedes elegir la orden.");
      if (cands.length) verdict.push(`Órdenes abiertas que ofrece el CTS (${all.length}${all.length > 10 ? ", se muestran 10" : ""}): ${cands.join("; ")}`);
      if (wanted) {
        const w = (await orderHeaders(sap, [wanted])).get(wanted);
        if (!w) verdict.push(`${wanted} no existe en este sistema.`);
        else if (!isOpen(w.trstatus)) verdict.push(`${wanted} no está modificable (${describeOrder(w)}).`);
        else {
          const warn = await transportWarnings(sap, wanted, system.user);
          verdict.push(warn.length ? `${wanted} está abierta, pero: ${warn.join(" ")}` : `${wanted} está abierta, con destino y es tuya: se puede usar.`);
        }
      }
    }
    for (const m of info?.MESSAGES ?? []) verdict.push(`CTS ${m.SEVERITY}: ${m.TEXT}`);

    // 5. Deriva de versión frente a calidad y productivo (paso 2 del flujo de modificación).
    const targets = (compare_with ?? system.targets).map((s) => s.toUpperCase());
    const drifts: string[] = [];
    if (targets.length && system.modules.includes(RISK_MODULE)) {
      ctx.progress?.(`Comparando con ${targets.join(", ")}…`);
      const dev = await c.getObjectSource(await sourceUrl(c, obj));
      for (const d of await versionDrift(sap, system, obj, dev, targets)) {
        verdict.push(driftVerdict(d));
        if (d.diff) drifts.push(`--- ${d.target} → DEV ---`, d.diff);
      }
    } else if (targets.length) {
      verdict.push(`Sin comparar con ${targets.join(", ")}: este sistema no tiene el módulo ${RISK_MODULE}. Compara con object_versions o remote_source.`);
    }
    if (!sid) verdict.push(`(No se pudo determinar el SID del sistema para comprobar reparaciones: añade "sid" en systems.json.)`);

    return [...out, "", "Veredicto:", ...verdict.map((v) => "  • " + v), ...(drifts.length ? ["", ...drifts] : [])].join("\n");
  },
});
