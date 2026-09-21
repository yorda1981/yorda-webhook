"use strict";

const pool = require("../../db");
const { guardarCliente, obtenerCliente, limpiarComprobantePendiente }             = require("../services/customer-memory");
const { agregarOperacion, existeOperacionPendiente, obtenerPendienteCliente }     = require("../services/operations");
const { calcularOperacion }                                                        = require("../services/calculator");
const { enviarMensaje, enviarImagen }                                              = require("../services/zapi");
const crm                                                                          = require("../services/crm");
const { esRecarga: esRecargaCliente }                                              = require("../services/reglas-bot");
const {
    extraerIdentidadComprobante, calcularDestinatarioMatch, buscarOperacionPorIdentidad
} = require("../services/comprobante-identidad");

// Trae la descripción configurada para este tipo de recarga (la misma que se le
// muestra al cliente al elegir "Nacional"/"Internacional" en recarga-flow.js) —
// ahí es donde normalmente se especifica cuánto saldo entrega la recarga.
// Consulta directa a la tabla en vez de importar recarga-flow.js para evitar
// una dependencia circular (recarga-flow.js ya importa de este archivo).
async function leerDescripcionRecarga(tipoRecarga) {
    try {
        const r = await pool.query("SELECT descripcion, precio FROM recargas WHERE tipo = $1 LIMIT 1", [tipoRecarga]);
        return r.rows[0] || null;
    } catch (e) {
        console.error("❌ Error leyendo descripción de recarga:", e.message);
        return null;
    }
}
const {
    enviarSeguro, limpiarSesion, fmt, pick, pickL,
    getPIXKey, getPIXHolder, getPIXBank, getPIXImage, getAdminPhone,
    ESPERA_COMPROBANTE_ES, ESPERA_COMPROBANTE_PT, parseTarjetas
} = require("./shared");

// ─────────────────────────────────────────
// NOTIFICAR ADMIN
// ─────────────────────────────────────────

async function notificarAdmin(pushName, phone, monto, cup, banco, tarjeta, titular) {
    const adminPhone = getAdminPhone();
    if (!adminPhone) { console.warn("⚠️ ADMIN_PHONE no configurado"); return; }
    await enviarSeguro(adminPhone,
        `📥 *NUEVA OPERACIÓN*\n👤 ${pushName}\n📱 ${phone}\n💵 R$${monto} → ${fmt(cup)} CUP\n🏦 ${banco || "-"}\n💳 ${tarjeta || "-"}\n👤 ${titular || "-"}\n⏳ Pendiente`
    );
}

// ─────────────────────────────────────────
// ETIQUETAR EN WASCRIPT CRM
// ─────────────────────────────────────────

async function etiquetarNuevoPedido(phone) {
    const token = process.env.WASCRIPT_TOKEN;
    if (!token) return;
    try {
        await fetch(`https://api-whatsapp.wascript.com.br/api/modificar-etiquetas/${token}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ phone: [phone], actions: [{ labelId: "2", type: "add" }] })
        });
        console.log(`🏷️ Etiqueta agregada: ${phone}`);
    } catch (e) {
        console.error("❌ Wascript:", e.message);
    }
}

// ─────────────────────────────────────────
// ENVIAR PIX
// ─────────────────────────────────────────

async function enviarPIX(phone, cliente, esEs) {
    if (!cliente?.ultimo_monto || Number(cliente.ultimo_monto) <= 0) {
        const msg = esEs ? "Primero dime cuánto vas a enviar 😊" : "Primeiro me diz quanto vai enviar 😊";
        await enviarSeguro(phone, msg);
        return msg;
    }
    // BUG VIEJO: comparaba contra "recarga_etecsa", pero el valor real que se guarda
    // (ver src/flows/recarga-flow.js) es "recarga_nacional" o "recarga_internacional" —
    // por eso esRecarga nunca daba true y las recargas se trataban como remesa normal.
    // Lógica en src/services/reglas-bot.js (probada en test/reglas-bot.test.js)
    const esRecarga = esRecargaCliente(cliente);
    if (!esRecarga && !cliente?.tarjeta && !cliente?.tarjeta_frecuente) {
        const msg = esEs
            ? "Solo me falta la tarjeta de destino 💳\n\nEnvíame una foto o los 16 dígitos."
            : "Só falta o cartão de destino 💳\n\nEnvie uma foto ou os 16 dígitos.";
        // Marca la pregunta pendiente para que, si el cliente ya tenía una
        // tarjeta_frecuente guardada de antes y responde solo "tarjeta", se
        // reutilice sin volver a pedirla (ver interpretarTarjetaPorPalabra
        // en reglas-bot.js). Si no hay ninguna guardada, no cambia nada.
        await guardarCliente({ phone, ultimaPregunta: "tarjeta_pendiente" });
        await enviarSeguro(phone, msg);
        return msg;
    }

    // Múltiples tarjetas → elegir cuál
    const tarjetas = parseTarjetas(cliente?.tarjetas).filter(t => /^\d{15,16}$/.test(t));
    if (!esRecarga && tarjetas.length > 1) {
        const opciones = tarjetas.map((t, i) => {
            const ultimos = t.slice(-4);
            const titular = cliente.titular_frecuente || "";
            return `${i + 1}️⃣ •••• ${ultimos}${titular ? " — " + titular.split(" ")[0] : ""}`;
        }).join("\n");
        const msg = `¿A cuál tarjeta envío hoy? 💳\n\n${opciones}`;
        // ultimasOpciones guarda los mismos números que se ofrecen (ya
        // filtrados a 15-16 dígitos) para poder interpretar "la primera"/
        // "la otra"/"esa" además del número -- ver interpretarSeleccionOpcion
        // en reglas-bot.js.
        await guardarCliente({
            phone, estado: "seleccionando_tarjeta", fechaEstado: new Date().toISOString(),
            ultimaPregunta: "seleccion_tarjeta", ultimasOpciones: tarjetas
        });
        await enviarSeguro(phone, msg);
        return msg;
    }

    // No preguntar lo que ya sabemos, pero tampoco reutilizar en silencio:
    // con UNA sola tarjeta frecuente conocida (no es el caso de "elegir
    // cuál" de arriba, ni el de un cliente que acaba de dar la tarjeta en
    // este mismo mensaje -- esos casos van directo a _enviarPIXFinal desde
    // otros lugares de openai.js), se confirma antes de reutilizarla. La
    // respuesta ("sí"/"esa tarjeta no"/"otra tarjeta") se resuelve en
    // openai.js. cliente?.ultima_pregunta ya marcada evita volver a
    // preguntar si esta función se llama de nuevo tras la confirmación.
    if (!esRecarga && tarjetas.length <= 1 && cliente?.tarjeta_frecuente &&
        cliente?.ultima_pregunta !== "confirmar_tarjeta_frecuente") {
        const ultimos4 = cliente.tarjeta_frecuente.slice(-4);
        const msg = esEs
            ? `¿Usamos nuevamente la tarjeta terminada en ${ultimos4}? 💳`
            : `Usamos novamente o cartão terminado em ${ultimos4}? 💳`;
        await guardarCliente({
            phone, ultimaPregunta: "confirmar_tarjeta_frecuente", ultimasOpciones: [cliente.tarjeta_frecuente]
        });
        await enviarSeguro(phone, msg);
        return msg;
    }

    return await _enviarPIXFinal(phone, cliente, esEs);
}

async function _enviarPIXFinal(phone, cliente, esEs) {
    const key = getPIXKey(); const holder = getPIXHolder();
    const bank = getPIXBank(); const img = getPIXImage();

    if (img)    await enviarImagen(phone, img, "📲 Escanea el QR para pagar.");
    if (key)    await enviarSeguro(phone, key);
    if (holder) await enviarSeguro(phone, `Titular: ${holder}${bank ? `\n🏦 ${bank}` : ""}`);
    await enviarSeguro(phone, esEs
        ? "Después del pago envíame el comprobante 📎 y proceso tu envío enseguida 🚀"
        : "Após o pagamento envie o comprovante 📎 e processo imediatamente 🚀"
    );
    await crm.onPIXEnviado(phone, esEs ? "es" : "pt");
    return key;
}

// ─────────────────────────────────────────
// RESPUESTA A COMPROBANTE DUPLICADO (mismo E2E/ID ya visto)
// ─────────────────────────────────────────

// Responde de forma NEUTRA al cliente (nunca revela nombre/teléfono/datos
// del cliente original) y, si la operación encontrada pertenece a OTRO
// teléfono, avisa al admin (auditoría de 7728e66, hallazgo I2) -- el E2E
// es global, así que dos teléfonos reclamando el mismo comprobante es una
// señal real (confusión o intento indebido) que el admin debe poder
// revisar, aun cuando el cliente que lo reenvía no se entera de nada.
async function responderComprobanteDuplicado(phone, operacionExistente, esEs) {
    const yaProcesada = operacionExistente.status === "confirmada" || operacionExistente.status === "completada";
    const m = yaProcesada
        ? (esEs ? "Este comprobante ya corresponde a una operación procesada. ✅" : "Este comprovante já corresponde a uma operação processada. ✅")
        : (esEs ? "Ya tengo ese comprobante registrado 👍 Sigue pendiente de revisión." : "Já tenho esse comprovante registrado 👍 Continua pendente de revisão.");
    await enviarSeguro(phone, m);

    if (operacionExistente.phone && operacionExistente.phone !== phone) {
        const adminPhone = getAdminPhone();
        if (adminPhone) {
            await enviarSeguro(adminPhone,
                `⚠️ *COMPROBANTE REPETIDO DESDE OTRO TELÉFONO*\n\nEl mismo comprobante (operación #${operacionExistente.id}, originalmente de ${operacionExistente.phone}) fue presentado también por ${phone}.\n\nRevisar manualmente -- posible confusión o intento indebido.`
            );
        }
    }

    // Hallazgo residual (revisión final de esta corrección): este
    // comprobante YA quedó resuelto como duplicado (propio o de otro
    // teléfono) -- se limpia SOLO su staging de identidad en `customers`
    // para que no bloquee innecesariamente al próximo comprobante
    // realmente distinto que este mismo cliente mande después (ver I3).
    // Nunca toca estado/monto/tarjeta, y la operación real (si existe)
    // sigue intacta en `operations`.
    await limpiarComprobantePendiente(phone);
}

// ─────────────────────────────────────────
// INTENTAR COMPLETAR OPERACIÓN
// ─────────────────────────────────────────

async function intentarCompletarOperacion(phone, pushName, cliente, esEs) {
    if (!cliente) return false;
    const esRecarga        = esRecargaCliente(cliente);
    const tieneTarjeta     = !!(cliente.tarjeta || cliente.tarjeta_frecuente);
    const tieneComprobante = !!cliente.comprobante_pendiente;

    if (tieneTarjeta && tieneComprobante && !cliente.ultimo_monto) {
        const montoComp = Number(cliente.valor_comprobante);
        if (montoComp > 0) {
            await guardarCliente({ phone, monto: montoComp, tipo: cliente.tipo_favorito || "brl_cup" });
            const cli2 = await obtenerCliente(phone);
            return await intentarCompletarOperacion(phone, pushName, cli2, esEs);
        }
    }

    const tieneMonto = Number(cliente.ultimo_monto) > 0;

    if (tieneTarjeta && tieneComprobante && !cliente.tipo_favorito) {
        await guardarCliente({ phone, tipo: "brl_cup" });
        const cli2 = await obtenerCliente(phone);
        return await intentarCompletarOperacion(phone, pushName, cli2, esEs);
    }

    if (!tieneMonto || !tieneComprobante || (!tieneTarjeta && !esRecarga)) {
        if (!tieneMonto) {
            await enviarSeguro(phone, esEs ? "¿Cuánto vas a enviar? 😊" : "Quanto vai enviar? 😊");
            return false;
        }
        if (!tieneTarjeta && !esRecarga) {
            // Igual que en enviarPIX: marca la pregunta pendiente para poder
            // reutilizar una tarjeta_frecuente si el cliente responde "tarjeta".
            await guardarCliente({ phone, ultimaPregunta: "tarjeta_pendiente" });
            await enviarSeguro(phone, esEs
                ? "Solo me falta la tarjeta de destino 💳\n\nEnvíame foto o los 16 dígitos."
                : "Só falta o cartão 💳\n\nFoto ou 16 dígitos."
            );
            return false;
        }
        return false;
    }

    const yaExiste = await existeOperacionPendiente(phone, cliente.ultimo_monto);
    if (yaExiste) return true;

    // Red de seguridad adicional (la comprobación principal ya corrió en
    // procesarComprobante): si el comprobante llegó ANTES de que monto/
    // tarjeta estuvieran completos, esta función puede correr varios
    // mensajes después -- se revalida la identidad justo antes de crear la
    // fila real, por si en el medio ya se creó una operación con el mismo
    // E2E/ID de transacción (ver src/services/comprobante-identidad.js).
    if (cliente.comprobante_e2e || cliente.comprobante_transaccion_id) {
        const identidadStaged = cliente.comprobante_e2e
            ? { tipo: "e2e", columna: "comprobante_e2e", valor: cliente.comprobante_e2e }
            : { tipo: "transaccion_id", columna: "comprobante_transaccion_id", valor: cliente.comprobante_transaccion_id };
        const dup = await buscarOperacionPorIdentidad(identidadStaged);
        if (dup) {
            await responderComprobanteDuplicado(phone, dup, esEs);
            return true;
        }
    }

    const resultado = await calcularOperacion({ tipo: cliente.tipo_favorito, valor: cliente.ultimo_monto, nivelVip: Number(cliente.nivel_vip || 0) });

    // C1 (auditoría 7728e66): comprobante_pendiente ya NO se pone en false
    // ANTES de saber si agregarOperacion() tuvo éxito -- si fallara, dejaría
    // el estado mintiendo ("ya no está pendiente" cuando en realidad nunca
    // se creó la operación). limpiarSesion() al final de esta función, en
    // el camino de éxito, ya lo deja en NULL -- no hace falta duplicarlo acá.
    const operacion = await agregarOperacion({
        phone,
        nombre:  pushName || cliente.nombre || "Cliente",
        monto:   cliente.ultimo_monto,
        cup:     resultado?.cup || 0,
        tarjeta: cliente.tarjeta || cliente.tarjeta_frecuente || "",
        titular: cliente.titular || cliente.titular_frecuente || "",
        banco:   cliente.banco_detectado || "",
        tipo:    cliente.tipo_favorito,
        comprobanteE2E:           cliente.comprobante_e2e || null,
        comprobanteTransaccionId: cliente.comprobante_transaccion_id || null,
        comprobanteDatos:         cliente.comprobante_datos || null
    });

    // C1 (auditoría 7728e66): agregarOperacion() puede devolver null por dos
    // motivos MUY distintos, y nunca se deben tratar igual:
    //   (a) una petición CONCURRENTE con el mismo E2E/ID ganó la carrera --
    //       el índice único de la migración 0012 rechazó nuestro INSERT.
    //       Se distingue re-consultando por identidad: si ahora SÍ existe
    //       una fila con nuestro mismo E2E/transacción, es (a) -- nunca se
    //       crea un duplicado, se responde según el estado REAL de esa fila
    //       (la que ganó), igual que cualquier otro reenvío.
    //   (b) un fallo real de persistencia (DB caída, timeout, etc.) -- en
    //       ese caso NUNCA se afirma que la operación quedó registrada. El
    //       staging (comprobante_pendiente/valor/identidad) se PRESERVA tal
    //       cual (no se llama limpiarSesion) para que un reintento futuro
    //       lo vuelva a intentar, y se deja registrado el error.
    if (!operacion) {
        if (cliente.comprobante_e2e || cliente.comprobante_transaccion_id) {
            const identidadStaged = cliente.comprobante_e2e
                ? { tipo: "e2e", columna: "comprobante_e2e", valor: cliente.comprobante_e2e }
                : { tipo: "transaccion_id", columna: "comprobante_transaccion_id", valor: cliente.comprobante_transaccion_id };
            const ganadora = await buscarOperacionPorIdentidad(identidadStaged);
            if (ganadora) {
                await responderComprobanteDuplicado(phone, ganadora, esEs);
                return true;
            }
        }

        // No hay reintento automático real -- el mensaje no debe prometer
        // uno. El comprobante queda guardado (staging preservado, no se
        // llamó limpiarSesion) y el cliente puede reenviarlo cuando quiera;
        // además se avisa al admin para seguimiento manual inmediato.
        console.error(`❌ intentarCompletarOperacion: agregarOperacion() devolvió null para ${phone} (monto=${cliente.ultimo_monto}) -- comprobante preservado en staging, NO se avisa como registrada.`);
        await enviarSeguro(phone, esEs
            ? "Tuvimos un problema técnico registrando tu comprobante 😕 Quedó guardado -- Yordanys lo va a revisar manualmente. Si quieres, puedes reenviarlo en un momento."
            : "Tivemos um problema técnico ao registrar seu comprovante 😕 Ficou salvo -- o Yordanys vai revisar manualmente. Se quiser, pode reenviar em instantes."
        );
        const adminPhone = getAdminPhone();
        if (adminPhone) {
            await enviarSeguro(adminPhone,
                `⚠️ *FALLO REGISTRANDO COMPROBANTE*\n\nNo se pudo crear la operación para ${phone} (monto R$${cliente.ultimo_monto}) por un error técnico. El comprobante quedó guardado -- revisar manualmente.`
            );
        }
        // true aquí NO significa "operación completada" -- significa "ya se
        // le respondió al cliente lo que corresponde, el caller (
        // procesarComprobante) no debe mandar además el genérico '¡Comprobante
        // recibido!' encima de un mensaje que ya explica el problema real.
        return true;
    }

    const opId      = `#${operacion.id} `;
    const tarjetaRaw = cliente.tarjeta || cliente.tarjeta_frecuente || "-";
    const tarjetaFmt = tarjetaRaw !== "-" ? tarjetaRaw.replace(/(.{4})/g, "$1 ").trim() : "-";

    const tipoOp   = cliente.tipo_favorito || "brl_cup";
    const totalBrl = resultado?.cup ?? resultado?.brl ?? 0;
    let lineasMonto;
    if (tipoOp.startsWith("recarga_")) {
        // Las recargas no tienen tasa/CUP — es un precio fijo de la tabla `recargas`,
        // no una operación de cambio. Antes esto caía al "else" de abajo y mostraba
        // "Recibe: 0 CUP", que no tiene sentido para una recarga.
        const tipoRecargaKey   = tipoOp.replace("recarga_", ""); // "nacional" | "internacional"
        const tipoRecargaLabel = tipoRecargaKey === "nacional" ? "Nacional" : "Internacional";
        const infoRecarga      = await leerDescripcionRecarga(tipoRecargaKey);
        const saldoTxt         = infoRecarga?.descripcion ? `\n\n📶 ${infoRecarga.descripcion}` : "";
        lineasMonto = `📱 Recarga ${tipoRecargaLabel}${saldoTxt}\n\n💵 Pagado: R$${cliente.ultimo_monto}`;
    } else if (tipoOp.startsWith("usd")) {
        lineasMonto = `🇨🇺 Recibe: ${cliente.ultimo_monto} USD\n\n💵 Paga: R$${fmt(totalBrl)}`;
    } else if (tipoOp === "mlc") {
        lineasMonto = `🇨🇺 Recibe: ${cliente.ultimo_monto} MLC\n\n💵 Paga: R$${fmt(totalBrl)}`;
    } else {
        lineasMonto = `💵 Enviado: R$${cliente.ultimo_monto}\n\n🇨🇺 Recibe: ${fmt(resultado?.cup || 0)} CUP`;
    }

    const msgOperacion = `📥 *OPERACIÓN ${opId}PENDIENTE*

👤 Cliente: ${pushName || cliente.nombre}

📱 Teléfono: ${phone}

${lineasMonto}

🏦 Banco: ${cliente.banco_detectado || "-"}

${esRecarga ? "📞 Número a recargar:" : "💳 Tarjeta:"}
${tarjetaFmt}

👤 Titular:
${cliente.titular || cliente.titular_frecuente || "-"}

⏳ Estado:
Pendiente de validación`;

    await enviarSeguro(phone, msgOperacion);

    // El destinatario del comprobante es una SEÑAL, no un bloqueo (ver
    // procesarComprobante) -- se agrega SOLO a la notificación del admin,
    // que es quien de verdad confirma manualmente. Al cliente no se le
    // alarma por algo que puede ser un simple falso positivo de OCR.
    // I5 (auditoría 7728e66): se incluye el nombre REALMENTE detectado por
    // OCR para que el admin pueda juzgar de un vistazo si es un error real
    // o solo una variante (acentos, apellido distinto, etc.) -- nunca se
    // inventa un nombre si no se pudo leer.
    const datosComp         = cliente.comprobante_datos || {};
    const destinatarioMatch = datosComp.destinatarioMatch;
    const avisoAdmin = destinatarioMatch === "diferente"
        ? `\n\n⚠️ Destinatario del comprobante NO coincide con el esperado${datosComp.destinatario ? ` (detectado: "${datosComp.destinatario}")` : " (nombre no legible)"} -- revisar antes de confirmar.`
        : "";

    const adminPhone = getAdminPhone();
    if (adminPhone) await enviarSeguro(adminPhone, msgOperacion + avisoAdmin);
    else console.warn("⚠️ ADMIN_PHONE no configurado");

    await etiquetarNuevoPedido(phone);
    await limpiarSesion(phone);
    return true;
}

// ─────────────────────────────────────────
// PROCESAR COMPROBANTE
// ─────────────────────────────────────────

// COMPROBANTE LEÍDO ≠ DINERO CONFIRMADO (ver src/services/comprobante-identidad.js):
// esta función EXTRAE, COMPARA, ASOCIA y DETECTA duplicados/inconsistencias --
// nunca confirma un pago ni completa la operación por sí sola. La ruta es la
// MISMA para imagen y PDF (ambas llaman aquí con el mismo shape de `datos`),
// así que la deduplicación y el chequeo de destinatario no se duplican entre
// canales.
async function procesarComprobante(phone, pushName, cliente, datos, esEs) {
    const identidad         = extraerIdentidadComprobante(datos);
    const destinatarioMatch = calcularDestinatarioMatch(datos);

    // 1) DEDUPLICACIÓN -- identidad fuerte primero (E2E, luego ID de
    // transacción). Dos comprobantes con identidad DISTINTA nunca se
    // consideran el mismo pago, aunque compartan monto/teléfono/fecha (caso
    // obligatorio: PIX A R$500 con E2E A y PIX B R$500 con E2E B son dos
    // pagos reales). Si hay identidad fuerte, esto REEMPLAZA el chequeo de
    // monto+ventana de abajo -- nunca corren los dos a la vez para el mismo
    // comprobante.
    if (identidad.tipo !== "fallback") {
        const opExistente = await buscarOperacionPorIdentidad(identidad);
        if (opExistente) {
            await responderComprobanteDuplicado(phone, opExistente, esEs);
            return "";
        }
    } else if (datos.valor && datos.fecha && datos.hora) {
        // FALLBACK sin cambios respecto a la fase anterior: solo corre
        // cuando NO se pudo leer ni E2E ni ID de transacción. Sigue siendo
        // una protección basada en monto + ventana de tiempo -- con su
        // limitación conocida y ya documentada (dos pagos legítimos del
        // mismo cliente y monto dentro de 2h podrían marcarse como
        // duplicado). No se tocó a propósito -- ver el reporte de la fase
        // de comprobantes para la decisión pendiente sobre esto.
        try {
            const dupCheck = await pool.query(`
                SELECT id FROM operations
                WHERE monto = $1
                AND created_at > NOW() - INTERVAL '24 hours'
                AND status != 'rechazada'
                LIMIT 1
            `, [Number(datos.valor)]);

            if (dupCheck.rows.length > 0) {
                const dupCliente = await pool.query(`
                    SELECT id FROM operations
                    WHERE phone = $1 AND monto = $2
                    AND created_at > NOW() - INTERVAL '2 hours'
                    LIMIT 1
                `, [phone, Number(datos.valor)]);

                if (dupCliente.rows.length > 0) {
                    await enviarSeguro(phone, "⚠️ Este comprobante ya fue procesado anteriormente.\n\nSi tienes alguna duda contacta a Yordanys. 😊");
                    return "";
                }
            }
        } catch (e) {
            console.error("❌ Error validando duplicado:", e.message);
        }
    }

    // 2) DESTINATARIO -- señal, nunca bloqueo automático (ver getPIXAliases()/
    // getPIXHolder() en src/flows/shared.js + src/config/env.js: ahí vive de
    // forma centralizada el nombre/alias esperado, nunca hardcodeado aquí).
    // "diferente" queda marcado para revisión manual del admin; "desconocido"
    // (ilegible) sigue como un comprobante pendiente normal, sin advertencia.
    let avisoDestinatario = "";
    if (destinatarioMatch === "diferente") {
        avisoDestinatario = esEs
            ? "\n\n⚠️ El destinatario del comprobante no coincide con el esperado — quedará marcado para revisión manual."
            : "\n\n⚠️ O destinatário do comprovante não coincide com o esperado — vai ficar marcado para revisão manual.";
    }

    // 3) I3 (auditoría 7728e66): si YA hay un comprobante DISTINTO en
    // staging que todavía no se convirtió en operación, NO lo pisamos en
    // silencio -- se detiene y se le pregunta al cliente cuál continuar.
    // Solo aplica cuando el que acaba de llegar tiene identidad fuerte y es
    // realmente distinta a la ya guardada -- si el nuevo NO tiene identidad
    // fuerte, el COALESCE de guardarCliente() ya preserva la vieja sin
    // tocarla (no hay nada que perder en ese caso). Prioridad: nunca perder
    // silenciosamente la identidad/datos del comprobante A.
    const yaHayOtroEnStaging = cliente?.comprobante_pendiente &&
        (cliente?.comprobante_e2e || cliente?.comprobante_transaccion_id) &&
        identidad.tipo !== "fallback" &&
        identidad.valor !== cliente?.comprobante_e2e &&
        identidad.valor !== cliente?.comprobante_transaccion_id;

    if (yaHayOtroEnStaging) {
        const m = esEs
            ? "Todavía tengo otro comprobante tuyo pendiente de revisión 🤔\n\n¿Este es un pago DIFERENTE o me equivoqué de comprobante? Si es nuevo, dime el monto para separarlo; si fue un error, dime \"olvida eso\" y seguimos con este."
            : "Ainda tenho outro comprovante seu pendente de revisão 🤔\n\nEste é um pagamento DIFERENTE ou foi engano? Se for novo, me diz o valor para separar; se foi erro, diz \"esquece isso\" e seguimos com este.";
        await enviarSeguro(phone, m);
        return "";
    }

    // 4) Staging en `customers` -- sobrevive aunque falte monto/tarjeta
    // todavía (mismo patrón que comprobante_pendiente/valor_comprobante ya
    // usaban). Se traslada a `operations` recién cuando agregarOperacion()
    // corre en intentarCompletarOperacion(). Se guarda la identidad EFECTIVA
    // (identidad.valor -- ya sea el E2E o el compuesto banco::transacción,
    // ver hallazgo I1), no los valores crudos por separado, para que sea
    // exactamente lo mismo que se usará para deduplicar/crear la operación.
    await guardarCliente({
        phone,
        comprobantePendiente: true,
        valorComprobante: datos.valor ?? null,
        comprobanteE2E: identidad.tipo === "e2e" ? identidad.valor : null,
        comprobanteTransaccionId: identidad.tipo === "transaccion_id" ? identidad.valor : null,
        comprobanteDatos: {
            fecha: datos.fecha ?? null,
            hora: datos.hora ?? null,
            pagador: datos.pagador ?? null,
            destinatario: datos.destinatario ?? null,
            destinatarioMatch,
            bancoOrigen: datos.banco ?? null,
            transaccionIdRaw: identidad.transaccionId ?? null
        },
        ...(datos.valor && !cliente.ultimo_monto && { monto: datos.valor })
    });

    const opPend = await obtenerPendienteCliente(phone);
    if (opPend && datos.valor &&
        Math.round(Number(datos.valor)) !== Math.round(Number(opPend.monto))
    ) {
        await enviarSeguro(phone,
            `⚠️ El comprobante es R$${datos.valor} pero la operación es R$${opPend.monto}.\n\nVerifica y reenvíalo.`
        );
        return "";
    }

    const clienteActualizado = await obtenerCliente(phone);
    const completado = await intentarCompletarOperacion(phone, pushName, clienteActualizado, esEs);

    if (!completado) {
        await enviarSeguro(phone, (esEs ? "¡Comprobante recibido! ✅" : "Comprovante recebido! ✅") + avisoDestinatario);
    }

    return "";
}

// ─────────────────────────────────────────
// GUARDAR TARJETA
// ─────────────────────────────────────────

async function guardarTarjeta(phone, num, titular, banco, cliente) {
    const arr = parseTarjetas(cliente?.tarjetas);
    if (!arr.includes(num)) arr.push(num);
    await guardarCliente({
        phone, tarjeta: num, titular: titular || "",
        bancoDetectado: banco || "", tarjeta_frecuente: num,
        titular_frecuente: titular || "", banco_detectado: banco || "",
        tarjetas: arr
    });
}

module.exports = {
    enviarPIX,
    _enviarPIXFinal,
    intentarCompletarOperacion,
    procesarComprobante,
    guardarTarjeta,
    notificarAdmin
};
