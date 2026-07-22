'use strict';

/*
 * Vitest global setup. Loaded once per worker.
 * 
 * Sets NODE_ENV=test and seeds the minimum env vars required by config/
 * modules so tests don't have to maintain their own .env. Real values are
 * nonsense — these never touch production secrets.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

// Auth — JWT signing
process.env.TOKEN_SECRET = process.env.TOKEN_SECRET || 'test-secret-do-not-use-outside-vitest';
process.env.TOKEN_ALGO = process.env.TOKEN_ALGO || 'HS256';
process.env.TOKEN_EXPIRES = process.env.TOKEN_EXPIRES || '1h';
process.env.TOKEN_ISSUER = process.env.TOKEN_ISSUER || 'test.invalid';

// CORS allowlist used by config/security
process.env.CORS_ALLOWED_ORIGINS = process.env.CORS_ALLOWED_ORIGINS || 'http://allowed.example';

// App identity / paths
process.env.APP_NAME = process.env.APP_NAME || 'repo-backend-v2-test';
process.env.APP_PATH = process.env.APP_PATH || '/repo';
process.env.APP_PORT = process.env.APP_PORT || '0';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'off';

/*
 * Belt-and-braces: never let a test process exit silently because of an
 * unhandled rejection in a non-awaited promise.
 */
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection in test:', reason);
    throw reason instanceof Error ? reason : new Error(String(reason));
});
