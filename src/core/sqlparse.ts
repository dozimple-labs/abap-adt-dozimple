import { ToolError } from "./errors.js";

/**
 * Qué fuentes lee una consulta ABAP SQL, con un análisis que entiende la estructura (FROM, JOIN, subconsultas y
 * CTE) en vez de mirar todas las palabras. Si no se puede determinar con certeza (variables host, fuente dinámica,
 * paréntesis sin cerrar, sintaxis que no se reconoce), se rechaza: una consulta que no se entiende no se ejecuta.
 */
export interface SqlSources {
  /** Tablas, vistas o entidades CDS nombradas directamente (sin CTE ni alias), en mayúsculas. */
  tables: string[];
  /** Nombres de CTE (WITH +nombre AS …) que la consulta define. */
  ctes: string[];
}

type Tok = { t: "id" | "lit" | "num" | "p"; v: string };

const KEYWORD_AFTER_SOURCE = new Set(["AS", "ON", "WHERE", "INNER", "LEFT", "RIGHT", "OUTER", "CROSS", "JOIN", "GROUP", "ORDER", "HAVING", "UNION", "INTERSECT", "EXCEPT", "CLIENT", "WITH", "UP", ")", ","]);
const NOT_A_SOURCE = new Set(["SELECT", "WITH", "DISTINCT", "SINGLE", "FROM", "JOIN", "WHERE", "ON", "AS", "INNER", "LEFT", "RIGHT", "OUTER", "CROSS", "UNION", "ALL", "GROUP", "ORDER", "BY", "HAVING", "AND", "OR", "NOT", "IN", "EXISTS", "CASE", "WHEN", "THEN", "ELSE", "END", "NULL", "IS", "LIKE", "BETWEEN", "INTO", "UP", "TO", "ROWS", "FIELDS", "CLIENT", "SPECIFIED", "INTERSECT", "EXCEPT"]);

export function tokenize(sql: string): Tok[] {
  const out: Tok[] = [];
  const re = /\s+|('(?:[^']|'')*')|(`(?:[^`]|``)*`)|(\d+(?:\.\d+)?)|([A-Za-z_/+@$][A-Za-z0-9_/~.$]*)|([(),;*=<>!]|<=|>=|<>)|(.)/gy;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    if (m[0].trim() === "") continue;
    if (m[1] !== undefined || m[2] !== undefined) out.push({ t: "lit", v: m[0] });
    else if (m[3] !== undefined) out.push({ t: "num", v: m[3] });
    else if (m[4] !== undefined) out.push({ t: "id", v: m[4].toUpperCase() });
    else if (m[5] !== undefined) out.push({ t: "p", v: m[5] });
    else throw new ToolError("INPUT", `Carácter no admitido en la consulta: «${m[6]}».`);
  }
  return out;
}

/**
 * Analiza la consulta y devuelve sus fuentes. Lanza POLICY cuando no puede determinarlas: ese es el contrato. Lo
 * que sigue a FROM o JOIN tiene que ser un nombre de tabla/vista/CDS, un CTE declarado o una subconsulta
 * «( SELECT … )». Variables host (@…), fuentes dinámicas «(nombre)» y UP TO n ROWS se rechazan con el motivo.
 */
export function parseSources(sql: string): SqlSources {
  const toks = tokenize(sql);
  if (!toks.length) throw new ToolError("INPUT", "Consulta vacía.");
  const fail = (why: string, hint?: string): never => {
    throw new ToolError("POLICY", `No se puede determinar qué tablas lee la consulta (${why}): no se ejecuta.`, hint ?? "Escribe la consulta con FROM/JOIN explícitos sobre tablas, vistas o CDS; subconsultas entre paréntesis.");
  };
  const tables = new Set<string>();
  const ctes = new Set<string>();
  let depth = 0;

  // CTE: WITH +a AS ( … ), +b AS ( … ) SELECT …
  let i = 0;
  if (toks[0].t === "id" && toks[0].v === "WITH") {
    i = 1;
    for (;;) {
      const name = toks[i];
      if (!name || name.t !== "id" || !name.v.startsWith("+")) fail("un CTE tiene que llamarse +nombre");
      ctes.add(name.v);
      if (toks[i + 1]?.v !== "AS" || toks[i + 2]?.v !== "(") fail(`falta «AS (» tras ${name.v}`);
      i += 2; // en «(»: el bucle general recorre el cuerpo
      // avanzar hasta el paréntesis de cierre de este CTE
      let d = 0;
      let j = i;
      for (; j < toks.length; j++) {
        if (toks[j].v === "(") d++;
        else if (toks[j].v === ")" && --d === 0) break;
      }
      if (j >= toks.length) fail("paréntesis sin cerrar en un CTE");
      scan(toks.slice(i + 1, j));
      i = j + 1;
      if (toks[i]?.v === ",") {
        i++;
        continue;
      }
      break;
    }
    if (toks[i]?.v !== "SELECT") fail("tras los CTE debe venir SELECT");
  }
  scan(toks.slice(i));
  return { tables: [...tables], ctes: [...ctes] };

  function scan(ts: Tok[]): void {
    for (let k = 0; k < ts.length; k++) {
      const tok = ts[k];
      if (tok.t === "p" && tok.v === "(") depth++;
      if (tok.t === "p" && tok.v === ")" && --depth < 0) fail("paréntesis sin abrir");
      if (tok.t === "p" && tok.v === ";") fail("varias sentencias");
      if (tok.t === "id" && tok.v.startsWith("@")) fail(`variable host ${tok.v}`, "La vista previa de datos de ADT no admite variables host: pon el valor como literal.");
      if (tok.t === "id" && tok.v === "UP" && ts[k + 1]?.v === "TO") fail("UP TO n ROWS", "El tope de filas lo pone max_rows; quita UP TO … ROWS.");
      if (tok.t === "id" && (tok.v === "INTO" || tok.v === "APPENDING")) fail(`${tok.v} no es parte de una consulta de lectura`);
      if (tok.t !== "id" || (tok.v !== "FROM" && tok.v !== "JOIN")) continue;
      const next = ts[k + 1];
      if (!next) fail(`nada después de ${tok.v}`);
      if (next.t === "p" && next.v === "(") {
        // subconsulta: «( SELECT …»; cualquier otra cosa entre paréntesis es una fuente dinámica
        if (ts[k + 2]?.v !== "SELECT") fail("fuente dinámica o paréntesis sin SELECT tras " + tok.v);
        continue; // el SELECT interior se recorre en este mismo bucle
      }
      if (next.t === "id" && next.v.startsWith("@")) fail(`variable host ${next.v}`, "La vista previa de datos de ADT no admite variables host: pon el valor como literal.");
      if (next.t !== "id" || NOT_A_SOURCE.has(next.v)) fail(`«${next.v}» no es una tabla tras ${tok.v}`);
      if (next.v.startsWith("+")) {
        if (!ctes.has(next.v)) fail(`CTE ${next.v} no declarado`);
        continue;
      }
      if (!/^(\/[A-Z0-9_]+\/)?[A-Z][A-Z0-9_]*$/.test(next.v)) fail(`«${next.v}» no es un nombre de tabla válido`);
      tables.add(next.v);
      // Tras la fuente solo cabe alias (AS x | x), ON, WHERE, otro JOIN, etc.
      const after = ts[k + 2];
      if (after && after.t === "id" && !KEYWORD_AFTER_SOURCE.has(after.v) && after.v !== "AS") {
        // alias sin AS: «FROM mara m» es válido en ABAP SQL ≥ 7.40; se admite si lo que sigue es un cierre o cláusula
        const after2 = ts[k + 3];
        if (after2 && after2.t === "id" && !KEYWORD_AFTER_SOURCE.has(after2.v)) fail(`sintaxis no reconocida tras ${next.v} (${after.v} ${after2.v})`);
      }
    }
    if (depth !== 0) fail("paréntesis sin cerrar");
  }
}
