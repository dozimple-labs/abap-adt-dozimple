# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/). Versionado [SemVer](https://semver.org/lang/es/).

## [Unreleased]

## [2.0.1] - 2026-10-18

Correcciones de la primera verificación en vivo de la 2.0 contra un NW 7.50: depurador (cierre, puntos de parada), mensajes
de sistema y vista previa de `sql_query` en productivo.

### Corregido
- **`debug_breakpoints clear` olvidaba los puntos de parada al cerrar la sesión** y quedaban puestos en SAP: ahora se
  recuerdan por sistema fuera de la sesión y se quitan por la conexión de lectura. Las variables internas del kernel
  («{DATAAGING_…}») ya no se listan. Verificado en vivo: punto de parada externo, adhesión por una petición HTTP
  propia, pila de 4 marcos, variables por nombre, paso «over» y cierre.
- **`debug_listen` tardaba dos minutos en volver tras el tiempo de espera y `debug_stop` se colgaba**: la sesión
  stateful seguía ocupada con la escucha larga y cualquier petición por ella esperaba a SAP. Ahora el listener se
  retira por la conexión de lectura, el cierre tiene tope y la sesión se cierra al agotar el tiempo. Verificado en
  vivo (10 s de espera → 15 s en total). La vista previa de las tools `exec` dice «ejecutado», no «escrito».
- `create_object` explica por familia por qué un release no expone un tipo (diccionario en 7.50 → `ddic_plan`; RAP
  solo en S/4).
- **`system_messages` leía columnas que no existen**: en un NW 7.50 real TEMSI es solo un contador y TEMSG trae todo
  (ID, EMTEXT, DATCRE/TIMCRE, DATDEL/TIMDEL, AUTHOR, APPLSERVER, CLIENT, LANGU). Ahora lee TEMSG. Verificado en vivo.
- **La vista previa de `sql_query` en sistemas con datos productivos fallaba en el cliente** («Output validation error»):
  una tool con esquema de salida no puede responder sin contenido estructurado. Nuevo `previewStructured` en la
  definición de tool (obligatorio, por test, en toda tool con `output` y confirmación); `sql_query` devuelve una
  respuesta vacía con la nota de vista previa. Verificado en vivo.

## [2.0.0] - 2026-10-18

Ola 3 del plan de mejoras: modo HTTP de equipo con identidad por persona, depurador de solo lectura, RAP y
diccionario con escritura en S/4, y varias fuentes en una operación. Versión mayor porque cambia el comportamiento
de 1.8.0 en dos puntos que vienen de la Ola 2: las tablas de seguridad y de personal requieren acceso elevado, y las
lecturas de datos productivos piden confirmación.

### Añadido
- **Depurador de solo lectura** (Ola 3, punto 13), grupo `depuracion`: `debug_breakpoints` (puntos de parada externos
  del usuario de la conexión, solo con datos `test` y con confirmación), `debug_listen` (escucha hasta un tiempo,
  se adhiere y devuelve pila y variables), `debug_variables`, `debug_step` (into, over, return, continue) y
  `debug_stop`. Sesión stateful por sistema en memoria del proceso; variables personales enmascaradas en sistemas
  `masked`; deshabilitado con datos `prod`; nunca cambia valores. Todo `exec`: solo DEV y con rastro en el registro.
  `SapConnection.openStateful()` para sesiones que duran más de una llamada. Sin verificar en vivo.
- **Modo HTTP de equipo con identidad por persona** (Ola 3, punto 14): `abap-adt-dozimple serve` publica el servidor por
  Streamable HTTP (`/mcp`). Cada petición lleva `Authorization: Basic usuario:contraseña` y el servidor conecta a SAP
  como esa persona (usuario en conexiones, bloqueos, órdenes y registro de auditoría); la contraseña vive solo en
  memoria mientras dura la sesión (`password: "session:<id>"`). Sin TLS no escucha fuera de loopback (`--cert`/`--key`
  o proxy TLS); protección contra DNS rebinding en loopback; tope de sesiones, caducidad por inactividad y 403 si otra
  identidad intenta usar una sesión. stdio sigue siendo el modo individual.

### Añadido
- **RAP y diccionario con escritura en S/4** (Ola 3, punto 12). `create_object` admite tipos tabla (TTYP), elementos
  de datos y dominios (DTEL, DOMA, con `ddic_properties` validadas y escritas bajo bloqueo), extensiones de metadatos
  CDS (DDLX), definiciones de servicio (SRVD), bindings OData V2 (SRVB, con `service_definition`) y definiciones de
  comportamiento (BDEF, con `implementation_type`, por petición ADT directa). Nueva `write_ddic_properties` para
  cambiar las propiedades de un dominio o elemento existente con diff, huella bajo bloqueo, orden y activación.
  Solo donde ADT lo expone (S/4 y NW ≥ 7.51); en 7.50, `ddic_plan`. Sin verificar en vivo todavía.

### Añadido
- **`push_sources`** (Ola 3, punto 15): varias fuentes completas (hasta 20 objetos existentes o includes de clase) en
  la misma orden, con una sola vista previa consolidada (sintaxis y diff por objeto), una sola confirmación, guardado
  objeto a objeto con las garantías de `write_source` (huella por objeto, bloqueo, orden) y activación conjunta al
  final; lo que falla se cuenta por objeto y no se activa.

## [1.8.0] - 2026-10-18

Ola 2 del plan de mejoras: acceso elevado por categorías de datos, auditoría de lecturas, SQL libre analizado por
estructura con confirmación en productivo, análisis de código en local con abaplint, runtime de solo lectura,
`object_context` y el instalador `init`. Además la matriz de paridad con el MCP de SAP y el protocolo de prueba.

### Añadido
- **Módulo de acceso elevado** (Ola 2, punto 7). Las tablas que lee una consulta (incluidas las base de vistas y
  CDS) se clasifican en `SECRETOS` (nunca), `SEG_ROLES`, `HCM_MAESTRO`, `HCM_NOMINA`, `PERSONAS_NEGOCIO` (elevables)
  y `NEGOCIO` (libre). Seguridad, maestro HCM y nómina solo se leen con una elevación vigente; `PERSONAS_NEGOCIO`
  elevada quita el enmascarado. `elevate_access` (vista previa + confirmación, por sistema, categoría, minutos y
  motivo; permitido por sistema con `elevation.allowed`/`maxMinutes`, en PRD solo seguridad y personas por defecto),
  `elevation_status` y `revoke_access`. Eventos `elevation_granted`, `elevation_used` (por lectura),
  `elevation_revoked` en el registro de auditoría; `data_read` lleva categorías y elevaciones. Cambio de
  comportamiento: AGR_*/USR* (antes libres) requieren ahora `SEG_ROLES`, y los infotipos (antes vetados) se pueden
  leer con `HCM_MAESTRO`/`HCM_NOMINA` en desarrollo. Las tools de lectura pueden declarar `confirm`.
- **Análisis de código en local con abaplint** (Ola 2, puntos 9 y 11). Nueva dependencia `@abaplint/core` (MIT,
  versión fijada). `code_structure` (clases con métodos y visibilidad, interfaces, forms, tablas, funciones, clases
  e includes que usa, métricas y métodos privados sin uso, de un objeto o de un fragmento), `package_dependencies`
  (grafo de dependencias de un paquete o lista, interno/externo, destinos más usados) y `unused_methods` (métodos
  privados o protegidos sin uso en su clase, por paquete). `object_context` añade un **resumen** de la fuente
  (qué hay y qué toca) en vez de obligar a leerla entera. Todo local: el código no sale del equipo ni se ejecuta.
- **Runtime de solo lectura** (Ola 2, punto 8), grupo `diagnostico`: `abap_traces` (trazas SAT grabadas: lista con
  tiempos ABAP/sistema/BD y, por traza, hit list, accesos a base de datos o sentencias), `sql_traces` (directorio y
  estado de ST05 por ADT, S/4 y NW ≥ 7.51; en 7.50 lo dice) y `system_messages` (SM02 desde TEMSI/TEMSG, con la
  política de datos del sistema). Activar o borrar trazas queda fuera a propósito (es escritura). Sin verificar en vivo.
- **SQL libre controlado** (Ola 2, punto 10). Las consultas de `sql_query`, `table_contents` y `count_rows` se
  analizan por estructura (`core/sqlparse.ts`: FROM, JOIN, subconsultas, CTE `WITH +x`) y se resuelven a tablas
  base antes del veto de vistas y CDS; si no se puede determinar qué leen (variables host, fuentes dinámicas,
  paréntesis sin cerrar, `UP TO`, `INTO`), se rechazan con el motivo en vez de adivinar. El evento `data_read`
  lleva las tablas del análisis. En sistemas con datos `prod`, `sql_query` y `table_contents` **piden confirmación
  en dos pasos** (vista previa con tablas y tope, token o elicitación) y dejan `intent`/`result` con quién confirmó,
  igual que una escritura; `confirmProdReads: false` en el sistema lo desactiva. `count_rows` no la pide.
- **Protocolo de prueba comparativa** (issue #90): `docs/benchmarks/PROTOCOLO.md` (diez tareas reales, dos sistemas por
  release, métricas y corridas) y el harness `scripts/benchmark.mjs`, que ejecuta las tareas contra un sistema con
  este MCP, publica la mediana de tres corridas en `docs/benchmarks/run-<fecha>-<etiqueta>.json` y compara dos
  resultados (`--compare`). Los objetos de prueba van por variables de entorno, nunca en el repositorio. La corrida
  contra sistemas reales y la comparación con el MCP de SAP quedan pendientes de conexión (#90, #95).
- **`object_context`** (issue #87): la ficha de un objeto en una llamada, con salida estructurada: tipo, paquete,
  responsable, sistema original, bloqueo CTS y orden, tamaño de la fuente e includes, versiones recientes, usos,
  deriva frente a calidad/productivo (módulo transport-risk) y el último ATC recordado; `depth` 0–2. Sustituye la
  cadena `search_objects` → `get_source` → `edit_preflight` → `where_used` → `object_versions`. Lo que no se puede
  leer se dice en `skipped`, nunca se omite. Entra en el perfil `core`. El bloqueo CTS y la lectura de TADIR salen
  de `edit_preflight` a `core/preflight.ts` y las comparten las dos tools.
- **Auditoría de lecturas de datos (`data_read`)** (issue #89). Cada consulta de datos de negocio (`sql_query`,
  `table_contents`, `count_rows`) deja en `audit.jsonl` una entrada encadenada y firmada con tool, sistema, usuario
  SAP, tablas leídas, columnas enmascaradas, filas entregadas, si se alcanzó el tope y la huella sha256 de los
  argumentos; nunca los valores. Fail-closed: si no se puede anotar, el resultado no se entrega. `npm run audit:verify`
  resume lecturas, tablas distintas y filas. Es el prerrequisito del módulo de acceso elevado (Ola 2).
- **`create_object` crea tablas y estructuras de diccionario en S/4 (y NW ≥ 7.51)** con su fuente DDL de ADT
  (`object_type` TABL o STRU), con la misma vista previa, validación de SAP, orden y confirmación. En ECC 7.50 la
  colección no existe y la respuesta remite a `ddic_plan`. Sin verificar en vivo todavía.
- **`abap-adt-dozimple init`** (issue #88): crea o amplía `systems.json` (permisos 600), guarda la contraseña en el
  almacén de secretos del sistema operativo (la pide el propio almacén) y registra el servidor en Claude Code,
  Claude Desktop, Kiro, Cursor o VS Code sin tocar las demás entradas; `--dry-run`, `--force`, `--no-password`.
  Lo que falte se pregunta por teclado; sin terminal, dice qué opción falta. `--version` y `--help` en el binario.
- **`server.json`** para el MCP Registry (versión sincronizada con `package.json` por test); la publicación en el
  registro y en los directorios (Glama, sap-ai-mcp-servers) queda como tarea manual del issue #88.
- Plantilla de issue «Lo estoy usando» (`.github/ISSUE_TEMPLATE/uso.yml`) y sección «¿Lo usas?» en el README (EN y ES):
  país, release, cliente MCP y tipo de uso, sin identificar empresa ni sistemas. Enlace de seguridad al aviso privado.
- **`docs/PARIDAD.md`**: matriz de capacidades frente al MCP oficial de SAP (ADT 3.60) y a los servidores estudiados,
  con estado verificado/supuesto/pendiente por capacidad, huecos conocidos y el procedimiento de comparación. Se
  revisa en cada release y es compuerta de salida de la 2.0.0.

## [1.7.0] - 2026-10-18

Menos tokens por conversación: perfil de tools `core` con carga diferida, descripciones compactas y línea base de
medición. Además, `activate` con `main_program` para includes compartidos y dependencias al día.

### Añadido
- **Línea base de tokens y descripciones compactas** (issue #86). `scripts/measure-tokens.mjs [core|expert] [--json]`
  mide lo que el MCP publica al arrancar con la configuración real; las mediciones quedan en `docs/benchmarks/`.
  Las 18 descripciones que pasaban de 60 palabras se reescribieron (media de 52 a 46 palabras) y un test impide que
  vuelva a ocurrir. Medición del 18-10: `expert` 61 tools, 91,5 KB (≈22.900 tokens); `core` 14 tools, 21,5 KB
  (≈5.400 tokens). Lo que más pesa ahora son los esquemas de entrada (media 810 bytes; `ddic_plan` 6,3 KB por su
  especificación anidada), no las descripciones.
- **Perfil de tools `core` y carga diferida (`load_tools`).** Al arrancar se publican 14 tools de uso diario; las
  otras 47 quedan registradas pero apagadas y se cargan por grupo del catálogo (o `all`) con `load_tools`, que avisa
  al cliente con una sola notificación `tools/list_changed`. Medido con la configuración real: el catálogo inicial
  pasa de 93,4 KB (61 tools, ~23.300 tokens) a 22,0 KB (14 tools, ~5.500 tokens), −76 % en cada arranque y en cada
  compactación de contexto. `tools.profile: "expert"` o `ABAP_DZ_PROFILE=expert` recupera el
  comportamiento anterior. Las tools fuera del catálogo se publican siempre; el filtro `only`/`except` manda sobre
  el perfil. `sap_systems` y el arranque dicen qué perfil está activo.
- **`activate` con `main_program`** para un include que usan varios programas principales (SAP: «REPS … se utiliza en
  varios programas marco»). Con un solo programa principal se usa solo; con varios y sin `main_program`, la tool
  devuelve la lista para elegir en vez del error de SAP. Vale nombre o URI. Mismo criterio al activar tras
  `write_source` y `edit_source`.

### Corregido
- **Activación conjunta rechazada con «Verificación de condición fallida»** (412 o 400 con ese texto) en algún
  release aunque la misma lista se active en Eclipse: se repite una vez con referencias mínimas (uri y nombre), que es
  la forma que SAP acepta para un objeto. Pendiente de verificar en vivo.
- El reintento con los subobjetos inactivos del propio objeto ignoraba la lista si SAP incluía entradas sin objeto
  (ocurre al activar un grupo de funciones): ahora esas entradas no cuentan.
- `npm run build` deja `dist/index.js` ejecutable: una copia manual de `dist` sobre una instalación (caché de npx) dejaba
  el binario sin el bit de ejecución y el servidor no arrancaba («Permission denied»).

## [1.6.1] - 2026-10-06

Corrección de la deriva de versión en módulos de función y reutilización del ATC de un objeto sin cambios.

### Corregido
- **`edit_preflight` comparaba la cabecera de interfaz de los módulos de función** y los daba por «diferentes» en
  calidad y productivo aunque fueran iguales: ADT muestra la interfaz como sentencia `FUNCTION … TABLES … LIKE …` y el
  include del destino trae la generada por SE37 (`FUNCTION x.` + bloque `*"`). Ahora se compara solo el cuerpo.
  Verificado en vivo: una función transportada da «idéntica» en QA y PRD; un programa solo de DEV, «ausente».

## [1.6.0] - 2026-10-06

Editar un fragmento sin reenviar la fuente, cambiar un objeto de paquete, exposición selectiva de tools, deriva de versión
en `edit_preflight`, cuatro tools para la Mesa de Servicios (del mensaje al código), y diccionario y modelos OData en
ECC / NW 7.50 sin abrir ningún servicio de escritura en SAP.

### Añadido
- **`edit_preflight` compara la versión de DEV con calidad y productivo** (deriva de versión, el paso 2 del flujo de
  modificación): con el módulo dz-transport-risk y los `targets` del sistema en `systems.json` (o `compare_with`),
  dice por destino si la fuente es idéntica, distinta (con el diff destino → DEV y lo que el pase arrastraría o
  pisaría) o si el objeto no existe allí. Programas, includes y módulos de función; otros tipos se indican como no
  comparados. Sin verificar en vivo todavía.
- **Exposición selectiva de tools.** `"tools": { "only": [...], "except": [...] }` en `systems.json` y `ABAP_DZ_TOOLS`
  (lista por comas) en la configuración MCP de un proyecto; se nombran tools, grupos del catálogo o tipos de acceso. El
  entorno se cruza con la configuración, nunca la amplía; `sap_systems` se ve siempre; una errata se avisa al arrancar.
  Idea de `ABAPILOT_TOOLS` (ABAPilot).
- **Cuatro tools para la Mesa de Servicios**, ideas tomadas del catálogo de ABAPilot (Crimson Consulting, MIT):
  - **`diagnose_message`**: de un mensaje de pantalla (clase y número, o el texto tal como se copió) a sus textos,
    marcadores, su **texto largo** (la ayuda del mensaje: causa, respuesta del sistema, qué hacer, leída de DOKTL y
    convertida de ITF a texto) y los includes que lo emiten, por el índice de referencias cruzadas de SE91 (CROSS): el
    where-used de mensajes de ADT devuelve vacío en 7.50. Sin usos estáticos, lista los programas que declaran la
    clase (candidatos a emitirlo con número dinámico) o remite a `source_search`.
  - **`search_tables`**: tablas, estructuras y vistas por una palabra de su descripción o de su nombre.
  - **`foreign_keys`**: claves externas en las dos direcciones, campo a campo, con la condición de JOIN lista.
  - **`count_rows`**: recuento con condición y agrupación opcionales, sin traer datos y con la política de `sql_query`.

### Seguridad
- `proxy-addr` (transitiva de `@modelcontextprotocol/sdk` → `express`) actualizada a 2.0.8 por GHSA-jqcg-44mw-7w3h (crítica).
- CI y `npm run security` fallan a partir de **alto**; el único hallazgo moderado (`sprintf-js` vía `abap-adt-api`, sin
  corrección disponible, formato fijo, no alcanzable) queda documentado en `SECURITY.md` → «Hallazgos aceptados».

### Añadido
- **`edit_source`: cambiar un fragmento sin reenviar la fuente entera.** Cada edición es el texto exacto que hay hoy y
  el que lo sustituye; el servidor lee la fuente de SAP, aplica las sustituciones y sigue el mismo camino que
  `write_source` (sintaxis de SAP sobre la fuente resultante, diff, orden explícita, huella y bloqueo). No adivina: si
  el fragmento no aparece o aparece varias veces (sin `replace_all`), no hace nada y lo dice. Pensada para cambios
  pequeños en programas de miles de líneas, donde reproducir el objeto entero es lento y arriesga cambios no pedidos.
- **`change_package`: cambiar de paquete un objeto existente** y registrarlo en la orden indicada (el caso típico:
  sacar de `$TMP` algo que nació como prueba). Usa el refactoring de ADT («Change Package Assignment»); la vista previa
  incluye la validación de SAP sin cambiar nada, y tras ejecutar se comprueba el paquete que quedó en el catálogo de
  objetos. Si SAP registraría el cambio en otra orden (objeto bloqueado), no sigue. La ejecución real está sin probar
  en vivo: solo la vista previa.
- **`ddic_plan`: preparar objetos de diccionario donde ADT no los crea (ECC / NW 7.50).** Valida una especificación de
  dominios, elementos de datos, tablas, estructuras, tipos tabla y grupos/módulos de función —nuevos, o cambios sobre
  los existentes—, comprueba contra el sistema el paquete, la tarea, los nombres y todo lo que referencia, y devuelve el
  fichero de instrucciones que una persona ejecuta en SE38 con el programa generador (componente de DoZimple que no se
  incluye en este repositorio). Es de **solo lectura**: no abre ningún servicio de escritura en SAP.
- **`odata_model`: modelo OData V2 (EDMX) desde el diccionario**, para importarlo en un proyecto de SEGW en ECC / NW
  7.50: entity types, entity sets, asociaciones y navegación a partir de tablas, estructuras o vistas, con tipos,
  longitudes, claves y etiquetas reales (el mandante no se expone). Solo lee el diccionario. Crear el proyecto,
  importar, generar las clases y registrar el servicio siguen siendo pasos manuales, y la importación en SEGW **no está
  verificada**: es experimental.

### Corregido
- **Un módulo de función nuevo o sin activar ya se encuentra.** En NW 7.50 la búsqueda de SAP no devuelve un módulo
  recién creado, y `create_object` no guardaba su fuente inicial; `get_source`, `syntax_check` y `write_source`
  respondían «No existe FUNC». Ahora, si la búsqueda no lo trae, se localiza por el directorio de funciones y se dice.
- **Activar una clase que SAP devuelve inactiva junto a su include de método.** Cuando SAP no activa, no da ningún
  mensaje y devuelve como inactivos solo el propio objeto y sus subobjetos, se reintenta **una vez** con esa lista (lo
  que en Eclipse es elegirlos en el diálogo). No se reintenta si hay errores, objetos ajenos o borrados pendientes.
- **`remote_source` admite el nombre de un módulo de función**: lo traduce a su include (`L<grupo>Unn`) con el
  directorio de funciones de desarrollo, y lo indica en la respuesta. Antes respondía «No hay versión activa».

### Cambiado
- **`run_atc` reutiliza el resultado de un objeto sin cambios**: si hay un ATC del mismo objeto de menos de una hora,
  con la misma variante, una petición igual o más estrecha y la marca de cambio del objeto (`changedAt` de ADT) no
  varió, devuelve ese resultado y lo dice («resultado de hace N min, objeto sin cambios»); `refresh=true` fuerza la
  ejecución. Las órdenes de transporte nunca se reutilizan. Motivo: 786 ejecuciones en 14 días a 10 s de media,
  la mayoría repetidas sobre el mismo objeto sin haberlo tocado.
  Pendiente de comprobar en vivo que la marca cambia también con un guardado inactivo.

## [1.5.0] - 2026-10-04

Activar varios objetos juntos y, en sistemas con datos productivos, el usuario SAP de las personas sale enmascarado.

### Añadido
- **`activate` activa varios objetos a la vez.** Además de un objeto, admite `objects` (una lista) o `all_inactive`
  (todos los inactivos del usuario de la conexión, opcionalmente solo los de una `transport`), y los activa **juntos en
  una sola activación** de SAP: es lo que resuelve dependencias mutuas (clase ↔ interfaz, programa ↔ include) que,
  activadas una a una, fallan. Nunca activa borrados pendientes (activarlos borraría el objeto) y, si la lista cambió
  entre la vista previa y la confirmación, no activa nada. Idea de `ActivateMultiple` (vsp / sap-ai-dev-toolkit) y del
  ABAP Accelerator; implementación propia.

### Seguridad
- **El usuario SAP de una persona también se enmascara** en sistemas con datos productivos o enmascarados. Las columnas
  de quién creó, cambió o aprobó un documento (`ERNAM`, `AENAM`, `UNAME`, `USNAM`, `AS4USER`… y sus variantes con
  sufijo o prefijo, como `ERNAM_S`, `ANGE_USER` o `ZZ_ERNAM`) salían en claro en `sql_query` y `table_contents`; ahora
  salen como `‹oculto›` y, como el resto de columnas personales, no valen en WHERE, alias ni expresiones.

### Corregido
- `function_modules` rotulaba como «normal» los módulos de actualización: el tipo se lee ahora también de
  `TFDIR-UTASK` (V1, V1 sin reinicio, V2, colectiva).

## [1.4.0] - 2026-09-30

`create_object`: crear objetos ABAP nuevos en desarrollo, con vista previa, orden explícita y confirmación. Correcciones de la revisión de la 1.3.0 y dependencias actualizadas.

### Añadido
- **`create_object`: crear objetos ABAP nuevos en desarrollo** — programa, include, clase, interfaz, grupo de
  funciones, módulo de función, vista CDS y control de acceso CDS — con las garantías de `write_source`: vista
  previa, confirmación humana, registro de auditoría y solo en sistemas DEV con escritura. Recoge lo aprendido con
  abap-fs, el ABAP Accelerator de AWS y los huecos anotados: idioma maestro del sistema (no EN fijo), sin `$TMP` por
  defecto, orden obligatoria en paquetes transportables y prohibida en locales, validación previa de SAP, comprobación
  de que el tipo se puede crear por ADT en ese release (en NW 7.50 no se pueden crear paquetes ni tablas), relectura
  del objeto tras crearlo, fuente inicial comprobada con la sintaxis de SAP antes de guardarla y en un solo guardado,
  y aviso del flag RFC de los módulos de función, que va en SE37.

### Seguridad
- Dependencias transitivas del SDK de MCP actualizadas por avisos moderados: `ip-address` 10.7.2 y `fast-uri` 3.1.8.

### Corregido
- **`my_transports` ya no cuenta de menos sin avisar.** Cada consulta pide un registro más que su tope (500 órdenes
  propias, 2.000 tareas, 5.000 objetos); si llega, la respuesta dice «RESULTADO INCOMPLETO» y lo marca en
  `incomplete`. Visto en vivo: con `status: "all"`, un usuario con 2.063 órdenes superaba el tope y el total salía bajo.
- **`run_atc` ya no repite la corrida por hallazgos exentos.** La lista se pide siempre con los exentos y se filtra
  aquí, así que el recuento que decide si faltan P1/P2 es comparable con los totales de SAP; el aviso de recorte
  compara con lo que SAP devolvió, no con lo que se muestra.
- La sesión caducada se reconoce también con **400 «Session Timed Out»**, además de «Logon Error».
- Workflow de release: npm procesa cada versión antes de hacerla visible; la comprobación del dist-tag espera ahora
  hasta 10 minutos (con la 1.3.0 no bastaron 2, y hubo que repetir el paso).

## [1.3.0] - 2026-09-27

`my_transports`, ATC sin pérdida de hallazgos P1/P2 y renovación de sesión ante «Logon Error». Primera versión publicada desde la organización `dozimple-labs`.

### Añadido
- **`my_transports`: «¿qué órdenes tengo abiertas?»** Las órdenes de un usuario (por defecto el de la conexión): las
  suyas y aquellas en las que tiene una tarea, con tareas, estado, destino y objetos. Avisa de órdenes sin sistema
  destino y de tareas propias dentro de órdenes de otra persona. En sistemas con datos productivos, solo el usuario de
  la conexión y sin nombres ajenos. Idea del ABAP Accelerator de AWS (MIT-0), reimplementada.

### Cambiado
- El repositorio pasó a la organización `dozimple-labs`; `repository.url` actualizado (la procedencia de npm exige que coincida).

### Corregido
- **`run_atc` ya no pierde hallazgos P1/P2 por el tope de SAP.** SAP recorta con `maximumVerdicts` antes de ordenar
  por prioridad: con muchos hallazgos informativos, un P1 podía quedar fuera. Si los totales indican que faltan P1/P2,
  la corrida se repite pidiendo todos (hasta 5.000).
- La renovación automática de la sesión de lectura reconoce también el **400 «Logon Error»** que SAP puede devolver
  tras una hora sin uso, además de CSRF y 401.

## [1.2.0] - 2026-09-23

Cuatro tools para diagnóstico y soporte: dumps agrupados por periodo, búsqueda de texto en el código, estado de notas SAP y ampliaciones/BAdI. Todas verificadas en vivo en un NW 7.50.

### Añadido
- **`enhancements`: ampliaciones y BAdI.** Tres preguntas en una tool, por SQL de diccionario (7.50 y S/4):
  implementaciones de una BAdI, nuevas y clásicas, activas o no, con las propias (Z/Y) primero; ampliaciones de código
  implementadas dentro de un programa, clase o grupo de funciones, avisando de las que **sustituyen** código estándar
  (overwrite); y todas las implementaciones de un espacio de nombres por tipo, con el total real. Lo que cambia el
  comportamiento de un estándar sin tocar su código, que es lo primero a mirar en un incidente. Verificado en vivo en
  un 7.50: 1.070 implementaciones Z (566 de código, 501 de BAdI).
- **`sap_notes`: estado de notas SAP en el sistema, como en SNOTE**, sin portal ni S-user: si la nota está descargada,
  estado de implementación y de tratamiento, versión, componente y título (español si existe). Por notas concretas
  («¿está la 2198647 en PRD?») o filtrando por estado y/o prefijo de componente, con el total real. Distingue «no
  descargada» de «no implementada». Los códigos de estado no son valores fijos del diccionario: su significado sale de
  las constantes de SAP (`IF_SCWN_NA_CONSTANTS`), verificadas en un 7.50. En sistemas con datos productivos no se
  muestra quién trató la nota. Sustituto seguro del MCP de notas de SAP, que usa APIs privadas y el S-user.
- **`source_search`: buscar texto en el código de un paquete, una orden o una lista de objetos.** Texto literal o
  expresión regular (máx. 200 caracteres), sin distinguir mayúsculas; devuelve objeto, include, línea y la línea
  encontrada, con salida estructurada. Lee cada fuente (programas, clases con sus includes locales, interfaces,
  módulos e includes propios de los grupos de funciones, CDS) con 4 lecturas en paralelo, progreso y cancelación;
  exige un alcance, tiene tope de objetos (150 por defecto, ~0,8 s por objeto medido en 7.50) y lista aparte los
  objetos que no pudo leer. Existe porque ADT no tiene búsqueda de texto en NW 7.50 (`textsearch` da 404 y no está
  en el discovery), y llega donde `where_used` no: verificado en vivo, `where_used` no encontró ningún uso de una
  clase de excepción y `source_search` encontró 49 en 6 objetos del mismo paquete.
- **`dumps(group_by, days)`: los errores más frecuentes de un periodo.** Cuenta los dumps de los últimos N días (hasta
  90) agrupados por error, programa, error+programa, usuario o día, con primer y último caso, usuarios distintos
  afectados y dónde terminó el más reciente (include y línea); salida estructurada. Los grupos salen de la cabecera
  de ST22 (`SNAP_BEG.FLIST`, solo metadatos: `SNAP`, que guarda valores de variables, sigue vetada), porque el feed
  ADT solo trae los dumps más recientes: en un 7.50 real devolvió 5 con miles en ST22, y su parámetro `from` no
  amplía la ventana. En sistemas con datos productivos no se agrupa por usuario (columna personal); el número de
  usuarios afectados sí se da. Cierra el hueco anotado el 11-09.

### Corregido
- `package_contents` listaba objetos **borrados** que TADIR conserva con `DELFLAG = 'X'`; ahora no aparecen.

## [1.1.0] - 2026-09-22

Tool nueva y contrato MCP ampliado (salida estructurada, progreso, cancelación) más resiliencia de conexión: el sprint 1 y parte del 2 del plan de mejoras.

### Añadido
- **Progreso y cancelación** (sprint 2 del plan): las tools largas informan de su avance (`transport_diff` objeto a
  objeto; `run_atc`, `where_used` y `run_unit_tests` por fase) y el cliente lo recibe como notificaciones de progreso
  MCP si las pidió. La cancelación del cliente se respeta **entre pasos**: el paso en curso termina (una llamada ADT
  no se puede abortar) y el siguiente ya no empieza. Una petición cancelada termina como `CANCELLED`, un tipo propio
  que no cuenta como fallo del servidor ni abre el circuito.
- **Salida estructurada** (`outputSchema` / `structuredContent` de MCP), sprint 2 del plan: una tool puede declarar
  `output` y devolver los mismos datos del texto de forma tipada, para que el cliente no tenga que interpretar la
  prosa. El registro exige que toda respuesta no errónea de esas tools la traiga (si falta es error del servidor,
  no un éxito a medias) y el SDK la valida contra el esquema antes de responder. Primeras tools: `sql_query` (filas,
  columnas, valores hasta 500, `truncated`, avisos) y `syntax_check` (errores, avisos y mensajes con línea y
  severidad). `docs/TOOLS.md` documenta el esquema de salida de cada una.
- **`revert_source`: volver a una versión anterior con confirmación.** Tras un `write_source` cuya activación falló,
  el objeto queda con un borrador inactivo encima de la versión activa; la tool vuelve a escribir la versión elegida
  (`active`: la última activa; `previous`: la anterior a la activa; `N`: una del historial de `object_versions`)
  pasando por la misma vista previa, huella, bloqueo y orden que cualquier escritura. Nunca revierte por su cuenta:
  un rollback automático que pisara una versión sin preguntar sería peor que dejar el objeto inactivo.
- **Resiliencia de conexión** (sprint 1 del plan de mejoras):
  - **Sesión caducada renovada en las lecturas.** Si una tool de lectura recibe un token CSRF rechazado o un 401 en
    una sesión que ya había entrado, el servidor descarta el cliente, vuelve a entrar y repite la lectura una vez;
    la respuesta lo anota. Nunca en escrituras ni ejecuciones: el bloqueo se perdió con la sesión y un reintento
    podría escribir dos veces. Una contraseña rechazada sigue fallando a la primera y sigue olvidándose.
  - **Circuit breaker por sistema.** Tres fallos de red en un minuto abren el circuito de ESE sistema durante un
    minuto: toda tool responde al instante «no se vuelve a intentar durante N s» en vez de esperar 120 s por llamada.
    Los demás sistemas no se ven afectados; `sap_systems(check=true)` lo cierra y reintenta. Solo cuentan los fallos
    de red reales de la librería, no los tiempos agotados propios.
  - **Tiempo máximo por tool** (`timeoutMs`, por defecto 60 s; ATC y diff de orden 180 s, where-used y ABAP Unit
    120 s). Al vencer, error `NETWORK` con el tiempo y la sugerencia de acotar; no se reintenta.

### Cambiado
- Insignia de **OpenSSF Best Practices (Passing)** en el README: el proyecto cumple los 67 criterios del nivel
  Passing, incluidas las sugerencias, con la ficha pública en https://www.bestpractices.dev/projects/14759.
- El job de publicación usa Node 24, que ya trae npm >= 11.5.1: se quita la instalación global de npm, que no se
  puede fijar por hash. Un paso comprueba la versión y falla antes de publicar si no la cumple. El build sigue en
  Node 22, la versión mínima que soporta el servidor.

## [1.0.1] - 2026-09-22

Versión de mantenimiento: seguimiento de la auditoría de seguridad, procedimiento de commit y pruebas por propiedades.

### Añadido
- **Pruebas por propiedades de la entrada hostil** (`test/property.test.ts`, fast-check): 15 invariantes sobre el
  filtro de `table_contents`, el saneado de errores, el HTML de documentación y feeds, los nombres que acaban en una
  ruta ADT, `SAP_USER_RE` y la huella de los tokens de confirmación. En vez de comprobar casos conocidos, cada prueba
  afirma lo que la función garantiza para **cualquier** entrada y el generador busca el contraejemplo (miles por
  ejecución; `FC_RUNS=5000 npm test` para una pasada profunda). Validadas rompiendo el código a propósito: cada
  propiedad detecta la regresión que le toca.

### Cambiado
- La release de GitHub adjunta el bundle de la atestación también como `<paquete>.intoto.jsonl`, además de
  `.sigstore.json`. Es el mismo bundle in-toto con los dos nombres: uno es el que verifica `gh attestation verify` y el
  otro el que las herramientas de cadena de suministro reconocen como procedencia (OpenSSF Scorecard entre ellas).

### Seguridad
- El veto de datos sensibles incluye `ICF_PASSWD` (contraseña del usuario de inicio de sesión fijo de un servicio ICF)
  y las columnas genéricas `PASSWD` / `PASSWORD`, en cualquier tabla, también cuando llegan por un `SELECT *` (se
  comprueban las columnas del resultado y, si aparece una, no se muestra nada). Detectado al revisar la configuración
  ICF de un servicio.
- Seguimiento de la auditoría (prioridades 1 y 2 del auditor y DZ-30): **permisos de `systems.json` en Windows**
  comprobados por ACL y SID (antes no se comprobaba nada en esa plataforma), fail-closed si no se pueden leer;
  **registro de auditoría firmado con HMAC-SHA256** con clave en el llavero del SO (quitar firmas se detecta), y
  `audit:verify` comprueba cadena y firmas; el escáner falla si `package.json` declara scripts de instalación.
- **Auditoría de seguridad del 21-09-2026** (30 hallazgos, ninguno alto ni crítico): corregidos todos los accionables.
  Los más relevantes: la escritura ya no aplica un diff aprobado sobre un objeto que cambió en SAP después de la vista
  previa (huella comprobada bajo el bloqueo); filtro de `table_contents` por lista blanca; usuarios SAP validados en
  filtros de feeds; nombres validados en rutas ADT; `allowSelfSigned` solo en DEV y avisado al arrancar; sin
  redirecciones en el servicio de riesgo; errores saneados antes de llegar al modelo; contraseñas en memoria con
  caducidad; toda tool `exec` decide expresamente si pide confirmación; tope de filas también en `jobs` y
  `application_log`; columnas personales propias por cliente (`piiColumns`); registro de auditoría con bloqueo entre
  procesos y lectura de la cola; marcado neutralizado tras decodificar HTML; ids online de `docs_fetch` validados ya
  decodificados. Documentado lo que cada control garantiza y lo que no (token frente a elicitación, cadena de
  auditoría sin secreto, aviso de «dato» probabilístico). Tests de regresión en `test/audit-2026-09.test.ts`.
- **Procedimiento de seguridad en cada commit** ([docs/COMMIT_SECURITY.md](docs/COMMIT_SECURITY.md)): el `pre-commit`
  revisa el código completo y el contenido exacto preparado; un `pre-push` nuevo y el CI revisan todo el historial de
  todas las ramas. El escáner detecta además direcciones (IPs reales, hosts con puertos de SAP, dominios internos),
  más tipos de credenciales (Google, JWT, tokens de GitHub de grano fino, GitLab, cadenas de conexión, secretos
  asignados, URLs con contraseña, webhooks) y archivos peligrosos por su nombre (`.env`, certificados, claves SSH, el
  `systems.json` real). 21 tests adversariales.

### Corregido
- Workflow de release: la comprobación de `latest` fallaba porque npm tarda unos segundos en propagar la etiqueta
  (la 1.0.0 se publicó bien, pero la release de GitHub no se creó y se completó a mano con los artefactos firmados del
  mismo run). Ahora reintenta durante 2 minutos, no republica una versión existente y actualiza la release si ya
  existe: reintentar un run es seguro.

## [1.0.0] - 2026-09-21

Primera versión estable, publicada en npm como `@dozimple/abap-adt` con procedencia.

### Seguridad
- El escáner de datos sensibles detecta tokens de npm y cualquier `_authToken` (p. ej. un `npm login` que escribe en
  el `.npmrc` del proyecto).
- **Parámetros desconocidos rechazados**: una llamada con un parámetro que la tool no declara (p. ej. `transprot` mal
  escrito) falla con la lista de parámetros admitidos y no ejecuta nada; antes se descartaba en silencio.
- **Escrituras con confirmación humana obligatoria.** `write_source`, `activate`, `write_text_elements` y
  `create_transport` devuelven primero una vista previa (sintaxis real de SAP y diff) y solo escriben tras la
  confirmación: por elicitación MCP si el cliente la soporta, o con un token de un solo uso atado a tool, sistema y
  argumentos exactos (10 minutos). Anotación MCP `destructiveHint` en las tools de escritura.
- **Registro de auditoría encadenado por hash** (`audit.jsonl`) de toda escritura y ejecución: intención, resultado y
  denegaciones, con la huella sha256 del contenido y nunca el contenido. Fail-closed: sin registro no se escribe
  (probado con disco lleno y permiso denegado). Verificación con `npm run audit:verify`.
- **Clases de datos por sistema** (`test` / `masked` / `prod`): en sistemas con datos productivos, columnas personales
  enmascaradas, prohibición de usarlas en WHERE, alias o expresiones, y tope de filas (200 por defecto).
- **Veto de material sensible también a través de vistas y CDS**: resolución de tablas base por DD26S y
  DDLDEPENDENCY + fuente DDL, hasta 3 niveles, falla cerrado. Nuevos vetos: datos de personal (PA\*, PB\*, PCL1-5,
  HRPY_\*), USRACL, SNAP y OA2C_\*. Validado contra un S/4HANA 2023 real: bloquea la vista estándar
  `PUSER_ADDR_EMAIL` y la CDS `P_USER_ADDR`, que leen USR02 sin nombrarla.
- `table_contents`: el filtro ya no admite subconsultas, UNION, comentarios ni comillas sin cerrar.
- ABAP Unit solo ejecuta tests `RISK LEVEL HARMLESS` y `DURATION SHORT`, de forma explícita.
- Componente de documentación con entorno explícito mínimo; `docs_fetch` valida la forma de los ids y los ids online
  pasan el filtro de datos de cliente.
- `systems.json` se rechaza si otros usuarios pueden modificarlo; el sistema por defecto por variable de entorno se
  identifica en cada respuesta y, si no existe, es error.
- Toda respuesta con contenido de SAP se marca como dato, nunca instrucciones.
- Credenciales en Linux vía Secret Service (`secret-tool`); `set-password.sh --strict` (opt-in) en macOS.
- Cadena de suministro: `ignore-scripts`, `npm audit signatures` y SBOM CycloneDX en CI.
- Nuevo [modelo de amenazas](docs/THREAT_MODEL.md) (STRIDE y OWASP Top 10 para aplicaciones LLM) y política de
  divulgación coordinada a 90 días.

### Corregido
- **`run_atc(explain=N)` y `atc_quickfix(finding=N)` podían devolver el hallazgo de OTRO objeto**: el ATC se recordaba
  solo por sistema, así que pedir la documentación del hallazgo 1 de un objeto devolvía la del último objeto
  analizado, con apariencia correcta. Ahora se recuerda por sistema y objeto u orden; `explain` sobre un objeto aún
  no analizado ejecuta su ATC, y toda respuesta dice de qué objeto y de cuándo es el ATC. Test de regresión.
- Telemetría: un resultado negativo (sintaxis con errores, tests en rojo, activación rechazada) ya no cuenta como
  fallo del servidor; `usage_stats` lo muestra en su propia columna.
- Documentación de hallazgos ATC y correcciones de SAP: las entidades HTML se decodificaban con `&amp;` antes que el
  resto, así que un texto como `&amp;#39;` terminaba en `'` (doble desescape). Ahora hay un único limpiador de HTML
  (`core/feeds.ts`) que decodifica una sola vez y quita etiquetas hasta que no queda ninguna. Detectado por CodeQL.
- `edit_preflight`: el nombre del objeto se insertaba en la expresión regular que busca bloqueos del CTS escapando
  solo `/` y `$`; ahora se escapan todos los metacaracteres. Detectado por CodeQL.
- La comprobación de vistas y CDS bloqueaba CDS estándar legítimas como `I_USER`: los valores de sus anotaciones
  (`#CDS_MODELING_ASSOCIATION_TARGET`, 31 caracteres) se enviaban como nombres de vista a DD26S, cuyo campo es
  C(30). Detectado al probar contra un sistema real, no en fixtures; cubierto por test de regresión.

- NW 7.50 (validado en vivo en ECC 6.0 EHP8): `run_atc` sobre una orden hace una corrida única sobre sus objetos
  cuando el release no admite la orden como conjunto ATC; `edit_preflight` acota las órdenes candidatas a 10; el
  smoke test no aborta ante una llamada lenta.

### Añadido
- Workflow de release (`release.yml`): al crear un tag `vX.Y.Z`, tests, auditoría, escáner, paquete con atestación de
  procedencia (Sigstore) y SBOM; tras la aprobación manual del environment `release`, publicación en npm con
  procedencia por trusted publishing (OIDC, sin tokens guardados) y release de GitHub con paquete, atestación y SBOM.
- **`function_modules`**: módulos de función de un grupo (texto en el idioma de la conexión, tipo RFC / actualización),
  o el grupo y los hermanos de un módulo. Funciona con namespaces.
- **`run_atc` sobre implementaciones de ampliación** (`object_type: ENHO`, cualquier subtipo).
- **`close_gap`**: marca como resuelto un hueco anotado con `report_gap`, con una nota, sin borrarlo; `usage_stats`
  separa pendientes y cerrados.
- **Tipo de objeto resuelto cuando la coincidencia es única**: pedir `PROG` para un include o `TABL` para una
  estructura resuelve el objeto y la respuesta lo anota («se pidió PROG X; en el sistema es PROG/I»). Un grupo de
  funciones nunca se toma por un módulo: el error indica cómo listar sus módulos.
- **Avisos de la orden antes de escribir** (vista previa de `write_source` y `write_text_elements`, `edit_preflight`
  y tras `create_transport`): orden sin sistema destino (lo guardado no viajaría), orden o tarea de otra persona,
  orden no modificable.

### Cambiado
- Paquete npm `@dozimple/abap-adt` (antes `abap-adt-dozimple`, privado): solo `dist`, documentación, licencias,
  ejemplo de configuración y `set-password.sh`; la versión que anuncia el servidor sale de `package.json`.
- Licencia: Apache-2.0 (antes, todos los derechos reservados). El componente SAP de DoZimple Transport Risk sigue
  siendo propietario y no forma parte del repositorio.
- README principal en inglés, con versión en español en `README.es.md`.
