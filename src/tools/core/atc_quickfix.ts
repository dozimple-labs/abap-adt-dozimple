import { z } from "zod";
import type { FixProposal } from "abap-adt-api";
import { objectScope, recallRun, runAge, transportScope } from "../../core/atc.js";
import { assertTrkorr } from "../../core/policy.js";
import { isError, renderSyntax, syntaxCheck } from "../../core/checks.js";
import { diffLines, unified } from "../../core/diff.js";
import { applyEdits } from "../../core/edits.js";
import { ToolError } from "../../core/errors.js";
import { decodeEntities, MAX_HTML_INPUT, neutralizeMarkup, stripTags } from "../../core/feeds.js";
import { resolveObject, sourceUrl, TYPE_HELP, type ResolvedObject } from "../../core/objects.js";
import { defineTool } from "../../core/tool.js";

const decode = decodeEntities;
/** ADT entrega estas descripciones con el HTML escapado dentro del XML: se decodifica dos veces, a propósito, y luego se quitan etiquetas. */
const plain = (html: string) => neutralizeMarkup(stripTags(decode(decode(html.slice(0, MAX_HTML_INPUT))), "")).replace(/\s+/g, " ").trim();

/** Columnas donde probar: la indicada y el inicio de cada token de la línea (literales primero). */
export function candidateColumns(line: string, given: number): number[] {
  const cols = new Set<number>();
  if (given > 0) cols.add(given);
  const quote = line.indexOf("'");
  if (quote >= 0) cols.add(quote + 1);
  const re = /[A-Za-z_\/][\w\/~>=-]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) && cols.size < 12) cols.add(m.index + 1);
  return [...cols];
}

export default defineTool({
  name: "atc_quickfix",
  title: "Correcciones propuestas por SAP",
  description:
    "Correcciones que SAP ofrece (las de Ctrl+1 en Eclipse) para un hallazgo ATC o una línea: crear símbolo de " +
    "texto, extraer constante… Sin apply lista las propuestas; apply=N calcula el cambio SIN GUARDAR y devuelve " +
    "diff y sintaxis; para guardar, pasa el fuente resultante a write_source (return_source=true). Flujo: run_atc " +
    "→ atc_quickfix(finding=N) → apply=K.",
  access: "read",
  requires: { adt: ["/sap/bc/adt/quickfixes"] },
  input: {
    finding: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Número de hallazgo del run_atc de object_name (o transport); sin ellos, del último run_atc del sistema"),
    transport: z.string().optional().describe("Con finding: el hallazgo es del run_atc de esta orden"),
    object_name: z.string().optional(),
    object_type: z.string().optional().describe(TYPE_HELP),
    line: z.number().int().min(1).optional(),
    column: z.number().int().min(0).optional(),
    apply: z.number().int().min(1).optional().describe("Propuesta a calcular (de la lista)"),
    return_source: z.boolean().default(false).describe("Incluir el fuente completo resultante (para write_source)"),
  },
  async run(a, { sap, system }) {
    const c = await sap.adt();
    let obj: ResolvedObject;
    let src: string;
    let line: number;
    let column = a.column ?? 0;
    let context = "";

    if (a.finding) {
      // El hallazgo N es del ATC del objeto u orden que se nombran, nunca de otro analizado antes.
      let key: string | undefined;
      let named = "";
      if (a.transport) {
        const tr = assertTrkorr(a.transport);
        key = transportScope(tr);
        named = `la orden ${tr}`;
      } else if (a.object_name) {
        const named0 = await resolveObject(c, a.object_name, a.object_type);
        key = objectScope(named0.name);
        named = named0.name;
      }
      const run = recallRun(system.id, key);
      if (!run) {
        throw new ToolError(
          "INPUT",
          key ? `No hay un run_atc de ${named} en esta sesión: ejecuta run_atc sobre ese objeto primero.` : "No hay un run_atc en esta sesión: ejecútalo primero.",
        );
      }
      const f = run.findings.find((x) => x.n === a.finding);
      if (!f) throw new ToolError("INPUT", `El ATC de ${run.scope} tiene ${run.findings.length} hallazgos: no existe el ${a.finding}.`);
      obj = { name: f.objectName, type: f.objectType, uri: f.objectUri };
      src = f.sourceUri;
      line = f.line;
      column = a.column ?? f.column;
      context = `Hallazgo ${f.n} del ATC de ${run.scope} (${runAge(run)}): P${f.priority} [${f.checkTitle}] ${decode(f.messageTitle)}\n`;
    } else {
      if (!a.object_name || !a.line) throw new ToolError("INPUT", "Indica finding, o object_name + line.");
      obj = await resolveObject(c, a.object_name, a.object_type);
      src = await sourceUrl(c, obj);
      line = a.line;
    }

    // Las posiciones del ATC son de la versión ACTIVA. Si hay cambios sin activar, no se mezcla.
    const active = await c.getObjectSource(src, { version: "active" });
    const latest = await c.getObjectSource(src, { version: "inactive" });
    if (active !== latest) {
      throw new ToolError(
        "INPUT",
        `${obj.name} tiene cambios guardados sin activar: las líneas del ATC ya no corresponden. Activa y vuelve a ejecutar run_atc.`,
      );
    }
    const lines = active.replace(/\r\n/g, "\n").split("\n");
    const text = lines[line - 1];
    if (text === undefined) throw new ToolError("INPUT", `${obj.name} tiene ${lines.length} líneas.`);

    const found: Array<{ p: FixProposal; col: number }> = [];
    const seen = new Set<string>();
    for (const col of candidateColumns(text, column)) {
      const props = await c.fixProposals(src, active, line, col);
      for (const p of props) {
        const key = `${p["adtcore:uri"]}|${plain(p["adtcore:name"])}`;
        if (!seen.has(key)) {
          seen.add(key);
          found.push({ p, col });
        }
      }
    }
    const head = `${context}${obj.name} L${line}: ${text.trim()}\n`;
    if (!found.length) {
      return `${head}\nSAP no ofrece correcciones automáticas en esta línea (se probaron ${candidateColumns(text, column).length} posiciones). Hay que corregir a mano.`;
    }

    if (!a.apply) {
      return (
        `${head}\nCorrecciones que ofrece SAP:\n` +
        found.map((f, i) => `  ${i + 1}. ${plain(f.p["adtcore:name"])} — ${plain(f.p["adtcore:description"]).slice(0, 220)}`).join("\n") +
        `\n\nPara ver el cambio sin guardar: atc_quickfix(... apply=N).`
      );
    }

    const chosen = found[a.apply - 1];
    if (!chosen) throw new ToolError("INPUT", `Solo hay ${found.length} propuestas.`);
    const deltas = await c.fixEdits(chosen.p, active);
    if (!deltas.length) {
      return {
        text:
          `${head}\nPropuesta ${a.apply}: ${plain(chosen.p["adtcore:name"])}\n\nSAP no devuelve cambios aplicables para esta ` +
          `propuesta: las de tipo «Rename» abren el asistente de renombrado de Eclipse y no se aplican por aquí.`,
        isError: true,
      };
    }
    const here = deltas.filter((d) => d.uri.split("#")[0] === src);
    const elsewhere = deltas.filter((d) => d.uri.split("#")[0] !== src);
    const next = applyEdits(active, here);
    const ops = diffLines(active, next);
    const u = ops ? unified(ops, 2) : undefined;
    const msgs = await syntaxCheck(c, obj, src, next);
    const errs = msgs.filter(isError);

    const out = [
      `${head}\nPropuesta ${a.apply}: ${plain(chosen.p["adtcore:name"])} (NO guardado)`,
      "",
      u?.text || "(la corrección no cambia este fuente)",
    ];
    if (elsewhere.length) {
      out.push(
        "",
        `⚠ Esta corrección también modifica otros objetos que atc_quickfix NO aplica: ${elsewhere.map((d) => d.name || d.uri).join(", ")}. ` +
          `Si es el pool de textos, crea el símbolo con abap-fs (manage_text_elements) antes de guardar.`,
      );
    }
    out.push("", errs.length ? `Sintaxis con el cambio: ${errs.length} errores\n${renderSyntax(msgs)}` : "Sintaxis con el cambio: sin errores (comprobado por SAP).");
    if (a.return_source) out.push("", "Fuente resultante completo:", "```abap", next, "```");
    else out.push("", "Para guardarlo: repite con return_source=true y pasa ese fuente a write_source con la orden.");
    return { text: out.join("\n"), isError: errs.length > 0 };
  },
});
