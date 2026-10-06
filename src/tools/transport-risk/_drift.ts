import type { SapConnection } from "../../core/connection.js";
import type { SystemConfig } from "../../core/config.js";
import { diffLines, unified } from "../../core/diff.js";
import type { ResolvedObject } from "../../core/objects.js";
import type { ToolResult } from "../../core/tool.js";
import { callRiskService } from "./_service.js";
import { functionInclude } from "./risk_extras.js";

/**
 * Deriva de versión antes de tocar un objeto: la fuente de DEV frente a la de cada destino (calidad, productivo), leída por el
 * canal de TMS del servicio de riesgo. Es el paso 2 del flujo de modificación, el que más se olvida: si DEV ya tiene
 * algo que productivo no tiene, el cambio lo arrastra; si productivo tiene algo que DEV no, se edita sobre código viejo.
 */
export interface Drift {
  target: string;
  status: "igual" | "distinta" | "ausente" | "sin_comparar";
  detail: string;
  /** Diff destino → DEV (líneas «+» = solo en DEV, «−» = solo en el destino), recortado. */
  diff?: string;
}

export type RemoteFetch = (system: SystemConfig, params: Record<string, string | undefined>) => Promise<ToolResult>;

/** Nombre con el que el servicio lee el objeto en el destino, o undefined si ese tipo no se puede comparar. */
export async function remoteName(sap: Pick<SapConnection, "query">, obj: ResolvedObject): Promise<string | undefined> {
  const t = obj.type.toUpperCase();
  if (t === "PROG/P" || t === "PROG/I") return obj.name.toUpperCase();
  if (t === "FUGR/FF") return functionInclude(sap, obj.name.toUpperCase());
  return undefined;
}

export async function versionDrift(
  sap: Pick<SapConnection, "query">,
  system: SystemConfig,
  obj: ResolvedObject,
  devSource: string,
  targets: string[],
  fetch: RemoteFetch = callRiskService,
): Promise<Drift[]> {
  const name = await remoteName(sap, obj);
  if (!name) return targets.map((target) => ({ target, status: "sin_comparar", detail: `la comparación remota no cubre ${obj.type}: compara a mano con remote_source si hace falta` }));
  const out: Drift[] = [];
  for (const target of targets) {
    let r: ToolResult;
    try {
      r = await fetch(system, { mode: "DEV", remote_source: target, object: name });
    } catch (e) {
      out.push({ target, status: "sin_comparar", detail: `no se pudo consultar ${target}: ${(e as Error).message}` });
      continue;
    }
    const text = typeof r === "string" ? r : r.text;
    let json: { subrc?: number; lines?: string[]; detail?: string; error?: string } | undefined;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    if (!json || (typeof r !== "string" && r.isError)) {
      out.push({ target, status: "sin_comparar", detail: `no se pudo consultar ${target}: ${text.split("\n")[0].slice(0, 160)}` });
      continue;
    }
    if (json.subrc !== 0 || !Array.isArray(json.lines)) {
      out.push({ target, status: "ausente", detail: `no existe en ${target}${json.detail ? ` (${json.detail})` : ""}: el cambio llegará como objeto nuevo` });
      continue;
    }
    // Los finales de línea y las líneas vacías del final no son diferencias.
    const isFunc = obj.type.toUpperCase() === "FUGR/FF";
    const norm = (s: string) => (isFunc ? functionBody(s) : s).replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n+$/, "");
    const ops = diffLines(norm(json.lines.join("\n")), norm(devSource));
    if (!ops) {
      out.push({ target, status: "distinta", detail: `DIFERENTE de ${target}: demasiadas diferencias para mostrarlas` });
      continue;
    }
    const u = unified(ops, 2);
    if (!u.hunks) {
      out.push({ target, status: "igual", detail: `idéntica a ${target}` });
      continue;
    }
    const lines = u.text.split("\n");
    out.push({
      target,
      status: "distinta",
      detail: `DIFERENTE de ${target}: ${u.added} líneas solo en DEV, ${u.removed} solo en ${target}, ${u.hunks} bloques`,
      diff: lines.slice(0, 60).join("\n") + (lines.length > 60 ? `\n[… ${lines.length - 60} líneas más]` : ""),
    });
  }
  return out;
}

/**
 * Cuerpo de un módulo de función sin su cabecera de interfaz: ADT la muestra como sentencia FUNCTION … TABLES … LIKE …,
 * y el include U<nn> del destino trae la generada por SE37 (FUNCTION x. + bloque de comentarios *"). Son el mismo
 * módulo con dos pintas distintas; comparar la cabecera daría «diferente» siempre.
 */
export function functionBody(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (/^\s*FUNCTION\b/i.test(lines[i] ?? "")) {
    if (/\.\s*$/.test(lines[i])) {
      // Forma de SE37: «FUNCTION x.» seguida del bloque *" de la interfaz
      i++;
      while (i < lines.length && /^\*"/.test(lines[i])) i++;
    } else {
      // Forma de ADT: la sentencia FUNCTION termina en la primera línea acabada en punto
      while (i < lines.length && !/\.\s*$/.test(lines[i])) i++;
      i++;
    }
  }
  while (i < lines.length && lines[i].trim() === "") i++;
  return lines.slice(i).join("\n");
}

/** Cómo contarlo en un veredicto: lo que implica para el cambio que se va a hacer. */
export function driftVerdict(d: Drift): string {
  switch (d.status) {
    case "igual":
      return `${d.target}: ${d.detail}.`;
    case "ausente":
      return `${d.target}: ${d.detail}.`;
    case "distinta":
      return `${d.target}: ${d.detail}. Si editas ahora, el pase arrastrará lo que DEV ya tiene de más, y lo que ${d.target} tiene de más se perderá al importar. Revisa el diff antes de tocar nada.`;
    default:
      return `${d.target}: ${d.detail}.`;
  }
}
