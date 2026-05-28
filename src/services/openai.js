const axios = require("axios");

async function procesarMensaje(
phone,
textMessage
) {

console.log(
"Mensaje recibido:",
phone,
textMessage
);

}

module.exports = {
procesarMensaje
};
