import type { SystemConfig } from "./config.js";
import { HR_TABLE_RE, SENSITIVE_COLUMNS, SENSITIVE_PREFIXES, SENSITIVE_TABLES } from "./policy.js";

/**
 * Acceso elevado (Ola 2, punto 7). Los datos de SAP se clasifican en categorías; las de más riesgo solo se leen con
 * una elevación que la persona aprueba (vista previa + confirmación), por sistema, categoría y tiempo, y que deja
 * eventos `elevation_*` en el registro de auditoría. `SECRETOS` no se eleva nunca. La elevación vive en memoria del
 * proceso: un reinicio la pierde (como los tokens de confirmación), que es más seguro que persistirla.
 */
export type Category = "SECRETOS" | "SEG_ROLES" | "HCM_MAESTRO" | "HCM_NOMINA" | "PERSONAS_NEGOCIO" | "NEGOCIO";

export const ELEVABLE = ["SEG_ROLES", "HCM_MAESTRO", "HCM_NOMINA", "PERSONAS_NEGOCIO"] as const;
export type Elevable = (typeof ELEVABLE)[number];

/** Categorías que bloquean la lectura sin elevación (PERSONAS_NEGOCIO no bloquea: enmascara). */
export const BLOCKING: Elevable[] = ["SEG_ROLES", "HCM_MAESTRO", "HCM_NOMINA"];

export const CATEGORY_LABEL: Record<Category, string> = {
  SECRETOS: "credenciales, almacén seguro, claves y dumps (nunca)",
  SEG_ROLES: "seguridad: usuarios, roles, perfiles y autorizaciones",
  HCM_MAESTRO: "datos maestros de personal (infotipos, estructura organizativa, candidatos)",
  HCM_NOMINA: "nómina y pagos a personas",
  PERSONAS_NEGOCIO: "datos personales de clientes, proveedores e interlocutores (en claro)",
  NEGOCIO: "datos de negocio",
};

export const MAX_ELEVATION_MINUTES = 480;
export const DEFAULT_MAX_MINUTES = 60;

const SEG_ROLES_RE = /^(AGR_[A-Z0-9_]+|USR0[13-9]|USR[1-9]\d|USRBF\d|UST\d{2}[A-Z]?|USOB[A-Z0-9_]*|SUSR[A-Z0-9_]*|USH0[4-9]|USH1\d|USGRP[A-Z0-9_]*|USLOGON|USREFUS|USREXTID|USORG|USRATTR|USZBVSYS|SMEN_[A-Z0-9_]+|TOBJ|TACT|TACTZ|PRGN_[A-Z0-9_]+)$/;
const HCM_NOMINA_RE = /^(PCL[1-5]|HRPY_[A-Z0-9_]+|PA0008|PA0009|PA0011|PA0014|PA0015|PA0267|PA0416|PA0045|PA0057)$/;
const HCM_MAESTRO_RE = /^(PA\d{4}|PB\d{4}|HRP\d{4}|HRT\d{4}|PAD\d{4}|HRHAP[A-Z0-9_]*|ASSHR|ASSOB|PTEX\d{4}|PTQUODED|PTRV_[A-Z0-9_]+|HRP1000|T77[A-Z0-9_]*)$/;
const PERSONAS_TABLES = new Set([
  "KNA1", "KNBK", "KNVK", "LFA1", "LFBK", "ADRC", "ADRP", "ADR2", "ADR3", "ADR6", "ADR12", "ADCP", "BUT000", "BUT020", "BUT0BK", "BUT0ID", "BUT021_FS", "SADR", "TIBAN", "DFKKBPTAXNUM", "CVI_CUST_LINK", "CVI_VEND_LINK",
]);

/** Categoría de una tabla, vista o entidad por su nombre. Las entidades CDS se clasifican por sus tablas base. */
export function classify(name: string): Category {
  const n = name.toUpperCase();
  if (SENSITIVE_TABLES.includes(n) || SENSITIVE_COLUMNS.includes(n) || SENSITIVE_PREFIXES.some((p) => n.startsWith(p))) return "SECRETOS";
  if (HCM_NOMINA_RE.test(n)) return "HCM_NOMINA";
  if (HR_TABLE_RE.test(n) || HCM_MAESTRO_RE.test(n)) return "HCM_MAESTRO";
  if (SEG_ROLES_RE.test(n)) return "SEG_ROLES";
  if (PERSONAS_TABLES.has(n)) return "PERSONAS_NEGOCIO";
  return "NEGOCIO";
}

/** Categorías presentes en un conjunto de nombres, con las tablas que las aportan. */
export function categorize(names: Iterable<string>): Map<Category, string[]> {
  const out = new Map<Category, string[]>();
  for (const n of names) {
    const c = classify(n);
    if (c === "NEGOCIO") continue;
    out.set(c, [...(out.get(c) ?? []), n.toUpperCase()]);
  }
  return out;
}

export interface Elevation {
  system: string;
  category: Elevable;
  reason: string;
  grantedAt: string;
  until: number;
  grantedBy: string;
}

const active = new Map<string, Elevation>();
const key = (system: string, category: string) => `${system.toUpperCase()}|${category.toUpperCase()}`;

/** Lo que la configuración permite elevar en un sistema: en productivo, nunca nómina ni maestro HCM por defecto. */
export function allowedElevations(s: SystemConfig): Elevable[] {
  const cfg = s.elevation?.allowed;
  if (cfg) return cfg as Elevable[];
  return s.role === "PRD" ? ["SEG_ROLES", "PERSONAS_NEGOCIO"] : [...ELEVABLE];
}

export function maxMinutes(s: SystemConfig): number {
  return Math.min(s.elevation?.maxMinutes ?? DEFAULT_MAX_MINUTES, MAX_ELEVATION_MINUTES);
}

export function grantElevation(e: Omit<Elevation, "grantedAt">, now = Date.now()): Elevation {
  const full: Elevation = { ...e, grantedAt: new Date(now).toISOString() };
  active.set(key(e.system, e.category), full);
  return full;
}

/** Elevación vigente para esa categoría en ese sistema, o undefined (las caducadas se retiran al consultarlas). */
export function activeElevation(system: string, category: Elevable, now = Date.now()): Elevation | undefined {
  const e = active.get(key(system, category));
  if (!e) return undefined;
  if (e.until <= now) {
    active.delete(key(system, category));
    return undefined;
  }
  return e;
}

export const isElevated = (system: string, category: Elevable, now = Date.now()) => !!activeElevation(system, category, now);

export function revokeElevation(system: string, category?: Elevable): Elevation[] {
  const out: Elevation[] = [];
  for (const [k, e] of active) {
    if (e.system.toUpperCase() !== system.toUpperCase()) continue;
    if (category && e.category !== category) continue;
    active.delete(k);
    out.push(e);
  }
  return out;
}

export function listElevations(system?: string, now = Date.now()): Elevation[] {
  const out: Elevation[] = [];
  for (const [k, e] of active) {
    if (e.until <= now) {
      active.delete(k);
      continue;
    }
    if (!system || e.system.toUpperCase() === system.toUpperCase()) out.push(e);
  }
  return out.sort((a, b) => a.system.localeCompare(b.system) || a.category.localeCompare(b.category));
}

/** Solo para tests. */
export function resetElevationsForTests(): void {
  active.clear();
}

export const minutesLeft = (e: Elevation, now = Date.now()) => Math.max(0, Math.ceil((e.until - now) / 60_000));
