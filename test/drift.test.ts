import { describe, expect, it } from "vitest";
import { driftVerdict, remoteName, versionDrift } from "../src/tools/transport-risk/_drift.js";

const sys = { id: "DEV", sid: "DEV", modules: ["dz-transport-risk"], targets: ["QAS", "PRO"] } as any;
const prog = { name: "ZDEMO_REP", type: "PROG/P", uri: "/x" };
const sap = { query: async (sql: string) => (/tfdir/.test(sql) ? { values: [{ PNAME: "SAPLZDEMO", INCLUDE: "01" }] } : { values: [] }) } as any;
const DEV = "REPORT zdemo_rep.\nWRITE 1.\nWRITE 2.\n";

describe("deriva de versión antes de editar", () => {
  it("nombre remoto: programas tal cual, módulos de función por su include, otros tipos sin comparar", async () => {
    expect(await remoteName(sap, prog)).toBe("ZDEMO_REP");
    expect(await remoteName(sap, { name: "ZDEMO_FM", type: "FUGR/FF", uri: "/y" })).toBe("LZDEMOU01");
    expect(await remoteName(sap, { name: "ZCL_X", type: "CLAS/OC", uri: "/z" })).toBeUndefined();
  });

  it("idéntica, distinta (con diff destino → DEV) y ausente, por destino", async () => {
    const fetch = async (_s: any, p: Record<string, string | undefined>) => {
      if (p.remote_source === "QAS") return JSON.stringify({ system: "QAS", subrc: 0, lines: ["REPORT zdemo_rep.", "WRITE 1.", "WRITE 2."] });
      if (p.remote_source === "PRO") return JSON.stringify({ system: "PRO", subrc: 0, lines: ["REPORT zdemo_rep.", "WRITE 1."] });
      return JSON.stringify({ system: p.remote_source, subrc: 4, detail: "no existe" });
    };
    const d = await versionDrift(sap, sys, prog, DEV, ["QAS", "PRO", "QS2"], fetch);
    expect(d.map((x) => `${x.target}:${x.status}`)).toEqual(["QAS:igual", "PRO:distinta", "QS2:ausente"]);
    expect(d[1].detail).toMatch(/1 líneas solo en DEV, 0 solo en PRO/);
    expect(d[1].diff).toMatch(/\+WRITE 2\./);
    expect(driftVerdict(d[1])).toMatch(/arrastrará lo que DEV ya tiene de más/);
    expect(driftVerdict(d[2])).toMatch(/llegará como objeto nuevo/);
  });

  it("servicio caído o respuesta no JSON: se dice «sin comparar», nunca «igual»", async () => {
    const d = await versionDrift(sap, sys, prog, DEV, ["QAS", "PRO"], async (_s, p) => {
      if (p.remote_source === "QAS") throw new Error("ECONNREFUSED");
      return { text: "La respuesta no es JSON (HTTP 200)", isError: true };
    });
    expect(d.map((x) => x.status)).toEqual(["sin_comparar", "sin_comparar"]);
    expect(d[0].detail).toMatch(/ECONNREFUSED/);
  });

  it("un tipo que no se compara lo dice por cada destino", async () => {
    const d = await versionDrift(sap, sys, { name: "ZCL_X", type: "CLAS/OC", uri: "/z" }, DEV, ["QAS"]);
    expect(d[0]).toMatchObject({ status: "sin_comparar" });
    expect(d[0].detail).toMatch(/no cubre CLAS\/OC/);
  });
});
