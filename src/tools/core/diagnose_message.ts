import { z } from "zod";
import { ToolError } from "../../core/errors.js";
import { sqlLiteral } from "../../core/objects.js";
import { tsv } from "../../core/output.js";
import { defineTool } from "../../core/tool.js";
import { sapLanguage } from "./function_modules.js";

/**
 * De un mensaje de pantalla (clase + número, o el texto «E:ZDEMO:012» que copia la gente) a su texto en varios
 * idiomas y al código que lo emite. Es el primer paso real de casi todo ticket: la persona tiene el mensaje, no el
 * programa. El where-used de mensajes de ADT no ve `MESSAGE ID ... NUMBER` dinámicos ni mensajes en textos de
 * excepciones: por eso se ofrece también la búsqueda en fuente acotada a un paquete.
 */
const CLASS_RE = /^(\/[A-Z0-9_]+\/)?[A-Z0-9_]{1,20}$/;

/** Admite «ZDEMO 012», «ZDEMO012», «E:ZDEMO:012», «ZDEMO(012)», «Mensaje no. 012 de la clase ZDEMO». */
export function parseMessage(text: string): { cls: string; num: string } | undefined {
  const t = text.trim().toUpperCase();
  const m =
    /^(?:[AEIWSX]:)?((?:\/[A-Z0-9_]+\/)?[A-Z][A-Z0-9_]{0,19})\s*[:(\s-]\s*(\d{1,3})\)?$/.exec(t) ??
    /^(?:[AEIWSX]:)?((?:\/[A-Z0-9_]+\/)?[A-Z][A-Z0-9_]*?)(\d{3})$/.exec(t) ??
    /(\d{1,3})\D*?\s((?:\/[A-Z0-9_]+\/)?[A-Z][A-Z0-9_]{0,19})$/.exec(t);
  if (!m) return undefined;
  const [cls, num] = /^\d/.test(m[1]) ? [m[2], m[1]] : [m[1], m[2]];
  return { cls, num: num.padStart(3, "0") };
}

export default defineTool({
  name: "diagnose_message",
  title: "Diagnosticar un mensaje",
  description:
    "Parte de un mensaje de pantalla (clase y número, o el texto tal como lo copió la persona: «E:ZDEMO:012», " +
    "«ZDEMO 012») y devuelve su texto en el idioma de la conexión y en inglés, los marcadores (&1…) y qué programas, " +
    "clases o funciones lo emiten (where-used de ADT). Primer paso de un ticket: del mensaje al código. No ve " +
    "mensajes dinámicos (MESSAGE ID … NUMBER con variables): para eso, source_search en el paquete sospechoso.",
  access: "read",
  input: {
    message: z.string().min(1).describe("«CLASE NNN», «E:CLASE:NNN» o el texto copiado de la barra de estado"),
    max_usages: z.number().int().min(1).max(500).default(50),
  },
  async run({ message, max_usages }, ctx) {
    const parsed = parseMessage(message);
    if (!parsed || !CLASS_RE.test(parsed.cls)) {
      throw new ToolError("INPUT", `No reconozco clase y número en «${message}».`, "Escríbelo como «ZDEMO 012» o «E:ZDEMO:012».");
    }
    const { cls, num } = parsed;
    const { sap, system } = ctx;
    const lang = sapLanguage(system.language);
    const rows = await sap.query(`SELECT sprsl, text FROM t100 WHERE arbgb = ${sqlLiteral(cls)} AND msgnr = ${sqlLiteral(num)}`, 50);
    if (!rows.values.length) {
      const any = await sap.query(`SELECT msgnr FROM t100 WHERE arbgb = ${sqlLiteral(cls)} AND sprsl = ${sqlLiteral(lang)}`, 1);
      throw new ToolError("NOT_FOUND", any.values.length ? `La clase ${cls} existe pero no tiene el mensaje ${num}.` : `No existe la clase de mensajes ${cls}.`);
    }
    const texts = new Map(rows.values.map((r) => [String(r.SPRSL).trim(), String(r.TEXT ?? "").trim()]));
    const main = texts.get(lang) ?? texts.get("E") ?? [...texts.values()][0];
    const out = [`Mensaje ${cls} ${num}`, `  ${lang}: ${texts.get(lang) ?? "(sin texto en este idioma)"}`];
    if (lang !== "E" && texts.has("E")) out.push(`  E: ${texts.get("E")}`);
    const placeholders = [...new Set(main.match(/&\d?|\$\d/g) ?? [])];
    if (placeholders.length) out.push(`  Marcadores: ${placeholders.join(" ")} (se rellenan con MESSAGE … WITH; el texto final depende del código)`);

    ctx.progress?.(`Buscando quién emite ${cls} ${num}…`);
    const c = await sap.adt();
    const uri = `/sap/bc/adt/messageclass/${encodeURIComponent(cls.toLowerCase())}/messages/${num}`;
    let usages: Array<Record<string, any>> | undefined;
    try {
      usages = (await c.usageReferences(uri)).filter((r) => r.isResult);
    } catch {
      usages = undefined;
    }
    if (usages === undefined) {
      out.push("", "Where-used: no disponible para mensajes en este sistema.", `Alternativa: source_search(text="${num}(${cls})") en el paquete sospechoso, y también "MESSAGE ID '${cls}'" por si el número es dinámico.`);
    } else if (!usages.length) {
      out.push("", "Where-used: se ejecutó y no encontró usos estáticos.", `Puede emitirse de forma dinámica (MESSAGE ID '${cls}' TYPE … NUMBER lv_num) o desde un texto de excepción: prueba source_search(text="${cls}") en el paquete sospechoso.`);
    } else {
      const shown = usages.slice(0, max_usages);
      out.push(
        "",
        `Lo emiten ${usages.length} objetos${usages.length > shown.length ? ` (se muestran ${shown.length})` : ""}:`,
        tsv(["objeto", "tipo", "paquete", "dónde"], shown.map((r) => [r["adtcore:name"], r["adtcore:type"], r.packageRef?.["adtcore:name"], r.usageInformation])),
        `Siguiente paso: get_source del objeto y buscar «${num}(${cls})» o «${cls}» para ver la condición que lo dispara.`,
      );
    }
    return out.join("\n");
  },
});
