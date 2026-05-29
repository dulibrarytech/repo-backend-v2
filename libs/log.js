'use strict';

// Structured logger. JSON layout in production (for log aggregators),
// plain colored output in development. Silent in tests unless
// ENABLE_TEST_LOGS=1.
//
// Usage:
//   const log = require('./libs/log');
//   log.info({ request_id, msg: 'something happened' });
//   log.error({ err: { message, stack } });

const path = require('node:path');
const fs = require('node:fs');
const log4js = require('log4js');

const env = process.env.NODE_ENV || 'development';
const level = (process.env.LOG_LEVEL || (env === 'production' ? 'info' : 'debug')).toLowerCase();

const logs_dir = path.resolve(__dirname, '..', 'logs');
try {
    fs.mkdirSync(logs_dir, { recursive: true });
} catch {
    // Best-effort; logger still works with stdout-only.
}

// log4js has NO built-in 'json' layout — its built-ins are only
// messagePassThrough / basic / colored / dummy / pattern. The custom
// 'json' layout the production appenders below reference MUST be
// registered with addLayout() BEFORE configure(), or log4js stores
// `undefined` as the appender layout and the first log call throws
// "TypeError: layout is not a function" (which only surfaces under
// NODE_ENV=production — e.g. when launched by systemd). Register it
// unconditionally; it's a no-op in dev/test where no appender uses it.
//
// One standalone JSON object per line (NDJSON) — the format Loki,
// Elastic, CloudWatch, Splunk, and Datadog all ingest directly. The
// optional `separator` config is honored if a future appender sets it,
// but we deliberately DON'T set one below: a trailing comma would make
// each line invalid standalone JSON.
log4js.addLayout('json', (config) => {
    const separator = (config && config.separator) || '';
    return (logEvent) => JSON.stringify(logEvent) + separator;
});

const appenders =
    env === 'production'
        ? {
              stdout: {
                  type: 'stdout',
                  layout: { type: 'json' },
              },
              file: {
                  type: 'dateFile',
                  filename: path.join(logs_dir, 'app.log'),
                  pattern: 'yyyy-MM-dd',
                  compress: true,
                  keepFileExt: true,
                  layout: { type: 'json' },
              },
          }
        : { stdout: { type: 'stdout' } };

log4js.configure({
    appenders,
    categories: {
        default: { appenders: Object.keys(appenders), level },
    },
});

const logger = log4js.getLogger();

if (env === 'test' && process.env.ENABLE_TEST_LOGS !== '1') {
    logger.level = 'off';
}

module.exports = logger;
