function logger(level, event, meta = {}) {

  console.log(
    JSON.stringify({

      level,
      event,

      timestamp:
        new Date().toISOString(),

      ...meta
    })
  );
}

module.exports = logger;
