# Seguridad — abap-adt-doZimple

Criterio del proyecto: **nada que afecte la ciberseguridad** de los clientes ni de DoZimple. Un cambio que debilite
algo de este documento no se acepta aunque añada funcionalidad. Análisis completo (STRIDE, OWASP Top 10 para
aplicaciones LLM, riesgos residuales): **[docs/THREAT_MODEL.md](docs/THREAT_MODEL.md)**.

## Controles

| Activo | Amenaza | Control |
|---|---|---|
| Credenciales SAP | Filtrado en archivos, logs, respuestas o procesos hijo | Llavero de macOS o Secret Service en Linux (`execFile` sin shell); opción `--strict` para que el llavero pregunte en cada lectura; en memoria, caducan a los 15 min y se borran al cerrar; la configuración no admite contraseñas; nunca en logs ni respuestas; los procesos hijo reciben un entorno explícito mínimo (`PATH`, `HOME`, `TMPDIR`, idioma y terminal) |
| Sistemas SAP | Cambios no deseados por un agente | `read` / `exec` / `write` por tool; `write` solo en DEV con `allowWrite`; QAS y PRD nunca; tools de escritura ocultas si ningún sistema la permite; sin liberar, importar ni borrar |
| Escrituras | El agente escribe sin que la persona vea qué | **Confirmación obligatoria** con vista previa (sintaxis de SAP + diff real + avisos de la orden). Dos niveles de garantía, y no son equivalentes: **elicitación MCP** (fuerte: la pregunta la responde una persona en el cliente) si el cliente la soporta; si no, **token** de un solo uso atado a tool, sistema y argumentos exactos (10 min), que es una garantía **de aviso**: el servidor no puede distinguir si una persona vio la vista previa, por eso el cliente no debe autoaprobar estas tools (`destructiveHint`). `npm run audit:verify` cuenta cuántas escrituras se confirmaron de cada forma. Además, la huella de lo mostrado viaja con la confirmación y se comprueba **bajo el bloqueo** antes de escribir: si el objeto cambió en SAP tras la vista previa, no se escribe |
| Trazabilidad | Una escritura sin rastro, o un rastro retocado | **Registro de auditoría** local encadenado por hash y **firmado con HMAC-SHA256** (`audit.jsonl`): intención, resultado y denegaciones de toda escritura y ejecución, con usuario SAP, sistema, forma de confirmación y huella sha256 del contenido (nunca el contenido). La clave se genera al primer uso y vive en el llavero del SO (se guarda por stdin, nunca como argumento de un proceso); la fecha de creación va con ella, así que quitar firmas se detecta. Sin registro no se escribe; escrituras de varios servidores a la vez, serializadas con bloqueo. `npm run audit:verify` comprueba cadena y firmas. **Límite:** quien pueda leer tu llavero (tu propia sesión sin `--strict`) podría recalcularlo todo; para evidencia fuera de tu control, anota fuera del equipo el «último hash» que imprime `audit:verify`. Sin almacén de secretos (Windows), la cadena queda sin firma y se avisa |
| ABAP Unit | Un test con efectos (BD, llamadas externas) | Solo tests `RISK LEVEL HARMLESS` y `DURATION SHORT`, pedido explícitamente; solo en DEV |
| Orden de transporte | El cambio cae en una orden ajena | `decideTransport`: orden explícita; si hay bloqueo CTS de otra orden, se para sin escribir |
| Material de seguridad en SAP | Lectura de hashes, almacén seguro, PSE, secretos OAuth o dumps | Veto de USR02/USH02/USRPWDHISTORY, RSECTAB/RSECACTB, SSF_PSE_*, USRACL, SNAP, OA2C_* y columnas de hash, **también a través de vistas (DD26S) y CDS (DDLDEPENDENCY + fuente DDL), hasta 3 niveles** |
| Datos de personal | Infotipos y nómina | PA\*, PB\*, PCL1-5 y HRPY_\* vetados, también vía vistas y CDS |
| Datos personales de negocio | Exposición masiva a un proveedor LLM | Clase de datos por sistema (`test` / `masked` / `prod`; por defecto DEV = test, QAS/PRD = prod). En masked/prod: **columnas personales enmascaradas** (nombres, direcciones, teléfonos, correos, identificadores fiscales, cuentas bancarias, fechas de nacimiento, el usuario SAP de quien creó o cambió un documento, y las columnas propias de cada cliente declaradas en `piiColumns`), prohibido usarlas en WHERE, alias o expresiones, y **tope de filas** por sistema (200 en prod, configurable), también en `jobs` y `application_log`. El enmascarado es por nombre de columna: un campo Z no declarado sale en claro |
| Parámetros de las tools | Un parámetro mal escrito o inventado que se ignora en silencio (p. ej. la orden de transporte) | Esquemas estrictos: un parámetro no declarado es error y la tool no se ejecuta; el esquema publicado declara `additionalProperties: false` |
| SQL | Escritura, varias sentencias o inyección en filtros | Solo `SELECT`/`WITH`, sin `;`; vista previa de ADT de solo lectura; literales escapados; en `table_contents` el filtro se valida por **lista blanca** (columnas, operadores, literales, AND/OR/NOT, LIKE, IN, BETWEEN, IS NULL/INITIAL, paréntesis equilibrados); usuarios SAP en filtros de feeds validados por formato; nombres en rutas ADT validados (sin `..`) |
| Configuración | Alguien redirige el servidor, habilita la escritura o cambia el comando de un componente | `systems.json` se rechaza si lo pueden modificar otros: en macOS/Linux por permisos y propietario; **en Windows por sus ACL**, leídas por SID (independiente del idioma): solo tu usuario, SYSTEM, Administradores y TrustedInstaller pueden escribirlo. Si la comprobación no puede hacerse, no se arranca (salvo `ABAP_DZ_SKIP_ACL_CHECK=1`, avisado en cada arranque). El sistema por defecto por variable de entorno se identifica en cada respuesta, y si no existe es error |
| Red | Exposición de un puerto | Solo stdio; no se abre ningún puerto |
| TLS | Intercepción (MitM) | Verificación por defecto; `caFile` para certificados propios; `allowSelfSigned` **solo en DEV** (rechazado en QAS/PRD), marcado con ⚠ y avisado en cada arranque. El servicio de riesgo no sigue redirecciones: las credenciales Basic no viajan a otra URL |
| Datos de clientes | Salida a internet vía documentación | Online apagado por defecto; si se habilita, `assertPublicQuery` bloquea objetos Z/Y, namespaces, órdenes, sistemas, SID, usuarios, dominios y términos configurados; `docs_fetch` solo acepta ids con forma de documento, y los online pasan el mismo filtro |
| Inyección de instrucciones | Fuente, textos o datos de SAP o de la web que intentan dirigir al agente | Toda respuesta de SAP y de documentación se marca como dato, nunca instrucciones (control **probabilístico**: reduce, no elimina, que el modelo obedezca contenido hostil); el marcado que revive al decodificar HTML se neutraliza; la barrera efectiva es que ninguna escritura ocurre sin confirmación humana con vista previa. Los errores que llegan al modelo se sanean (sin credenciales en URLs, sin cabeceras, sin marcado, con longitud acotada) |
| Dependencias | Vulnerabilidades o código malicioso | 4 dependencias de producción con versión exacta y lockfile; `ignore-scripts` (sin scripts de instalación) en el desarrollo, y el paquete publicado **no declara ningún script de instalación** (el escáner falla si aparece uno: el `.npmrc` no protege a quien instala el paquete); `npm audit` y `npm audit signatures` (firmas y procedencia) en CI; SBOM CycloneDX como artefacto de cada build; acciones de CI fijadas por commit; Dependabot |
| Terceros | Un MCP externo con acceso a credenciales | Solo como proceso hijo aislado, tras revisión, con entorno mínimo; sus tools pasan por la política de este servidor |
| Estado local | Lectura por otros usuarios del equipo | Carpetas `700`, archivos `600`; el registro de uso no guarda argumentos |
| Repositorio | Credenciales, direcciones (IPs, hosts internos o de SAP) o datos de clientes en el código o en el historial | [Procedimiento en cada commit](docs/COMMIT_SECURITY.md): `pre-commit` revisa el código completo más lo preparado; `pre-push` y CI revisan todo el historial; `main` exige el CI; secret scanning con push protection. Los términos de clientes se leen de la configuración local, nunca se listan en el repo |

## Recomendaciones de despliegue

- **`scripts/set-password.sh --strict`** (macOS) en equipos compartidos y para las credenciales de productivo: el
  llavero pide confirmación en cada lectura. No es el valor por defecto a propósito: un aviso por lectura empuja a
  guardar la contraseña en variables de entorno, que es peor. La solución de fondo prevista es certificado de
  cliente / SSO ([roadmap](docs/THREAT_MODEL.md#roadmap-de-seguridad)).
- **No autoaprobar** en el cliente MCP las tools de escritura (`write_source`, `activate`, `write_text_elements`,
  `create_transport`): la confirmación del servidor es la segunda barrera, no la única.
- Un **usuario SAP personal** por consultor, con las autorizaciones de su rol. El servidor restringe; no amplía.
- Clasificar cada sistema con `dataClass` si su realidad no coincide con el rol (p. ej. un DEV con copia de productivo
  → `"dataClass": "prod"`).
- Revisar periódicamente `npm run audit:verify` y conservar `audit.jsonl` según la política de retención del equipo.

## Verificación

```sh
npm run security      # npm audit + firmas del registro + escáner de credenciales y datos de clientes
npm test              # incluye los tests de política y de seguridad (test/security.test.ts) y las
                      # pruebas por propiedades de la entrada hostil (test/property.test.ts, fast-check)
npm run audit:verify  # integridad del registro de auditoría local
npm run sbom          # SBOM CycloneDX de las dependencias de producción
```

## Reportar una vulnerabilidad / Reporting a vulnerability

**Español.** Escribe a **security@dozimple.cl** o usa la
[notificación privada de vulnerabilidades](../../security/advisories/new) de GitHub. Incluye versión o commit,
pasos para reproducir e impacto. Confirmamos la recepción en 5 días hábiles. Aplicamos **divulgación coordinada a
90 días**: publicamos la corrección y el aviso dentro de ese plazo, o antes si hay un parche; te pedimos no publicar
detalles hasta entonces. Con gusto te damos crédito en el aviso.

**English.** Email **security@dozimple.cl** or use GitHub
[private vulnerability reporting](../../security/advisories/new). Include version or commit, reproduction steps and
impact. We acknowledge within 5 business days and follow **90-day coordinated disclosure**: the fix and advisory are
published within that window (sooner if a patch is ready); please keep details private until then. We are happy to
credit you in the advisory.

Nunca envíes credenciales ni datos de clientes en un reporte. / Never include credentials or customer data in a report.
