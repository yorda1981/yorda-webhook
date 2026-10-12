-- MVP 1 · Pulso del grupo.
-- Mide el grupo del Motor de Marketing (altas, bajas, permanencia) y los
-- mensajes que llegan al bot. Solo eventos, fechas y tipos: nunca el
-- contenido de un mensaje.

-- Estado actual de cada participante. joined_at es el inicio de su
-- permanencia ACTUAL: si sale y vuelve a entrar, empieza de nuevo.
-- baseline = ya estaba en la primera lectura del grupo, así que su
-- antigüedad real es desconocida y cuenta desde esa lectura.
CREATE TABLE IF NOT EXISTS community_members (
    group_id        VARCHAR(160) NOT NULL,
    phone           VARCHAR(80)  NOT NULL,
    joined_at       TIMESTAMPTZ  NOT NULL,
    left_at         TIMESTAMPTZ,
    activo          BOOLEAN      NOT NULL DEFAULT TRUE,
    baseline        BOOLEAN      NOT NULL DEFAULT FALSE,
    actualizado_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    PRIMARY KEY (group_id, phone)
);

-- Historial de altas y bajas. message_id deduplica los eventos del webhook
-- (Z-API puede reenviar un callback); las altas/bajas deducidas de la
-- lectura diaria no tienen message_id.
CREATE TABLE IF NOT EXISTS community_member_events (
    id           BIGSERIAL PRIMARY KEY,
    group_id     VARCHAR(160) NOT NULL,
    phone        VARCHAR(80)  NOT NULL,
    tipo         VARCHAR(10)  NOT NULL CHECK (tipo IN ('ALTA', 'BAJA')),
    origen       VARCHAR(10)  NOT NULL CHECK (origen IN ('WEBHOOK', 'LECTURA')),
    motivo       VARCHAR(40),
    message_id   VARCHAR(200) UNIQUE,
    ocurrido_at  TIMESTAMPTZ  NOT NULL,
    creado_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_community_member_events_group_time
    ON community_member_events (group_id, ocurrido_at);

-- Una lectura por grupo y día (calendario de São Paulo).
CREATE TABLE IF NOT EXISTS community_snapshots (
    id         BIGSERIAL PRIMARY KEY,
    group_id   VARCHAR(160) NOT NULL,
    fecha      DATE         NOT NULL,
    miembros   INTEGER      NOT NULL CHECK (miembros >= 0),
    altas      INTEGER      NOT NULL CHECK (altas >= 0),
    bajas      INTEGER      NOT NULL CHECK (bajas >= 0),
    tomada_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (group_id, fecha)
);

-- Mensajes entrantes al bot: teléfono, tipo y hora. Se conservan 180 días.
CREATE TABLE IF NOT EXISTS bot_inbound_messages (
    id           BIGSERIAL PRIMARY KEY,
    phone        VARCHAR(40)  NOT NULL,
    tipo         VARCHAR(20)  NOT NULL,
    recibido_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bot_inbound_messages_phone_time
    ON bot_inbound_messages (phone, recibido_at);

CREATE INDEX IF NOT EXISTS idx_bot_inbound_messages_time
    ON bot_inbound_messages (recibido_at);
