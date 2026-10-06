import type { Config } from "./config.js";
import { GROUPS } from "./catalog.js";
import type { Access, ToolDef } from "./tool.js";

/**
 * Exposición selectiva de tools: un proyecto o un cliente de IA solo ve las que necesita. Un filtro es una lista de
 * nombres de tool, de grupos del catálogo (`exploracion`, `escritura`…) o de tipos de acceso (`read`, `write`, `exec`).
 * `only` deja solo lo listado; `except` quita lo listado. La variable de entorno ABAP_DZ_TOOLS (lista separada por comas)
 * es un `only` más: se cruza con el de la configuración, nunca lo amplía. `sap_systems` se ve siempre, para que quien
 * pregunte sepa qué hay configurado.
 */
export interface ToolFilter {
  only?: string[];
  except: string[];
}

const ALWAYS = new Set(["sap_systems"]);
const ACCESS: Access[] = ["read", "write", "exec", "local"];

export function resolveToolFilter(cfg: Config, env: NodeJS.ProcessEnv = process.env): ToolFilter {
  const fromEnv = env.ABAP_DZ_TOOLS?.split(",").map((s) => s.trim()).filter(Boolean);
  const only = [cfg.tools.only, fromEnv].filter((l): l is string[] => !!l);
  return { only: only.length ? [...new Set(only.flat())] : undefined, except: cfg.tools.except, ...(only.length > 1 ? { onlyIntersect: only } : {}) } as ToolFilter & { onlyIntersect?: string[][] };
}

/** ¿La entrada del filtro nombra a esta tool? Por nombre, por grupo del catálogo o por tipo de acceso. */
function names(entry: string, def: ToolDef<any>): boolean {
  const e = entry.trim().toLowerCase();
  if (e === def.name) return true;
  if ((ACCESS as string[]).includes(e)) return def.access === e;
  const g = GROUPS.find((x) => x.id === e);
  return !!g && g.tools.some((t) => t.name === def.name);
}

export function toolAllowed(def: ToolDef<any>, filter: ToolFilter & { onlyIntersect?: string[][] }): boolean {
  if (ALWAYS.has(def.name)) return true;
  const lists = filter.onlyIntersect ?? (filter.only ? [filter.only] : []);
  // Varias listas «only» (configuración y entorno): la tool debe estar en TODAS.
  if (lists.some((l) => !l.some((e) => names(e, def)))) return false;
  return !filter.except.some((e) => names(e, def));
}

/** Entradas del filtro que no corresponden a nada: casi siempre una errata, y una errata esconde tools en silencio. */
export function filterWarnings(filter: ToolFilter & { onlyIntersect?: string[][] }, defs: readonly ToolDef<any>[]): string[] {
  const entries = [...(filter.onlyIntersect ?? (filter.only ? [filter.only] : [])).flat(), ...filter.except];
  const unknown = [...new Set(entries)].filter((e) => !defs.some((d) => names(e, d)));
  const out = unknown.length ? [`Filtro de tools: ${unknown.join(", ")} no corresponde a ninguna tool, grupo ni tipo de acceso.`] : [];
  if (filter.only || filter.except.length) {
    const visible = defs.filter((d) => toolAllowed(d, filter)).length;
    out.push(`Filtro de tools activo: se publican ${visible} de ${defs.length} tools.`);
  }
  return out;
}
