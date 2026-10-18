import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** server.json (MCP Registry) tiene que llevar la misma versión que package.json en cada release. */
describe("server.json", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const srv = JSON.parse(readFileSync("server.json", "utf8"));
  it("versión y paquete npm coinciden con package.json", () => {
    expect(srv.version).toBe(pkg.version);
    expect(srv.packages[0]).toMatchObject({ registryType: "npm", identifier: pkg.name, version: pkg.version, transport: { type: "stdio" } });
    expect(srv.name).toBe("io.github.dozimple-labs/abap-adt-dozimple");
  });
});
