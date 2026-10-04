import { describe, expect, it } from "vitest";
import { buildEdmx, edmType, propertyName, type DdicField } from "../src/core/edmx.js";
import type { ToolDef } from "../src/core/tool.js";
import odataModel from "../src/tools/core/odata_model.js";

const f = (name: string, datatype: string, length = 0, key = false, decimals = 0, label?: string): DdicField => ({ name, datatype, length, key, decimals, label });
const HEAD = [f("MANDT", "CLNT", 3, true), f("VBELN", "CHAR", 10, true, 0, "Pedido"), f("ERDAT", "DATS", 8), f("NETWR", "CURR", 15, false, 2), f("WAERK", "CUKY", 5)];
const ITEM = [f("MANDT", "CLNT", 3, true), f("VBELN", "CHAR", 10, true), f("POSNR", "NUMC", 6, true), f("MENGE", "QUAN", 13, false, 3), f("GUID", "RAW", 16), f("XTRA", "PREC", 2)];

describe("modelo OData desde el diccionario", () => {
  it("nombres de propiedad y tipos EDM", () => {
    expect(propertyName("ERDAT_DOC")).toBe("ErdatDoc");
    expect(propertyName("/ABC/FIELD_X")).toBe("FieldX");
    expect(edmType(f("A", "DATS", 8))).toMatch(/Edm\.DateTime.*display-format="Date"/);
    expect(edmType(f("A", "CURR", 15, false, 2))).toBe(`Type="Edm.Decimal" Precision="15" Scale="2"`);
    expect(edmType(f("A", "RAW", 16))).toBe(`Type="Edm.Guid"`);
    expect(edmType(f("A", "RAW", 4))).toBe(`Type="Edm.Binary" MaxLength="4"`);
    expect(edmType(f("A", "PREC", 2))).toBeUndefined();
  });

  it("entidades con clave sin mandante, etiquetas, asociación y navegación", () => {
    const { xml, skipped } = buildEdmx(
      "ZDEMO_SRV",
      [{ name: "Order", source: "ZDEMO_HEAD", fields: HEAD }, { name: "Item", set: "Items", source: "ZDEMO_ITEM", fields: ITEM }],
      [{ name: "OrderToItems", from: "Order", to: "Item", multiplicity: "*", on: [["VBELN", "VBELN"]] }],
    );
    expect(xml).not.toMatch(/Mandt/);
    expect(xml).toMatch(/<EntityType Name="Order"[^>]*>\n\s+<Key>\n\s+<PropertyRef Name="Vbeln"\/>\n\s+<\/Key>/);
    expect(xml).toMatch(/<Property Name="Vbeln" Type="Edm.String" MaxLength="10" Nullable="false" sap:label="Pedido"\/>/);
    expect(xml).toMatch(/<NavigationProperty Name="ToItem" Relationship="ZDEMO_SRV.OrderToItems"/);
    expect(xml).toMatch(/<End Type="ZDEMO_SRV.Item" Multiplicity="\*" Role="ToRole_OrderToItems"\/>/);
    expect(xml).toMatch(/<EntitySet Name="OrderSet" EntityType="ZDEMO_SRV.Order"/);
    expect(xml).toMatch(/<EntitySet Name="Items" EntityType="ZDEMO_SRV.Item"/);
    expect(xml).toMatch(/<AssociationSet Name="OrderToItemsSet"/);
    expect(skipped).toEqual(["Item-XTRA (PREC)"]);
  });

  it("sin clave, entidad o campo desconocido en una asociación: error claro", () => {
    expect(() => buildEdmx("ZDEMO_SRV", [{ name: "Row", source: "ZES_ROW", fields: [f("A", "CHAR", 1)] }])).toThrow(/no tiene campos clave/);
    const ents = [{ name: "Order", source: "H", fields: HEAD }, { name: "Item", source: "I", fields: ITEM }];
    expect(() => buildEdmx("ZDEMO_SRV", ents, [{ name: "X", from: "Order", to: "Nope", multiplicity: "*", on: [["VBELN", "VBELN"]] }])).toThrow(/Nope no es una entidad/);
    expect(() => buildEdmx("ZDEMO_SRV", ents, [{ name: "X", from: "Order", to: "Item", multiplicity: "*", on: [["VBELN", "NOPE"]] }])).toThrow(/Item-NOPE no es un campo/);
  });

  it("las etiquetas van escapadas", () => {
    const { xml } = buildEdmx("ZDEMO_SRV", [{ name: "Row", source: "X", fields: [f("A", "CHAR", 1, true, 0, `Alta & "baja" <x>`)] }]);
    expect(xml).toMatch(/sap:label="Alta &amp; &quot;baja&quot; &lt;x&gt;"/);
  });
});

describe("odata_model · lectura del diccionario", () => {
  const sap = {
    query: async (sql: string) => {
      if (/FROM dd03l/.test(sql)) {
        if (/'ZNOPE'/.test(sql)) return { values: [] };
        return {
          values: [
            { FIELDNAME: ".INCLUDE", KEYFLAG: "", ROLLNAME: "", DATATYPE: "", LENG: "000000", DECIMALS: "000000" },
            { FIELDNAME: "ID", KEYFLAG: "", ROLLNAME: "ZED_ID", DATATYPE: "CHAR", LENG: "000010", DECIMALS: "000000" },
            { FIELDNAME: "TEXTO", KEYFLAG: "", ROLLNAME: "ZED_TXT", DATATYPE: "CHAR", LENG: "000040", DECIMALS: "000000" },
            { FIELDNAME: "IMPORTE", KEYFLAG: "", ROLLNAME: "ZED_IMP", DATATYPE: "DEC", LENG: "000013", DECIMALS: "000002" },
          ],
        };
      }
      return { values: [{ ROLLNAME: "ZED_ID", DDLANGUAGE: "S", SCRTEXT_M: "Identificador", DDTEXT: "x" }, { ROLLNAME: "ZED_ID", DDLANGUAGE: "E", SCRTEXT_M: "Identifier", DDTEXT: "x" }] };
    },
  };
  const ctx = { sap, system: { id: "DEV", language: "ES" } } as any;
  const run = (e: Record<string, unknown>) => (odataModel as ToolDef<any>).run({ namespace: "ZDEMO_SRV", entities: [{ name: "Row", source: "ZES_ROW", ...e }], associations: [] }, ctx) as Promise<any>;

  it("estructura con keys indicadas y subconjunto de campos; etiqueta en el idioma de la conexión", async () => {
    const r = await run({ keys: ["ID"], fields: ["IMPORTE"] });
    expect(r).toMatch(/Row ← ZES_ROW: 2 propiedades, clave ID/);
    expect(r).toMatch(/<Property Name="Id" Type="Edm.String" MaxLength="10" Nullable="false" sap:label="Identificador"\/>/);
    expect(r).toMatch(/<Property Name="Importe" Type="Edm.Decimal" Precision="13" Scale="2" Nullable="true"\/>/);
    expect(r).not.toMatch(/Texto|INCLUDE/);
  });

  it("estructura sin clave, campo inexistente u objeto que no existe", async () => {
    await expect(run({})).rejects.toThrow(/no tiene campos clave/);
    await expect(run({ keys: ["NOPE"] })).rejects.toThrow(/ZES_ROW no tiene el campo NOPE/);
    await expect(run({ source: "ZNOPE" })).rejects.toThrow(/ZNOPE no existe activa/);
  });
});
