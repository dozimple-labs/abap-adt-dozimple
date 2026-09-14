import type { z, ZodRawShape } from "zod";
import type { Config, SystemConfig, SystemSource } from "./config.js";
import type { ConnectionPool, SapConnection } from "./connection.js";
import type { Sidecar, SidecarPool } from "./sidecar.js";

/**
 * Qué hace la tool contra SAP. Decide dónde se permite:
 * - read:  cualquier sistema.
 * - exec:  ejecuta código (ABAP Unit…): solo sistemas DEV.
 * - write: modifica el repositorio: solo DEV con allowWrite.
 * - local: no toca SAP (estadísticas, registro de huecos…).
 */
export type Access = "read" | "exec" | "write" | "local";

export interface ToolContext {
  readonly config: Config;
  readonly pool: ConnectionPool;
  readonly tools: readonly ToolDef<any>[];
  /** Sistema resuelto para esta llamada. Lanza si la tool es local. */
  readonly system: SystemConfig;
  readonly systemSource: SystemSource;
  readonly sap: SapConnection;
  /** MCP de terceros aislado (requires.sidecar). */
  sidecar(name: string): Sidecar;
}

export interface ToolEnv {
  config: Config;
  pool: ConnectionPool;
  tools: readonly ToolDef<any>[];
  sidecars?: SidecarPool;
  /**
   * Pregunta al usuario vía elicitación MCP. Solo existe si el cliente la
   * soporta; si no, las escrituras se confirman con token en dos fases.
   */
  elicit?: (message: string) => Promise<"accept" | "decline" | "cancel">;
}

export type ToolResult = string | { text: string; isError?: boolean };

export interface ToolDef<S extends ZodRawShape = ZodRawShape> {
  name: string;
  title: string;
  /** Qué hace y CUÁNDO usarla. Es lo que lee el modelo para elegir. */
  description: string;
  access: Access;
  input: S;
  requires?: {
    /** Colecciones ADT que deben existir en el discovery del sistema. */
    adt?: string[];
    /** Módulo de cliente: la tool solo existe si algún sistema lo habilita. */
    module?: string;
    /** Componente de terceros (sidecars.<nombre>): la tool solo existe si está configurado. */
    sidecar?: string;
    /** Envía la consulta a internet: solo existe si el sidecar tiene allowOnline. */
    online?: boolean;
  };
  run(args: z.output<z.ZodObject<S>>, ctx: ToolContext): Promise<ToolResult>;
  /**
   * Solo tools write: qué va a cambiar, sin cambiar nada (diff, sintaxis,
   * orden). Es lo que el usuario confirma antes de que run() escriba.
   */
  preview?(args: z.output<z.ZodObject<S>>, ctx: ToolContext): Promise<string>;
}

/** Identidad tipada: da inferencia de los argumentos a partir de `input`. */
export function defineTool<S extends ZodRawShape>(def: ToolDef<S>): ToolDef<S> {
  return def;
}
