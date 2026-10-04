import { describe, expect, it } from "vitest";
import { previewBody } from "../src/core/changepackage.js";
import type { ToolDef } from "../src/core/tool.js";
import changePackage from "../src/tools/core/change_package.js";

const def = changePackage as ToolDef<any>;
const URI = "/sap/bc/adt/programs/programs/zdemo_rep";

function setup(o: { type?: string; devclass?: string; korrflag?: string; sapTransport?: string; after?: string; previewFails?: boolean } = {}) {
  const posts: Array<{ step: string; body: string }> = [];
  let moved = false;
  const c = {
    searchObject: async () => [{ "adtcore:name": "ZDEMO_REP", "adtcore:type": o.type ?? "PROG/P", "adtcore:uri": URI, "adtcore:packageName": o.devclass ?? "$TMP" }],
    httpClient: {
      request: async (_url: string, opt: any) => {
        posts.push({ step: opt.qs.step, body: opt.body });
        if (opt.qs.step === "preview") {
          if (o.previewFails) throw new Error("Object is locked");
          return { status: 200, body: `<generic:genericRefactoring><generic:transport>${o.sapTransport ?? "DEVK900123"}</generic:transport></generic:genericRefactoring>` };
        }
        moved = true;
        return { status: 200, statusText: "OK", body: "" };
      },
    },
  };
  const sap = {
    adt: async () => c,
    query: async (sql: string) => {
      if (/FROM tadir/.test(sql)) return { values: [{ DEVCLASS: moved ? (o.after ?? "ZDEMO_PKG") : (o.devclass ?? "$TMP"), SRCSYSTEM: "DEV" }] };
      if (/FROM tdevc/.test(sql)) return { values: /ZNOPE/.test(sql) ? [] : [{ DEVCLASS: "ZDEMO_PKG", KORRFLAG: o.korrflag ?? "X" }] };
      return { values: [] }; // E070/E07T: la orden no existe en el doble → transportWarnings lo avisa
    },
  };
  const ctx = (confirmedState?: string) => ({ sap, system: { id: "DEV", user: "DEV_ME" }, confirmedState }) as any;
  return { posts, ctx };
}
const args = { object_name: "ZDEMO_REP", object_type: "PROG", package: "zdemo_pkg", transport: "DEVK900123" };

describe("change_package", () => {
  it("la vista previa pide a SAP su validación y no ejecuta nada", async () => {
    const { posts, ctx } = setup();
    const p: any = await def.preview!(args, ctx());
    expect(p.text).toMatch(/ZDEMO_REP \(PROG\/P\): paquete \$TMP → ZDEMO_PKG/);
    expect(p.text).toMatch(/pasa a ser transportable/);
    expect(p.text).toMatch(/SAP valida el cambio de paquete: correcto/);
    expect(posts.map((x) => x.step)).toEqual(["preview"]);
  });

  it("ejecuta con lo que devolvió la vista previa de SAP y comprueba el paquete que quedó", async () => {
    const { posts, ctx } = setup();
    const p: any = await def.preview!(args, ctx());
    const r: any = await def.run(args, ctx(p.state));
    expect(posts.map((x) => x.step)).toEqual(["preview", "preview", "execute"]);
    expect(posts[2].body).toMatch(/^<generic:genericRefactoring>/);
    expect(r).toMatch(/está ahora en el paquete ZDEMO_PKG, registrado en la orden DEVK900123/);
  });

  it("paquete transportable sin orden, paquete inexistente o el mismo paquete: no se intenta", async () => {
    await expect(def.preview!({ ...args, transport: undefined }, setup().ctx())).rejects.toThrow(/es transportable: indica transport/);
    await expect(def.preview!({ ...args, package: "ZNOPE" }, setup().ctx())).rejects.toThrow(/no existe en este sistema/);
    await expect(def.preview!(args, setup({ devclass: "ZDEMO_PKG" }).ctx())).rejects.toThrow(/ya está en el paquete/);
  });

  it("un módulo de función o un include no tienen paquete propio", async () => {
    await expect(def.preview!(args, setup({ type: "PROG/I" }).ctx())).rejects.toThrow(/no tiene paquete propio/);
  });

  it("si SAP lo registraría en otra orden, avisa en la vista previa y no ejecuta", async () => {
    const { posts, ctx } = setup({ sapTransport: "DEVK900999" });
    const p: any = await def.preview!(args, ctx());
    expect(p.text).toMatch(/SAP propone registrar el cambio en DEVK900999, no en DEVK900123/);
    const r: any = await def.run(args, ctx(p.state));
    expect(r.isError).toBe(true);
    expect(posts.some((x) => x.step === "execute")).toBe(false);
  });

  it("si el objeto cambió de paquete desde la vista previa, no ejecuta", async () => {
    const p: any = await def.preview!(args, setup().ctx());
    const other = setup({ devclass: "ZOTRO" });
    const r: any = await def.run(args, other.ctx(p.state));
    expect(r.text).toMatch(/ya no está en el paquete que se mostró/);
    expect(other.posts).toEqual([]);
  });

  it("si SAP responde sin error pero el paquete no cambió, es un error", async () => {
    const { ctx } = setup({ after: "$TMP" });
    const r: any = await def.run(args, ctx());
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/sigue en el paquete \$TMP/);
  });

  it("SAP rechaza en la vista previa: se cuenta, no se da token", async () => {
    await expect(def.preview!(args, setup({ previewFails: true }).ctx())).rejects.toThrow(/SAP rechaza el cambio de paquete de ZDEMO_REP/);
  });

  it("los nombres van escapados en el XML", () => {
    const x = previewBody({ name: "A&B", type: "PROG/P", uri: "/x?a=1&b=2", oldPackage: "$TMP", newPackage: "Z<P>", transport: "" });
    expect(x).toMatch(/adtcore:name="A&amp;B"/);
    expect(x).toMatch(/Z&lt;P&gt;/);
    expect(x).not.toMatch(/a=1&b=2/);
  });
});
