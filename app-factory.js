const restify = require('restify');
const SwaggerRestifyMw = require('swagger-restify-mw');
const morgan = require('morgan');
const bodyParser = require('body-parser');
const elasticApmNode = require('elastic-apm-node');

const { ResponseJsonMiddleware } = require('./middlewares/response-json-middleware');

let UnexpectedError;

const verifyIntegrityErrors = ({ integrityCheckers }) => {
  const errors = integrityCheckers.map((checker) => {
    try {
      checker();
      return null;
    } catch (error) {
      return error;
    }
  }).filter(error => error);
  if (errors.length) {
    throw new UnexpectedError(errors
      .reduce((acc, error) => `${acc || ''}${error.message}\n`));
  }
};

const injectSwaggerToApp = ({ app, appRoot, swaggerFile }) => new Promise((resolve, reject) => {
  SwaggerRestifyMw.create({ appRoot, swaggerFile }, (err, swaggerRestify) => {
    if (err) {
      reject(err);
      return;
    }
    swaggerRestify.register(app);
    resolve();
  });
});

const registerGracefulShutdown = ({ app, closeSequelize, logger }) => {
  const gracefulShutdown = () => {
    app.close();
    closeSequelize()
      .then(() => { process.exit(0); })
      .catch((err) => {
        logger.error(err);
        process.exit(1);
      });
  };
  process.on('SIGINT', gracefulShutdown);
};

const notifyProcessInitializedGracefully = () => {
  // for more information see https://pm2.io/doc/en/runtime/best-practices/graceful-shutdown/
  if (process.send) process.send('ready');
};

const setupElasticApm = ({ logger, elasticApmEnabled }) => {
  logger.info(`ElasticSearch APM enabled: ${elasticApmEnabled || false}`);

  if (elasticApmEnabled) {
    logger.info(`Init ElasticSearch APM enabled: ${process.env.ES_APM_ENABLED}`);
    elasticApmNode.start({
      serviceName: process.env.APM_SERVICE_NAME || 'default',
      serverUrl: process.env.APM_SERVICE_HOST,
    });
  }
};

module.exports.createApp = ({ integrityCheckers }) => {
  verifyIntegrityErrors({ integrityCheckers });
  return restify.createServer();
};

module.exports.injectMiddlewaresAndListen = async ({
  app, isSentryEnabled, isDevelopment, isLogRequestEnabled, logger, sentry,
  closeSequelize, port, env, appRoot, swaggerFile, isElasticApmEnabled, isNewRelicApmEnabled,
  requestTraceMiddleware, prometheusMiddleware, auditTrailMiddleware, unexpectedError,
}) => {
  UnexpectedError = unexpectedError;

  if (isSentryEnabled) {
    app.use(sentry.Handlers.requestHandler());
  }

  if (isLogRequestEnabled) {
    if (isDevelopment) {
      app.use(morgan('dev'));
    } else {
      app.use(morgan('combined'));
    }
  }
  logger.info(`NewRelic APM enabled: ${isNewRelicApmEnabled}`);
  setupElasticApm({ logger, elasticApmEnabled: isElasticApmEnabled });

  app.use(requestTraceMiddleware);
  app.use(prometheusMiddleware.requestCounters);
  app.use(prometheusMiddleware.responseCounters);
  app.use(ResponseJsonMiddleware);
  app.use(bodyParser.json({ limit: '50mb' }));
  app.use(bodyParser.urlencoded({ extended: true }));
  app.use(restify.plugins.multipartBodyParser());
  prometheusMiddleware.injectMetricsRoute(app);

  await injectSwaggerToApp({ app, appRoot, swaggerFile });
  app.on('after', auditTrailMiddleware);
  app.listen(port);
  logger.info(`API running on http://localhost:${port}`);
  logger.info(`API running on ${env.toUpperCase()} mode.`);

  notifyProcessInitializedGracefully();
  registerGracefulShutdown({ app, closeSequelize, logger });

  return app;
};
