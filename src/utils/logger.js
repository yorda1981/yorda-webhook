function logger(
  level,
  event,
  data = {}
) {

  console.log(

    JSON.stringify({

      level,
      event,
      ...data,
      timestamp:
        new Date()
        .toISOString()
    })
  );
}

module.exports =
  logger;
