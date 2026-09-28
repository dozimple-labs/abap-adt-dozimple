import { z } from "zod";
import { dataClassOf } from "../../core/datapolicy.js";
import { ToolError } from "../../core/errors.js";
import { sqlLiteral } from "../../core/objects.js";
import { SAP_USER_RE } from "../../core/policy.js";
import { defineTool } from "../../core/tool.js";
import { isOpen, orderHeaders, TRFUNCTION, TRSTATUS, type OrderHeader } from "../../core/transport.js";

/**
 * «¿Qué órdenes tengo abiertas?»: las órdenes de un usuario (las suyas y aquellas en las que tiene una tarea), con
 * sus tareas y objetos. Idea del ABAP Accelerator de AWS (MIT-0), reimplementada sobre E070/E07T/E071. Avisa de lo
 * que suele salir mal: una orden sin sistema destino (lo guardado en ella no viaja) o una tarea propia dentro de la
 * orden de otra persona.
 */

const STATUS = { open: ["D", "L"], released: ["O", "R", "N"], all: ["D", "L", "O", "R", "N"] } as const;

const TASK = z.object({ task: z.string(), owner: z.string(), status: z.string(), objects: z.number().int(), sample: z.array(z.string()) });
const ORDER = z.object({
  order: z.string(),
  text: z.string(),
  type: z.string(),
  status: z.string(),
  owner: z.string(),
  target: z.string(),
  date: z.string(),
  warnings: z.array(z.string()),
  tasks: z.array(TASK),
});

const inList = (xs: string[]) => xs.map(sqlLiteral).join(", ");

export default defineTool({
  name: "my_transports",
  title: "Mis órdenes de transporte",
  description:
    "Órdenes de transporte de un usuario (por defecto, el de la conexión): las que son suyas y aquellas en las que " +
    "tiene una tarea, con sus tareas, estado, sistema destino y objetos. Responde «¿qué órdenes tengo abiertas?» sin " +
    "saber el número. Avisa de órdenes sin destino (lo guardado no viajaría) y de tareas propias en órdenes ajenas.",
  access: "read",
  input: {
    user: z.string().regex(SAP_USER_RE, "usuario SAP: letras, números y _ . @ -, hasta 12").optional().describe("Por defecto, el usuario de la conexión"),
    status: z.enum(["open", "released", "all"]).default("open"),
    since: z.string().regex(/^\d{8}$/).optional().describe("Solo órdenes con fecha ≥ AAAAMMDD"),
    objects_per_task: z.number().int().min(0).max(200).default(10).describe("Objetos de ejemplo por tarea (0 = solo el recuento)"),
    max: z.number().int().min(1).max(200).default(30),
  },
  output: { user: z.string(), orders: z.array(ORDER), total: z.number().int(), truncated: z.boolean() },
  async run({ user, status, since, objects_per_task, max }, { sap, system }) {
    const me = system.user.toUpperCase();
    const who = (user ?? me).toUpperCase();
    const test = dataClassOf(system) === "test";
    if (who !== me && !test) {
      throw new ToolError("POLICY", `En ${system.id} (datos ${dataClassOf(system)}) solo se consultan las órdenes del usuario de la conexión.`);
    }
    const st = inList([...STATUS[status]]);
    const date = since ? ` AND as4date >= ${sqlLiteral(since)}` : "";

    // Órdenes propias y órdenes padre de las tareas propias.
    const own = await sap.query(`SELECT trkorr FROM e070 WHERE as4user = ${sqlLiteral(who)} AND strkorr = ' ' AND trstatus IN ( ${st} )${date}`, 500);
    const myTasks = await sap.query(`SELECT trkorr, strkorr FROM e070 WHERE as4user = ${sqlLiteral(who)} AND strkorr <> ' ' AND trstatus IN ( ${st} )`, 2000);
    const roots = [...new Set([...own.values.map((v) => String(v.TRKORR)), ...myTasks.values.map((v) => String(v.STRKORR))])];
    if (!roots.length) {
      const structured = { user: who, orders: [], total: 0, truncated: false };
      return { text: `${who} no tiene órdenes ${status === "open" ? "abiertas" : status === "released" ? "liberadas" : ""}${since ? ` desde ${since}` : ""} en ${system.id} (se consultó E070).`, structured };
    }

    const heads = await orderHeaders(sap, roots);
    let orders = [...heads.values()]
      .filter((h) => !h.parent && (STATUS[status] as readonly string[]).includes(h.trstatus) && (!since || h.date >= since))
      .sort((a, b) => b.date.localeCompare(a.date) || b.trkorr.localeCompare(a.trkorr));
    const total = orders.length;
    orders = orders.slice(0, max);

    const shownRoots = orders.map((o) => o.trkorr);
    const taskRows = shownRoots.length ? await sap.query(`SELECT trkorr FROM e070 WHERE strkorr IN ( ${inList(shownRoots)} )`, 2000) : { values: [] };
    const taskHeads = await orderHeaders(sap, taskRows.values.map((v) => String(v.TRKORR)));
    const ids = [...shownRoots, ...taskHeads.keys()];
    const entries = ids.length ? await sap.query(`SELECT trkorr, pgmid, object, obj_name FROM e071 WHERE trkorr IN ( ${inList(ids)} )`, 5000) : { values: [] };
    const byTask = new Map<string, string[]>();
    for (const e of entries.values) {
      if (e.PGMID === "CORR") continue;
      const k = String(e.TRKORR);
      byTask.set(k, [...(byTask.get(k) ?? []), `${String(e.OBJECT).trim()} ${String(e.OBJ_NAME).trim()}`]);
    }
    const ownerOf = (h: OrderHeader) => (test || h.owner.toUpperCase() === me ? h.owner : "‹otro usuario›");

    const rows = orders.map((o) => {
      const tasks = [...taskHeads.values()]
        .filter((t) => t.parent === o.trkorr)
        .map((t) => ({
          task: t.trkorr,
          owner: ownerOf(t),
          status: TRSTATUS[t.trstatus] ?? t.trstatus,
          objects: byTask.get(t.trkorr)?.length ?? 0,
          sample: (byTask.get(t.trkorr) ?? []).slice(0, objects_per_task),
        }));
      const warnings: string[] = [];
      if (isOpen(o.trstatus) && !o.tarsystem && o.trfunction === "K") warnings.push("sin sistema destino: lo que se guarde en ella no viaja");
      if (o.owner.toUpperCase() !== who) warnings.push(`la orden es de otra persona (${ownerOf(o)}); aquí solo está tu tarea`);
      return {
        order: o.trkorr, text: o.text, type: TRFUNCTION[o.trfunction] ?? o.trfunction, status: TRSTATUS[o.trstatus] ?? o.trstatus,
        owner: ownerOf(o), target: o.tarsystem, date: o.date, warnings, tasks,
      };
    });

    const structured = { user: who, orders: rows, total, truncated: total > rows.length };
    const lines = rows.map((r) => {
      const head = `${r.order} «${r.text}» · ${r.type} · ${r.status} · ${r.owner} · ${r.target ? `destino ${r.target}` : "SIN DESTINO"} · ${r.date}`;
      const warn = r.warnings.map((w) => `   ⚠ ${w}`);
      const tasks = r.tasks.map(
        (t) => `   └ ${t.task} · ${t.owner} · ${t.status} · ${t.objects} objetos${t.sample.length ? `: ${t.sample.join(", ")}${t.objects > t.sample.length ? "…" : ""}` : ""}`,
      );
      return [head, ...warn, ...tasks].join("\n");
    });
    return {
      text: `${total} órdenes ${status === "open" ? "abiertas" : status === "released" ? "liberadas" : ""} de ${who} en ${system.id}${total > rows.length ? ` (se muestran ${rows.length})` : ""}\n\n${lines.join("\n\n")}`,
      structured,
    };
  },
});
