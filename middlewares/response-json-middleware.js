const { NotFoundError } = require('restify');

function ResponseJsonMiddleware(req, res, next) {
  res.json = (json, statusCode = 200) => {
    res.writeHead(statusCode, {
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache',
      Expires: 0,
      'Content-Type': 'application/json',
    });
    res.end(JSON.stringify(json));
  };

  res.action = (localNext, actionFunction) => actionFunction()
    .then((obj) => {
      if (obj === null) {
        localNext(new NotFoundError());
      } else {
        res.json(obj);
      }
    })
    .catch((err) => {
      localNext(err);
    });

  res.xml = (xml, statusCode = 200) => {
    res.writeHead(statusCode, {
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache',
      Expires: 0,
      'Content-Type': 'application/xml',
    });
    res.end(xml);
  };

  next();
}

module.exports = { ResponseJsonMiddleware };
