const Redis = require("ioredis");

const {
  REDIS_URL
} = require("../config/env");

let redis = null;

try {

  if (REDIS_URL) {

    redis =
      new Redis(
        REDIS_URL
      );

    console.log(
      "✅ Redis conectado"
    );

  } else {

    console.log(
      "⚠️ REDIS_URL no configurado"
    );
  }

} catch (e) {

  console.log(
    "❌ Error Redis:",
    e.message
  );
}

module.exports =
  redis;
