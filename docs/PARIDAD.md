# Paridad de capacidades con otros MCP para SAP

Qué cubre `abap-adt-doZimple` frente al MCP oficial de SAP (ADT) y a los servidores de la comunidad que se estudiaron
para el plan de mejoras. Es un documento vivo: se revisa en cada release nuestra y cada vez que SAP publica una
versión nueva de ADT. Marca con honestidad lo verificado y lo supuesto.

**Última revisión:** 2026-10-18 · **Nuestra versión:** 1.8.0 · **MCP de SAP:** el que trae ADT 3.60 (Eclipse y
VS Code), según documentación pública y pruebas de terceros; **no se ha ejecutado todavía contra un sistema propio.**

## 1. Qué se puede garantizar y qué no

No se puede garantizar «toda la funcionalidad del MCP de SAP» en ningún release, por tres razones:

1. **Es propietario y cambia con cada ADT.** SAP añade tools en cada versión y publica poca documentación de su lista.
   Solo podemos comparar contra una versión concreta en una fecha concreta.
2. **No corre en los mismos sistemas.** El MCP de SAP vive dentro de ADT y apunta a releases recientes de S/4HANA y
   ABAP Cloud; parte de sus capacidades (generadores, asistencia) están ligadas a Joule y a licencia. Nosotros
   cubrimos también ECC 6.0 / NW 7.50, donde SAP no ofrece nada.
3. **Algunas cosas las hace por estar dentro del IDE** (identidad del desarrollador, depurador, APIs internas que SAP se
   reserva según su política de APIs). No las replicaremos igual, a propósito.

Lo que sí se compromete: que cada capacidad del **flujo de desarrollo y soporte** (leer, buscar, crear, editar, verificar,
activar, probar, transportar, diagnosticar) esté cubierta y **verificada en vivo**, y que esta matriz diga en qué
estado está cada una. La 2.0.0 no se publica sin la columna «2.0» en verde para ese flujo (compuerta de salida de la
Ola 3 del plan de mejoras).

## 2. Fuentes

| Fuente | Qué se tomó | Fiabilidad |
| --- | --- | --- |
| SAP Help: *Enabling ADT MCP Server* (ADT para VS Code) | Existe un MCP oficial dentro de ADT; mismo servidor en Eclipse y VS Code | Oficial, sin lista de tools |
| SAP Community (equipo de SAP, 2026-09): *The Official ABAP MCP Server: What My Tests Revealed* | Crear órdenes, ejecutar ABAP Unit, ATC con correcciones; resultados iguales a Eclipse | Oficial, pruebas de un autor |
| Extensión comunitaria sobre el MCP de SAP (`arc1-adt-abap-mcp-ext`) | Tools que SAP trae por defecto (abajo) y punto de extensión `com.sap.adt.mcp.core.adtMcpTools`; requiere ADT 3.60 | Terceros, por verificar |
| Servidores estudiados para el plan: fr0ster/mcp-abap-adt, vibing-steampunk (vsp), Dassian ADT, ABAPilot, arc-1 | Capacidades de referencia de la comunidad | README y código públicos |

Tools que, según esas fuentes, trae el MCP de SAP de serie en una instalación S/4 (nombres tal como se publican):
`abap_list_destinations`, `abap_generators-list_generators`, `abap_generators-get_schema`,
`abap_generators-generate_objects`, `abap_transport-get`, `abap_transport-create`,
`abap_business_services-fetch_services`, `abap_business_services-fetch_service_information`. Lo demás (fuente,
búsqueda, sintaxis, where-used, ATC, ABAP Unit) lo aportan los módulos de ADT instalados o extensiones, y es lo que
hay que confirmar en vivo.

## 3. Matriz

Estado: **V** verificado en vivo en un sistema real · **S** supuesto por documentación o README · **P** pendiente ·
**–** no aplica. Para SAP, «Sí» significa que una fuente de la sección 2 lo afirma.

| Capacidad | MCP de SAP (ADT 3.60) | Nuestra 1.8.0 | Estado | Plan 2.0 |
| --- | --- | --- | --- | --- |
| Buscar objetos, leer fuente, versiones, paquete | Sí (IDE/extensión) | `search_objects`, `get_source`, `object_versions`, `package_contents` | V (7.50 y 758) | Igual |
| Where-used y búsqueda de texto en código | Sí (where-used) | `where_used`, `source_search` | V | Igual |
| Sintaxis real de SAP sobre código no guardado | Sí | `syntax_check` | V | Igual |
| ATC y correcciones propuestas | Sí, con fixes | `run_atc`, `atc_quickfix` (`apply` calcula sin guardar) | V | Igual |
| ABAP Unit | Sí | `run_unit_tests` | V | Igual |
| Crear objetos de código (PROG, CLAS, INTF, FUGR, FUNC, INCL, DDLS, DCLS) | Sí (generadores) | `create_object` con vista previa y confirmación | V | Igual |
| Editar y activar | Sí (IDE) | `write_source`, `edit_source`, `activate`, `revert_source` | V | Igual |
| Órdenes: crear, contenido, mis órdenes | Sí (`transport-get/create`) | `create_transport`, `transport_contents`, `my_transports`, `edit_preflight` | V | Igual |
| Diff de lo que cambia una orden | No consta | `transport_diff` | V | Igual |
| Riesgo de pase, cola, colisiones, auditoría de cambios | No | Módulo transport-risk (7 tools) | V (un cliente) | Igual |
| Deriva DEV vs QAS/PRD antes de editar | No | `edit_preflight` con `targets` | V | Igual |
| Diccionario: tablas y estructuras (S/4) | Sí (generadores) | `create_object` TABL/STRU (1.8.0) | S: sin verificar en vivo | Sí (issue 12) |
| Diccionario: dominios, elementos, tipos tabla | Sí (generadores) | `ddic_type_info` (lectura); `ddic_plan` (7.50, vía programa generador) | P en S/4 | Sí (issue 12) |
| Diccionario en ECC 7.50 | No aplica | `ddic_plan` + programa generador; RFC `ddic_apply` en curso | V (plan), P (apply) | Sí |
| RAP: BDEF, SRVD, SRVB, DDLX, business services | Sí (`business_services`, generadores) | Solo lectura de CDS/DCL | P | Sí (issue 12) |
| OData clásico (SEGW) | No | `odata_model` (EDMX) | S: importación en SEGW sin verificar | Sí |
| Consulta de datos con política (veto, masking, tope por sistema) | No | `sql_query`, `table_contents`, `count_rows`, `search_tables`, `foreign_keys` | V | Igual |
| Diagnóstico: dumps, mensajes, jobs, SLG1, gateway, notas, ampliaciones | Parcial | `dumps`, `diagnose_message`, `jobs`, `application_log`, `gateway_errors`, `sap_notes`, `enhancements` | V | Igual |
| Runtime: SAT, ST05, SM02 | No consta | `abap_traces`, `sql_traces` (S/4), `system_messages` | S: sin verificar en vivo | Igual |
| Análisis local de código: estructura, dependencias por paquete, métodos sin uso | No consta | `code_structure`, `package_dependencies`, `unused_methods` (abaplint) | V (tests) | Igual |
| Acceso elevado por categoría de datos (seguridad, HCM, personas) con auditoría | No | `elevate_access`, `elevation_status`, `revoke_access` | V (tests) | Igual |
| SQL libre analizado a tablas base; lectura productiva confirmada | No así | `sql_query`, `table_contents` | V (tests) | Igual |
| Depurador | Sí (el del IDE) | No | P | Lectura (issue 13) |
| Documentación ABAP, Clean Core, abaplint local | Vía Joule | 7 tools del grupo `documentacion` | V | Igual |
| Varios sistemas y clientes en un proceso | No (un proyecto ADT por sesión) | `system` explícito en cada tool | V | Igual |
| Identidad por persona en uso compartido | Sí (sesión del IDE) | No (stdio, un usuario por proceso) | P | Sí (issue 14, HTTP) |
| Escritura solo con vista previa y confirmación humana | No (acción directa) | Sí, en todas las tools de escritura | V | Igual |
| Auditoría encadenada de lecturas y escrituras | No | `audit` por hash; `data_read` por consulta | V | Igual |
| Catálogo reducido al arrancar | No consta | Perfil `core` + `load_tools`, −76 % de tokens | V | Igual |
| Bulk push de varios archivos | No consta | No | P | Sí (issue 15) |
| ECC 6.0 / NW 7.50 | No | Sí | V | Igual |
| S/4HANA on-premise (758) | Sí | Sí | V | Igual |
| ABAP Cloud / BTP ABAP Environment | Sí | Sin probar | P | Decidir |

Resumen: en S/4 estamos a la par en el flujo de desarrollo y por delante en gobierno, datos y diagnóstico; en RAP,
diccionario con escritura y depuración llegamos en la Ola 3; en ECC 7.50 SAP no compite.

## 4. Huecos conocidos frente al MCP de SAP

1. **Generadores RAP y business services.** Issue 12 del plan. Primero S/4; en ECC no aplica.
2. **Diccionario con escritura en S/4** (tablas, estructuras, dominios, elementos). Tablas y estructuras en 1.8.0, sin verificar en vivo; dominios y elementos pendientes.
3. **Depurador.** Issue 13: lectura de pila y variables; breakpoints solo en sistemas `test`.
4. **Identidad por persona.** Issue 14: modo HTTP con sesión SAP por usuario. Hasta entonces, un proceso por persona.
5. **ABAP Cloud.** No probado. El MCP de SAP nace ahí; decidir si entra en la 2.0 o después.

## 5. Cómo se verifica (procedimiento de la comparación)

1. Instalar ADT 3.60 en Eclipse con el MCP de SAP habilitado (Preferencias → ABAP Development → MCP Server) contra un
   S/4HANA de desarrollo (758). Anotar la lista real de tools que publica.
2. Correr el **mismo protocolo de 10 tareas** del issue #90 con los dos servidores, 3 corridas cada uno: tokens por
   tarea, tareas resueltas al primer intento, tool equivocada, errores visibles.
3. Rellenar la columna «MCP de SAP» de la matriz con lo observado (no con lo leído) y cambiar los **S** a **V** o a
   «No».
4. Repetir en cada release de ADT y en cada minor nuestra; dejar la fecha arriba.

Esfuerzo estimado: dos a tres días con el sistema disponible.

## 6. Reglas

- Esta matriz no copia tools de nadie: se estudia qué resuelven y se decide si entra (plan, sección 8).
- Una capacidad cuenta como cubierta solo con **V**. Un README ajeno o propio no vale como evidencia.
- Nada de este documento menciona sistemas, clientes ni usuarios concretos: los sistemas se describen por release.
