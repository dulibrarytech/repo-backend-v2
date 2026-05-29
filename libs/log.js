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

const appenders =
    env === 'production'
        ? {
              stdout: {
                  type: 'stdout',
                  layout: { type: 'json', separator: ',' },
              },
              file: {
                  type: 'dateFile',
                  filename: path.join(logs_dir, 'app.log'),
                  pattern: 'yyyy-MM-dd',
                  compress: true,
                  keepFileExt: true,
                  layout: { type: 'json', separator: ',' },
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
