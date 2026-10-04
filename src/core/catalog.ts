/**
 * Catálogo funcional: a qué grupo pertenece cada tool y a quién se debe lo que
 * usa. Es la fuente de la documentación generada (docs/TOOLS.md) y un test
 * exige que toda tool tenga grupo y créditos.
 */
export interface Credit {
  /** Proyecto, obra o fuente. */
  what: string;
  /** Autor o titular. */
  by: string;
  url: string;
  license: string;
  /** dependencia = se usa su código; datos = contenido de terceros; idea = diseño reimplementado sin copiar código. */
  kind: "dependencia" | "datos" | "idea" | "algoritmo";
}

export const CREDITS = {
  abapAdtApi: { what: "abap-adt-api", by: "Marcello Urbani", url: "https://github.com/marcellourbani/abap-adt-api", license: "MIT", kind: "dependencia" },
  abapFs: { what: "ABAP Remote FS (vscode_abap_remote_fs)", by: "Marcello Urbani", url: "https://github.com/marcellourbani/vscode_abap_remote_fs", license: "MIT", kind: "idea" },
  mcpSdk: { what: "Model Context Protocol TypeScript SDK", by: "Model Context Protocol", url: "https://github.com/modelcontextprotocol/typescript-sdk", license: "MIT", kind: "dependencia" },
  marioAdt: { what: "mcp-abap-adt", by: "mario-andreschak", url: "https://github.com/mario-andreschak/mcp-abap-adt", license: "MIT", kind: "idea" },
  arc1: { what: "ARC-1", by: "arc-mcp (Marian Zeis y contribuidores)", url: "https://github.com/arc-mcp/arc-1", license: "MIT", kind: "idea" },
  vsp: { what: "vibing-steampunk", by: "oisee y contribuidores", url: "https://github.com/oisee/vibing-steampunk", license: "MIT", kind: "idea" },
  awsAccel: { what: "ABAP Accelerator for Amazon Q Developer", by: "AWS Solutions Library Samples", url: "https://github.com/aws-solutions-library-samples/guidance-for-deploying-sap-abap-accelerator-for-amazon-q-developer", license: "MIT-0", kind: "idea" },
  sapDocsMcp: { what: "mcp-sap-docs", by: "Marian Zeis (marianfoo)", url: "https://github.com/marianfoo/mcp-sap-docs", license: "Apache-2.0", kind: "dependencia" },
  abapDocs: { what: "ABAP Keyword Documentation", by: "SAP SE", url: "https://help.sap.com/doc/abapdocu_latest_index_htm/latest/en-US/index.htm", license: "© SAP SE", kind: "datos" },
  cheatSheets: { what: "ABAP Cheat Sheets", by: "SAP (SAP-samples)", url: "https://github.com/SAP-samples/abap-cheat-sheets", license: "Apache-2.0", kind: "datos" },
  cleanAbap: { what: "Clean ABAP (SAP Style Guides)", by: "SAP", url: "https://github.com/SAP/styleguides", license: "según el repositorio", kind: "datos" },
  dsag: { what: "DSAG ABAP-Leitfaden", by: "DSAG e.V.", url: "https://github.com/marianfoo/DSAG-ABAP-Guide", license: "según el repositorio", kind: "datos" },
  featureMatrix: { what: "ABAP Feature Matrix", by: "Software-Heroes", url: "https://software-heroes.com/en/abap-feature-matrix", license: "© Software-Heroes", kind: "datos" },
  releasedObjects: { what: "Released objects / Cloudification Repository (abap-atc-cr-cv-s4hc)", by: "SAP", url: "https://github.com/SAP/abap-atc-cr-cv-s4hc", license: "Apache-2.0", kind: "datos" },
  abaplint: { what: "abaplint", by: "Lars Hvam y contribuidores", url: "https://github.com/abaplint/abaplint", license: "MIT", kind: "dependencia" },
  sapCommunity: { what: "SAP Community / SAP Help Portal", by: "SAP SE y autores de la comunidad", url: "https://community.sap.com", license: "términos de SAP", kind: "datos" },
  myers: { what: "An O(ND) Difference Algorithm and Its Variations (1986)", by: "Eugene W. Myers", url: "https://doi.org/10.1007/BF01840446", license: "algoritmo publicado", kind: "algoritmo" },
  zod: { what: "zod", by: "Colin McDonnell y contribuidores", url: "https://github.com/colinhacks/zod", license: "MIT", kind: "dependencia" },
} satisfies Record<string, Credit>;

type CreditKey = keyof typeof CREDITS;

export interface Group {
  id: string;
  title: string;
  /** Qué problema resuelve el grupo, en una frase. */
  pitch: string;
  tools: Array<{ name: string; credits: CreditKey[] }>;
}

const ADT: CreditKey[] = ["abapAdtApi"];

export const GROUPS: Group[] = [
  {
    id: "revision",
    title: "Revisión de código y pases",
    pitch: "Saber qué cambia de verdad una orden y qué puede romper, antes de liberarla.",
    tools: [
      { name: "transport_diff", credits: ["abapAdtApi", "arc1", "myers"] },
      { name: "transport_contents", credits: ADT },
      { name: "my_transports", credits: ["abapAdtApi", "awsAccel"] },
      { name: "co_change", credits: ["vsp"] },
      { name: "inactive_objects", credits: ADT },
      { name: "edit_preflight", credits: ADT },
    ],
  },
  {
    id: "calidad",
    title: "Calidad, ATC y remediación",
    pitch: "Encontrar, entender y corregir hallazgos con la sintaxis y las correcciones reales de SAP.",
    tools: [
      { name: "run_atc", credits: ADT },
      { name: "atc_quickfix", credits: ["abapAdtApi", "arc1", "myers"] },
      { name: "api_release_state", credits: ["abapAdtApi", "vsp"] },
      { name: "sap_notes", credits: ADT },
      { name: "syntax_check", credits: ["abapAdtApi", "abapFs"] },
      { name: "run_unit_tests", credits: ADT },
    ],
  },
  {
    id: "exploracion",
    title: "Exploración del repositorio",
    pitch: "Leer y entender cualquier objeto ABAP y sus relaciones, en ECC y en S/4HANA.",
    tools: [
      { name: "search_objects", credits: ["abapAdtApi", "marioAdt"] },
      { name: "get_source", credits: ["abapAdtApi", "marioAdt"] },
      { name: "where_used", credits: ADT },
      { name: "source_search", credits: ["abapAdtApi", "vsp"] },
      { name: "object_versions", credits: ADT },
      { name: "package_contents", credits: ["abapAdtApi", "marioAdt"] },
      { name: "ddic_type_info", credits: ["abapAdtApi", "marioAdt"] },
      { name: "ddic_plan", credits: [] },
      { name: "transaction_info", credits: ["abapAdtApi", "marioAdt"] },
      { name: "function_modules", credits: ADT },
      { name: "text_elements", credits: ADT },
      { name: "enhancements", credits: ["abapAdtApi", "vsp"] },
    ],
  },
  {
    id: "datos",
    title: "Consulta de datos",
    pitch: "Preguntar a las tablas con ABAP SQL, de solo lectura y sin tocar material de credenciales.",
    tools: [
      { name: "sql_query", credits: ADT },
      { name: "table_contents", credits: ["abapAdtApi", "marioAdt"] },
    ],
  },
  {
    id: "diagnostico",
    title: "Diagnóstico de incidentes",
    pitch: "Reunir en una conversación lo que antes exigía ST22, SM37, SLG1 y /IWFND/ERROR_LOG.",
    tools: [
      { name: "dumps", credits: ADT },
      { name: "jobs", credits: ["vsp"] },
      { name: "application_log", credits: ["vsp"] },
      { name: "gateway_errors", credits: ["abapAdtApi", "arc1"] },
    ],
  },
  {
    id: "documentacion",
    title: "Documentación SAP",
    pitch: "Responder con la documentación oficial y comprobar qué sintaxis existe en cada release.",
    tools: [
      { name: "abap_feature_matrix", credits: ["sapDocsMcp", "featureMatrix"] },
      { name: "docs_search", credits: ["sapDocsMcp", "abapDocs", "cheatSheets", "cleanAbap", "dsag"] },
      { name: "docs_fetch", credits: ["sapDocsMcp", "abapDocs"] },
      { name: "clean_core_objects", credits: ["sapDocsMcp", "releasedObjects"] },
      { name: "clean_core_object", credits: ["sapDocsMcp", "releasedObjects"] },
      { name: "abap_lint", credits: ["sapDocsMcp", "abaplint"] },
      { name: "docs_community_search", credits: ["sapDocsMcp", "sapCommunity"] },
    ],
  },
  {
    id: "escritura",
    title: "Escritura controlada",
    pitch: "Guardar cambios solo en desarrollo, en la orden correcta y con la sintaxis verificada antes.",
    tools: [
      { name: "create_object", credits: ["abapAdtApi", "awsAccel", "abapFs"] },
      { name: "write_source", credits: ADT },
      { name: "edit_source", credits: ADT },
      { name: "revert_source", credits: ADT },
      { name: "change_package", credits: ADT },
      { name: "activate", credits: ADT },
      { name: "write_text_elements", credits: ADT },
      { name: "create_transport", credits: ADT },
    ],
  },
  {
    id: "transport-risk",
    title: "DoZimple Transport Risk",
    pitch: "Decidir si un pase entero puede ir a calidad o productivo, con el porqué en lenguaje de negocio.",
    tools: [
      { name: "analyze_transport_risk", credits: [] },
      { name: "import_health", credits: [] },
      { name: "failure_ranking", credits: [] },
      { name: "change_audit", credits: [] },
      { name: "object_transport_history", credits: [] },
      { name: "remote_source", credits: [] },
      { name: "transport_source_check", credits: [] },
    ],
  },
  {
    id: "operacion",
    title: "Operación y crecimiento",
    pitch: "Ver qué funciona en cada sistema y decidir con datos cuál es la siguiente tool.",
    tools: [
      { name: "sap_systems", credits: ADT },
      { name: "report_gap", credits: [] },
      { name: "close_gap", credits: [] },
      { name: "usage_stats", credits: ["awsAccel"] },
    ],
  },
];

/** Créditos del núcleo (todas las tools se apoyan en ellos). */
export const CORE_CREDITS: CreditKey[] = ["mcpSdk", "zod", "abapAdtApi", "awsAccel"];

export function groupOf(tool: string): Group | undefined {
  return GROUPS.find((g) => g.tools.some((t) => t.name === tool));
}
