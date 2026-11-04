import { z } from "zod";
import { textElementsUrl, type ADTClient, type TextElement } from "abap-adt-api";
import { stateOf } from "../../core/confirm.js";
import { ToolError } from "../../core/errors.js";
import { resolveObject, TYPE_HELP, type ResolvedObject } from "../../core/objects.js";
import { assertTrkorr, assertPackageAllowed } from "../../core/policy.js";
import { decideTransport, orderHeaders, transportWarnings } from "../../core/transport.js";
import { defineTool } from "../../core/tool.js";

const CATEGORIES = ["symbols", "selections", "headings"] as const;

type Category = (typeof CATEGORIES)[number];

/** Fusiona los textos pedidos con los existentes; valida longitudes. */
async function mergeTexts(c: ADTClient, obj: ResolvedObject, category: Category, elements: { id: string; text: string; max_length?: number }[]) {
  const current = (await c.getTextElements(textElementsUrl(obj.type, obj.name), category)).textElements;
  const merged = new Map<string, TextElement>(current.map((t) => [t.id.toUpperCase(), t]));
  for (const e of elements) {
    const id = e.id.toUpperCase();
    const prev = merged.get(id);
    const maxLength = e.max_length ?? prev?.maxLength ?? Math.max(e.text.length, 1);
    if (e.text.length > maxLength) throw new ToolError("INPUT", `El texto ${id} mide ${e.text.length} y su máximo es ${maxLength}.`);
    merged.set(id, { ...prev, id, text: e.text, maxLength });
  }
  return { current, merged };
}

/** Huella del conjunto de textos tal como está en SAP (orden estable), para comparar vista previa y escritura. */
const textsState = (ts: TextElement[]) =>
  stateOf(JSON.stringify(ts.map((t) => [t.id.toUpperCase(), t.text, t.maxLength ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))));

const read = defineTool({
  name: "text_elements",
  title: "Símbolos de texto y textos de selección",
  description:
    "Lee los símbolos de texto (TEXT-001…), textos de selección o encabezados de un programa, clase o grupo de funciones.",
  access: "read",
  requires: { adt: ["/sap/bc/adt/textelements"] },
  input: {
    object_name: z.string().min(1),
    object_type: z.string().optional().describe(TYPE_HELP),
    category: z.enum(CATEGORIES).default("symbols"),
  },
  async run({ object_name, object_type, category }, { sap }) {
    const c = await sap.adt();
    const obj = await resolveObject(c, object_name, object_type);
    const r = await c.getTextElements(textElementsUrl(obj.type, obj.name), category);
    if (!r.textElements.length) return `${obj.name}: no tiene ${category}.`;
    return `${obj.name} · ${category} (${r.textElements.length})\n` + r.textElements.map((t) => `  ${t.id}  ${t.text}${t.maxLength ? `  [máx ${t.maxLength}]` : ""}`).join("\n");
  },
});

const write = defineTool({
  name: "write_text_elements",
  title: "Crear o cambiar símbolos de texto",
  description:
    "Añade o modifica símbolos de texto (o textos de selección) de un programa/clase/grupo, fusionando con los " +
    "existentes: no borra los que no se mencionan. Completa la corrección «Create text in text pool» de atc_quickfix. " +
    "Misma regla de orden que write_source.",
  access: "write",
  requires: { adt: ["/sap/bc/adt/textelements"] },
  input: {
    object_name: z.string().min(1),
    object_type: z.string().optional().describe(TYPE_HELP),
    category: z.enum(CATEGORIES).default("symbols"),
    elements: z.array(z.object({ id: z.string().min(1).max(8), text: z.string(), max_length: z.number().int().min(1).max(255).optional() })).min(1),
    transport: z.string().optional(),
  },
  async preview({ object_name, object_type, category, elements, transport }, { sap, system }) {
    const requested = transport ? assertTrkorr(transport) : undefined;
    const c = await sap.adt();
    const obj = await resolveObject(c, object_name, object_type);
    assertPackageAllowed(system, obj.packageName, obj.name);
    const { current, merged } = await mergeTexts(c, obj, category, elements);
    const before = new Map(current.map((t) => [t.id.toUpperCase(), t]));
    const lines = elements.map((e) => {
      const id = e.id.toUpperCase();
      const prev = before.get(id);
      const now = merged.get(id)!;
      if (!prev) return `  + ${id}  «${now.text}»  [máx ${now.maxLength}]`;
      if (prev.text === now.text && prev.maxLength === now.maxLength) return `  = ${id}  sin cambio`;
      return `  ~ ${id}  «${prev.text}» → «${now.text}»  [máx ${now.maxLength}]`;
    });
    const warn = requested ? await transportWarnings(sap, requested, system.user) : [];
    const text = [
      ...(warn.length ? [`AVISOS DE LA ORDEN ${requested}:`, ...warn.map((w) => "  ⚠ " + w), ""] : []),
      `${obj.name} (${obj.type}) · ${category} · orden ${requested ?? "ninguna indicada"}`,
      `Quedarán ${merged.size} (hoy ${current.length}); no se borra ninguno.`,
      ...lines,
    ];
    return { text: text.join("\n"), state: textsState(current) };
  },
  async run({ object_name, object_type, category, elements, transport }, { sap, system, confirmedState }) {
    const requested = transport ? assertTrkorr(transport) : undefined;
    const c = await sap.adt();
    const obj = await resolveObject(c, object_name, object_type);
    assertPackageAllowed(system, obj.packageName, obj.name);
    const url = textElementsUrl(obj.type, obj.name);
    const { merged } = await mergeTexts(c, obj, category, elements);
    const res = await sap.stateful(async (s) => {
      const lock = await s.lock(obj.uri);
      try {
        // Igual que write_source: bajo el bloqueo, los textos tienen que seguir como en la vista previa.
        if (confirmedState && textsState((await s.getTextElements(url, category)).textElements) !== confirmedState) {
          return { ok: false as const, reason: `No se escribió nada: los ${category} de ${obj.name} cambiaron en SAP después de la vista previa. Pide una vista previa nueva.` };
        }
        const parent = lock.CORRNR ? (await orderHeaders(sap, [lock.CORRNR])).get(lock.CORRNR)?.parent : undefined;
        const d = decideTransport(lock, requested, parent);
        if (!d.ok) return d;
        await s.setTextElements(url, category, [...merged.values()], lock.LOCK_HANDLE, d.corrNr || undefined);
        return d;
      } finally {
        await s.unLock(obj.uri, lock.LOCK_HANDLE).catch(() => undefined);
      }
    });
    if (!res.ok) return { text: res.reason, isError: true };
    return `${obj.name}: ${elements.length} ${category} guardados (${merged.size} en total). ${res.note}\nActiva el objeto para que el cambio sea efectivo.`;
  },
});

export default [read, write];
