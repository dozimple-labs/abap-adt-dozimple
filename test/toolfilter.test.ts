import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "../src/core/config.js";
import { isVisible, loadTools } from "../src/core/registry.js";
import type { ToolDef } from "../src/core/tool.js";
import { filterWarnings, resolveToolFilter, toolAllowed } from "../src/core/toolfilter.js";

let defs: ToolDef<any>[];
beforeAll(async () => {
  defs = await loadTools(join(__dirname, "..", "src", "tools"));
});
const byName = (n: string) => defs.find((d) => d.name === n)!;
const base = { url: "https://sap.example:44300", client: "100", user: "U" };
const cfg = (tools: Record<string, unknown>) => parseConfig({ systems: [{ ...base, id: "DEV", role: "DEV", allowWrite: true, modules: ["dz-transport-risk"] }], tools });

describe("exposición selectiva de tools", () => {
  it("only por nombre, por grupo del catálogo y por tipo de acceso", () => {
    const f = resolveToolFilter(cfg({ only: ["get_source", "exploracion", "write"] }), {});
    expect(toolAllowed(byName("get_source"), f)).toBe(true);
    expect(toolAllowed(byName("where_used"), f)).toBe(true); // grupo exploracion
    expect(toolAllowed(byName("write_source"), f)).toBe(true); // acceso write
    expect(toolAllowed(byName("sql_query"), f)).toBe(false);
    expect(toolAllowed(byName("sap_systems"), f)).toBe(true); // siempre
  });

  it("except quita, y only + ABAP_DZ_TOOLS se cruzan (el entorno nunca amplía)", () => {
    const e = resolveToolFilter(cfg({ except: ["write", "exec"] }), {});
    expect(toolAllowed(byName("write_source"), e)).toBe(false);
    expect(toolAllowed(byName("run_unit_tests"), e)).toBe(false);
    expect(toolAllowed(byName("get_source"), e)).toBe(true);
    const both = resolveToolFilter(cfg({ only: ["read"] }), { ABAP_DZ_TOOLS: "get_source, write_source" });
    expect(toolAllowed(byName("get_source"), both)).toBe(true);
    expect(toolAllowed(byName("write_source"), both)).toBe(false); // el entorno lo pide, la configuración no lo permite
    expect(toolAllowed(byName("sql_query"), both)).toBe(false); // la configuración lo permite, el entorno no lo pide
  });

  it("sin filtro todo sigue visible, y una errata se avisa en vez de esconder tools en silencio", () => {
    const none = resolveToolFilter(cfg({}), {});
    expect(defs.every((d) => toolAllowed(d, none))).toBe(true);
    expect(filterWarnings(none, defs)).toEqual([]);
    const typo = resolveToolFilter(cfg({ only: ["get_sorce", "read"] }), {});
    const w = filterWarnings(typo, defs);
    expect(w[0]).toMatch(/get_sorce no corresponde/);
    expect(w[1]).toMatch(/se publican \d+ de \d+ tools/);
  });

  it("isVisible respeta el filtro además de módulos y escritura", () => {
    const c = cfg({ only: ["exploracion"] });
    expect(isVisible(byName("get_source"), c)).toBe(true);
    expect(isVisible(byName("analyze_transport_risk"), c)).toBe(false);
    expect(isVisible(byName("sap_systems"), c)).toBe(true);
  });
});
