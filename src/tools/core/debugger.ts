import { z } from "zod";
import { isDebuggee, isDebugListenerError, type DebugStackInfo } from "abap-adt-api";
import { stateOf } from "../../core/confirm.js";
import { dataClassOf } from "../../core/datapolicy.js";
import { assertDebugAllowed, breakpointsOf, closeSession, forgetBreakpoints, getSession, IDE_ID, openSession, presentVariable, rememberBreakpoint, terminalId, type ShownVariable } from "../../core/debugsession.js";
import { normalizeError, ToolError } from "../../core/errors.js";
import { resolveObject, sourceUrl, TYPE_HELP } from "../../core/objects.js";
import { tsv } from "../../core/output.js";
import { defineTool, type ToolContext } from "../../core/tool.js";

/**
 * Depurador de solo lectura: puntos de parada externos (solo sistemas de prueba, con confirmación), escucha y
 * adhesión al propio usuario, pila, variables y pasos. Nunca cambia el valor de una variable ni el flujo salvo
 * los pasos que pide la persona. Todo es `exec`: solo sistemas DEV y con rastro en el registro de auditoría.
 */
const BP = z.object({ object_name: z.string().min(1), object_type: z.string().optional().describe(TYPE_HELP), line: z.number().int().min(1) });

function renderStack(st: DebugStackInfo, max = 15): string {
  const rows = st.stack.slice(0, max).map((f, i) => [i === (st.debugCursorStackIndex ?? 0) ? "▶" : "", f.stackPosition, f.programName, String(f.includeName ?? ""), f.line, `${f.eventType} ${f.eventName ?? ""}`.trim(), f.systemProgram ? "sistema" : ""]);
  return tsv(["", "#", "programa", "include", "línea", "evento", ""], rows) + (st.stack.length > max ? `\n[… ${st.stack.length - max} marcos más]` : "");
}

function renderVars(vars: ShownVariable[]): string {
  if (!vars.length) return "Sin variables en este ámbito.";
  const masked = vars.filter((v) => v.masked).length;
  return tsv(["variable", "tipo", "valor"], vars.map((v) => [v.name, v.type, v.value])) + (masked ? `\n(${masked} variables personales enmascaradas por la clase de datos del sistema.)` : "");
}

async function snapshot(ctx: ToolContext, maxVars: number): Promise<{ text: string; vars: ShownVariable[] }> {
  const s = getSession(ctx.system.id);
  if (!s?.attached) throw new ToolError("INPUT", `No hay sesión de depuración adherida en ${ctx.system.id}: usa debug_listen primero.`);
  const st = await s.client.debuggerStackTrace(false);
  const kids = await s.client.debuggerChildVariables();
  // Las entradas «{DATAAGING_…}» son internas del kernel, no variables del programa.
  const ids = kids.variables.map((v) => v.ID).filter((id) => !id.startsWith("{")).slice(0, maxVars);
  const values = ids.length ? await s.client.debuggerVariables(ids) : [];
  const vars = values.map((v) => presentVariable(ctx.system, v));
  return { text: `Pila (${st.stack.length} marcos):\n${renderStack(st)}\n\nVariables (${vars.length}${kids.variables.length > vars.length ? ` de ${kids.variables.length}` : ""}):\n${renderVars(vars)}`, vars };
}

const debugBreakpoints = defineTool({
  name: "debug_breakpoints",
  title: "Puntos de parada externos (depurador)",
  description:
    "Pone o quita puntos de parada externos para el usuario de la conexión (objeto y línea), como los de Eclipse. " +
    "Solo en sistemas de desarrollo con datos de prueba y con confirmación. Después, debug_listen espera a que el " +
    "programa pase por ahí. clear quita los puestos desde este servidor.",
  access: "exec",
  confirm: true,
  confirmWhat: "puntos de parada en el sistema",
  input: {
    action: z.enum(["set", "clear"]).default("set"),
    breakpoints: z.array(BP).max(20).default([]),
  },
  async preview({ action, breakpoints }, ctx) {
    assertDebugAllowed(ctx.system);
    if (dataClassOf(ctx.system) !== "test") throw new ToolError("POLICY", `${ctx.system.id} no tiene datos de prueba (dataClass test): los puntos de parada solo se ponen ahí.`);
    if (action === "set" && !breakpoints.length) throw new ToolError("INPUT", "Indica al menos un punto de parada (objeto y línea).");
    const c = await ctx.sap.adt();
    const lines: string[] = [];
    for (const b of breakpoints) {
      const obj = await resolveObject(c, b.object_name, b.object_type);
      lines.push(`  ${obj.name} (${obj.type}) línea ${b.line}`);
    }
    const text = action === "set"
      ? `Puntos de parada externos para ${ctx.system.user} en ${ctx.system.id} (terminal de este servidor):\n${lines.join("\n")}\nSaltarán cuando ese usuario ejecute el código (diálogo, RFC, job); el programa quedará parado hasta que debug_listen se adhiera o SAP lo libere.`
      : `Quitar los ${breakpointsOf(ctx.system.id).length} puntos de parada puestos desde este servidor en ${ctx.system.id}: ${breakpointsOf(ctx.system.id).map((b) => `${b.object} línea ${b.line}`).join(", ") || "ninguno recordado"}.`;
    return { text, state: stateOf(text) };
  },
  async run({ action, breakpoints }, ctx) {
    assertDebugAllowed(ctx.system);
    const c = await ctx.sap.adt();
    const user = ctx.system.user.toUpperCase();
    if (action === "clear") {
      // Se quitan por la conexión de lectura: no hace falta sesión de depuración, y sobreviven a su cierre.
      let n = 0;
      for (const b of breakpointsOf(ctx.system.id)) {
        try {
          await c.debuggerDeleteBreakpoints({ id: b.id, clientId: IDE_ID, uri: { uri: b.uri, range: { start: { line: b.line, column: 0 }, end: { line: b.line, column: 0 } } }, kind: "line", type: "", name: b.object, nonAbapFlavour: "" } as never, "user", terminalId(), IDE_ID, user);
          n++;
        } catch (e) {
          return { text: `Quitados ${n}; falló ${b.object} línea ${b.line}: ${normalizeError(e).message}`, isError: true };
        }
      }
      forgetBreakpoints(ctx.system.id);
      return `Quitados ${n} puntos de parada en ${ctx.system.id}.`;
    }
    const s = await openSession(ctx.sap, ctx.system);
    const uris: Array<{ uri: string; line: number; object: string }> = [];
    for (const b of breakpoints) {
      const obj = await resolveObject(c, b.object_name, b.object_type);
      uris.push({ uri: await sourceUrl(c, obj), line: b.line, object: obj.name });
    }
    const res = await s.client.debuggerSetBreakpoints("user", s.terminalId, IDE_ID, IDE_ID, uris.map((u) => `${u.uri}#start=${u.line}`), s.user, "external");
    const out: string[] = [];
    let i = 0;
    for (const r of res) {
      const u = uris[i++];
      if (r && "errorMessage" in r) out.push(`✗ ${u?.object ?? "?"} línea ${u?.line ?? "?"}: ${r.errorMessage}`);
      else if (r && "id" in r) {
        if (u) rememberBreakpoint(ctx.system.id, { id: r.id, uri: u.uri, line: u.line, object: u.object });
        out.push(`✓ ${u?.object ?? r.id} línea ${u?.line ?? "?"} (id ${r.id})`);
      }
    }
    const ok = out.filter((l) => l.startsWith("✓")).length;
    return { text: `${ok} de ${uris.length} puntos de parada puestos en ${ctx.system.id} para ${s.user}:\n${out.join("\n")}\n\nAhora debug_listen espera a que el programa pase por ellos.`, isError: ok === 0 };
  },
});

const debugListen = defineTool({
  name: "debug_listen",
  title: "Esperar y adherirse al depurador",
  timeoutMs: 150_000,
  description:
    "Escucha hasta timeout_s a que un programa del usuario de la conexión pare en un punto de parada externo, se " +
    "adhiere y devuelve la pila y las variables del marco actual. Solo lectura: no cambia valores. En sistemas con " +
    "datos enmascarados, las variables personales salen ocultas; con datos productivos no funciona.",
  access: "exec",
  confirm: false,
  input: {
    timeout_s: z.number().int().min(5).max(120).default(60),
    max_variables: z.number().int().min(1).max(200).default(50),
  },
  async run({ timeout_s, max_variables }, ctx) {
    const s = await openSession(ctx.sap, ctx.system);
    if (s.attached) return `Ya hay una sesión adherida en ${ctx.system.id}: usa debug_variables, debug_step o debug_stop.`;
    const conflict = await s.client.debuggerListeners("user", s.terminalId, IDE_ID, s.user, true);
    if (conflict && isDebugListenerError(conflict)) {
      throw new ToolError("SAP", `Otro depurador ya escucha a ${s.user} en ${ctx.system.id}: ${conflict.localizedMessage?.text ?? conflict.message?.text ?? conflict.conflictText}.`, "Cierra el depurador de Eclipse o ADT de esa persona, o espera a que termine.");
    }
    ctx.progress?.(`Escuchando a ${s.user} en ${ctx.system.id} hasta ${timeout_s} s…`);
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), timeout_s * 1000)));
    const poll = s.client.debuggerListen("user", s.terminalId, IDE_ID, s.user, true, true);
    poll.catch(() => undefined); // si se abandona por tiempo, su rechazo posterior no debe quedar sin manejar
    const hit = await Promise.race([poll, limit]);
    clearTimeout(timer);
    if (hit === "timeout") {
      // La sesión stateful sigue ocupada con la escucha: el listener se retira por la conexión de lectura y la
      // sesión se cierra sin esperar a que SAP responda (verificado en vivo).
      const done = await closeSession(ctx.system.id, "detachDebugger", await ctx.sap.adt());
      return `Pasaron ${timeout_s} s sin que ningún programa de ${s.user} parase en un punto de parada en ${ctx.system.id} (${done.join("; ")}). Comprueba con debug_breakpoints que están puestos y vuelve a escuchar.`;
    }
    if (!hit) return `SAP cerró la escucha sin un programa parado (${timeout_s} s). Vuelve a intentarlo.`;
    if (isDebugListenerError(hit)) throw new ToolError("SAP", `La escucha terminó con error: ${hit.localizedMessage?.text ?? hit.message?.text}`);
    if (!isDebuggee(hit)) throw new ToolError("INTERNAL", "Respuesta de escucha no reconocida.");
    if (hit.IS_ATTACH_IMPOSSIBLE) return { text: `Un programa de ${hit.DEBUGGEE_USER} paró en ${hit.PRG_CURR} (${hit.INCL_CURR} línea ${hit.LINE_CURR}) pero no es posible adherirse (${hit.IS_SAME_SERVER ? "" : "otro servidor de aplicación, "}${hit.DBGEE_KIND}).`, isError: true };
    await s.client.debuggerAttach("user", hit.DEBUGGEE_ID, s.user, false);
    s.debuggeeId = hit.DEBUGGEE_ID;
    s.attached = true;
    const snap = await snapshot(ctx, max_variables);
    return `Adherido a ${hit.PRG_CURR} (${hit.INCL_CURR} línea ${hit.LINE_CURR}) de ${hit.DEBUGGEE_USER} en ${ctx.system.id}, tipo ${hit.DBGEE_KIND}.\n\n${snap.text}\n\nSiguiente: debug_step (into, over, return, continue) o debug_variables; debug_stop para soltar el programa.`;
  },
});

const debugVariables = defineTool({
  name: "debug_variables",
  title: "Variables del depurador",
  description:
    "Con una sesión adherida: valores de variables por nombre (p. ej. LV_X, LS_HEAD-KUNNR) o los hijos de una " +
    "estructura o tabla por su id, y la pila si se pide. Solo lectura; variables personales enmascaradas según el " +
    "sistema.",
  access: "exec",
  confirm: false,
  input: {
    names: z.array(z.string().min(1)).max(50).optional().describe("Nombres o ids de variables a leer"),
    children_of: z.string().optional().describe("Id de una estructura, tabla u objeto para listar sus componentes"),
    stack: z.boolean().default(false),
    max_variables: z.number().int().min(1).max(200).default(50),
  },
  async run({ names, children_of, stack, max_variables }, ctx) {
    const s = getSession(ctx.system.id);
    if (!s?.attached) throw new ToolError("INPUT", `No hay sesión de depuración adherida en ${ctx.system.id}: usa debug_listen primero.`);
    const out: string[] = [];
    if (names?.length) {
      const vals = await s.client.debuggerVariables(names);
      out.push(renderVars(vals.map((v) => presentVariable(ctx.system, v))));
    }
    if (children_of) {
      const kids = await s.client.debuggerChildVariables([children_of]);
      const ids = kids.variables.map((v) => v.ID).slice(0, max_variables);
      const vals = ids.length ? await s.client.debuggerVariables(ids) : [];
      out.push(`Componentes de ${children_of} (${vals.length}${kids.variables.length > vals.length ? ` de ${kids.variables.length}` : ""}):\n${renderVars(vals.map((v) => presentVariable(ctx.system, v)))}`);
    }
    if (stack || (!names?.length && !children_of)) out.push((await snapshot(ctx, max_variables)).text);
    return out.join("\n\n");
  },
});

const debugStep = defineTool({
  name: "debug_step",
  title: "Paso del depurador",
  description:
    "Con una sesión adherida: into, over, return o continue (hasta el siguiente punto de parada o el final). Devuelve " +
    "la pila y las variables tras el paso. Si el programa termina, la sesión se cierra y lo dice.",
  access: "exec",
  confirm: false,
  timeoutMs: 150_000,
  input: {
    step: z.enum(["into", "over", "return", "continue"]),
    max_variables: z.number().int().min(1).max(200).default(50),
  },
  async run({ step, max_variables }, ctx) {
    const s = getSession(ctx.system.id);
    if (!s?.attached) throw new ToolError("INPUT", `No hay sesión de depuración adherida en ${ctx.system.id}: usa debug_listen primero.`);
    const kind = { into: "stepInto", over: "stepOver", return: "stepReturn", continue: "stepContinue" }[step] as "stepInto" | "stepOver" | "stepReturn" | "stepContinue";
    let r;
    try {
      r = await s.client.debuggerStep(kind);
    } catch (e) {
      const te = normalizeError(e);
      // Tras continue, si el programa acabó SAP responde que ya no hay debuggee: la sesión se cierra.
      s.attached = false;
      await closeSession(ctx.system.id, "detachDebugger", await ctx.sap.adt());
      return `El programa terminó o SAP soltó la sesión tras «${step}» (${te.message}). Sesión cerrada en ${ctx.system.id}.`;
    }
    if (r.isDebuggeeChanged || !r.isSteppingPossible && r.isTerminationPossible === false) {
      s.attached = false;
      await closeSession(ctx.system.id, "detachDebugger", await ctx.sap.adt());
      return `Tras «${step}» el programa terminó: sesión cerrada en ${ctx.system.id}.`;
    }
    const snap = await snapshot(ctx, max_variables);
    const reached = r.reachedBreakpoints?.length ? `Punto de parada alcanzado: ${r.reachedBreakpoints.map((b) => b.id).join(", ")}.\n\n` : "";
    return `${reached}${snap.text}`;
  },
});

const debugStop = defineTool({
  name: "debug_stop",
  title: "Cerrar la sesión de depuración",
  description: "Suelta el programa depurado (continúa) o lo termina, retira la escucha y cierra la sesión del depurador en el sistema.",
  access: "exec",
  confirm: false,
  input: { terminate: z.boolean().default(false).describe("true: termina el programa depurado en vez de dejarlo seguir") },
  async run({ terminate }, ctx) {
    const done = await closeSession(ctx.system.id, terminate ? "terminateDebuggee" : "detachDebugger", await ctx.sap.adt());
    return done.length ? `Sesión de depuración cerrada en ${ctx.system.id}: ${done.join("; ")}.` : `No había sesión de depuración en ${ctx.system.id}.`;
  },
});

export default [debugBreakpoints, debugListen, debugVariables, debugStep, debugStop];
