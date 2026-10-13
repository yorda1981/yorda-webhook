# Manual del proceso YORDA

Versión: 1 (2026-10-12) — redactado a partir de los flujos reales del bot y de la calculadora web. Pendiente de aprobación del operador.

Este manual es la única fuente del contenido permanente del Director IA. Si un flujo del bot cambia, este manual debe cambiar con él. No contiene tasas ni precios: cambian a diario y los da siempre el bot.

## Qué envía YORDA

- **CUP a tarjeta:** el cliente paga en reales (BRL) y la familia recibe pesos cubanos (CUP) en su tarjeta.
- **USD a tarjeta:** la familia recibe dólares en su tarjeta. Hay dos tipos de tarjeta: Clásica (BPA o Bandec) y Prepago (Nauta o Internacional). Si el cliente no lo indica, el bot pregunta cuál es.
- **MLC a tarjeta:** cuando está disponible. Si no lo está, el bot lo dice.
- **Efectivo en Cuba (CUP o USD):** se pide con la calculadora web y se entrega en mano.
- **Recargas** de teléfonos cubanos (nacional e internacional), con las opciones que estén activas.

## Cómo pedir una cotización

- Basta con escribir al bot el monto en reales, por ejemplo «300». El bot responde cuánto recibe la familia.
- También se puede escribir la intención («quiero enviar»): el bot pregunta el monto.
- Para ver las tasas del día: «tasa de hoy» o «a cómo está». El bot muestra la tabla y pregunta cuánto quieres enviar.
- Si sabes cuánto debe recibir tu familia, puedes preguntarlo al revés: «para que lleguen 85 mil CUP». El bot calcula cuántos reales necesitas enviar.
- La tasa de CUP mejora por tramos: con R$100 o más, con R$500 o más y con R$1000 o más.
- Una cotización vale 2 horas y solo el mismo día. Pasado ese tiempo, el bot vuelve a cotizar.
- Para confirmar basta con responder «sí», «ok», «dale» o «listo». Si escribes un monto nuevo, el bot cotiza de nuevo en lugar de confirmar el anterior.

## La tarjeta de destino

- La primera vez, el bot pide la tarjeta de destino: una foto de la tarjeta o sus 16 dígitos.
- Con la foto, el bot lee el número, el titular y el banco. No hace falta escribirlos.
- La tarjeta queda guardada. La próxima vez el bot pregunta si se usa de nuevo la tarjeta terminada en los mismos 4 dígitos, o deja elegir entre las guardadas («la primera», «la otra»). Para usar una distinta: «otra tarjeta».

## El pago por PIX

1. Al confirmar, el bot envía los datos del PIX: un código QR para escanear, la clave PIX en un mensaje aparte y el nombre del titular con su banco.
2. El cliente paga desde su banco en Brasil.
3. Después del pago, el cliente envía el comprobante al mismo chat: una foto o un PDF.
4. El bot lee el comprobante (valor, fecha, banco y destinatario) y registra la operación como pendiente de validación.

## Qué revisa el bot en el comprobante

- **El monto:** si el comprobante no coincide con el monto de la operación, el bot avisa para que lo revises y lo reenvíes.
- **El destinatario:** si el pago no fue a la cuenta de YORDA, la operación queda marcada para revisión manual.
- **Duplicados:** un comprobante ya usado no se vuelve a aceptar.
- **Pagos distintos:** si llega un segundo comprobante diferente, el bot pregunta si es otro pago o un error.
- **Revisión humana:** cada pago lo valida una persona antes de procesarlo. Un comprobante recibido todavía no es un pago confirmado.

## Qué pasa después del pago

- Cuando el pago se confirma, el cliente recibe un mensaje de confirmación.
- Cuando la transferencia se completa, el cliente recibe un aviso de que se completó con éxito.
- Si una operación se cancela, el cliente también recibe un aviso.

## Entregas en efectivo

- Se piden con la calculadora web en cuatro pasos: calcular, datos, revisar y pagar.
- Datos necesarios para el efectivo: nombre y apellidos de quien recibe, teléfono de quien recibe en Cuba, provincia, municipio y dirección. Son opcionales una referencia, un teléfono alternativo y observaciones.
- Antes de pagar hay que marcar que revisaste los datos del beneficiario.
- Cobertura: se entrega en el municipio cabecera de las 16 provincias. En otro municipio, la disponibilidad se confirma por WhatsApp.
- Plazos: La Habana hasta 24 horas; resto de provincias hasta 48 horas, según la demanda y la disponibilidad. Fuera del municipio cabecera, el plazo empieza al confirmar la disponibilidad.
- El costo de entrega se suma aparte: nunca se descuenta de lo que recibe la familia.
- Mientras la entrega está pendiente, el cliente recibe avisos de seguimiento por la mañana y por la tarde. Al completarse, recibe un aviso de entrega completada.
- Al enviar el pedido por WhatsApp, el bot responde que lo recibió y que avisará en cuanto esté confirmado.

## Transferencias desde la calculadora web

- Datos necesarios: la tarjeta o cuenta de destino, con exactamente 16 dígitos. Son opcionales el nombre del beneficiario, el teléfono, el banco y observaciones.

## Recargas

1. El bot muestra las recargas disponibles con su precio y descripción.
2. Se elige con «1», «2», «nacional» o «internacional».
3. El bot pide el número cubano: 8 dígitos que empiezan por 5, con o sin +53.
4. El bot muestra un resumen y pregunta si se confirma; después envía el PIX.

## Cómo hablar con el bot para ir más rápido

- Escribe el monto directamente («300») en lugar de solo saludar.
- Ten a mano una foto clara de la tarjeta o sus 16 dígitos.
- Paga el PIX y envía el comprobante en el mismo chat, como foto o PDF.
- Para empezar de nuevo: «olvida eso» o «cancela». Para pausar: «espera».
- El bot atiende solo mensajes de texto, no audios.
- Horario de atención: de 8:00 a 23:00, hora de Brasil. Fuera de horario el bot avisa, y por la mañana responde a quien escribió de noche. Los comprobantes enviados fuera de horario se procesan igualmente.

## Errores frecuentes

- **Foto de tarjeta poco clara:** el bot pide otra foto más clara o los 16 dígitos escritos.
- **Comprobante con un monto distinto al de la operación:** el bot pide revisarlo y reenviarlo.
- **Pedir el PIX sin haber dicho el monto:** el bot pide primero el monto.
- **Número de recarga inválido:** debe ser un número cubano de 8 dígitos que empiece por 5.
- **Cotización vencida:** pasadas 2 horas o al cambiar el día, hay que pedir una nueva cotización.
- **Datos del beneficiario del efectivo:** revísalos bien antes de pagar; se confirman en el paso de revisión.

## Si algo no sale bien

- Si el bot no entiende, ofrece hablar con una persona.
- Si hay un problema técnico al registrar la operación, el comprobante queda guardado y una persona lo revisa.
- Si el destinatario del comprobante no coincide, la operación queda en revisión manual, no se pierde.

## Programa VIP

- Hay tres niveles (⭐, ⭐⭐ y ⭐⭐⭐) según la actividad del último año.
- Beneficios: tasa preferencial en los envíos de CUP, descuento en la entrega en efectivo y promociones exclusivas.

## Seguridad

- Cada pago se revisa manualmente antes de procesarse.
- Los comprobantes duplicados se detectan y no se aceptan dos veces.
- La operación avisa al cliente en cada paso: pago recibido, operación completada o cancelada.
- El bot nunca inventa tasas ni da una operación por confirmada antes de tiempo.
