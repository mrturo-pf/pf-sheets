# Plan: `GET_CLP_RANGE` — lookup por lote para reducir llamadas HTTP concurrentes

> **Estado: EN PROGRESO.** El diagnóstico y diseño de más abajo ya están confirmados.
> La función de dominio en lote (`findRateValues`), el endpoint `doPost` del Web App, y
> el snippet cliente `GET_CLP_RANGE` **ya están implementados y con tests en verde** --
> ver "Progreso" más abajo. Lo que falta es exclusivamente el redeploy real + la
> migración de las celdas de "(05) Payroll", que requieren acceso a esas hojas concretas
> (fuera del alcance de este repo/sesión de código). Es la continuación de
> [`plan-get-clp-01-webapp.md`](plan-get-clp-01-webapp.md) (ese plan ya está
> completo y en producción) -- este documento cubre el problema de escala detectado
> después del lanzamiento.
>
> **`GET_CLP` NO se elimina ni se deprecia con este plan.** `GET_CLP_RANGE` es una
> fórmula nueva y adicional, pensada solo para el caso de muchas celdas recalculando
> juntas (como "(05) Payroll"). Ambas conviven indefinidamente: cualquier hoja/celda
> puede seguir usando `GET_CLP` para lookups individuales, incluso después de que
> `GET_CLP_RANGE` exista.

Plan de acción para la próxima sesión -- **implementación de código ya hecha**, falta
solo el redeploy + la migración real en las hojas consumidoras (fuera de este repo).

## Progreso (esta sesión)

- **`findRateValues(accessor, pairs, timeZone)`** agregada en `src/domain/index.js` --
  pura, reutiliza `findRateValue` por par (la ganancia real es amortizar el round-trip
  HTTP entre todos los pares, no cambiar el algoritmo de búsqueda -- ver "Piezas a
  diseñar" punto 2 más abajo, ya resuelto así). Un par malformado (`null`/`undefined`,
  o sin `code`/`date`) resuelve a `null` en su propia posición sin tirar abajo el resto
  del lote -- 6 tests nuevos, 100% cobertura.
- **`doPost(e)`** agregado en `src/interfaces/webapp.js` -- mismo query param `key` que
  `doGet` (el body JSON solo lleva los pares, ver "Piezas a diseñar" punto 1), valida
  tamaño de lote (`GET_CLP_RANGE_MAX_PAIRS = 500`, punto 5), cachea por par con el mismo
  esquema `code|date` que `doGet` (punto 4) antes de tocar el `RowAccessor`, y responde
  un array JSON con número o string de error por posición -- nunca falla el lote entero
  por un solo par (punto 3). No testeado directamente, mismo criterio ya establecido
  para `doGet` (smoke test en `tests/interfaces.test.js`).
- **Snippet cliente `GET_CLP_RANGE`** documentado en `docs/api.md` -- recibe dos rangos
  (fechas, códigos), arma el payload, hace `POST` con el mismo backoff/presupuesto de
  tiempo que ya usa `GET_CLP`, y devuelve un array 2D para que Sheets lo derrame en
  columna. No es código que este repo pushee (mismo criterio que el snippet de
  `GET_CLP`, ver Fase 4 de `plan-get-clp-01-webapp.md`).
- **86/86 tests en el repo** (80 + 6 nuevos), lint limpio, cobertura 100% líneas/statements/
  funciones y por encima del umbral en branches, en `domain/` e `infrastructure/`.
- **CI/CD:** sin cambios -- confirmado, `push-target.sh` ya corre `clasp deploy -i <id>`
  después de todo `clasp push` para el target `exchange-rates` (ver Fase 5 de
  `plan-get-clp-01-webapp.md`), así que el próximo merge a `main` despliega `doPost`
  automáticamente sin tocar el pipeline.
- **`src/interfaces/library.js`** (nuevo): `GET_CLP`/`GET_CLP_RANGE` públicas para
  consumo vía Apps Script Library (ver "Decisión de arquitectura tomada" más abajo).
  `GET_CLP_RANGE` ahora soporta rango O constante en `dates`/`codes` de forma
  independiente (pedido explícito, calza con el layout real de Payroll: columnas H/K son
  rangos reales aunque todas las celdas digan el mismo código).
- **`scripts/resolve-is-library.js`** (nuevo, +4 tests) y `scripts/push-target.sh`:
  cortan una versión nueva de Library (`clasp version`) después de cada push a un
  target marcado `"isLibrary": true` en `targets.json` (hoy solo `exchange-rates`).
- **91/91 tests en el repo**, lint limpio, cobertura sobre el umbral.

## Qué falta (requiere acceso a las hojas reales, fuera de esta sesión)

**Decisión de arquitectura tomada (Punto 2 -- distribución automática):**
`GET_CLP`/`GET_CLP_RANGE` ahora se distribuyen como una **Apps Script Library**
publicada desde el mismo proyecto `exchange-rates` (`src/interfaces/library.js`), en vez
de pegar el snippet completo a mano en cada consumidor. Se evaluaron 3 opciones (Library
/ este repo pasa a ser dueño del código completo de Payroll-MedicalRefund / solo detectar
desincronización) -- se eligió Library por ser la única que resuelve "actualización
automática" sin que este repo tenga que hacerse cargo de código ajeno que no puede ver
(un `clasp push --force` a los proyectos de Payroll/MedicalRefund borraría cualquier otra
macro que tengan y que este repo no ve). Detalle completo en `docs/api.md` (sección
"Consuming GET_CLP / GET_CLP_RANGE from another Apps Script project") y
`docs/getting-started.md`/`docs/ci.md`.

Con esto, el costo de mantenimiento futuro baja mucho: arreglar un bug o mejorar el retry
de `GET_CLP`/`GET_CLP_RANGE` ya no requiere volver a pegar código en cada consumidor --
solo bumpear el número de versión de la Library desde el editor de Apps Script (un
dropdown, no un paste). Lo que **sí** sigue siendo manual, una única vez por consumidor:

1. Agregar la Library al proyecto de Apps Script de Payroll/MedicalRefund (Editor →
   Libraries → pegar el script ID `1DMVavLk-uV8kSkdpLmvYCzk_7w5becIcwjOukVO09cpD8WNi2ECAK4m-`
   → elegir versión → identificador `ExchangeRates`).
2. Pegar el wrapper de 3 líneas por fórmula (`GET_CLP`/`GET_CLP_RANGE`, ver "Install" en
   `docs/api.md`) -- esto sí es inevitable sin importar la opción elegida: Apps Script
   exige que toda `@customfunction` sea top-level en el proyecto que la llama desde la
   celda, no puede vivir solo en la Library (confirmado en el spike de la Fase 1.5 del
   plan 01).
3. Confirmar el layout exacto de las 2 columnas en "(05) Payroll" antes de decidir si
   migran a `GET_CLP_RANGE(A1:A54, B1:B54)` -- **ya confirmado**: `G7:G60` usa
   `=iferror(GET_CLP($D?,H?),)` (rango `H7:H60`, todas "USD") y `J7:J60` usa
   `=iferror(GET_CLP($D?,K?),)` (rango `K7:K60`, todas "CLF") -- dos series
   independientes, ambas con rango real (no literal) en la columna de código. Migran
   directo a `=GET_CLP_RANGE($D$7:$D$60, $H$7:$H$60)` y
   `=GET_CLP_RANGE($D$7:$D$60, $K$7:$K$60)` respectivamente.
4. Migrar solo esas dos columnas de `GET_CLP` a `GET_CLP_RANGE` -- el resto de cualquier
   hoja sigue pudiendo usar `GET_CLP` sin cambios.
5. Validar en producción con el volumen real (108 celdas) que ya no aparece
   `"Unexpected response"` ni demoras de 30+ segundos.

## Problema real observado (no hipotético)

`GET_CLP` funciona bien en volumen chico, pero en **"(05) Payroll"** hay:

- 2 columnas × 54 filas = **108 celdas con `GET_CLP` que recalculan casi al mismo
  tiempo** cuando se recalcula la hoja completa.
- Crecimiento conocido: **+24 filas/año** (12 filas × 2 columnas), así que esto va a
  empeorar solo, no es un problema que se resuelva solo con el tiempo.
- Hasta con reintentos, **una celda aislada** (sin el resto de la ráfaga) puede tardar
  "más de 30 segundos" en resolver — esto ya no encaja del todo con "es solo
  congestión de red bajo ráfaga simultánea"; sugiere que el **volumen total de
  llamadas HTTP individuales** contra el mismo Web App/hoja central es parte del
  problema, no únicamente la simultaneidad exacta.

## Qué ya se investigó y quedó confirmado (evidencia real, no supuestos)

1. **El dominio (`normalizeDateKey`, `findRateValue`) es robusto** ante fechas
   malformadas — se corrió una simulación directa contra el código real con 4
   variantes de fecha (objeto `Date`, número crudo `46167`, ese mismo número como
   string, texto libre) y ninguna tira excepción sin capturar; en el peor caso
   devuelve `"Not found"` limpio. **No es la causa de nada de lo que sigue.**
2. **El deployment del Web App está sano y actualizado** — verificado vía la API de
   Apps Script (`projects.deployments.list`): `AKfycbw4QLt1lRwNAIltLr36L3Obmdgawm2FmhFB5BfAiY2iqi5OhGR6Bi1Xr5jJXqfc0YAk @2`
   coincide con el último commit desplegado.
3. **El log de Executions confirmó el patrón real**: filtrando por función `doGet` se
   vieron ~18 ejecuciones en un lapso de 3 segundos, **todas "Completed"** — nuestro
   código nunca falló del lado del servidor. El error que veía el usuario (HTML
   "Sorry, unable to open the file" de Google) se genera en la capa de
   redirect/entrega de Google (`script.google.com` → `script.googleusercontent.com`),
   no en `doGet`.
4. **Fase A (ya en producción, commit `b6830c0`)**: `GET_CLP` reintenta hasta 3 veces
   con backoff (300ms/600ms) cuando la respuesta no es reconocible. Redujo bastante
   los casos de HTML crudo, pero introdujo un problema nuevo:
5. **Fase B (ya en producción, commit `8cf4260`)**: el retry se volvió consciente del
   presupuesto de tiempo (máximo 25s acumulados) para nunca chocar contra el límite
   duro de 30s que Google impone a toda custom function — evita el mensaje feo
   "Exceeded maximum execution time", cae a un `throw new Error("Unexpected
   response")` propio, capturable por `IFERROR`.
6. **Estado actual**: funciona, pero con fricción — algunas celdas todavía tiran
   `"Unexpected response"` bajo la ráfaga completa de 108 celdas, y una celda aislada
   puede tardar 30+ segundos en resolver. Es tolerable hoy, pero no es una solución
   definitiva a medida que crece.

## Diagnóstico de fondo

El diseño actual hace **una llamada HTTP separada por celda**. Con 108 celdas
recalculando junto, eso son 108 invocaciones independientes de `doGet` compitiendo
por: la infraestructura de redirect de Google, cuota de lectura sobre la hoja central
(~30.000 filas), y el propio `CacheService`. Reintentar cada una por separado no
ataca la causa raíz — solo hace más resiliente a cada llamada individual, con
rendimientos decrecientes.

## Dirección propuesta: lookup por lote (`GET_CLP_RANGE`)

En vez de 108 llamadas HTTP, una única función custom que reciba **rangos** de
fechas/códigos y devuelva **todos los valores de una sola vez**, aprovechando que
Google Sheets permite que una custom function devuelva un array 2D que se "derrama"
en varias celdas.

Uso previsto en la hoja:
```
=GET_CLP_RANGE(A1:A54, B1:B54)
```
en vez de arrastrar `=GET_CLP(A1,B1)` 54 veces hacia abajo.

### Piezas de diseño (implementadas)

1. **Nuevo endpoint del Web App** (`doPost`, no `doGet`): un `GET` con 54+ pares
   fecha/código codificados en query params casi seguro pisa el límite de longitud
   de URL. **Implementado** con un body JSON con la lista de pares --
   `src/interfaces/webapp.js`.
2. **Nueva función de dominio** para resolver un lote de pares en una sola pasada
   sobre el `RowAccessor` (reusar `findRateValue` por par es aceptable para arrancar
   — la ganancia real viene de amortizar el round-trip HTTP y el overhead de
   invocación de `doGet`/`doPost` entre TODOS los pares, no de cambiar el algoritmo
   de búsqueda en sí). **Implementado**: `findRateValues` en `src/domain/index.js`.
3. **Manejo de errores por fila**: un `"Not found"` en una fila no puede tirar abajo
   el lote completo — cada posición del array de salida necesita poder ser
   número o mensaje de error de forma independiente. **Implementado** en `doPost`.
4. **Caché**: seguir cacheando por `code|date` individual (clave ya usada hoy) para
   que corridas parciales/repetidas sigan beneficiándose del `CacheService` existente.
   **Implementado**, mismo esquema de clave que `doGet`.
5. **Límite de tamaño de lote**: definir un máximo razonable de pares por request.
   **Implementado**: `GET_CLP_RANGE_MAX_PAIRS = 500`.
6. **¿Se mantiene `GET_CLP` de celda única?** Sí — no todos los consumidores
   necesitan lookup masivo (ver Fase 4 del plan original,
   `plan-get-clp-01-webapp.md`: el criterio ya establecido es no imponerle a un
   consumidor más máquina de la que necesita). `GET_CLP_RANGE` es un complemento,
   no un reemplazo.
7. **Testing**: la función de dominio que resuelve el lote debe vivir en `domain/`
   (pura, testeable, mismo estándar de cobertura ya exigido). El `doPost`/wrapper de
   Apps Script sigue el mismo criterio ya establecido para `doGet`/`index.js`: no
   testeado directamente, cubierto por smoke test mínimo. **Implementado**: 6 tests
   nuevos para `findRateValues`, smoke test actualizado para `doPost`.
8. **CI/CD**: sin cambios de infraestructura esperados — mismo pipeline, mismo
   `clasp push` + `clasp deploy -i <id>` ya en `push-target.sh`. **Confirmado sin
   cambios necesarios.**

### Qué NO se va a tocar

- `GET_CLP` de celda única sigue existiendo tal cual está hoy (con su retry
  time-budget-aware) — sigue siendo la opción correcta para consumidores con pocas
  celdas.
- El pipeline de CI/CD no necesita cambios de configuración, solo el código nuevo.

## Estado de los otros documentos consumidores

- **(05) Payroll**: 108 celdas hoy, +24/año — el caso que motiva este plan.
- **(12) MedicalRefund**: mismo `GetClp.js` desplegado, volumen de uso no relevado
  todavía — revisar antes de asumir que tiene el mismo problema de escala.

## Próximos pasos al retomar

Ver "Qué falta" al comienzo de este documento -- son los mismos 4 puntos, todos
condicionados a tener acceso directo a las hojas "(05) Payroll"/"(12) MedicalRefund",
no a más trabajo de código en este repo.
