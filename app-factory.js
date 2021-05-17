const restify = require('restify');
const SwaggerRestifyMw = require('swagger-restify-mw');
const morgan = require('morgan');
const bodyParser = require('body-parser');
const elasticApmNode = require('elastic-apm-node');

const { ResponseJsonMiddleware } = require('./middlewares/response-json-middleware');

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
    throw new Error(errors
      .reduce((acc, error) => `${acc || ''}${error.message}\n`, ''));
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

// Kubernetes will wait for up to the grace period before forcibly killing the process
const GRACE_PERIOD = 29 * 1000;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const registerGracefulShutdown = ({ app, closeSequelize, logger }) => {
  let initTime;
  const gracefulShutdown = async (signal) => {
    initTime = new Date();
    logger.info(`Starting app graceful shutdown after signal ${signal}`);
    let exitCode = 0
    if (process.env.NODE_ENV === 'production') {
      await sleep(GRACE_PERIOD);
    }
    try {
      await Promise.all([
        new Promise((resolve) => app.close(resolve)),
        closeSequelize(),
      ]);
    } catch (err) {
      exitCode = 1;
      logger.error(err);
    }
    const stopTime = new Date();
    logger.info(`Shutdown graceful ${stopTime - initTime} ms after signal`);
    process.exit(exitCode);
  };
  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);
  process.on('exit', (code) => {
    const stopTime = new Date();
    logger.info(`Process exit ${stopTime - initTime} ms after signal`);
    logger.info(`About to exit with code: ${code}`);
  });
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

module.exports.createApp = () => {
  return restify.createServer();
};

module.exports.injectMiddlewaresAndListen = async ({
  app, isSentryEnabled, isDevelopment, isLogRequestEnabled, logger, sentry, swaggerRoutePathMiddleware,
  closeSequelize, port, env, appRoot, swaggerFile, isElasticApmEnabled, isNewRelicApmEnabled,
  requestTraceMiddleware, prometheusMiddleware, auditTrailMiddleware, integrityCheckers = [],
}) => {
  verifyIntegrityErrors({ integrityCheckers });

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
  app.use((req, res, next) => {
    res.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload')
    return next();
  })
  prometheusMiddleware.injectMetricsRoute(app);

  await injectSwaggerToApp({ app, appRoot, swaggerFile });

  app.on('after', swaggerRoutePathMiddleware);
  app.on('after', auditTrailMiddleware);
  app.listen(port);
  logger.info(`API running on http://localhost:${port}`);
  logger.info(`API running on ${env.toUpperCase()} mode.`);

  notifyProcessInitializedGracefully();
  registerGracefulShutdown({ app, closeSequelize, logger });

  return app;
};
