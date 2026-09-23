# Plan: `GET_CLP_RANGE` — lookup por lote para reducir llamadas HTTP concurrentes

> **Estado: INCIDENTE RESUELTO Y VERIFICADO EN PRODUCCIÓN por el usuario en (05)
> Payroll.** Surgió un segundo incidente en (12) MedicalRefund por rangos abiertos
> (`$F$4:$F`) chocando contra el límite de tamaño de lote -- ver "Incidente 2: rangos
> abiertos en (12) MedicalRefund" más abajo para diagnóstico y fix (ya implementado,
> testeado, pendiente de deploy). Es la continuación de
> [`plan-get-clp-01-webapp.md`](plan-get-clp-01-webapp.md) (ese plan ya está
> completo y en producción) -- este documento cubre el problema de escala detectado
> después del lanzamiento.
>
> **`GET_CLP` NO se elimina ni se deprecia con este plan.** `GET_CLP_RANGE` es una
> fórmula nueva y adicional, pensada solo para el caso de muchas celdas recalculando
> juntas (como "(05) Payroll"). Ambas conviven indefinidamente: cualquier hoja/celda
> puede seguir usando `GET_CLP` para lookups individuales, incluso después de que
> `GET_CLP_RANGE` exista.

Plan de acción para la próxima sesión -- **implementación de código, deploy y
distribución vía Library ya hechos**; lo que falta es diagnosticar y arreglar el
incidente de `"Not found"` antes de poder migrar las 108 celdas reales.

##  Incidente abierto: `GET_CLP_RANGE` devuelve `"Not found"` en todas las celdas de Payroll

**Síntoma reportado por el usuario:** después de migrar las fórmulas de "(05) Payroll"
a `GET_CLP_RANGE($D$7:$D$60, $H$7:$H$60)` y `GET_CLP_RANGE($D$7:$D$60, $K$7:$K$60)`,
**ambas columnas muestran `"Not found"` en las 54 filas**, sin excepción -- no es un par
suelto fallando, es el 100% del lote.

**Lo que ya se descartó por revisión de código** (no por prueba en vivo -- ver
limitación más abajo):

- `findRateValue`/`findRateValues` (`src/domain/index.js`): 100% cubiertos por tests
  unitarios, sin cambios en esta sesión, mismo código que ya funciona hace tiempo para
  `GET_CLP` de celda única. Muy improbable que el bug esté acá.
- `doPost` (`src/interfaces/webapp.js`): revisado línea por línea contra el código real
  ya deployado (versión de Library 10, confirmada en "Progreso" abajo) -- la lógica de
  normalización, caché y batching se ve correcta y sigue el mismo patrón que `doGet`
  (que sí funciona en producción hace semanas).
- Autenticación: si la `key` no matcheara, la respuesta sería un objeto de error (no un
  array) y el wrapper de la Library tiraría una excepción en vez de mostrar texto en la
  celda. El síntoma observado es inconsistente con un problema de `GET_CLP_API_KEY`.
- Tamaño/formato de lote: un batch vacío o mal formado también responde con un objeto
  de error, no un array -- mismo argumento que el punto anterior, tampoco explica
  `"Not found"` celda por celda.

**Limitación real de este diagnóstico:** todo lo anterior es revisión de código + 91
tests unitarios que corren en Node/Jest con globals de Apps Script *simulados* --
`doPost`, y sobre todo **`GET_CLP_RANGE` del lado cliente en `src/interfaces/library.js`,
nunca se ejecutaron una sola vez en un runtime real de Apps Script/Sheets antes de este
incidente**. No se pudo acceder al log de Executions de Payroll ni de `exchange-rates`
para confirmar si `doPost` siquiera fue invocado: el token de `clasp` disponible en este
entorno no tiene el scope `script.processes` que exige la API de Apps Script para listar
ejecuciones (confirmado -- `403 ACCESS_TOKEN_SCOPE_INSUFFICIENT` al intentarlo), y
`clasp logs` requiere un proyecto de GCP vinculado que no está configurado ("GCP project
ID is not set"). Es decir: **no hay evidencia directa todavía de si el fallo es del
lado del cliente (Payroll) o del servidor (`exchange-rates`)**, solo descarte por
lectura de código.

**Hipótesis, ordenadas por probabilidad:**

1. **Argumentos de la fórmula en orden equivocado.** La firma es
   `GET_CLP_RANGE(dates, codes)` -- fechas primero, códigos después. Si en Payroll se
   escribió `GET_CLP_RANGE($H$7:$H$60, $D$7:$D$60)` (invertido) en vez de
   `GET_CLP_RANGE($D$7:$D$60, $H$7:$H$60)`, cada "fecha" enviada al servidor sería en
   realidad `"USD"`/`"CLF"` y cada "código" sería una fecha -- ningún par matchearía
   nunca, exactamente el patrón 100%-`"Not found"` observado. **Es la hipótesis más
   simple y más probable.**
2. **Bug real en `src/interfaces/library.js`'s `GET_CLP_RANGE`** (el código que arma
   `pairs` a partir de los argumentos rango/constante) -- nunca ejecutado en un runtime
   real de Apps Script hasta ahora; podría haber una diferencia de comportamiento entre
   cómo Node/Jest simula un rango 2D y cómo Sheets realmente lo entrega a una función
   de Library.
3. **La versión de la Library resuelta en tiempo de ejecución no es la 10** a pesar de
   que `appsscript.json` la declara -- poco probable, pero no confirmado en vivo.
4. **Los datos reales para esas fechas/códigos específicos no existen en `VALUES`** --
   muy improbable dado que las mismas celdas con `GET_CLP` (no `_RANGE`) funcionaban
   antes de la migración, para las mismas fechas.

**Diagnóstico pedido al usuario (bloqueante para seguir):**

1. Copiar/pegar la fórmula **exacta** que quedó en `G7` y en `J7` después de migrar
   (para descartar/confirmar la Hipótesis 1 directamente).
2. Probar en una celda suelta cualquiera, sin tocar Payroll: `=GET_CLP($D7, $H7)` (el
   `GET_CLP` de celda única, ya migrado a la Library) -- si **esto también** da
   `"Not found"` o error, el problema es de la Library/config, no específico de
   `GET_CLP_RANGE` (apunta a Hipótesis 2/3). Si funciona bien, el problema es
   específico del batch.
3. Si es posible, revisar Extensions → Apps Script → Executions (panel izquierdo) en
   el proyecto de Payroll y compartir la entrada más reciente de `GET_CLP_RANGE`
   (duración, éxito/error).

### Actualización: respuesta del usuario -- `GET_CLP` simple TAMBIÉN falla

El usuario confirmó: `=GET_CLP($D7, $H7)` (celda única, vía Library) **también**
devuelve `"Not found"`/error. Esto **descarta la Hipótesis 1** (orden de argumentos en
`GET_CLP_RANGE`) -- el problema no es específico del batch, es genérico a cualquier
llamada a través de la Library. Apunta directo a Hipótesis 2/3.

### Datos exactos reportados por el usuario (evidencia, no reconstrucción)

- **`G7`**: `=GET_CLP_RANGE($D$7:$D$60, $H$7:$H$60)` -- **todas** las celdas derramadas
  dicen `"Not found"`.
- **`J7`**: `=GET_CLP_RANGE($D$7:$D$60, $K$7:$K$60)` -- **todas** las celdas derramadas
  dicen `"Not found"`.
  - Ambas fórmulas usan el orden correcto de argumentos (`dates` primero, `codes`
    después) exactamente como está documentado en `docs/api.md` -- **la Hipótesis 1
    queda descartada del todo**, no por deducción sino por inspección directa de la
    fórmula real.
- **Prueba de reemplazo en `G7` con la fórmula de celda única**: `=GET_CLP(D7, H7)` -->
  produce **`Error: Not found (line 91)`** (mensaje de error de Apps Script, no el
  string `"Not found"` -- porque `GET_CLP` de celda única hace `throw new Error("Not
  found")` en vez de devolver el string, a diferencia de `GET_CLP_RANGE` que sí
  devuelve el string por posición).
  - **Este dato es clave**: el `(line 91)` del error apunta exactamente a la línea
    `throw new Error("Not found");` dentro de `GET_CLP` en `src/interfaces/library.js`
    (confirmado contra el archivo local -- coincide línea por línea). Eso significa que
    la ejecución **sí** llegó hasta ese punto del código real de la Library: la request
    HTTP se armó, salió, el Web App (`doGet`) respondió 200 con el texto literal
    `"Not found"`, y el cliente lo interpretó y tiró el throw correspondiente. **No es
    un fallo de red, de auth (eso sería `"Unauthorized"`, no `"Not found"`), ni de
    parseo de la respuesta** -- es un round-trip completo y "exitoso" en el sentido de
    que el protocolo funcionó de punta a punta, pero con datos incorrectos viajando en
    el medio. Esto es consistente con la Causa raíz de abajo (fecha corrupta enviada al
    servidor), no con un problema de conectividad/deploy/versión de Library.

**Causa raíz identificada por revisión de código (alta confianza, NO implementada
todavía -- el usuario pidió explícitamente no tocar código en esta sesión, solo
documentar):**

`grep "instanceof Date"` sobre `src/` da 3 resultados:

```
src/domain/index.js:74:      if (rawDate instanceof Date) {
src/interfaces/library.js:73:    date instanceof Date
src/interfaces/library.js:181:      rawDate instanceof Date ? Utilities.formatDate(rawDate, timeZone, "yyyy-MM-dd") : String(rawDate);
```

El de `domain/index.js` es seguro: `domain/` y `webapp.js` corren concatenados en el
**mismo** proyecto/realm (`exchange-rates`), nunca cruzan un límite de Library.

Los dos de `library.js` (uno en `GET_CLP`, otro dentro del loop de `GET_CLP_RANGE`) son
el problema: es un gotcha **documentado y conocido** de Apps Script Libraries -- cuando
un objeto `Date` se crea en el proyecto que LLAMA (Payroll) y se pasa como argumento a
una función de una Library (`RatesUpdater`), `instanceof Date` dentro de la Library
**puede evaluar `false`**, porque cada proyecto de Apps Script corre en su propio
"realm" de V8 con su propio constructor `Date` interno -- análogo al problema clásico de
`instanceof Array` entre iframes distintos en un browser.

Si eso pasa, la rama `date instanceof Date` cae a `String(date)` en vez de
`Utilities.formatDate(date, timeZone, "yyyy-MM-dd")` -- `String(unObjetoDate)` produce
algo tipo `"Mon Jan 15 2024 00:00:00 GMT-0300 (Chile Summer Time)"`, no
`"2024-01-15"`. Ese string nunca va a matchear ninguna fecha real en `VALUES`, así que
**el 100% de los lookups fallan con `"Not found"`**, exactamente el síntoma reportado --
y explica por qué pasa igual con `GET_CLP` simple y con `GET_CLP_RANGE`: ambos comparten
el mismo patrón roto.

**Fix propuesto (NO implementado -- solo diagnóstico, a hacer en la próxima sesión):**
reemplazar `date instanceof Date` / `rawDate instanceof Date` en `library.js` (las dos
ocurrencias, líneas 73 y 181) por un chequeo que sea seguro entre realms, por ejemplo:

```javascript
function isDateValue_(value) {
  return Object.prototype.toString.call(value) === "[object Date]";
}
```

(`Object.prototype.toString.call(...)` inspecciona el tag interno `[[Class]]` del
objeto, no la cadena de prototipos -- por eso sí funciona de forma consistente cruzando
el límite de una Library, a diferencia de `instanceof`.)

**Plan para la próxima sesión (1-2 ejecutados esta sesión, 3-5 pendientes de luz
verde del usuario para commitear/pushear y del paso manual en Payroll/MedicalRefund):**

1. ~~Aplicar el fix de `isDateValue_` en `src/interfaces/library.js` (2 lugares).~~ --
   **hecho** esta sesión. `isDateValue_` reemplaza las dos ocurrencias de
   `instanceof Date` (líneas originales 73 y 181) usando
   `Object.prototype.toString.call(value) === "[object Date]"`. El
   `rawDate instanceof Date` de `src/domain/index.js` (línea 74) **no** se tocó a
   propósito -- `domain/` y `webapp.js` corren en el mismo realm que `doGet`/`doPost`
   (proyecto `exchange-rates`), nunca cruzan el límite de una Library, así que ese
   `instanceof` es seguro tal cual está.
2. ~~Agregar un test de regresión real para este bug exacto~~ -- **hecho**,
   `tests/library.test.js` (nuevo archivo, 3 tests): usa `vm.runInNewContext` de
   Node para construir un `Date` de un realm distinto dentro del mismo test --
   reproduce fielmente el problema real entre proyecto llamador y Library, prueba
   primero que `instanceof Date` efectivamente falla ahí (documenta el bug que se
   está arreglando), y después que `isDateValue_` sí lo reconoce. `isDateValue_` se
   agregó al `module.exports` de `library.js` (sigue con el sufijo `_` -- Apps Script
   la mantiene privada/no expuesta a consumidores de la Library igual que antes,
   el export solo habilita el test en Jest). **94/94 tests, lint limpio, cobertura
   sin bajar** (`make check`, corrido y verificado esta sesión).
3. Commitear, pushear, esperar el deploy (con Approval Gate) -- esto corta una nueva
   versión de Library automáticamente (ver `docs/ci.md`). **Pendiente -- requiere
   instrucción explícita del usuario, no se hace autónomamente** (ver `AGENTS.md` raíz
   y de `pf-sheets`: ningún agente commitea/pushea sin luz verde expresa).
4. **Repuntar la versión de la Library en Payroll y MedicalRefund**: la versión 10 ya
   pinneada en ambos `appsscript.json` quedaría con el bug -- hay que actualizar el
   número de versión ahí (Apps Script editor → Libraries → cambiar versión) a la nueva
   versión que incluya el fix. Esto es un paso manual aparte, igual que agregar la
   Library la primera vez.
5. Recién ahí volver a probar `=GET_CLP($D7, $H7)` y `=GET_CLP_RANGE(...)` en Payroll.

## `describeMissingRate`: UX de `"Not found"` en `GET_CLP_RANGE`

Después de verificar en producción que el fix de `isDateValue_` resolvió el incidente
(el usuario confirmó valores reales en Payroll), surgió una pregunta legítima de UX,
no un bug nuevo: **`IFERROR` no sirve para controlar `"Not found"` por celda en
`GET_CLP_RANGE`**, a diferencia de `GET_CLP`.

**Por qué no aplica `IFERROR` en `GET_CLP_RANGE`:** `GET_CLP` lanza (`throw`) un error
real por celda porque cada `=GET_CLP(...)` es su propia invocación independiente de
custom function -- eso es justo lo que permite que `IFERROR` la intercepte. Pero
`GET_CLP_RANGE` sirve TODO el rango con una única invocación que devuelve un único
array -- si esa invocación tirara una excepción por una sola fila faltante, la
plataforma vaciaría TODAS las celdas del rango, no solo la que falta (confirmado en el
spike de la Fase 1.5 de `plan-get-clp-01-webapp.md`). Por eso `doPost`/`GET_CLP_RANGE`
deliberadamente nunca tiran por fila -- devuelven un string plano en esa posición (ver
"Piezas de diseño", punto 3, más abajo). Un string plano **no es un valor de error**
para Sheets, así que `IFERROR` no hace nada con él: no hay ningún error por celda
adentro del array que atrapar -- envolver toda la llamada `GET_CLP_RANGE(...)` en
`IFERROR` solo protege contra una falla a nivel de **lote completo** (key inválida,
body mal formado), nunca contra el `"Not found"` de una fila puntual. Sí, confirmado:
el `"Not found"` aparece solo en la celda específica del par que falló (nunca tira
abajo el resto del lote -- eso ya estaba así diseñado desde el principio, ver "Piezas de
diseño" punto 3), pero al ser texto plano y no un error real, no hay forma de
capturarlo con `IFERROR` a nivel de esa celda individual.

**Fix aplicado (pedido explícito del usuario):** en vez de devolver siempre
`"Not found"`, `doPost` ahora decide entre dos strings comparando la fecha del par
contra "hoy" en el timezone del spreadsheet central:

- **Fecha futura, sin match:** `""` (celda vacía) -- todavía no existe ese tipo de
  cambio para publicar, no es un problema de datos que valga la pena mostrar.
- **Fecha presente/pasada, sin match:** `"Not found"` -- un gap real en `VALUES`, sí
  vale la pena mostrarlo.

Implementado como `describeMissingRate(dateKey, todayKey)` en `src/domain/index.js`
(pura, comparando los dos "YYYY-MM-DD" como strings -- ordenan lexicográficamente
igual que cronológicamente, sin necesidad de volver a parsear a `Date`), con `today`
calculado una vez en `doPost` vía `normalizeDateKey(new Date(), timeZone)` -- seguro
porque `webapp.js` y `domain/` corren en el mismo realm (`exchange-rates`), nunca
cruzan el límite de la Library, a diferencia del bug de `isDateValue_` de más arriba.
La rama de `doPost` donde falta la hoja `VALUES` por completo (fallo de
infraestructura, no de datos) se dejó sin tocar -- sigue devolviendo `"Not found"`
para todo el lote sin importar la fecha, a propósito: es un error real del sistema,
no un "todavía no hay dato para esa fecha futura".

`GET_CLP` (celda única) **no se tocó** -- sigue lanzando `Error: Not found` igual que
siempre, el usuario confirmó explícitamente que ese comportamiento ya funciona bien
con `IFERROR` y no quiere cambiarlo.

Si un consumidor quiere ADEMáS ocultar visualmente el `"Not found"` de
`GET_CLP_RANGE` (además de ya tener las fechas futuras en blanco), tiene que ser una
fórmula/columna separada con `IF` comparando el texto literal (no `IFERROR`, no hay
error que atrapar) -- documentado con el ejemplo exacto en `docs/api.md`, sección
"'Not found' vs. blank".

**Tests:** 3 casos nuevos para `describeMissingRate` en `tests/domain.test.js`
(futuro, hoy/presente, pasado) -- 97/97 tests en el repo, lint limpio, cobertura
100% líneas/statements/funciones sin bajar.

## Incidente 2: rangos abiertos en (12) MedicalRefund (`$F$4:$F, $T$4:$T`)

El usuario confirmó que (05) Payroll funciona 100% bien, pero (12) MedicalRefund usa
`=GET_CLP_RANGE($F$4:$F, $T$4:$T)` -- **rangos sin acotar** (columna completa hasta el
final de la hoja), a diferencia de Payroll (`$D$7:$D$60`, acotado). La pestaña tiene un
total de 1000 filas.

**Causa raíz, confirmada por inspección de código (alta confianza):** un rango abierto
como `$F$4:$F` envía a Sheets **una fila por cada fila real de la hoja**, sin importar
cuántas tengan datos -- eso son ~997 pares (filas 4 a 1000). `GET_CLP_RANGE_MAX_PAIRS`
estaba fijado en 500 como límite **sobre el largo crudo del array `pairs`**, sin
distinguir filas con datos reales de filas vacías. Como 997 > 500, `doPost` rechazaba
**el lote entero** con `{"error": "Batch too large (max 500 pairs)"}` -- eso se
propaga como un único error en la celda ancla de la fórmula, y no se resolvía **nada**,
ni siquiera las filas con datos reales.

**Fix aplicado:**

- **`classifyRangePair(rawCode, rawDate)`** nueva función pura en
  `src/domain/index.js`: clasifica cada par ANTES de normalizar/buscar en tres estados
  -- `"blank"` (ambos vacíos -- fila de relleno de un rango abierto, no es un error),
  `"malformed"` (exactamente uno de los dos vacío -- un error de datos real, alguien
  puso fecha sin código o viceversa), o el par en sí (ambos presentes, listo para
  `normalizeDateKey`/`applySheetCodeAlias`).
- **`GET_CLP_RANGE_MAX_PAIRS` (500) ahora aplica solo a pares REALES** (ambos
  presentes) -- las filas de relleno de un rango abierto ya no cuentan contra el
  límite ni tocan la hoja `VALUES` para nada, resuelven directo a `""`.
- **Nuevo `GET_CLP_RANGE_MAX_REQUEST_PAIRS = 5000`**, un techo separado y mucho más
  generoso sobre el tamaño crudo del array recibido (reales + blancos + malformados) --
  protege contra payloads absurdamente grandes sin chocar con el uso legítimo de
  rangos abiertos.
- `doPost` actualizado: la fila `"blank"` resuelve a `""`, la fila `"malformed"`
  resuelve a `"Missing parameters"` (se preserva para el caso real de error).
- Documentado en `docs/api.md`: sección nueva "Blank rows in an open-ended range", más
  ajustes en la sección de límites de tamaño y en la lista de valores de respuesta.

**Resultado esperado en MedicalRefund:** el mismo `=GET_CLP_RANGE($F$4:$F, $T$4:$T)`
sin modificar debería ahora resolver las filas con datos reales normalmente, mostrar
`""` en las ~850 filas de relleno (en vez de fallar el lote entero), y `"Missing
parameters"` solo si una fila real tiene fecha sin código o viceversa -- sin que el
usuario tenga que acotar el rango ni actualizar la fórmula a mano cuando la hoja
crezca.

**Tests:** 3 casos nuevos para `classifyRangePair` en `tests/domain.test.js` (blanco,
malformado en ambas direcciones, válido) -- 100/100 tests en el repo, lint limpio,
cobertura 100% líneas/statements/funciones sin bajar.

**Pendiente:** luz verde del usuario para commitear/pushear, y que confirme en
MedicalRefund que las filas reales resuelven bien y las de relleno quedan en blanco.

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
- **Library instalada y verificada en los dos proyectos consumidores reales** (no solo
  documentado -- confirmado por acceso directo con `clasp`):
  - **Payroll** (`1LPEm_bR_l3DsYwQGofLU_zgGz6GyA-Ozp7lMVhD2ILJ3VNALMBlub8Wf`) y
    **MedicalRefund** (`1N22pIcRE3JVVaHZy6Bqcr1xhafxhwjscuSXAOPz-faKIMri2BVmtpQtZ`)
    tenían ya agregada la Library como `RatesUpdater`, versión 10, en su
    `appsscript.json` (paso hecho por el usuario).
  - Confirmado que la versión 10 de la Library **sí** incluye `GET_CLP_RANGE`
    (`npx clasp versions` en `exchange-rates` listó 10 versiones; la 9 y 10
    corresponden al deploy que ya incluía `src/interfaces/library.js`).
  - `GetClp.js` en ambos proyectos tenía el snippet viejo completo (retry/parsing a
    mano) -- se reemplazó por el wrapper de 3 líneas por fórmula que delega a
    `RatesUpdater.GET_CLP(...)`/`RatesUpdater.GET_CLP_RANGE(...)`.
  - Antes de tocar nada se hizo `clasp pull` de solo lectura en ambos proyectos para
    ver el 100% del contenido real (`Code.js` son stubs vacíos en los dos -- cero
    riesgo de pisar otra macro). Después del `clasp push --force`, se volvió a
    pullear a una carpeta separada y se comparó byte a byte (`diff`): `appsscript.json`
    y `Code.js` quedaron idénticos, `GetClp.js` coincide exacto con lo que se pusheó.

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

1. ~~Agregar la Library al proyecto de Apps Script de Payroll/MedicalRefund~~ --
   **hecho** en ambos (identificador elegido: `RatesUpdater`, versión 10).
2. ~~Pegar el wrapper de 3 líneas por fórmula~~ -- **hecho** en ambos (`GetClp.js`
   reemplazado y verificado byte a byte, ver "Progreso" arriba).
3. Confirmar el layout exacto de las 2 columnas en "(05) Payroll" -- **ya confirmado**:
   `G7:G60` usa `=iferror(GET_CLP($D?,H?),)` (rango `H7:H60`, todas "USD") y `J7:J60`
   usa `=iferror(GET_CLP($D?,K?),)` (rango `K7:K60`, todas "CLF") -- dos series
   independientes, ambas con rango real (no literal) en la columna de código.
4. **Migración de las fórmulas: EN CURSO, BLOQUEADA por el incidente de arriba.** El
   usuario ya migró al menos una de las columnas a `GET_CLP_RANGE($D$7:$D$60, ...)` y
   ambas devuelven `"Not found"` en las 54 filas -- ver " Incidente abierto" al
   comienzo de este documento para el diagnóstico pedido antes de seguir.
5. Validar en producción con el volumen real (108 celdas) que ya no aparece
   `"Unexpected response"` ni demoras de 30+ segundos -- **bloqueado** hasta resolver
   el punto 4.

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

1. ~~Responder el "Diagnóstico pedido al usuario"~~ -- **hecho**, causa raíz confirmada
   (Hipótesis 2: `instanceof Date` cruzando el límite de la Library).
2. ~~Confirmar cuál de las 4 hipótesis es la real y corregir~~ -- **hecho**, fix
   aplicado en `src/interfaces/library.js` (`isDateValue_`) + test de regresión en
   `tests/library.test.js`.
3. ~~Commitear, pushear, deploy~~ -- **hecho**, commit `d237796`, pipeline verde de
   punta a punta, Library versión 12 cortada.
4. ~~Repuntar versión en Payroll/MedicalRefund~~ -- **hecho**, usuario confirmó que
   ambas fórmulas (`GET_CLP` y `GET_CLP_RANGE`) ya resuelven valores reales en
   Payroll. **Incidente cerrado.**
**Paso 5.** ~~UX de `"Not found"` en `GET_CLP_RANGE`~~ -- **hecho, deployado y
   confirmado por el usuario en (05) Payroll**: fix `describeMissingRate` (blank para
   fecha futura, `"Not found"` para presente/pasada).
**Paso 6.** ~~Rangos abiertos rompen `GET_CLP_RANGE` en (12) MedicalRefund~~ -- **fix
   aplicado esta sesión** (`classifyRangePair` + desacoplar `GET_CLP_RANGE_MAX_PAIRS`
   de las filas de relleno), 100/100 tests, lint limpio. **Pendiente**: luz verde
   explícita del usuario para commitear/pushear (mismo `AGENTS.md`, ningún agente
   commitea sin instrucción expresa) y, una vez deployado, que el usuario confirme en
   MedicalRefund que `=GET_CLP_RANGE($F$4:$F, $T$4:$T)` ya resuelve las filas reales
   y deja en blanco las de relleno sin fallar el lote entero.
