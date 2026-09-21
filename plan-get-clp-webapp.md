# Plan: `GET_CLP(fecha, codigo)` — Web App + custom function

Análisis de factibilidad + plan de acción para exponer los datos de la pestaña `VALUES`
como una función custom reutilizable desde otros libros de Google Sheets, para no
perder el contexto entre sesiones.

## Contexto de datos

- **Spreadsheet central:** `1WLAE02oOJlDjLwQ4aS-ranKLNgV2bVuAt9L96m7-8DA` — confirmado:
  es la misma hoja que ya sincroniza `updateExchangeRates()` (target `exchange-rates`
  en `clasp-targets/`).
- **Pestaña:** `VALUES`.
- **Columnas (por posición, igual que usa `readExistingRows`):**
  - A (0): `id`
  - B (1): `code` (ej. `USD`, `EUR`, `CLF`, `UTM`, `IPC_CL`)
  - C (2): `date` (`YYYY-MM-DD` o `Date`)
  - D (3): `value_clp` (numérico)
  - E (4): `last_modified_at`
- **Volumen actual:** ~30.000 filas.
- **Consumidores:** N libros/hojas, todos pertenecientes a la misma cuenta de Google
  que ya es dueña del spreadsheet central. No hace falta consumo externo por HTTP fuera
  de Google Sheets (si eso surge, la vía correcta es `pf-rates` directamente).

## Objetivo

Exponer esos valores mediante una función custom `=GET_CLP(fecha, codigo)` invocable
desde N libros/hojas de Google Sheets.

## Veredicto

**Factible con Web App.** Se evaluaron dos arquitecturas (Web App y Apps Script
Library); Library quedó **descartada por un bloqueo real de plataforma**, no por
preferencia de diseño — ver más abajo. El diseño Web App ingenuo evaluado al inicio
tenía 4 problemas concretos que siguen requiriendo corrección.

## Problemas encontrados en el diseño inicial evaluado

| # | Problema | Detalle |
|---|---|---|
| 1 | Reintroduce el bug de OOM que ya arreglamos | El `doGet` propuesto escaneaba las ~30.000 filas de `VALUES` linealmente **en cada request**, llamando `Utilities.formatDate` fila por fila — el mismo patrón que causó el `Out of memory error` de `updateExchangeRates`. **Resuelto en Fase 1** con búsqueda binaria. |
| 2 | `SpreadsheetApp.getActiveSpreadsheet()` no funciona en un Web App | Depende de una sesión de UI activa; en un `doGet` disparado por HTTP típicamente devuelve `null`/error. Hay que usar `SpreadsheetApp.openById(ID_FIJO)`. |
| 3 | Hueco de seguridad | Config propuesta = "Ejecutar como: Me" + "Acceso: cualquier cuenta de Google", sin autenticación propia. Se resuelve con una clave compartida por query param (ver Fase 0/2), mismo patrón que `X-API-Key` en `pf-rates`. |
| 4 | Cero cacheo | Cada llamada re-escanea el sheet central completo. Se resuelve con `CacheService` (Fase 3), complementario a la búsqueda binaria. |

## Ventaja aprovechable: el sheet ya está ordenado

`computeUpsertPlan` (arreglado en esta misma sesión) siempre deja `VALUES` ordenada por
`date`, `code`, `last_modified_at` antes de escribir. Eso garantiza que la columna de
fecha está ordenada ascendente — permite **búsqueda binaria por fecha** (~15
comparaciones en vez de 30.000) + un barrido chico (≤5 códigos por fecha) para el match
exacto de código, en vez de un escaneo lineal completo. Esta parte es independiente del
mecanismo de transporte (Web App o Library) y ya está implementada (Fase 1, completada).

## Decisión de arquitectura: Web App (Library descartada — bloqueo de plataforma)

### Intento 1: Apps Script Library (descartado)

Se evaluó primero una Library, razonando que como todos los consumidores pertenecen a
la misma cuenta dueña del spreadsheet central, el problema típico de una Library
("el consumidor necesita acceso Viewer a la hoja central") no aplicaba. Esa parte del
razonamiento era correcta, pero **investigación posterior encontró un bloqueo distinto,
más fundamental**, documentado explícitamente por Google:

> **Spreadsheet**: Read-only (can use most `get*()` methods, but not `set*()`).
> **Cannot open other spreadsheets** (`SpreadsheetApp.openById()` or
> `SpreadsheetApp.openByUrl()`).
> — [Custom Functions in Google Sheets § Use Google Apps Script services](https://developers.google.com/apps-script/guides/sheets/functions#using_apps_script_services)

Esto no es un tema de permisos de cuenta — es una restricción de la sandbox de
ejecución de **toda** custom function, sin excepción. Y como una Library corre en el
**mismo proceso/ejecución** que la custom function que la invoca (no es una llamada
separada, es la misma pila de ejecución), la restricción se hereda: el código de
`GET_CLP` dentro de la Library no podría hacer `SpreadsheetApp.openById(CENTRAL_ID)`
para leer `VALUES`, sin importar que ese código viva en el proyecto central y no en el
consumidor, ni que dueño y consumidor sean la misma cuenta.

**Conclusión: Library queda descartada para este caso.**

### Intento 2 (elegido): Web App

Un `doGet` **no se ejecuta como custom function** — es una ejecución HTTP separada,
disparada por `UrlFetchApp.fetch(...)` desde el proyecto consumidor. `URL Fetch` está
confirmado como servicio permitido sin matices dentro de una custom function (a
diferencia de `SpreadsheetApp.openById()`). El código que realmente lee la hoja central
corre *fuera* de la sandbox restringida, dentro de la ejecución propia del deployment
del Web App, con permisos completos. Por eso el diseño original evaluado al inicio de
este documento elegía Web App — la forma era correcta, los 4 problemas de
implementación (tabla de arriba) sí eran reales y hay que corregirlos igual.

## Fases del plan

### Fase 0 — Config (completada)
- Nuevo Script Property `GET_CLP_API_KEY` configurado en el proyecto `exchange-rates`
  (clave compartida, nunca hardcodeada — ver `docs/getting-started.md`).
- Deployment de Web App creado a mano (Deploy → New deployment → Web app, "Execute as:
  Me", "Access: Anyone"). `clasp pull` reconcilió `src/appsscript.json` con el manifest
  real:
  ```json
  "webapp": { "executeAs": "USER_DEPLOYING", "access": "ANYONE_ANONYMOUS" }
  ```
  `ANYONE_ANONYMOUS` (no `ANYONE`) confirma lo que ya sabíamos por la Fase 1.5: una
  llamada `UrlFetchApp.fetch()` simple, sin headers de auth, no lleva sesión de Google
  — así que el Web App tiene que aceptar requests anónimos para que la custom function
  consumidora pueda golpearlo sin plumbing de OAuth adicional. El filtro real de acceso
  lo hace `GET_CLP_API_KEY` dentro de `doGet` (Fase 2), no este permiso.
  Deployment ID y URL documentados en `docs/getting-started.md` (no son secretos, pero
  tampoco los consume ninguna herramienta todavía — eso llega en la Fase 5).
- Deployment todavía sin código real detrás (`doGet` no existe hasta la Fase 2) — pegarle
  hoy devuelve el error genérico de Google "Script function not found: doGet", esperado.

### Fase 1 — `domain/` (completada)
- `findRateValue(accessor, code, dateKey, timeZone)`: búsqueda binaria por `dateKey`
  sobre un `RowAccessor` inyectable (no requiere cargar las 30.000 filas en memoria de
  una) + barrido acotado por código. Reutiliza `normalizeDateKey` /
  `applySheetCodeAlias` ya existentes.
- `findFirstRowIndexAtOrAfterDate` y `createArrayRowAccessor` como piezas de apoyo.
- 18 tests nuevos (66 en total en el archivo), 100% statements/lines/functions y 95.77%
  branches en `domain/index.js`, incluyendo un benchmark de regresión sobre ~30.000
  filas sintéticas (falla si esto vuelve a convertirse en un escaneo lineal).
- Esta capa es 100% independiente del transporte — sigue sirviendo igual con Web App.

### Fase 1.5 — Spike de validación (completada)
Tres hallazgos, todos con fuente oficial citada:
1. `=ExchangeRates.GET_CLP(...)` directo desde una celda vía Library no funciona —
   confirmado, pero ya sin relevancia al descartar Library.
2. `HEAD`/Development Mode de una Library no es apto para producción — confirmado,
   igualmente sin relevancia ya.
3. **Bloqueo real:** custom functions no pueden abrir otro spreadsheet
   (`SpreadsheetApp.openById()`/`openByUrl()` prohibidos), ni siquiera vía Library —
   esto es lo que definió la arquitectura final (Web App).

Límites de plataforma confirmados que siguen aplicando con Web App (indirectamente, vía
la custom function que llama a `UrlFetchApp.fetch`):
- Toda custom function debe devolver un resultado en **máximo 30 segundos** — la
  búsqueda binaria de la Fase 1 más el propio `doGet` deben responder muy por debajo de
  ese límite.
- `URL Fetch` confirmado sin restricciones dentro de una custom function — es el
  mecanismo que hace viable el Web App.

### Fase 2 — `interfaces/webapp.js` (completada)
- `doGet(e)`: valida `key` contra `GET_CLP_API_KEY` (nueva `getGetClpApiKey` en
  `infrastructure/`), valida `date`/`code`, usa `SpreadsheetApp.openById(ID)` (nunca
  `getActiveSpreadsheet()`), llama a `findRateValue` (Fase 1) con un `RowAccessor` real
  respaldado por lecturas de rango puntuales (nueva `createSheetRowAccessor` en
  `infrastructure/`), responde texto plano vía `ContentService`.
- Strings de respuesta en inglés (`"Unauthorized"`, `"Missing parameters"`,
  `"Not found"`), no en español como se había escrito inicialmente en este plan —
  corregido para respetar la política de idioma de `pf-sheets/AGENTS.md` (inglés sin
  excepción), consistente con el resto del código (`interfaces/index.js` ya usa
  mensajes en inglés).
- Separado de `index.js` por SRP, como estaba planeado. El comentario de cabecera de
  `index.js` se actualizó para dejar de decir que es "el único" archivo con acceso a
  globals de Apps Script — ahora son dos.
- No unit-testeado directamente (mismo criterio ya establecido para `index.js` en
  `jest.config.js`: `src/interfaces/**` queda fuera de `collectCoverageFrom` a
  propósito) — smoke test mínimo en `tests/interfaces.test.js` (verifica que `doGet`
  se exporta como función), validación real end-to-end pendiente contra el deployment
  ya creado (Fase 0).
- 73/73 tests en el repo, 100% statements/lines/functions y branches por encima del
  90% exigido en `domain/` e `infrastructure/`.

### Fase 3 — Cacheo (completada)
- `getCachedRateValue` / `cacheRateValue` en `infrastructure/`, sobre
  `CacheService.getScriptCache()`, TTL 21600s (6h, el máximo permitido).
- Clave `code|date` construida con el código/fecha ya normalizados (`applySheetCodeAlias`
  + `normalizeDateKey`) para que `"uf"`, `"UF"` y `"CLF"` compartan la misma entrada de
  caché.
- **Decisión deliberada: solo se cachean resultados positivos.** Un "Not found" nunca se
  cachea — es justo el caso con mayor probabilidad de cambiar pronto (un valor que
  todavía no sincronizó `updateExchangeRates()`), y cachear un negativo por hasta 6h
  podría esconder una sincronización recién hecha.
- `doGet` chequea el caché **antes** de abrir la hoja `VALUES` (aunque `openById` +
  `getSpreadsheetTimeZone()` siguen ejecutándose siempre — son lecturas de metadata
  baratas, no tocan datos; lo que se evita en un cache hit es el rango de lecturas caras
  de `createSheetRowAccessor`).
- 4 tests nuevos (77 en total), 100% statements/lines/functions, branches por encima
  del umbral en `domain/` e `infrastructure/`.

### Fase 4 — Cliente `GET_CLP` (completada)
- Snippet completo documentado en `docs/api.md`: función `@customfunction` que arma la
  URL, llama `UrlFetchApp.fetch`, parsea la respuesta (número o string de error).
- **Corrección respecto a la versión anterior de este plan:** el modelo multi-target
  (`clasp-targets/` + `targets.json`) NO aplica acá — existe específicamente para
  escalar `updateExchangeRates`/`onOpen` a N documentos que necesitan el mismo
  comportamiento de sync completo (ver `docs/development.md`, "Adding a new
  document/target"). Reusarlo para GET_CLP empujaría el macro completo (más un
  segundo `doGet` sin sentido) a cada hoja consumidora, que no necesita nada de eso.
  El snippet de GET_CLP no es código que este repo pushee a ningún lado — se pega a
  mano, una vez, en cada proyecto de Apps Script consumidor (docs/api.md tiene el
  runbook completo).
- La clave `GET_CLP_API_KEY` se guarda también como Script Property en el proyecto
  consumidor (no hardcodeada en el snippet), consistente con la regla de "sin secretos
  en el código" que ya sigue el resto del repo.
- Formateo de fecha con `SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone()`
  — a diferencia de `doGet`, una custom function sí tiene un spreadsheet activo válido
  (es la hoja consumidora, no la central), y usar SU propio timezone reconstruye
  correctamente "el día calendario que el usuario tipeó en la celda".

### Fase 5 — CI/CD (completada)
- `targets.json` ganó un campo opcional `webAppDeploymentId` por target (hoy solo
  `exchange-rates` lo tiene). Sin cambios al workflow YAML — toda la lógica nueva vive
  en `scripts/push-target.sh`, que ya era el punto único que la matrix del job `deploy`
  invoca por alias.
- Nuevo `scripts/resolve-webapp-deployment.js` (hermano de `resolve-target.js`, mismo
  patrón, deliberadamente sin compartir módulo con él — no vale la pena el riesgo de
  tocar un script ya confiado en CI por unas pocas líneas compartidas): devuelve el
  `webAppDeploymentId` del alias, o string vacío si no tiene uno configurado (no es un
  error — no todo target necesita un Web App).
- `push-target.sh`: después de `clasp push --force`, si el alias tiene
  `webAppDeploymentId`, corre `clasp deploy -i <id>` para que la URL pública sirva el
  código nuevo (`clasp push` por sí solo NO actualiza lo que responde un Web App ya
  desplegado — congela una versión en el momento del deploy).
- Mismo gate de aprobación manual (`production` environment) que ya existía — sin
  camino separado/más liviano para el redeploy del Web App.
- `AGENTS.md` actualizado: la línea "no versioned clasp deploy — YAGNI" ya no aplica.
- `docs/ci.md` con sección nueva "Web App redeploys (GET_CLP)".
- 80/80 tests (3 nuevos para `resolveWebAppDeploymentId`), lint limpio, sintaxis de
  shell verificada con `bash -n`.

### Fase 6 — Docs (completada)
- `pf-sheets/docs/api.md`: nueva sección "`GET_CLP(date, code)` (Web App custom
  function)" con contrato formal del endpoint (query params, tabla de respuestas
  posibles, ejemplo con `curl`), estilo espejado de `pf-rates/docs/api.md`
  (**Método Path** / **Authentication** / **Query params** / **Response** /
  **Errors**), más el runbook de instalación completo (Fase 4).
- `AGENTS.md`: ya actualizado en la Fase 5 (línea "no versioned clasp deploy — YAGNI"
  corregida ahí mismo, no separado, porque el cambio de CI y la doc son la misma
  unidad lógica).
- `docs/getting-started.md` y `docs/ci.md`: actualizados incrementalmente en las Fases
  0 y 5 respectivamente, no había nada pendiente adicional acá.
- Revisión de consistencia de punta a punta de este mismo documento (`plan-get-clp-webapp.md`)
  al cerrar la Fase 6 — sin contradicciones remanentes entre fases (el giro Library →
  Web App, la corrección de idioma, y la corrección de multi-target quedaron
  reflejados de forma consistente en todas las secciones que los mencionan).

## Verificación final

Criterios de aceptación:
1. `curl "[WEB_APP_URL]?date=2026-09-15&code=USD&key=.."` → valor numérico correcto.
2. `=GET_CLP(DATE(2026,9,15), "USD")` en una celda de una hoja consumidora → mismo
   valor, numérico.
3. Combinación inexistente (fecha futura o código inválido) → `"Not found"` limpio,
   sin romper la hoja.
4. Falta algún parámetro → `"Missing parameters"`.
5. `key` incorrecta o ausente → `"Unauthorized"`.

Nota de idioma: los strings de respuesta de `doGet` van en inglés, no en español —
`pf-sheets/AGENTS.md` fija política de idioma inglés para todo el código, sin
excepción aplicable acá (a diferencia del borrador inicial de este plan).

Más: benchmark de latencia contra las ~30.000 filas reales antes de dar por cerrado
(mismo enfoque que el benchmark del fix de OOM de `updateExchangeRates`, ya cubierto en
parte por el test de regresión de la Fase 1).
