import { z } from "zod";
import { appendAudit } from "../../core/audit.js";
import {
  activeElevation, allowedElevations, CATEGORY_LABEL, ELEVABLE, grantElevation, listElevations, maxMinutes, minutesLeft, revokeElevation, type Elevable,
} from "../../core/elevation.js";
import { ToolError } from "../../core/errors.js";
import { defineTool } from "../../core/tool.js";

/**
 * Acceso elevado: la persona aprueba (vista previa + confirmación) leer una categoría de datos protegida en un
 * sistema durante un tiempo. Cada concesión, uso, caducidad y revocación queda en el registro de auditoría.
 */
const category = z.enum(ELEVABLE).describe(ELEVABLE.map((c) => `${c}: ${CATEGORY_LABEL[c]}`).join(" · "));

function assertAllowed(systemId: string, allowed: readonly Elevable[], cat: Elevable, minutes: number, max: number): void {
  if (!allowed.includes(cat)) {
    throw new ToolError("POLICY", `${systemId} no permite elevar ${cat} (${CATEGORY_LABEL[cat]}). Permitidas: ${allowed.join(", ") || "ninguna"}.`, 'Lo decide "elevation.allowed" en la entrada del sistema en systems.json.');
  }
  if (minutes > max) throw new ToolError("POLICY", `${systemId} limita la elevación a ${max} minutos (pediste ${minutes}).`, 'Lo decide "elevation.maxMinutes" en systems.json.');
}

const elevateAccess = defineTool({
  name: "elevate_access",
  title: "Elevar acceso a una categoría de datos",
  description:
    "Pide acceso temporal a una categoría de datos protegida en un sistema: seguridad y roles, maestro de personal, " +
    "nómina o datos personales en claro. Dos pasos: la vista previa dice qué se abre y por cuánto; con la " +
    "conformidad del usuario queda concedido, caduca solo y todo uso se audita. SECRETOS nunca se eleva.",
  access: "read",
  confirm: true,
  confirmWhat: "elevación de acceso",
  input: {
    category,
    minutes: z.number().int().min(5).max(480).default(60),
    reason: z.string().min(10).max(300).describe("Para qué: ticket, análisis, auditoría… queda en el registro"),
  },
  async preview({ category: cat, minutes, reason }, { system }) {
    assertAllowed(system.id, allowedElevations(system), cat, minutes, maxMinutes(system));
    const cur = activeElevation(system.id, cat);
    return (
      `Elevación en ${system.id} (${system.role}, datos ${system.dataClass ?? (system.role === "DEV" ? "test" : "prod")}): ${cat} — ${CATEGORY_LABEL[cat]}.\n` +
      `Duración: ${minutes} minutos${cur ? ` (sustituye a la vigente, que caduca en ${minutesLeft(cur)} min)` : ""}. Motivo: ${reason}\n` +
      (cat === "PERSONAS_NEGOCIO"
        ? "Efecto: las columnas personales dejan de enmascararse en sql_query, table_contents y count_rows; el tope de filas sigue."
        : "Efecto: sql_query, table_contents y count_rows podrán leer las tablas de esa categoría (también a través de vistas y CDS); el tope de filas y el enmascarado siguen.") +
      "\nCada lectura con esta elevación deja un evento en el registro de auditoría."
    );
  },
  async run({ category: cat, minutes, reason }, { system }) {
    assertAllowed(system.id, allowedElevations(system), cat, minutes, maxMinutes(system));
    const e = grantElevation({ system: system.id, category: cat, reason, until: Date.now() + minutes * 60_000, grantedBy: system.user });
    appendAudit({ phase: "elevation_granted", tool: "elevate_access", access: "read", system: system.id, sapUser: system.user, client: system.client, args: { category: cat, minutes, reason }, elevation: { category: cat, until: new Date(e.until).toISOString(), reason } });
    return `Acceso elevado en ${system.id}: ${cat} (${CATEGORY_LABEL[cat]}) hasta ${new Date(e.until).toISOString().slice(11, 16)} UTC (${minutes} min). Queda en el registro de auditoría; revoke_access lo cierra antes.`;
  },
});

const elevationStatus = defineTool({
  name: "elevation_status",
  title: "Elevaciones vigentes",
  description: "Qué categorías de datos están elevadas ahora en el sistema (o en todos), con motivo y minutos que quedan.",
  access: "read",
  input: { all_systems: z.boolean().default(false) },
  async run({ all_systems }, { system }) {
    const es = listElevations(all_systems ? undefined : system.id);
    if (!es.length) return `Sin elevaciones vigentes${all_systems ? "" : ` en ${system.id}`}.`;
    return es.map((e) => `${e.system} · ${e.category} (${CATEGORY_LABEL[e.category]}) · ${minutesLeft(e)} min restantes · concedida ${e.grantedAt.slice(0, 16).replace("T", " ")} · motivo: ${e.reason}`).join("\n");
  },
});

const revokeAccess = defineTool({
  name: "revoke_access",
  title: "Revocar una elevación",
  description: "Cierra antes de tiempo una elevación de acceso en el sistema (una categoría o todas). Queda en el registro de auditoría.",
  access: "read",
  input: { category: category.optional().describe("Sin categoría: todas las del sistema") },
  async run({ category: cat }, { system }) {
    const gone = revokeElevation(system.id, cat);
    if (!gone.length) return `No había elevación${cat ? ` de ${cat}` : ""} vigente en ${system.id}.`;
    for (const e of gone) appendAudit({ phase: "elevation_revoked", tool: "revoke_access", access: "read", system: system.id, sapUser: system.user, client: system.client, args: { category: e.category }, elevation: { category: e.category, reason: e.reason } });
    return `Revocadas en ${system.id}: ${gone.map((e) => e.category).join(", ")}.`;
  },
});

export default [elevateAccess, elevationStatus, revokeAccess];
