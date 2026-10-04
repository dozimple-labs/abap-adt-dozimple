import { describe, expect, it } from "vitest";
import { stateOf } from "../src/core/confirm.js";
import type { ToolDef } from "../src/core/tool.js";
import editSource, { applySourceEdits } from "../src/tools/core/edit_source.js";

const SRC = "REPORT zdemo.\nDATA lv_a TYPE i.\nlv_a = 1.\nWRITE lv_a.\nlv_a = 1.\n";
const ed = (old_text: string, new_text: string, replace_all = false) => ({ old_text, new_text, replace_all });

describe("edit_source · sustituciones", () => {
  it("sustituye un fragmento único y deja el resto intacto", () => {
    expect(applySourceEdits(SRC, [ed("WRITE lv_a.", "WRITE: / lv_a.")])).toBe(SRC.replace("WRITE lv_a.", "WRITE: / lv_a."));
  });

  it("varias apariciones: error salvo replace_all", () => {
    expect(() => applySourceEdits(SRC, [ed("lv_a = 1.", "lv_a = 2.")])).toThrow(/aparece 2 veces/);
    expect(applySourceEdits(SRC, [ed("lv_a = 1.", "lv_a = 2.", true)])).not.toMatch(/lv_a = 1\./);
  });

  it("si no aparece, lo dice; y distingue el caso de mayúsculas distintas", () => {
    expect(() => applySourceEdits(SRC, [ed("WRITE lv_b.", "x")])).toThrow(/no aparece en la fuente/);
    try {
      applySourceEdits(SRC, [ed("write LV_A.", "x")]);
      throw new Error("debía fallar");
    } catch (e: any) {
      expect(e.hint).toMatch(/otras mayúsculas/);
    }
  });

  it("las ediciones se aplican en orden, cada una sobre el resultado de la anterior", () => {
    expect(applySourceEdits(SRC, [ed("WRITE lv_a.", "WRITE lv_b."), ed("WRITE lv_b.", "WRITE lv_c.")])).toMatch(/WRITE lv_c\./);
  });

  it("new_text vacío borra, y «$&» en new_text es texto literal", () => {
    expect(applySourceEdits(SRC, [ed("WRITE lv_a.\n", "")])).not.toMatch(/WRITE/);
    expect(applySourceEdits(SRC, [ed("WRITE lv_a.", "WRITE '$&'.")])).toMatch(/WRITE '\$&'\./);
  });

  it("conserva los finales de línea de SAP aunque el fragmento llegue con otros", () => {
    const crlf = SRC.replace(/\n/g, "\r\n");
    expect(applySourceEdits(crlf, [ed("DATA lv_a TYPE i.\nlv_a = 1.", "DATA lv_a TYPE i VALUE 1.")])).toBe(
      "REPORT zdemo.\r\nDATA lv_a TYPE i VALUE 1.\r\nWRITE lv_a.\r\nlv_a = 1.\r\n",
    );
  });

  it("old_text igual a new_text es un error, no un guardado sin cambios", () => {
    expect(() => applySourceEdits(SRC, [ed("WRITE lv_a.", "WRITE lv_a.")])).toThrow(/son iguales/);
  });
});

describe("edit_source · mismo camino que write_source", () => {
  function setup(sapSource = SRC) {
    const written: string[] = [];
    const s = {
      lock: async () => ({ LOCK_HANDLE: "H", CORRNR: "", CORRUSER: "", IS_LOCAL: "X" }),
      getObjectSource: async () => sapSource,
      setObjectSource: async (_u: string, src: string) => void written.push(src),
      unLock: async () => undefined,
    };
    const c = {
      searchObject: async () => [{ "adtcore:name": "ZDEMO", "adtcore:type": "PROG/P", "adtcore:uri": "/sap/bc/adt/programs/programs/zdemo", "adtcore:packageName": "$TMP" }],
      objectStructure: async () => { throw new Error("sin estructura"); },
      getObjectSource: async () => sapSource,
      syntaxCheck: async () => [],
    };
    const ctx = (confirmedState?: string) => ({ sap: { adt: async () => c, stateful: async (fn: any) => fn(s), query: async () => ({ values: [] }) }, system: { id: "DEV", user: "DEV_ME" }, confirmedState }) as any;
    return { written, ctx };
  }
  const def = editSource as ToolDef<any>;
  const args = { object_name: "ZDEMO", object_type: "PROG", include: "main", edits: [ed("WRITE lv_a.", "WRITE: / lv_a.")], activate: false };

  it("la vista previa muestra el diff de la fuente resultante y devuelve la huella de la guardada", async () => {
    const { ctx } = setup();
    const p: any = await def.preview!(args, ctx());
    expect(p.text).toMatch(/Cambio: \+1 −1 en 1 bloques/);
    expect(p.text).toMatch(/-WRITE lv_a\.\n\+WRITE: \/ lv_a\./);
    expect(p.state).toBe(stateOf(SRC));
  });

  it("guarda la fuente completa con la sustitución aplicada", async () => {
    const { written, ctx } = setup();
    const r: any = await def.run(args, ctx(stateOf(SRC)));
    expect(written).toEqual([SRC.replace("WRITE lv_a.", "WRITE: / lv_a.")]);
    expect(typeof r === "string" ? r : r.text).toMatch(/ZDEMO guardado/);
  });

  it("no escribe si la fuente ya no es la de la vista previa", async () => {
    const { written, ctx } = setup();
    const r: any = await def.run(args, ctx(stateOf("REPORT zdemo.\n* versión anterior\nWRITE lv_a.\n")));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/cambió en SAP después de la vista previa/);
    expect(written).toEqual([]);
  });
});
