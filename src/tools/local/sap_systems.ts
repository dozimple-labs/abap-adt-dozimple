import { z } from "zod";
import { canWrite } from "../../core/config.js";
import { dataClassOf, rowCap } from "../../core/datapolicy.js";
import { normalizeError } from "../../core/errors.js";
import { inProfile, resolveProfile } from "../../core/profiles.js";
import { eligibleSystems, isVisible } from "../../core/registry.js";
import { defineTool } from "../../core/tool.js";

export default defineTool({
  name: "sap_systems",
  title: "Sistemas SAP y tools disponibles",
  description:
    "Lista los sistemas configurados (rol, escritura, módulos). Con check=true se conecta a cada uno: dice si responde, " +
    "su release y qué tools funcionan ahí según los endpoints ADT que publica. Úsala al empezar o si algo falla por conexión.",
  access: "local",
  input: {
    check: z.boolean().default(false),
    only: z.string().optional().describe("Comprobar solo este sistema"),
    refresh_discovery: z.boolean().default(false).describe("Releer el discovery ADT en vez de usar la caché (7 días)"),
  },
  async run({ check, only, refresh_discovery }, { config, pool, tools }) {
    const out: string[] = [];
    const profile = resolveProfile(config);
    const visible = tools.filter((t) => isVisible(t, config));
    const loaded = visible.filter((t) => inProfile(t, profile)).length;
    out.push(`Perfil de tools: ${profile} · ${profile === "core" ? `${Math.min(loaded + 1, visible.length + 1)} cargadas de ${visible.length + 1}; el resto con load_tools(groups)` : `${visible.length} publicadas`}`);
    const systems = config.systems.filter((s) => !only || s.id.toUpperCase() === only.toUpperCase());
    for (const s of systems) {
      const flags = [
        s.role,
        canWrite(s) ? "escritura" : "solo lectura",
        `datos ${dataClassOf(s)} (tope ${rowCap(s)} filas${dataClassOf(s) === "test" ? "" : ", columnas personales enmascaradas"})`,
        ...(s.modules.length ? [`módulos: ${s.modules.join(", ")}`] : []),
        ...(s.allowSelfSigned && !s.caFile ? ["⚠ TLS SIN VERIFICAR (configura caFile)"] : []),
      ];
      out.push(`${s.id}${config.defaultSystem?.toUpperCase() === s.id.toUpperCase() ? " (por defecto)" : ""} — ${s.description ?? s.url} · mandante ${s.client} · ${flags.join(" · ")}`);
      if (!check) continue;
      const sap = pool.get(s);
      if (sap.circuitOpenFor()) {
        out.push("  circuito abierto por fallos de red seguidos: se cierra y se reintenta ahora");
        sap.resetCircuit();
      }
      try {
        const caps = await sap.capabilities(refresh_discovery);
        const rel = await sap.release();
        out.push(`  conectado · SAP_BASIS ${rel ?? "?"} · ${caps.known ? `${caps.collections.length} colecciones ADT` : "discovery no disponible"}`);
        const ok: string[] = [];
        const no: string[] = [];
        for (const t of tools) {
          if (t.access === "local" || !isVisible(t, config)) continue;
          if (!eligibleSystems(t, config).some((e) => e.id === s.id)) continue;
          const miss = (t.requires?.adt ?? []).filter(
            (r) => caps.known && !caps.collections.some((h) => h === r || h.startsWith(r + "/")),
          );
          (miss.length ? no : ok).push(miss.length ? `${t.name} (falta ${miss.join(", ")})` : t.name);
        }
        out.push(`  tools: ${ok.join(", ")}`);
        if (no.length) out.push(`  sin confirmar por el discovery (se intentan igual; un 404 lo confirmaría): ${no.join("; ")}`);
      } catch (e) {
        const te = normalizeError(e, s.id);
        out.push(`  ${te.kind}: ${te.message}${te.hint ? " " + te.hint : ""}`);
      }
    }
    for (const [name, sc] of Object.entries(config.sidecars)) {
      const own = tools.filter((t) => t.requires?.sidecar === name && isVisible(t, config)).map((t) => t.name);
      out.push(
        `\nComponente «${name}» (proceso aislado: ${sc.command})` +
          ` · búsqueda online ${sc.allowOnline ? "HABILITADA (con filtro de datos de cliente)" : "deshabilitada"}` +
          `\n  tools: ${own.join(", ")}`,
      );
    }
    return out.join("\n");
  },
});
