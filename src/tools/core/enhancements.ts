import { z } from "zod";
import { rowCap } from "../../core/datapolicy.js";
import { ToolError } from "../../core/errors.js";
import { sqlLiteral } from "../../core/objects.js";
import { tsv } from "../../core/output.js";
import { defineTool } from "../../core/tool.js";

/**
 * Ampliaciones del sistema por SQL de diccionario (valen en 7.50 y S/4):
 * - BAdI nuevas (framework de ampliaciones): BADIIMPL_ENH; clásicas: SXC_EXIT + SXC_ATTR.
 * - Ampliaciones en código (puntos y secciones implícitos o explícitos): ENHINCINX, por programa principal.
 * - Implementaciones de ampliación: ENHHEADER.
 * Los significados vienen del diccionario (ENHMODE, ENHBOOLEAN, ACTIVEFLAG), verificados en un 7.50.
 */

const ENHMODE: Record<string, string> = { S: "estática", D: "dinámica" };
/** ENHTOOLTYPE no tiene valores fijos en el diccionario: se muestra el código y, si se conoce, qué es. */
const TOOL: Record<string, string> = {
  HOOK_IMPL: "ampliación de código (punto o sección)",
  BADI_IMPL: "implementación de BAdI",
  CLASENH: "ampliación de clase",
  INTFENH: "ampliación de interfaz",
  FUGRENH: "ampliación de grupo de funciones",
  WDYENH: "ampliación Web Dynpro",
};
const tool = (t: string) => (TOOL[t] ? `${t} (${TOOL[t]})` : t);

/** Nombre del programa principal que usa ENHINCINX: clase → NOMBRE====…CP (32), grupo → SAPL<grupo>. */
export function mainProgram(name: string, type: "PROG" | "CLAS" | "FUGR"): string {
  const n = name.trim().toUpperCase();
  if (type === "PROG") return n;
  if (type === "CLAS") return `${n.padEnd(30, "=")}CP`;
  const m = /^(\/[^/]+\/)(.+)$/.exec(n);
  return m ? `${m[1]}SAPL${m[2]}` : `SAPL${n}`;
}

const NAME = /^[A-Z0-9_/]{1,40}$/i;
/** Propias del cliente primero: Z, Y y espacios de nombres que no son de SAP no se distinguen aquí; Z/Y sí. */
const isCustom = (n: string) => /^[ZY]/i.test(n);

export default defineTool({
  name: "enhancements",
  title: "Ampliaciones y BAdI",
  description:
    "Qué ampliaciones hay y dónde. badi=NOMBRE: implementaciones de esa BAdI, nuevas y clásicas, activas o no. " +
    "program + program_type (PROG, CLAS, FUGR): ampliaciones de código implementadas dentro de ese programa, " +
    "clase o grupo, lo que cambia un estándar sin tocarlo. prefix (p. ej. Z): implementaciones de ese espacio de " +
    "nombres, por tipo. Solo lectura.",
  access: "read",
  input: {
    badi: z.string().regex(NAME).optional().describe("Definición de BAdI, p. ej. MB_MIGO_BADI"),
    program: z.string().regex(NAME).optional().describe("Programa, clase o grupo de funciones ampliado, p. ej. SAPMV45A"),
    program_type: z.enum(["PROG", "CLAS", "FUGR"]).default("PROG"),
    prefix: z.string().regex(/^[A-Z0-9_/]{1,20}$/i).optional().describe("Implementaciones cuyo nombre empieza así, p. ej. Z o ZSD"),
    tool_type: z.string().regex(/^[A-Z_]{3,20}$/i).optional().describe("Con prefix: filtrar por tipo, p. ej. BADI_IMPL o HOOK_IMPL"),
    max: z.number().int().min(1).max(2000).default(200),
  },
  output: {
    mode: z.enum(["badi", "program", "prefix"]),
    target: z.string(),
    rows: z.array(z.record(z.union([z.string(), z.number(), z.boolean()]))),
    total: z.number().int(),
    truncated: z.boolean(),
  },
  async run({ badi, program, program_type, prefix, tool_type, max }, { sap, system }) {
    if ([badi, program, prefix].filter(Boolean).length !== 1) throw new ToolError("INPUT", "Indica exactamente uno: badi, program o prefix.");
    const cap = Math.min(max, rowCap(system));

    if (badi) {
      const b = badi.toUpperCase();
      const kernel = await sap.query(`SELECT enhname, badi_impl, active, spotname FROM badiimpl_enh WHERE badi_name = ${sqlLiteral(b)}`, 2000);
      const classic = await sap.query(`SELECT imp_name FROM sxc_exit WHERE exit_name = ${sqlLiteral(b)}`, 2000);
      const names = classic.values.map((v) => String(v.IMP_NAME).trim());
      const attr = names.length ? await sap.query(`SELECT imp_name, active FROM sxc_attr WHERE imp_name IN ( ${names.map(sqlLiteral).join(", ")} )`, 2000) : { values: [] };
      const activeClassic = new Map(attr.values.map((v) => [String(v.IMP_NAME).trim(), v.ACTIVE === "X"]));
      // Una BAdI clásica migrada aparece en las dos tablas: se muestra una vez, como nueva.
      const kernelImpls = new Set(kernel.values.map((v) => String(v.BADI_IMPL).trim()));
      const rows = [
        ...kernel.values.map((v) => ({ implementation: String(v.BADI_IMPL).trim(), kind: "nueva", enhancement: String(v.ENHNAME).trim(), spot: String(v.SPOTNAME ?? "").trim(), active: v.ACTIVE === "X" })),
        ...names.filter((n) => !kernelImpls.has(n)).map((n) => ({ implementation: n, kind: "clásica", enhancement: "", spot: "", active: activeClassic.get(n) ?? false })),
      ].sort((a, b2) => Number(isCustom(b2.implementation)) - Number(isCustom(a.implementation)) || Number(b2.active) - Number(a.active) || a.implementation.localeCompare(b2.implementation));
      const shown = rows.slice(0, cap);
      const structured = { mode: "badi" as const, target: b, rows: shown, total: rows.length, truncated: rows.length > cap };
      if (!rows.length) return { text: `La BAdI ${b} no tiene implementaciones en este sistema (se consultaron BADIIMPL_ENH y SXC_EXIT).`, structured };
      const act = rows.filter((r) => r.active).length;
      return {
        text:
          `BAdI ${b}: ${rows.length} implementaciones, ${act} activas, ${rows.filter((r) => isCustom(r.implementation)).length} propias (Z/Y, primero)` +
          `${rows.length > cap ? ` (se muestran ${cap})` : ""}\n\n` +
          tsv(["implementación", "tipo", "activa", "ampliación", "spot"], shown.map((r) => [r.implementation, r.kind, r.active ? "sí" : "NO", r.enhancement, r.spot])),
        structured,
      };
    }

    if (program) {
      const p = mainProgram(program, program_type);
      const r = await sap.query(
        `SELECT enhname, version, enhmode, overwrite FROM enhincinx WHERE programname = ${sqlLiteral(p)} ORDER BY enhname`,
        5000,
      );
      const by = new Map<string, { enhancement: string; mode: string; active: boolean; overwrite: boolean; places: number }>();
      for (const v of r.values) {
        const k = String(v.ENHNAME).trim();
        const cur = by.get(k) ?? { enhancement: k, mode: ENHMODE[String(v.ENHMODE)] ?? String(v.ENHMODE), active: false, overwrite: false, places: 0 };
        cur.places++;
        if (v.VERSION === "A") cur.active = true;
        if (v.OVERWRITE === "X") cur.overwrite = true;
        by.set(k, cur);
      }
      const rows = [...by.values()].sort((a, b2) => a.enhancement.localeCompare(b2.enhancement));
      const shown = rows.slice(0, cap);
      const structured = { mode: "program" as const, target: p, rows: shown, total: rows.length, truncated: rows.length > cap };
      if (!rows.length) return { text: `${program.toUpperCase()} (${p}) no tiene ampliaciones de código implementadas (se consultó ENHINCINX).`, structured };
      const over = rows.filter((x) => x.overwrite).length;
      return {
        text:
          `${program.toUpperCase()} (${p}): ${rows.length} implementaciones de ampliación en su código` +
          `${over ? ` — ${over} SUSTITUYEN código estándar (overwrite)` : ""}${rows.length > cap ? ` (se muestran ${cap})` : ""}\n\n` +
          tsv(["ampliación", "modo", "activa", "sustituye", "lugares"], shown.map((x) => [x.enhancement, x.mode, x.active ? "sí" : "solo inactiva", x.overwrite ? "SÍ" : "", x.places])),
        structured,
      };
    }

    const pre = prefix!.toUpperCase();
    const typeFilter = tool_type ? ` AND enhtooltype = ${sqlLiteral(tool_type.toUpperCase())}` : "";
    const where = `WHERE enhname LIKE ${sqlLiteral(`${pre}%`)} AND version = 'A'${typeFilter}`;
    const counts = await sap.query(`SELECT enhtooltype, COUNT(*) AS n FROM enhheader ${where} GROUP BY enhtooltype`, 50);
    const total = counts.values.reduce((s, v) => s + Number(v.N), 0);
    const r = await sap.query(`SELECT enhname, enhtooltype FROM enhheader ${where} ORDER BY enhname`, cap);
    const rows = r.values.map((v) => ({ enhancement: String(v.ENHNAME).trim(), type: String(v.ENHTOOLTYPE).trim() }));
    const structured = { mode: "prefix" as const, target: pre, rows, total, truncated: total > rows.length };
    if (!total) return { text: `No hay implementaciones de ampliación activas que empiecen por ${pre}${tool_type ? ` de tipo ${tool_type}` : ""}.`, structured };
    const summary = counts.values.map((v) => `${tool(String(v.ENHTOOLTYPE).trim())}: ${Number(v.N)}`).join(" · ");
    return {
      text: `${total} implementaciones de ampliación activas que empiezan por ${pre}${total > rows.length ? ` (se muestran ${rows.length})` : ""}\n${summary}\n\n` +
        tsv(["ampliación", "tipo"], rows.map((x) => [x.enhancement, x.type])),
      structured,
    };
  },
});
