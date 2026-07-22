/**
 * repo-backend-v2 — entry point.
 *
 * Phase 1: boots the Express app, listens on APP_PORT, installs signal
 * handlers, exports the app instance for tests. Phase 4 will plug DB
 * pool drains into the shutdown path.
 *
 * Copyright 2026 University of Denver
 * Licensed under the Apache License, Version 2.0.
 */

'use strict';

require('dotenv').config();

/*
 * IMPORTANT: do NOT set NODE_TLS_REJECT_UNAUTHORIZED here. The legacy
 * repo.js set it globally and unconditionally — see
 * docs/MODERNIZATION_PLAN.md §1.1. If a dev host needs a self-signed
 * cert, add it to NODE_EXTRA_CA_CERTS instead.
 */

const create_app = require('./config/express');
const app_config = require('./config/app');
const db_module = require('./config/db');
const log = require('./libs/log');
const { create_worker: create_metadata_worker } = require('./metadata/worker');
const { create_producer: create_metadata_producer } = require('./metadata/producer');
const { create_worker: create_indexer_worker } = require('./indexer/worker');
const {
    create_worker: create_ingest_worker,
    set_active_worker: set_active_ingest_worker,
} = require('./ingester/worker');
const { create_worker: create_convert_worker } = require('./convert/worker');

const cfg = app_config();
const app = create_app();

/*
 * Three long-running workers: metadata-refresh syncs from
 * ArchivesSpace, indexer pushes to Elasticsearch, ingest drives
 * packages through the 5-stage Archivematica pipeline. All three
 * follow the same lifecycle (start after listen, stop before DB
 * drain). Concurrency is bounded independently — see config/app.js
 * metadata_worker, indexer, ingest_worker blocks.
 */
const metadata_worker = create_metadata_worker();
/*
 * Producer is the system-refresh sibling of the metadata worker. It's
 * idle until an admin starts a batch via the admin page; once active
 * it paces queue inserts so the table stays bounded regardless of
 * repo size. See metadata/producer.js for cadence + chunk size.
 */
const metadata_producer = create_metadata_producer();
const indexer_worker = create_indexer_worker();
const ingest_worker = create_ingest_worker();
/*
 * Register the live ingest worker so the dashboard controller can
 * signal mid-stage AbortControllers (staff Cancel button). See
 * ingester/worker.js — `set_active_worker` writes a module-level
 * reference, NOT a global; controller reads via `get_active_worker`.
 */
set_active_ingest_worker(ingest_worker);
/*
 * TIFF→JPG conversion worker. Serial + paced (one POST every
 * CONVERT_SERVICE_DELAY_MS) because the remote convert service is
 * fragile under load. Idle until a collection/object batch is enqueued
 * from the dashboard (/dashboard/admin/convert). See convert/worker.js.
 */
const convert_worker = create_convert_worker();

let server = null;
let shutting_down = false;

async function shutdown(signal) {
    if (shutting_down) return;
    shutting_down = true;
    log.info({ event: 'shutdown', signal, msg: 'graceful shutdown initiated' });

    /*
     * 10s hard timeout — if anything hangs, exit non-zero so the process
     * supervisor (systemd / PM2) restarts us.
     */
    const timer = setTimeout(() => {
        log.error({ event: 'shutdown', msg: 'timeout exceeded, forcing exit' });
        process.exit(1);
    }, 10_000);
    timer.unref();

    try {
        if (server) {
            await new Promise((resolve, reject) => {
                server.close((err) => (err ? reject(err) : resolve()));
            });
            log.info({ event: 'shutdown', msg: 'HTTP server closed' });
        }
        /*
         * Drain workers BEFORE killing the DB pools — either may have
         * an in-flight call whose result still needs to land in the
         * DB. Drain in parallel; both bounded at 8s.
         */
        await Promise.all([
            metadata_worker.stop({ timeout_ms: 8000 }),
            // Producer is DB-only — drains in milliseconds. 3s is plenty.
            metadata_producer.stop({ timeout_ms: 3000 }),
            indexer_worker.stop({ timeout_ms: 8000 }),
            /*
             * Ingest worker gets a longer drain because its long polls
             * (AM transfer-status, QA upload-status) need a beat to
             * react to abort signals before the next cancel-loop tick.
             */
            ingest_worker.stop({ timeout_ms: 12000 }),
            /*
             * Convert worker aborts its in-flight POST on stop; 8s is
             * plenty for the abort + the row release to land.
             */
            convert_worker.stop({ timeout_ms: 8000 }),
        ]);
        log.info({ event: 'shutdown', msg: 'workers stopped' });
        await db_module.destroy_all();
        log.info({ event: 'shutdown', msg: 'DB pools drained' });
        clearTimeout(timer);
        process.exit(0);
    } catch (err) {
        log.error({ event: 'shutdown', err: { message: err.message, stack: err.stack } });
        clearTimeout(timer);
        process.exit(1);
    }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
    log.error({ event: 'unhandledRejection', reason: String(reason) });
});
process.on('uncaughtException', (err) => {
    log.error({
        event: 'uncaughtException',
        err: { message: err.message, stack: err.stack },
    });
    // Best practice: treat as fatal. Let supervisor restart us.
    shutdown('uncaughtException');
});

/*
 * Only listen when invoked directly. When required by tests (supertest
 * uses the bare app), we don't want to bind a port.
 */
if (require.main === module) {
    server = app.listen(cfg.port);

    /*
     * listen() is async — failures (EADDRINUSE, EACCES) arrive on the
     * 'error' event, not via a thrown exception. Without this handler
     * they'd surface as uncaughtException, which would race against the
     * 'listening' callback below.
     */
    server.on('error', (err) => {
        log.error({
            event: 'listen_error',
            port: cfg.port,
            err: { message: err.message, code: err.code },
        });
        console.error(`${cfg.name}: failed to bind port ${cfg.port}: ${err.message}`);
        // No graceful path here — DB pools aren't open yet, just exit.
        process.exit(1);
    });

    server.on('listening', () => {
        const addr = server.address();
        log.info({
            event: 'startup',
            app: cfg.name,
            version: cfg.version,
            env: cfg.env,
            listening: addr ? `http://${addr.address}:${addr.port}` : `port ${cfg.port}`,
        });
        console.log(
            `${cfg.name} v${cfg.version} listening on http://${cfg.host}:${(addr && addr.port) || cfg.port} ` +
                `(NODE_ENV=${cfg.env})`
        );
        /*
         * Start both workers once the HTTP server is up. Failures
         * here don't block the rest of the app — workers log and
         * stay idle until their upstream is reachable.
         */
        metadata_worker.start().catch((err) => {
            log.error({ event: 'metadata_worker_start_failed', err: err.message });
        });
        metadata_producer.start().catch((err) => {
            log.error({ event: 'metadata_producer_start_failed', err: err.message });
        });
        indexer_worker.start().catch((err) => {
            log.error({ event: 'indexer_worker_start_failed', err: err.message });
        });
        ingest_worker.start().catch((err) => {
            log.error({ event: 'ingest_worker_start_failed', err: err.message });
        });
        convert_worker.start().catch((err) => {
            log.error({ event: 'convert_worker_start_failed', err: err.message });
        });
    });
}

module.exports = app;
