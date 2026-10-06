import { z } from "zod";
import type { SapConnection } from "../../core/connection.js";
import { ToolError } from "../../core/errors.js";
import { sqlLiteral } from "../../core/objects.js";
import { tsv } from "../../core/output.js";
import { defineTool } from "../../core/tool.js";
import { sapLanguage } from "./function_modules.js";

/**
 * De un mensaje de pantalla (clase + número, o el texto «E:ZDEMO:012» que copia la gente) a su texto en varios
 * idiomas y al código que lo emite. Es el primer paso real de casi todo ticket: la persona tiene el mensaje, no el
 * programa. El where-used de mensajes de ADT devuelve vacío en 7.50; el índice CROSS (SE91) sí tiene los MESSAGE
 * estáticos. Los dinámicos (`MESSAGE ID ... NUMBER variable`) no están en ningún índice: se listan los programas que
 * declaran la clase y se remite a source_search.
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

/** Títulos de las secciones estándar de la documentación de un mensaje (símbolos de SAPscript). */
const SECTION: Record<string, string> = { CAUSE: "Causa", SYSTEM_RESPONSE: "Respuesta del sistema", WHAT_TO_DO: "Qué hacer", SYS_ADMIN: "Administración del sistema", PROCEDURE: "Procedimiento", NOTE: "Nota", EXAMPLE: "Ejemplo", DEFINITION: "Definición", USE: "Uso" };

/**
 * Texto largo del mensaje (el botón de ayuda de la barra de estado) a partir de las líneas de DOKTL, que están en
 * formato ITF de SAPscript: U1 = título, AS/vacío = párrafo (la línea vacía continúa el anterior), B1 = viñeta,
 * «/:» = comando (INCLUDE de un texto estándar). Se devuelve como texto plano legible.
 */
export function renderDocu(lines: Array<{ format: string; text: string }>): string {
  const out: string[] = [];
  let para = "";
  const flush = () => {
    if (para.trim()) out.push(para.trim());
    para = "";
  };
  for (const l of lines) {
    const f = l.format.trim().toUpperCase();
    const t = l.text.replace(/&([A-Z_]+)&/g, (m, k: string) => SECTION[k] ?? m);
    if (f === "U1" || f === "U2" || f === "U3") {
      flush();
      out.push(`${t.trim()}:`);
    } else if (f === "/:") {
      flush();
      const inc = /INCLUDE\s+'([^']+)'/i.exec(t);
      out.push(inc ? `[texto estándar incluido: ${inc[1]}]` : `[${t.trim()}]`);
    } else if (f === "B1" || f === "N1") {
      flush();
      para = `• ${t}`;
    } else if (f === "" || f === "AS" || f === "/") {
      if (f === "AS" || f === "/") flush();
      para = para ? `${para} ${t}` : t;
    } else {
      para = para ? `${para} ${t}` : t;
    }
  }
  flush();
  return out.join("\n");
}

async function messageDocu(sap: Pick<SapConnection, "query">, cls: string, num: string, lang: string): Promise<{ lang: string; text: string } | undefined> {
  const object = `${cls}${num}`;
  const versions = await sap.query(`SELECT langu, version FROM dokil WHERE id = 'NA' AND object = ${sqlLiteral(object)} AND typ = 'E' AND langu IN ( ${sqlLiteral(lang)}, 'E' )`, 4);
  const pick = versions.values.find((v) => String(v.LANGU).trim() === lang) ?? versions.values.find((v) => String(v.LANGU).trim() === "E");
  if (!pick) return undefined;
  const l = String(pick.LANGU).trim();
  const rows = await sap.query(
    `SELECT line, dokformat, doktext FROM doktl WHERE id = 'NA' AND object = ${sqlLiteral(object)} AND langu = ${sqlLiteral(l)} AND typ = 'E' AND dokversion = ${Number(pick.VERSION)} ORDER BY line`,
    500,
  );
  if (!rows.values.length) return undefined;
  return { lang: l, text: renderDocu(rows.values.map((r) => ({ format: String(r.DOKFORMAT ?? ""), text: String(r.DOKTEXT ?? "") }))) };
}

export default defineTool({
  name: "diagnose_message",
  title: "Diagnosticar un mensaje",
  description:
    "Parte de un mensaje de pantalla (clase y número, o el texto tal como lo copió la persona: «E:ZDEMO:012», " +
    "«ZDEMO 012») y devuelve su texto en el idioma de la conexión y en inglés, los marcadores (&1…) y qué programas, " +
    "clases o funciones lo emiten (índice de referencias cruzadas, el de SE91), más su texto largo (la ayuda del mensaje: causa, respuesta del " +
    "sistema, qué hacer) si existe. Primer paso de un ticket: del mensaje al código. Los mensajes con número " +
    "dinámico (MESSAGE ID … NUMBER variable) no están en el índice: se listan los programas que declaran la clase.",
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
    const docu = await messageDocu(sap, cls, num, lang);
    if (docu) out.push("", `Texto largo (ayuda del mensaje${docu.lang !== lang ? `, en ${docu.lang}` : ""}):`, docu.text.split("\n").map((x) => "  " + x).join("\n"));
    else out.push("", "Sin texto largo (el mensaje no tiene documentación).");

    ctx.progress?.(`Buscando quién emite ${cls} ${num}…`);
    // El índice de referencias cruzadas (CROSS, el de SE91) guarda cada MESSAGE estático como tipo N con el nombre
    // «clase a 20 caracteres + número», y el MESSAGE-ID de cada programa como tipo N con solo la clase.
    const key = `${cls.padEnd(20)}${num}`;
    const direct = await sap.query(`SELECT include FROM cross WHERE type = 'N' AND name = ${sqlLiteral(key)} ORDER BY include`, max_usages + 1);
    const includes = [...new Set(direct.values.map((v) => String(v.INCLUDE).trim()).filter(Boolean))];
    if (includes.length) {
      const shown = includes.slice(0, max_usages);
      out.push(
        "",
        `Lo emiten ${includes.length} includes${includes.length > shown.length ? ` (se muestran ${shown.length})` : ""}: ${shown.join(", ")}`,
        `Siguiente paso: get_source del include y buscar «${num}(${cls})» o «${cls}» para ver la condición que lo dispara.`,
      );
    } else {
      const byClass = await sap.query(`SELECT include FROM cross WHERE type = 'N' AND name = ${sqlLiteral(cls)} ORDER BY include`, 50);
      const decl = [...new Set(byClass.values.map((v) => String(v.INCLUDE).trim()).filter(Boolean))];
      out.push(
        "",
        "Ningún include lo emite de forma estática (índice de referencias cruzadas).",
        decl.length
          ? `Programas que declaran MESSAGE-ID ${cls} y pueden emitirlo con número dinámico (${decl.length}${decl.length > 20 ? ", se muestran 20" : ""}): ${decl.slice(0, 20).join(", ")}`
          : `Ningún programa declara MESSAGE-ID ${cls}: puede emitirse con MESSAGE ID '${cls}' … NUMBER variable o desde un texto de excepción. Prueba source_search(text="${cls}") en el paquete sospechoso.`,
      );
    }
    return out.join("\n");
  },
});
