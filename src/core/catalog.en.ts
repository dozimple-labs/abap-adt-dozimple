/**
 * English texts for the generated blocks of README.md. The tool descriptions the
 * model reads stay in the code (Spanish); this is only the public summary. A test
 * requires every catalogued tool, group and prompt to have its English entry.
 */
export const GROUPS_EN: Record<string, { title: string; pitch: string }> = {
  revision: { title: "Code review and transports", pitch: "Know what a transport really changes and what it may break, before releasing it." },
  calidad: { title: "Quality, ATC and remediation", pitch: "Find, understand and fix findings with SAP's real syntax check and quick fixes." },
  exploracion: { title: "Repository exploration", pitch: "Read and understand any ABAP object and its relations, on ECC and S/4HANA." },
  datos: { title: "Data queries", pitch: "Query tables with ABAP SQL, read-only, with sensitive and personal data protected." },
  diagnostico: { title: "Incident diagnosis", pitch: "One conversation for what used to take ST22, SM37, SLG1 and /IWFND/ERROR_LOG." },
  documentacion: { title: "SAP documentation", pitch: "Answer from official documentation and check which syntax exists in each release." },
  escritura: { title: "Controlled writes", pitch: "Save changes only in development, in the right transport, previewed and confirmed by a human." },
  "transport-risk": { title: "DoZimple Transport Risk", pitch: "Decide whether a whole release can go to QA or production, with the why in business terms." },
  operacion: { title: "Operations and growth", pitch: "See what works on each system and decide the next tool with data." },
};

export const TOOLS_EN: Record<string, string> = {
  transport_diff: "**What a transport changed (code diff).** Code review of a transport: for each source object (programs, includes, classes, interfaces, function modules, CDS) compares the version recorded with that transport against the previous one and shows a unified diff.",
  my_transports: "**My transports.** Transports of a user (by default the connection user): their own and those where they have a task, with tasks, status, target and objects; flags transports without a target and own tasks in someone else's transport.",
  transport_contents: "**Transport contents.** Header, tasks (owner and status) and objects of a transport request, read from E070/E07T/E071.",
  co_change: "**What usually travels with this object?** Looks at the transports that touched an object and counts which other objects travelled with it, most frequent first.",
  inactive_objects: "**Inactive objects.** Objects saved but not activated by the connection user, with their transport.",
  edit_preflight: "**Before editing: which transport will it land in?** Tells, BEFORE changing an object, which transport the change will end up in and why: CTS lock by another transport, local object ($TMP), repair (different original system), or free with your open transports.",
  run_atc: "**Run ATC.** Runs the ABAP Test Cockpit on an object or a transport and lists numbered findings (priority, line, check, message) with SAP's P1/P2/P3 totals.",
  atc_quickfix: "**SAP-proposed fixes.** The fixes SAP offers (the same as Ctrl+1 in Eclipse) for an ATC finding or a line: create text symbol, extract constant, etc.",
  api_release_state: "**Is this API released? What is its successor?** Release state of an SAP object (class, function module/BAPI, table, CDS…) by contract C0–C4 and its released successor, read from the system itself.",
  sap_notes: "**SAP notes in the system (SNOTE).** Whether a note is downloaded in this system, its implementation and processing status, version, component and title, per note or filtered by status/component; no SAP portal or S-user needed.",
  syntax_check: "**SAP syntax check.** SAP's real syntax check (not abaplint), also on code not saved yet.",
  run_unit_tests: "**Run ABAP Unit.** Runs the ABAP Unit tests of a class or program (harmless and short only) and returns the result per method, with each failure in detail.",
  search_objects: "**Search ABAP objects.** Searches repository objects by name (supports * wildcards).",
  get_source: "**Read ABAP source.** Reads the source of any object: program, include, class (and its includes), interface, function module (without knowing its group), CDS, table/structure, etc.",
  where_used: "**Where used.** Where-used list of an object: who references it, with package and owner.",
  source_search: "**Search text in source code.** Searches a text or regex in the source of a package (with subpackages), a transport or a list of objects, and returns object, include, line and the matching line; reaches what where-used misses (dynamic calls, literals, Z code outside the reference index).",
  enhancements: "**Enhancements and BAdIs.** Implementations of a BAdI (new and classic, active or not), source code enhancements implemented inside a program, class or function group (flagging those that overwrite standard code), or all enhancement implementations of a namespace by type.",
  object_versions: "**Object versions.** Version history of an object (date, author, transport).",
  package_contents: "**Package contents.** Objects of a development package grouped by type, with subpackages (TADIR/TDEVC, any release).",
  ddic_type_info: "**Data element, domain or table type.** Definition of a DDIC type: data element (domain, type, length, texts), domain (type, length, fixed values, value table) or table type (line type, key).",
  function_modules: "**Function modules of a group.** Lists the function modules of a function group with their text and whether they are RFC or update modules; given a module, finds its group and siblings. Works with /XXX/ namespaces.",
  transaction_info: "**What a transaction runs.** Program, screen and parameters of a transaction (TSTC/TSTCP), with its text.",
  text_elements: "**Text symbols and selection texts.** Reads the text symbols (TEXT-001…), selection texts or headings of a program, class or function group.",
  sql_query: "**ABAP SQL query.** Runs an ABAP SQL SELECT (WHERE, JOIN, ORDER BY, subqueries) through ADT data preview, with personal columns masked and row caps on production-data systems.",
  table_contents: "**Table contents.** Rows of a table, view or CDS, with optional columns and filter.",
  dumps: "**Dumps (ST22).** Lists runtime dumps: date, error, program, user and short text.",
  jobs: "**Background jobs (SM37).** Background jobs by name (supports *), user, status and date, with their steps (program and variant).",
  application_log: "**Application log (SLG1) headers.** Application log headers (BALHDR) by object/subobject, external number, user and date, with error and warning counts.",
  gateway_errors: "**SAP Gateway errors (/IWFND/ERROR_LOG).** Lists SAP Gateway (OData) errors: service, error, user, date.",
  abap_feature_matrix: "**Since which release does this syntax exist?** Availability of each ABAP language feature per release (7.40 … 7.58, 2025).",
  docs_search: "**Search ABAP documentation.** Searches the official ABAP keyword documentation (standard and cloud), Clean ABAP, the DSAG guide, ABAP cheat sheets and RAP samples, locally.",
  docs_fetch: "**Read a documentation page.** Returns the full content of a document by the id docs_search gives.",
  clean_core_objects: "**Released objects catalog (Clean Core).** Searches SAP's public catalog (abap-atc-cr-cv-s4hc, local) for released/deprecated objects by name or topic, with Clean Core level (A released … D all) and successors.",
  clean_core_object: "**Clean Core state of an SAP object.** Release state, Clean Core level and successor of an SAP object according to the public catalog (local).",
  abap_lint: "**abaplint on a snippet.** Runs abaplint locally (code never leaves the machine) on an ABAP snippet or source.",
  docs_community_search: "**Search SAP Community.** Searches SAP Community (blogs and questions) by error message, class or concept.",
  write_source: "**Save source to SAP.** Replaces the FULL source of an existing object (or class include) in the given transport, after a preview with syntax check and diff and a human confirmation.",
  revert_source: "**Revert to an earlier version.** Writes back an earlier version of an object (the last active one, the one before it, or a numbered one from object_versions) through the same preview, fingerprint, lock and transport as write_source; never reverts on its own.",
  activate: "**Activate object.** Activates an object and returns SAP's messages as they are (errors with line, warnings, objects left inactive).",
  write_text_elements: "**Create or change text symbols.** Adds or changes text symbols (or selection texts) of a program/class/group, merging with the existing ones: nothing not mentioned is deleted.",
  create_transport: "**Create transport request.** Creates a workbench request for an object's package BEFORE the first edit, so the change lands in the ticket's transport and not in a reused task.",
  analyze_transport_risk: "**Transport risk.** Tells whether a transport (or a release of several, comma-separated) is safe to move to QA or production: unreleased tasks, import status, dependencies that don't travel, positional access, CTS locks, import queue.",
  import_health: "**Import health.** Health of the imports into a target (QA or production): answers “how are the releases to production going?”.",
  failure_ranking: "**Objects that fail most on import.** Ranking of objects by import failure history in a target.",
  change_audit: "**Change audit evidence.** Evidence for a change management audit on a target: what went in, with which ticket, initiative and origin.",
  object_transport_history: "**Transport history of an object.** Which transports touched an object, when, and which already reached the target.",
  remote_source: "**Source on the target.** The source of an object AS IT IS in QA or production, read through TMS (like “Retrieve remote versions”).",
  transport_source_check: "**Transport code against the target.** Compares the code of a transport's objects with the target: objects missing there (R3.4) and version drift — signatures, fields or parameters that differ and don't travel in the transport (R3.5).",
  sap_systems: "**SAP systems and available tools.** Lists the configured systems (role, writes, data class, modules) and, optionally, checks connectivity and which tools work on each.",
  report_gap: "**Record a missing tool.** Records a need no tool covers (e.g. something you had to do manually in a transaction), to decide what to build next.",
  close_gap: "**Close a recorded gap.** Marks a gap recorded with report_gap as resolved, with a note (a tool now covers it, or the note turned out to be wrong); nothing is deleted.",
  usage_stats: "**Tool usage and gaps.** Summary of the local log: calls per tool, failure rate and type, systems, and the gaps recorded with report_gap.",
};

export const PROMPTS_EN: Record<string, { title: string; description: string; chain: string }> = {
  revisar_pase: {
    title: "Review a transport before release",
    description: "Full review of a transport: code, missing companions, locks and, with the risk module, its analysis.",
    chain: "transport_contents → transport_diff → inactive_objects → co_change + edit_preflight → analyze_transport_risk (if module) → three-layer report: business, consultant, Basis",
  },
  remediar_atc: {
    title: "Remediate ATC findings of an object",
    description: "ATC → documentation and SAP note → released successor → fix → syntax → save in the transport.",
    chain: "edit_preflight → run_atc (BEFORE) → explain + api_release_state + where_used/object_versions → CHANGE/INVESTIGATE/KEEP classification → atc_quickfix → syntax_check → write_source in the transport (with human OK) → run_atc (AFTER) and P1 reduction",
  },
  diagnosticar_ticket: {
    title: "Diagnose an incident",
    description: "Dumps, jobs, application log and Gateway errors around an incident.",
    chain: "dumps → jobs → application_log → gateway_errors → transaction_info / get_source / object_versions / transport_contents → probable cause with evidence and what could not be checked",
  },
};

const PHRASES_EN: Array<[RegExp, string]> = [
  [/ y contribuidores/g, " and contributors"],
  [/ y autores de la comunidad/g, " and community authors"],
  [/^según el repositorio$/, "per repository"],
  [/^términos de SAP$/, "SAP terms"],
  [/^algoritmo publicado$/, "published algorithm"],
];
export const toEn = (s: string) => PHRASES_EN.reduce((acc, [re, en]) => acc.replace(re, en), s);
export const KIND_EN: Record<string, string> = { dependencia: "dependency", datos: "data", idea: "idea", algoritmo: "algorithm" };
