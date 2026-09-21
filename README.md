# Yorda Webhook

Backend de **Yorda Envíos**: remesas y envíos de dinero Brasil → Cuba
(reales por PIX, USD, MLC, y entregas de efectivo en Cuba), operado
como un bot de WhatsApp con panel administrativo. Es un sistema **en
producción**, en uso diario real — cualquier cambio se trata con esa
seriedad.

Este documento describe el sistema **tal como está hoy** (post
Fases 1-7 de endurecimiento). No es un tutorial de v0/plantilla — es la
referencia real para operar, mantener y extender este backend sin
depender de conocimiento histórico no escrito.

## Arquitectura general

Monolito Node.js + Express, un solo proceso, sin ORM (SQL crudo con
`pg`), pensado para desplegarse tal cual en Railway.

```
Cliente en WhatsApp
      │
      ▼
   Z-API  (proveedor de WhatsApp)
      │  POST
      ▼
  POST /webhook  (index.js)
      │
      ├─ seguridad: secreto opcional en la URL + validación de payload
      ├─ rate limiting, filtrado de grupos/newsletters
      ├─ deduplicación de messageId (Postgres + memoria)
      ├─ pausa humana (¿el operador ya está atendiendo a mano?)
      │
      ▼
  Reglas de negocio (src/flows/*, src/services/reglas-bot.js)
  + OpenAI (OCR de imágenes/PDF, asistente de respaldo)
      │
      ▼
  PostgreSQL (customers, operations, rates, ofertas, recargas,
              entregas y su CRM propio)
      │
      ▼
  Panel admin (/dashboard, /entregas) + notificaciones de vuelta
  al cliente y al admin por Z-API
```

No hay cola de mensajes ni workers separados: todo corre en el mismo
proceso Express, con `setInterval`/`setTimeout` para las tareas
periódicas (ver "Jobs periódicos" más abajo).

## Estructura de carpetas

```
index.js                    Entry point: rutas, migración legacy al arrancar, jobs periódicos
db.js                        Pool único de pg — nunca se instancia otro en ningún archivo
docs/database-schema.md      Esquema de base de datos documentado (ver sección Base de datos)
migrations/                  Migraciones versionadas (0001-0008), ver sección Base de datos
scripts/migrate.js           Runner de migraciones — manual, nunca automático
src/
  config/env.js              Único punto que lee process.env para el resto del código
  services/                  zapi, openai (OCR/asistente vive en flows/imagen-flow.js),
                              operations, entregas, customer-memory, crm, calculator,
                              reglas-bot, job-lock, webhook-guard, promo
  flows/                     Máquina de estados conversacional por caso de uso
                              (cotizacion, pix, recarga, pedido-web, imagen, shared)
  middleware/webhook-security.js   Secreto opcional + validación de payload del webhook
  utils/structured-logger.js       Logging JSON estructurado (ver sección Logging)
public/                      3 páginas estáticas sin build step: dashboard.html
                              (admin completo), entregas.html (panel reducido),
                              calculadora.html (pública, cliente)
test/                        node:test — todo mockeado, nunca toca Postgres/Z-API/OpenAI reales
```

## Requisitos locales

- Node.js 20+ (probado con Node 22).
- Una base PostgreSQL accesible (local, Docker, o un branch/rama de tu
  proveedor gestionado — **nunca la de producción** para desarrollo).
- Sin Redis, sin Odoo, sin Google Cloud: esas integraciones **ya no
  forman parte del proyecto** (ver "Deuda técnica" más abajo no aplica
  aquí — fueron removidas por completo en la Fase 7 por estar
  demostrablemente muertas: cero referencias en el código).

## Instalación

```bash
npm ci
```

`package-lock.json` ya está commiteado (agregado en la Fase 7) — usar
siempre `npm ci`, no `npm install`, para instalaciones reproducibles
(local, CI, y el build de Railway).

## Variables de entorno

Ninguna se versiona con valor real (`.env` está en `.gitignore`). Copiar
a un `.env` local y completar:

| Variable | Para qué |
|---|---|
| `PORT` | Puerto HTTP (default 8080 si no se define) |
| `DATABASE_URL` | Conexión a Postgres. **Nunca apuntar la de producción desde un entorno local de desarrollo.** |
| `DB_SSL_REJECT_UNAUTHORIZED` | `"true"` para validar el certificado SSL estrictamente; por defecto `false` (compatibilidad con proveedores gestionados tipo Neon/Railway) |
| `ADMIN_TOKEN` | Bearer token del panel `/dashboard` (acceso completo) |
| `ENTREGAS_TOKEN` | Bearer token reducido, solo para `/admin/entregas/*` (panel `/entregas`) — `ADMIN_TOKEN` también sirve ahí |
| `OPENAI_API_KEY` | OCR de imágenes/PDF y asistente conversacional de respaldo |
| `ZAPI_INSTANCE`, `ZAPI_TOKEN`, `ZAPI_CLIENT_TOKEN` | Credenciales de la instancia de Z-API (envío de mensajes) |
| `WEBHOOK_SHARED_SECRET` | Opcional — ver sección "Seguridad del webhook" |
| `PIX_KEY`, `PIX_HOLDER_NAME`, `PIX_BANK`, `PIX_IMAGE_URL`, `PIX_HOLDER_ALIASES` | Datos de la cuenta PIX que se muestran/validan contra el cliente (`PIX_HOLDER_ALIASES` separado por `\|`) |
| `ADMIN_PHONE` | Número de WhatsApp del admin — recibe notificaciones de nuevas operaciones, tasas diarias, avisos de atraso |
| `ENTREGA_CONTACT_PHONE` | Número del contacto en Cuba que coordina entregas en efectivo (default hardcodeado si no se define) |
| `WASCRIPT_TOKEN` | Opcional — etiquetado de clientes en WASCRIPT CRM (`src/flows/pix-flow.js`); si no está seteada, esa llamada simplemente no se hace |

Ya no existen (removidas en la Fase 7 por no tener ningún uso real en
el código): `ODOO_URL`, `ODOO_DB`, `ODOO_USER`, `ODOO_API_KEY`,
`REDIS_URL`, `OPENAI_ASSISTANT_ID`. Si alguna sigue configurada en
Railway, no tiene ningún efecto — ver "Deuda técnica conocida".

## Ejecutar localmente

```bash
npm start          # node index.js
```

Al arrancar corre automáticamente el mecanismo **legacy** de migración
(bloques `ALTER TABLE ... IF NOT EXISTS` dentro de `index.js` y
`src/services/crm.js`) — esto sigue existiendo tal cual, por
compatibilidad, y no se reemplazó (ver "Base de datos").

## Tests

```bash
npm test            # node --test
```

148 tests, todos con mocks (`pool.query`/`pool.connect`/`console.log`
capturado) — ninguno toca Postgres, Z-API ni OpenAI reales. Cubren:
cálculo de tasas (CUP/USD/MLC), reglas del bot, seguridad del webhook,
idempotencia de operaciones/entregas, deduplicación (memoria + Postgres),
locks entre instancias, logging estructurado, y parseo de respuestas OCR.

## Base de datos

El esquema real está documentado en **[docs/database-schema.md](docs/database-schema.md)**
— tabla por tabla, columna por columna, con su nivel de confianza
(qué tiene DDL real en el repo vs. qué se reconstruyó leyendo el código
porque nunca tuvo un `CREATE TABLE` versionado).

### Dos mecanismos de migración conviven, a propósito

1. **Legacy (sigue activo):** el IIFE al inicio de `index.js` y
   `crm.migrarColumnasCRM()` — corren automáticamente cada vez que
   arranca el proceso, con `ADD COLUMN IF NOT EXISTS`. **No se tocó ni
   se va a reemplazar de golpe** — es lo que ha mantenido la base de
   producción funcionando hasta ahora.
2. **Nuevo, versionado, manual (`migrations/` + `scripts/migrate.js`):**
   para cualquier cambio de esquema *futuro*. Nunca se ejecuta solo —
   es un comando aparte que vos corrés cuando decidís, apuntando a la
   base que elijas.

### Cómo correr las migraciones nuevas

```bash
# Ver qué falta aplicar, sin tocar nada:
DATABASE_URL="postgresql://..." node scripts/migrate.js --dry-run

# Aplicar de verdad:
DATABASE_URL="postgresql://..." node scripts/migrate.js
```

Idempotente (registra cada archivo aplicado en `schema_migrations`,
nunca repite uno ya corrido) y transaccional por archivo (si uno falla,
hace `ROLLBACK` de ese archivo y se detiene — no dejar la base a medio
migrar). Probado localmente contra Postgres efímero, en dos escenarios
(base vacía y una base "legacy" simulada con datos) — nunca contra
producción.

**Estado en producción (2026-09-21): las migraciones 0001-0009 ya se
aplicaron contra la base real** (`railway run --service yorda-webhook --
node scripts/migrate.js`), verificado con `--dry-run` devolviendo 0
pendientes. `webhook_events` (dedup persistente) e `idempotency_keys`
(idempotencia de entrega manual) están operativas. Cualquier migración
*futura* (0010 en adelante) sigue siendo una decisión y una acción
manual aparte, nunca automática.

## Seguridad del webhook

`POST /webhook` es la única puerta de entrada pública que dispara
lógica de negocio real. Z-API **no firma criptográficamente** sus
webhooks salientes (verificado contra su documentación oficial) — el
`Client-Token` que ya usa `src/services/zapi.js` autentica las llamadas
que *nosotros* hacemos hacia Z-API, no al revés.

La protección compatible implementada es un secreto propio en la query
string de la URL del webhook (la URL la configuramos nosotros en el
panel de Z-API, y puede incluir lo que queramos):

- `WEBHOOK_SHARED_SECRET` sin configurar → el middleware es un no-op
  total, el webhook funciona exactamente igual que siempre.
- `WEBHOOK_SHARED_SECRET` configurada → toda request a `/webhook` debe
  incluir `?secret=<el mismo valor>` o se rechaza con 401.

**Activarlo en producción requiere coordinar DOS cambios a la vez, y
ninguno de los dos se hizo desde este documento:**
1. Configurar `WEBHOOK_SHARED_SECRET` en las variables de Railway.
2. Actualizar la URL del webhook en el panel de Z-API a
   `https://<host>/webhook?secret=<el mismo valor>`.

Si se hace solo uno de los dos pasos, el webhook deja de recibir
mensajes — por eso queda documentado pero **no activado**.

## Paneles y endpoints principales

| Ruta | Qué es |
|---|---|
| `POST /webhook` | Único webhook entrante, recibe callbacks de Z-API |
| `GET /dashboard` | Panel admin completo (tasas, VIP, ofertas, operaciones, CRM) — requiere `ADMIN_TOKEN` |
| `GET /entregas` | Panel reducido, solo CRM de entregas en efectivo — `ADMIN_TOKEN` o `ENTREGAS_TOKEN` |
| `GET /calculadora.html` | Público — calculadora de envío para el cliente, genera el mensaje de WhatsApp del "pedido web" |
| `/admin/*` | API del dashboard (tasas, clientes, operaciones, stats, ofertas, recargas) |
| `/admin/entregas/*` | API del CRM de entregas (listar, marcar entregado/cancelado, registrar pago, tasa USDT) |
| `GET /api/tasas`, `GET /api/pix-info` | Públicos, alimentan la calculadora |

## Jobs periódicos

Todos corren dentro del mismo proceso (`setInterval`/`setTimeout` en
`index.js`), protegidos con **advisory locks de Postgres**
(`src/services/job-lock.js`) para que, si alguna vez hay dos instancias
corriendo a la vez, solo una ejecute cada ronda:

| Job | Frecuencia |
|---|---|
| Recordatorios CRM (30 min / 24 h / 7 días) | cada 15 min |
| Recalcular niveles VIP | 1 vez al día |
| Mensaje diario de tasas al admin | 13:15 UTC (10:15 Bahía) |
| Saludo matutino a quien escribió fuera de horario | 11:00 UTC (8:00 Bahía) |
| Aviso de entregas atrasadas (+48h pendientes) | cada 6 horas |
| Limpieza de `webhook_events` (dedup) | 1 vez al día |

## Deduplicación persistente de webhooks

`messageId` se confirma contra la tabla `webhook_events`
(`migrations/0008_webhook_events_dedup.sql`) con
`INSERT ... ON CONFLICT DO NOTHING ... RETURNING`, atómico incluso con
dos instancias escribiendo al mismo tiempo. Un Set en memoria sigue
como filtro rápido de primera línea (evita una consulta a la DB para el
caso obvio dentro del mismo proceso).

**Comportamiento degradado, a propósito:** si `webhook_events` todavía
no existe (la migración 0008 no se corrió) o la conexión falla, el
dedup cae automáticamente a memoria únicamente — el webhook nunca se
bloquea por un problema de esta tabla.

## Logging estructurado

`src/utils/structured-logger.js` escribe una línea JSON por evento a
stdout (Railway ya la captura como log). Eventos:
`WEBHOOK_RECEIVED`, `WEBHOOK_DUPLICATE`, `WEBHOOK_REJECTED`,
`MESSAGE_PROCESSED`, `OCR_SUCCESS`, `OCR_FAILED`, `OPERATION_CREATED`,
`OPERATION_CONFIRMED`, `OPERATION_COMPLETED`, `DELIVERY_CREATED`,
`DELIVERY_COMPLETED`, `EXTERNAL_API_ERROR`.

Nunca imprime tokens/API keys/secretos/clave PIX/tarjetas/documentos —
redacta por nombre de campo como defensa adicional, y enmascara
teléfonos a los últimos 4 dígitos. Para seguir una operación puntual:
`grep` por su `operationId`, código de entrega, o los últimos dígitos
del teléfono en los logs de Railway.

## Pausa humana

Cuando el operador le escribe manualmente a un cliente desde su propio
WhatsApp (`fromMe` sin venir de la API), el bot se silencia 10 minutos
para ese número (`customers.pausa_hasta`, persistido en Postgres —
sobrevive un reinicio de Railway). `src/services/webhook-guard.js`.

## Idempotencia de operaciones y entregas

- `confirmarOperacion`/`completarOperacion` solo transicionan desde el
  estado de origen correcto (`pendiente`→`confirmada`→`completada`) —
  una segunda llamada (doble clic, reintento) no encuentra filas y no
  reenvía notificaciones al cliente.
- El CRM de entregas (`marcarEntregado`, `marcarCancelado`,
  `registrarPago`) ya tenía este mismo guard desde antes.
- Pedidos de la calculadora web se deduplican por `ref_web` antes de
  crear la operación y la entrega.

## Integraciones externas

- **Z-API** (`src/services/zapi.js`): envío de WhatsApp — texto, imagen,
  indicador de "escribiendo...".
- **OpenAI** (`src/flows/imagen-flow.js`): GPT-4o para OCR de
  imágenes (tarjeta cubana vs. comprobante PIX), GPT-4o-mini para OCR
  de PDF, y GPT-4o-mini (Responses API) como asistente de respaldo
  cuando las reglas del bot no cubren el mensaje. No usa Assistants API.
- **WASCRIPT** (`src/flows/pix-flow.js`): etiquetado opcional de
  clientes en su CRM externo — se salta en silencio si
  `WASCRIPT_TOKEN` no está configurada.
- **Odoo, Redis/ioredis y googleapis ya NO forman parte del
  proyecto** — se removieron por completo en la Fase 7 (código muerto,
  cero referencias reales) junto con sus dependencias en `package.json`.

## Deploy

Procedimiento recomendado (Railway hace auto-deploy de `main`):

```
rama de feature (ej. claude/harden-yorda-webhook)
        │
        ▼
   npm ci && npm test        (148/148 antes de seguir)
        │
        ▼
   revisión (código + docs/database-schema.md si hay cambio de esquema)
        │
        ▼
   migraciones controladas, si aplica
   (node scripts/migrate.js --dry-run primero, luego sin --dry-run,
    SIEMPRE contra un DATABASE_URL que vos elegís explícitamente)
        │
        ▼
   merge a main
        │
        ▼
   Railway auto-deploy
```

**Rollback básico:** revertir el merge en `main` (o `git revert`) y
dejar que Railway redespliegue la versión anterior. Las migraciones de
`migrations/` son siempre aditivas (`ADD COLUMN IF NOT EXISTS`,
`CREATE TABLE IF NOT EXISTS`) — un rollback de código nunca necesita un
rollback de esquema para funcionar, porque el código viejo simplemente
ignora las columnas/tablas nuevas que no usa.

**Nunca ejecutar cambios destructivos de base de datos** (`DROP TABLE`,
`DROP COLUMN`, `RENAME`, truncar datos) como parte de un deploy o
migración — ninguna migración de este repo lo hace, y no debería
agregarse una que lo haga sin una estrategia explícita aparte
(backup confirmado, ventana de mantenimiento, plan de reversión).

## Deuda técnica conocida

Registrada a propósito, sin resolver en este bloque:

1. **"Efectivo" (cash) se calcula solo del lado del cliente.**
   `public/calculadora.html` computa el precio con `rates.efectivo`/
   `tarifa_entrega` y el backend solo *parsea* el resultado ya
   calculado del texto del pedido — nunca lo revalida. Propuesta
   técnica (no implementada): portar la misma fórmula a
   `calculator.js` y recalcular server-side al crear la operación,
   comparando contra lo que mandó el cliente sin bloquear, solo
   logueando discrepancias. Requiere garantizar paridad exacta de
   redondeo antes de cambiar la fuente de verdad — un desajuste
   cambiaría lo que se le cobra a un cliente real.
2. **`WEBHOOK_SHARED_SECRET` implementado pero no activado en
   producción.** Requiere coordinar la variable en Railway + la URL en
   el panel de Z-API al mismo tiempo (ver "Seguridad del webhook").
3. ~~Migraciones 0001-0008 sin correr contra la base real~~ — **cerrado
   2026-09-21**: 0001-0009 aplicadas en producción, 0 pendientes
   (verificado con `--dry-run`). `webhook_events` e `idempotency_keys`
   operativas.
4. **Variables de entorno obsoletas que podrían seguir existiendo en
   Railway** aunque el código ya no las lea: `ODOO_URL`, `ODOO_DB`,
   `ODOO_USER`, `ODOO_API_KEY`, `REDIS_URL`, `OPENAI_ASSISTANT_ID`. No
   tienen ningún efecto hoy; borrarlas de Railway (o no) es indistinto
   para el funcionamiento del sistema.
