# Esquema de base de datos — yorda-webhook

Documento generado en la Fase 4 (endurecimiento del webhook). Reconstruye
el esquema real a partir de **todo** el código que hace `pool.query(...)`
contra Postgres — no hay ORM ni un archivo de esquema único, así que esta
es la fuente de verdad más cercana que existe hoy fuera de la base de
producción misma.

**Nunca se conectó a producción para escribir este documento.** Todo lo de
abajo viene de leer `index.js`, `src/services/*.js` y `src/flows/*.js`.

## Nivel de confianza por tabla

| Tabla | DDL en el repo | Confianza |
|---|---|---|
| `entregas`, `entregas_pagos`, `entregas_historial`, `entregas_tasas` | `CREATE TABLE IF NOT EXISTS` completo en `index.js` | **Alta** — DDL exacto |
| `customers`, `operations`, `rates`, `ofertas`, `recargas` | Ninguna. Solo `ALTER TABLE ADD COLUMN IF NOT EXISTS` para columnas agregadas después | **Media** — columnas reconstruidas leyendo cada INSERT/SELECT/UPDATE del código; tipos inferidos por uso, no confirmados contra la base real |

**Hallazgo importante:** no existe, en ningún commit de este repositorio,
la sentencia `CREATE TABLE` original de `customers`, `operations`, `rates`,
`ofertas` ni `recargas`. Estas 5 tablas ya existían en la base de Neon
antes de este código (creadas a mano o desde un proyecto anterior no
versionado). Cualquier "migración 0001" que las declare es, por
definición, una **reconstrucción best-effort**, no la definición
original — se marca así explícitamente en `migrations/0001_baseline_reconstructed.sql`.

**Segundo hallazgo:** `customers.pausa_hasta` (pausa humana) se usa desde
`src/services/webhook-guard.js` (`INSERT ... ON CONFLICT ... SET
pausa_hasta`, `SELECT pausa_hasta`) pero **tampoco tiene ningún `ALTER
TABLE` en todo el historial de git**. Como `saludo_pendiente`, `nivel_vip`,
etc. sí lo tienen, esto sugiere que `pausa_hasta` se agregó a mano
directamente en Neon en algún momento, sin dejar rastro en el código. Se
documenta y se agrega su `ADD COLUMN IF NOT EXISTS` en las migraciones
nuevas por seguridad (no tiene efecto en producción, donde ya existe).

---

## `customers`

Clave: `phone` (usado como identificador único en todo el código —
`WHERE phone = $1`, `ON CONFLICT (phone)`).

| Columna | Tipo (inferido) | Origen | Uso |
|---|---|---|---|
| `phone` | TEXT/VARCHAR, único | base | identidad del cliente |
| `nombre` | TEXT | base | `customer-memory.js` |
| `ultimo_monto` | NUMERIC | base | `customer-memory.js`, recordatorios |
| `tipo_favorito` | VARCHAR | base | tipo de operación (`brl_cup`, `usd_clasica`, …) |
| `banco_favorito` | VARCHAR | base | |
| `tarjeta_frecuente` | VARCHAR | base | 16 dígitos |
| `titular_frecuente` | VARCHAR | base | |
| `banco_detectado` | VARCHAR | base | OCR de tarjeta |
| `estado` | VARCHAR | base | máquina de estados del bot (no confundir con `estado_crm`) |
| `fecha_estado` | TIMESTAMP | base | |
| `fecha_cotizacion` | TIMESTAMPTZ | base (redeclarada en migración CRM, "ya puede existir") | dispara los recordatorios |
| `fecha_pix` | TIMESTAMP | base | |
| `tarjetas` | JSON/TEXT | base | array de tarjetas guardadas, ver `parseTarjetas` en `shared.js` |
| `comprobante_pendiente` | BOOLEAN | base | |
| `valor_comprobante` | NUMERIC | base | |
| `ultima_interaccion` | TIMESTAMP | base | también usada por recordatorios y saludo fuera de horario |
| `saludo_enviado` | BOOLEAN | base | |
| `last_response_id` | VARCHAR | base | Responses API de OpenAI (asistente fallback) |
| `created_at` / `updated_at` | TIMESTAMP | base | |
| `saludo_pendiente` | BOOLEAN DEFAULT false | `index.js` ALTER (histórico) | saludo matutino fuera de horario |
| `nivel_vip` | INTEGER DEFAULT 0 | `index.js` ALTER (histórico) | programa VIP ⭐/⭐⭐/⭐⭐⭐ |
| `ultimo_aviso_entrega` | TIMESTAMP | `index.js` ALTER (histórico) | no repetir explicación de entrega |
| `estado_crm` | VARCHAR(40) DEFAULT 'nuevo_cliente' | `crm.js migrarColumnasCRM` | estado del embudo comercial |
| `idioma` | VARCHAR(2) DEFAULT 'es' | `crm.js migrarColumnasCRM` | 'es' / 'pt' |
| `cliente_frecuente` | BOOLEAN DEFAULT false | `crm.js migrarColumnasCRM` | 3+ operaciones confirmadas |
| `ultimo_recordatorio` | TIMESTAMPTZ | `crm.js migrarColumnasCRM` | |
| `tipo_ultimo_recordatorio` | VARCHAR(20) | `crm.js migrarColumnasCRM` | evita repetir la misma onda |
| `pausa_hasta` | TIMESTAMPTZ | **sin ALTER en el repo — ver hallazgo arriba** | pausa humana (10 min) |

## `operations`

Clave: `id` (serial, autoincremental — usado en `RETURNING *` / `WHERE id = $1`).

| Columna | Tipo (inferido) | Origen |
|---|---|---|
| `id` | SERIAL PK | base |
| `phone`, `nombre`, `monto`, `cup` | TEXT/NUMERIC | base |
| `tarjeta`, `titular`, `banco` | TEXT | base |
| `tipo` | VARCHAR (`brl_cup`, `usd_clasica`, `usd_prepago`, `usd_efectivo`, `cup_efectivo`, `mlc`, …) | base |
| `status` | VARCHAR (`pendiente` → `confirmada` → `completada`, o `expirada`) | base |
| `created_at`, `confirmed_at`, `completed_at`, `updated_at` | TIMESTAMP | base |
| `ref_web` | VARCHAR(20) | `index.js` ALTER (histórico) — dedup de pedidos de la calculadora |
| `origen` | VARCHAR(30) | `0020` — origen interno (`dashboard_manual` = alta manual de transferencias); NULL en los flujos existentes |
| `direccion`, `provincia`, `municipio` | TEXT/VARCHAR(60) | `index.js` ALTER (histórico) |
| `referencia_entrega`, `telefono_entrega` | TEXT/VARCHAR(30) | `index.js` ALTER (histórico) |
| `entrega_disponible` | BOOLEAN | `index.js` ALTER (histórico) |

## `rates` (fila única, `id = 1`)

| Columna | Origen |
|---|---|
| `id` | base (PK, siempre 1) |
| `brl_0`, `brl_100`, `brl_500`, `brl_1000` | base — tramos BRL→CUP |
| `usd1`, `usd2` | base — USD Clásica / Prepago |
| `mlc` | base |
| `updated_at` | base |
| `efectivo` | ALTER (histórico) — tasa CUP por real, **solo la lee `public/calculadora.html`**, ver propuesta de Fase "Efectivo" en el reporte |
| `tarifa_entrega` | ALTER (histórico) — igual, solo cliente |
| `umbral_vip_1/2/3`, `bono_vip_1/2/3`, `descuento_entrega_1/2/3` | ALTER (histórico) — programa VIP |

## `ofertas` (fila única, `id = 1`)

`texto`, `activa`, `vence_at` (base) + `texto_vip`, `activa_vip` (ALTER histórico, oferta exclusiva VIP).

## `recargas`

Clave funcional: `tipo` (usado en `WHERE tipo = $4` desde el admin, valores conocidos: `nacional`, `internacional`).
Columnas: `tipo`, `precio`, `descripcion`, `activa`, `updated_at`. No se referencia ningún `id` — puede o no existir, no se puede confirmar desde el código.

## `entregas` — CRM de efectivo (DDL completo, alta confianza)

Ver `migrations/0005_entregas_subsystem.sql` — copiado literal del `CREATE TABLE` de `index.js`. Incluye `entregas`, `entregas_pagos`, `entregas_historial`, `entregas_tasas`, las secuencias `entregas_codigo_seq` / `entregas_pago_codigo_seq`, y los 3 índices (`estado_entrega`, `estado_pago`, `phone`).

## Dependencias entre tablas

```
customers (phone) ──┐
                     ├── operations.phone (sin FK declarada, solo por convención)
                     └── entregas.phone   (sin FK declarada)

operations.id ──FK──> entregas.operation_id (REFERENCES operations(id), sin ON DELETE)
entregas.id   ──FK──> entregas_historial.entrega_id (REFERENCES entregas(id), NOT NULL)
entregas.pago_id ──FK──> entregas_pagos.id (REFERENCES entregas_pagos(id))
```

Ninguna relación con `customers`/`operations` tiene FK real a nivel de
Postgres (son "soft references" por `phone` en texto) — solo
`entregas.operation_id`, `entregas_historial.entrega_id` y
`entregas.pago_id` son FK de verdad.
