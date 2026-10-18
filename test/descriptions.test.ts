import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadTools } from "../src/core/registry.js";

/**
 * Cada descripción se paga en tokens en cada conversación, y el modelo elige peor entre textos largos: tope de 60
 * palabras. Lo que no cabe va a docs/TOOLS.md, no a la descripción.
 */
describe("descripciones de tools", () => {
  it("ninguna pasa de 60 palabras ni baja de 8", async () => {
    const defs = await loadTools(join(__dirname, "..", "src", "tools"));
    const words = (s: string) => s.trim().split(/\s+/).length;
    const long = defs.filter((d) => words(d.description) > 60).map((d) => `${d.name} (${words(d.description)})`);
    const short = defs.filter((d) => words(d.description) < 8).map((d) => d.name);
    expect(long, "descripciones de más de 60 palabras").toEqual([]);
    expect(short, "descripciones demasiado cortas para elegir la tool").toEqual([]);
  });
});
