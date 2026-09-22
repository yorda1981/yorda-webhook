"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const axiosPath = require.resolve("axios");
const zapiPath = require.resolve("../src/services/zapi");
const axiosOriginal = require.cache[axiosPath];
const zapiOriginal = require.cache[zapiPath];
const llamadas = [];

require.cache[axiosPath] = {
    id: axiosPath, filename: axiosPath, loaded: true,
    exports: async config => {
        llamadas.push(config);
        if (config.url.includes("send-text") && config.data.message === "FALLA") throw new Error("Z-API rechazó el envío");
        return { data: { ok: true } };
    }
};
delete require.cache[zapiPath];
const { enviarConDelay } = require("../src/services/zapi");
const { enviarSeguro } = require("../src/flows/shared");

test.after(() => {
    if (axiosOriginal) require.cache[axiosPath] = axiosOriginal;
    else delete require.cache[axiosPath];
    if (zapiOriginal) require.cache[zapiPath] = zapiOriginal;
    else delete require.cache[zapiPath];
});

test("enviarConDelay propaga éxito y fallo reales de enviarMensaje sin WhatsApp real", async () => {
    assert.equal(await enviarConDelay("5511999", "OK", 0), true);
    assert.equal(await enviarConDelay("5511999", "FALLA", 0), false);
});

test("enviarSeguro propaga el resultado de su transporte", async () => {
    assert.equal(await enviarSeguro("5511999", "ok", 0, false, async () => true), true);
    assert.equal(await enviarSeguro("5511999", "ok", 0, false, async () => false), false);
});
