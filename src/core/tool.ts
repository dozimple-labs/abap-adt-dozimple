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
  /**
   * Solo en escrituras confirmadas: la huella del estado que el usuario vio en la vista previa. La tool la compara
   * (dentro del bloqueo) con el estado actual y no escribe si cambió.
   */
  confirmedState?: string;
  /**
   * Cancelación pedida por el cliente. Las tools largas lo comprueban ENTRE pasos (`signal.throwIfAborted()`): una
   * llamada ADT en curso no se puede abortar, así que la cancelación llega al terminar el paso actual.
   */
  readonly signal?: AbortSignal;
  /** Avance de una operación larga; llega al cliente como notificación de progreso si la pidió, y si no, se ignora. */
  progress?(message: string, current?: number, total?: number): void;
}

/** Lo que devuelve una vista previa: el texto que se muestra y, opcionalmente, la huella del estado mostrado. */
export type PreviewResult = string | { text: string; state?: string };

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
  /** Señal de cancelación de la petición MCP en curso. */
  signal?: AbortSignal;
  /** Envío de progreso al cliente (solo si la petición trae progressToken). */
  progress?: (message: string, current?: number, total?: number) => void;
}

/**
 * Resultado de una tool: el texto que lee el modelo y, si la tool declara `output`, los mismos datos de forma
 * estructurada (`structuredContent` del protocolo MCP) para que el cliente no tenga que interpretar el texto.
 */
export type ToolResult = string | { text: string; isError?: boolean; structured?: Record<string, unknown> };

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
  /**
   * Si la tool pide confirmación humana con vista previa antes de ejecutarse. Las tools write la piden SIEMPRE (no
   * se puede desactivar); las exec tienen que declararlo expresamente: un test falla si una exec no lo decide. Una
   * read puede pedirla también (elevate_access): entonces queda con intención y resultado en el registro de auditoría.
   */
  confirm?: boolean;
  /**
   * Tool de lectura de datos de negocio: en sistemas con datos productivos (dataClass prod y confirmProdReads) pide
   * confirmación con vista previa, igual que una escritura, y queda en el registro de auditoría con quién confirmó.
   */
  confirmReads?: boolean;
  /** Con confirm en una tool de lectura: cómo se llama la acción en la pregunta («elevación de acceso»). */
  confirmWhat?: string;
  /**
   * Tools con `output` que pueden responder con una vista previa (confirmReads, confirm): el contenido estructurado
   * de esa respuesta, conforme al esquema, porque el cliente lo valida aunque no se haya ejecutado nada.
   */
  previewStructured?(args: z.objectOutputType<S, z.ZodTypeAny>, previewText: string): Record<string, unknown>;
  /** Tiempo máximo de una ejecución (por defecto 60 s). Las lentas (ATC, where-used, diff) declaran el suyo. */
  timeoutMs?: number;
  /**
   * Esquema de la salida estructurada (outputSchema de MCP). Si se declara, TODO resultado que no sea error debe
   * traer `structured` conforme a él: el registro lo exige y el SDK lo valida antes de responder.
   */
  output?: ZodRawShape;
  run(args: z.objectOutputType<S, z.ZodTypeAny>, ctx: ToolContext): Promise<ToolResult>;
  /**
   * Solo tools write: qué va a cambiar, sin cambiar nada (diff, sintaxis,
   * orden). Es lo que el usuario confirma antes de que run() escriba.
   */
  preview?(args: z.objectOutputType<S, z.ZodTypeAny>, ctx: ToolContext): Promise<PreviewResult>;
}

/** Identidad tipada: da inferencia de los argumentos a partir de `input`. */
export function defineTool<S extends ZodRawShape>(def: ToolDef<S>): ToolDef<S> {
  return def;
}
