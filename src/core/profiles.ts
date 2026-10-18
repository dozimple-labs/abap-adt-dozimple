import type { Config } from "./config.js";
import { GROUPS, groupOf } from "./catalog.js";
import type { ToolDef } from "./tool.js";

/**
 * Perfil de tools: cuántas se publican al arrancar. Cada tool publicada cuesta tokens en cada conversación (nombre,
 * descripción y esquema), y con 61 el modelo elige peor. `core` publica las de uso diario y deja el resto registradas
 * pero apagadas; `load_tools(groups)` las enciende cuando hacen falta y el cliente recibe `tools/list_changed`.
 * `expert` publica todo desde el principio (comportamiento anterior a 1.7.0).
 */
export type Profile = "core" | "expert";

export const LOAD_TOOL = "load_tools";

/** Lo que casi toda conversación usa: localizar, leer, consultar, comprobar y guardar con sus garantías. */
export const CORE_TOOLS = new Set([
  "sap_systems",
  LOAD_TOOL,
  "search_objects",
  "get_source",
  "object_context",
  "sql_query",
  "where_used",
  "edit_preflight",
  "syntax_check",
  "write_source",
  "edit_source",
  "activate",
  "transport_contents",
  "diagnose_message",
  "report_gap",
]);

export function resolveProfile(cfg: Config, env: NodeJS.ProcessEnv = process.env): Profile {
  const fromEnv = env.ABAP_DZ_PROFILE?.trim().toLowerCase();
  if (fromEnv === "core" || fromEnv === "expert") return fromEnv;
  return cfg.tools.profile;
}

/**
 * ¿Se publica al arrancar con este perfil? Una tool que no está en ningún grupo del catálogo se publica siempre: no
 * hay forma de pedirla con load_tools, y esconderla en silencio sería peor que el coste de sus tokens.
 */
export function inProfile(def: Pick<ToolDef<any>, "name">, profile: Profile): boolean {
  if (profile === "expert") return true;
  return CORE_TOOLS.has(def.name) || !groupOf(def.name);
}

/** Grupos del catálogo con lo que cada uno carga, para la descripción de load_tools y para sap_systems. */
export function groupSummary(names: ReadonlySet<string>): Array<{ id: string; title: string; pitch: string; tools: string[] }> {
  return GROUPS.map((g) => ({ id: g.id, title: g.title, pitch: g.pitch, tools: g.tools.map((t) => t.name).filter((n) => names.has(n)) })).filter((g) => g.tools.length);
}
