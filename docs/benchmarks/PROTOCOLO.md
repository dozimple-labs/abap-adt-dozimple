# Protocolo de prueba comparativa

Cómo medir, con números y no con adjetivos, cuánto cuesta resolver tareas reales con este MCP frente a otras
herramientas (el MCP oficial de SAP en ADT, los servidores de la comunidad estudiados, o una versión anterior de
este mismo servidor). Es la línea base del issue #90 y la fuente de las cifras que se publican.

## Sistemas

Dos sistemas de desarrollo, descritos por release y nunca por cliente:

| Etiqueta | Sistema | Para qué |
| --- | --- | --- |
| `ecc` | ECC 6.0 EHP8, SAP_BASIS 7.50 | lo que el MCP de SAP no cubre |
| `s4` | S/4HANA on-premise, SAP_BASIS 758 | comparación directa con el MCP de SAP y la comunidad |

Los objetos, órdenes y mensajes concretos se pasan por variables de entorno (`BENCH_OBJECT`, `BENCH_TRANSPORT`,
`BENCH_MESSAGE`, `BENCH_PACKAGE`, `BENCH_TABLE`): nunca quedan en el repositorio.

## Tareas

Diez tareas que un consultor hace a diario. Cada una tiene una **secuencia mínima de llamadas** (lo que haría un
agente que conoce la herramienta) y un **resultado esperado** verificable.

| # | Tarea | Secuencia con este MCP | Resultado esperado |
| --- | --- | --- | --- |
| 1 | Localizar y explicar un objeto | `search_objects` → `get_source` (80 líneas) | nombre, tipo, paquete y primeras líneas |
| 2 | Contexto antes de tocar un objeto | `object_context` (depth 1); variante «cadena»: `edit_preflight` → `where_used` → `object_versions` | orden que tomaría el cambio, usos y versiones |
| 3 | Diagnosticar un mensaje de pantalla | `diagnose_message` | texto, ayuda larga y quién lo emite |
| 4 | Revisar una orden antes del pase | `transport_contents` → `transport_diff(summary_only)` | objetos y qué cambió |
| 5 | Cambiar una línea con confirmación | `edit_source` sin token (solo vista previa) | diff y sintaxis; no escribe |
| 6 | ATC de un objeto | `run_atc` | hallazgos numerados con P1/P2/P3 |
| 7 | Consultar datos con política | `count_rows` → `sql_query` (20 filas) | filas con política aplicada |
| 8 | Dumps recientes | `dumps(max=5)` | lista agrupada |
| 9 | Documentación del lenguaje | `docs_search` (local) | tres resultados |
| 10 | Mis órdenes abiertas | `my_transports` | órdenes con tareas y objetos |

La tarea 5 solo corre en sistemas con escritura habilitada; la 9 solo con el componente `docs`. Si una no aplica,
se anota como «no aplica», nunca como fallo.

## Métricas

Por tarea y corrida:

| Métrica | Cómo se mide | Por qué importa |
| --- | --- | --- |
| Tokens de respuesta | caracteres de todas las respuestas de tool ÷ 4 | es lo que paga cada conversación |
| Llamadas | número de llamadas a tools | cada vuelta cuesta tokens de contexto y tiempo |
| Tiempo | ms desde la primera llamada hasta la última respuesta | latencia que siente la persona |
| Resuelta al primer intento | el resultado esperado aparece sin repetir ni corregir | calidad, no solo coste |
| Tool equivocada | una llamada que no aporta al resultado | cuánto ayuda el catálogo a elegir |
| Errores visibles | respuestas con `isError` | lo que la persona tiene que leer y rodear |

Además, por servidor y perfil: **tokens del catálogo al arrancar** (`scripts/measure-tokens.mjs`), porque se pagan
en cada conversación antes de la primera tarea.

## Corridas

Tres corridas por tarea, herramienta y sistema, en el mismo día y con el mismo estado del sistema (sin cambiar
objetos entre corridas). Se publica la **mediana**. Una corrida con «Sin conexión» se repite, no se promedia.

Con este MCP, el harness `scripts/benchmark.mjs` ejecuta las diez tareas y escribe el JSON:

```sh
BENCH_OBJECT=ZXX_PROGRAMA BENCH_TRANSPORT=XXXK900123 BENCH_MESSAGE="ZXX:001" BENCH_TABLE=ZXX_TABLA \
  node scripts/benchmark.mjs MI_DEV --label s4-dozimple-1.8.0 --runs 3
```

Con otra herramienta (MCP de SAP, otro servidor), la misma persona hace la misma tarea en el mismo cliente, con la
secuencia mínima que esa herramienta permita, y anota las mismas métricas a mano en un JSON con la misma forma.

## Archivos

`docs/benchmarks/run-<AAAA-MM-DD>-<etiqueta>.json`, con esta forma:

```json
{
  "date": "2026-10-18",
  "label": "s4-dozimple-1.8.0",
  "server": { "name": "abap-adt-doZimple", "version": "1.8.0", "profile": "core", "catalogTokens": 5500 },
  "system": { "release": "758" },
  "runs": 3,
  "tasks": [
    { "id": 2, "name": "Contexto antes de tocar", "variant": "object_context", "calls": 1, "ms": 2300, "chars": 1800, "tokens": 450, "ok": true, "firstTry": true, "wrongTool": 0, "errors": 0 }
  ]
}
```

`scripts/benchmark.mjs --compare a.json b.json` imprime la tabla comparativa (tokens, llamadas, tiempo y aciertos por
tarea) para el CHANGELOG o un informe.

## Lo que no mide

- La calidad del razonamiento del modelo: aquí se mide el coste y el acierto de la **herramienta** con una secuencia
  fija, no lo que un agente decida hacer.
- Tokens exactos del proveedor: se aproximan por caracteres ÷ 4, igual que en `measure-tokens`. La comparación entre
  herramientas es válida porque la aproximación es la misma para todas.
