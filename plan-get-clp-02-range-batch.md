# Plan: `GET_CLP_RANGE` — lookup por lote para reducir llamadas HTTP concurrentes

> **Estado: PENDIENTE.** Diagnóstico y diseño documentados más abajo; implementación
> no iniciada todavía. Es la continuación de
> [`plan-get-clp-01-webapp.md`](plan-get-clp-01-webapp.md) (ese plan ya está
> completo y en producción) — este documento cubre el problema de escala detectado
> después del lanzamiento.

Plan de acción para la próxima sesión — **no implementar todavía**, solo dejar
registrado el diagnóstico y el rumbo propuesto para no perder contexto.

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

### Piezas a diseñar (pendiente, próxima sesión)

1. **Nuevo endpoint del Web App** (`doPost`, no `doGet`): un `GET` con 54+ pares
   fecha/código codificados en query params casi seguro pisa el límite de longitud
   de URL. Necesita un body JSON con la lista de pares.
2. **Nueva función de dominio** para resolver un lote de pares en una sola pasada
   sobre el `RowAccessor` (reusar `findRateValue` por par es aceptable para arrancar
   — la ganancia real viene de amortizar el round-trip HTTP y el overhead de
   invocación de `doGet`/`doPost` entre TODOS los pares, no de cambiar el algoritmo
   de búsqueda en sí).
3. **Manejo de errores por fila**: un `"Not found"` en una fila no puede tirar abajo
   el lote completo — cada posición del array de salida necesita poder ser
   número o mensaje de error de forma independiente.
4. **Caché**: seguir cacheando por `code|date` individual (clave ya usada hoy) para
   que corridas parciales/repetidas sigan beneficiándose del `CacheService` existente.
5. **Límite de tamaño de lote**: definir un máximo razonable de pares por request
   (a determinar según límites reales de tamaño de payload de Apps Script).
6. **¿Se mantiene `GET_CLP` de celda única?** Sí — no todos los consumidores
   necesitan lookup masivo (ver Fase 4 del plan original,
   `plan-get-clp-01-webapp.md`: el criterio ya establecido es no imponerle a un
   consumidor más máquina de la que necesita). `GET_CLP_RANGE` es un complemento,
   no un reemplazo.
7. **Testing**: la función de dominio que resuelve el lote debe vivir en `domain/`
   (pura, testeable, mismo estándar de cobertura ya exigido). El `doPost`/wrapper de
   Apps Script sigue el mismo criterio ya establecido para `doGet`/`index.js`: no
   testeado directamente, cubierto por smoke test mínimo.
8. **CI/CD**: sin cambios de infraestructura esperados — mismo pipeline, mismo
   `clasp push` + `clasp deploy -i <id>` ya en `push-target.sh`.

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

1. Confirmar el layout exacto de las 2 columnas en "(05) Payroll" (qué contiene cada
   una, si son realmente fecha+código por fila) para diseñar la firma de
   `GET_CLP_RANGE` con precisión.
2. Decidir el formato de payload del `doPost` (JSON array de `{date, code}`).
3. Implementar la función de dominio del lote + tests.
4. Implementar `doPost` en `interfaces/webapp.js`.
5. Implementar `GET_CLP_RANGE` en el snippet cliente (`docs/api.md` + push a
   Payroll/MedicalRefund vía `clasp`, mismo procedimiento pull-then-push ya usado).
6. Migrar manualmente la hoja de Payroll de `GET_CLP` por celda a `GET_CLP_RANGE`.
7. Validar en producción con el volumen real (108 celdas) que ya no aparece
   `"Unexpected response"` ni demoras de 30+ segundos.
