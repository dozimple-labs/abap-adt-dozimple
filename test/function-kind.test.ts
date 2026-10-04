import { describe, expect, it } from "vitest";
import { moduleKind } from "../src/tools/core/function_modules.js";

describe("function_modules · tipo del módulo", () => {
  it("un módulo de actualización se reconoce por UTASK aunque FMODE venga vacío", () => {
    expect(moduleKind("", "1")).toBe("update (V1)");
    expect(moduleKind("", "3")).toBe("update (V2)");
    expect(moduleKind("R", "1")).toBe("RFC, update (V1)");
  });
  it("sin UTASK manda FMODE, como antes", () => {
    expect(moduleKind("", "")).toBe("normal");
    expect(moduleKind("R", undefined)).toBe("RFC");
    expect(moduleKind("K", " ")).toBe("update (V1)");
  });
});
