const {
enviarMensaje
} = require("./zapi");

async function procesarMensaje(
phone,
textMessage
) {

console.log(
"Mensaje recibido:",
phone,
textMessage
);

await enviarMensaje(

```
phone,

`🔥 YordaBot recibió:
```

${textMessage}`
);
}

module.exports = {
procesarMensaje
};
