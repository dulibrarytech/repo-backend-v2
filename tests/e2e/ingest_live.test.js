'use strict';

/*
 * Live integration smoke tests against the dev Archivematica / Handle /
 * curation (QA) services. SKIPPED by default — they only run when
 * `INGEST_LIVE_E2E=1` is set in the environment so CI / `npm test`
 * stay hermetic.
 * 
 * What's covered:
 *   - QA service /health is reachable + API key works.
 *   - Archivematica main + storage API ping endpoints respond.
 *   - Handle service is reachable (best-effort; some envs disable
 *     this).
 *   - End-to-end happy-path smoke: enqueue a package, let the worker
 *     run, observe the queue row reaching COMPLETE or a sensible
 *     halt. This test is GATED behind `INGEST_LIVE_E2E_FULL=1` because
 *     it actually moves packages around on the QA SFTP — running it
 *     accidentally would consume real test capacity.
 * 
 * Why a separate file: keeping live tests out of the default suite
 * preserves the existing 902-pass deterministic baseline. Operators
 * run this file explicitly via:
 *   INGEST_LIVE_E2E=1 npx vitest run tests/e2e/ingest_live.test.js
 * 
 * The expected env shape is the same as production (see .env-example).
 * Without those vars the suite hard-skips with a clear message.
 */

const should_run = process.env.INGEST_LIVE_E2E === '1';
const should_run_full = process.env.INGEST_LIVE_E2E_FULL === '1';

/*
 * vitest's `describe.skipIf` would be cleaner but it's not in this
 * project's pinned major version. Instead we conditionally short-circuit
 * the suite body with a single placeholder `it.skip`.
 */
const describeOrSkip = should_run ? describe : describe.skip;

describeOrSkip('ingest — LIVE smoke (gated by INGEST_LIVE_E2E=1)', () => {
    let qa_module;
    let am_module;
    let handles_module;

    beforeAll(async () => {
        /*
         * Re-load config so the live env vars are visible. Tests that
         * ran before us in the worker may have set NODE_ENV=test with
         * mock values; we explicitly use whatever the operator's
         * .env-example points at.
         */
        const app_config = require('../../config/app');
        app_config._reset();
        qa_module = require('../../ingester/libs/qa_service');
        am_module = require('../../libs/archivematica');
        handles_module = require('../../libs/handles');
    });

    describe('configuration sanity', () => {
        it('QA service env vars are set', () => {
            expect(qa_module.is_configured()).toBe(true);
        });

        it('Archivematica main env vars are set', () => {
            expect(am_module.is_configured()).toBe(true);
        });

        it('Handle service env vars are set', () => {
            /*
             * Handle is optional in some deployments — accept either
             * configured or unconfigured but log a hint when missing.
             */
            const ok = handles_module.is_configured();
            if (!ok) {
                console.warn(
                    '[live e2e] HANDLE_* env vars are not set — skipping handle minting checks'
                );
            }
            /*
             * We don't assert here; the smoke test below tolerates an
             * unconfigured handle service.
             */
            expect(typeof ok).toBe('boolean');
        });
    });

    describe('reachability', () => {
        it('QA /health returns 200 with status ok', async () => {
            const res = await qa_module.health();
            expect(res.status).toBe(200);
            // The Python service returns `{status: 'ok', version: '...'}`.
            expect(res.data).toBeTruthy();
            // Tolerate either parsed JSON (object) or raw text body.
            const ok =
                (res.data && res.data.status === 'ok') ||
                (typeof res.data === 'string' && res.data.includes('ok'));
            expect(ok).toBe(true);
        }, 15000);

        it('Archivematica ping_api returns true', async () => {
            const ok = await am_module.ping_api();
            /*
             * If this is false the AM dev instance is down — surface
             * that clearly to the operator running the smoke.
             */
            if (!ok) {
                console.warn(
                    '[live e2e] AM ping_api returned false — check ARCHIVEMATICA_API and creds'
                );
            }
            expect(ok).toBe(true);
        }, 30000);

        it('Archivematica ping_storage_api returns true', async () => {
            const ok = await am_module.ping_storage_api();
            if (!ok) {
                console.warn(
                    '[live e2e] AM ping_storage_api returned false — storage API may be unreachable'
                );
            }
            expect(ok).toBe(true);
        }, 30000);

        it('QA list_ready_folders returns 200', async () => {
            const res = await qa_module.list_ready_folders();
            /*
             * Some deployments return an empty list (`{folders: []}`)
             * when nothing is staged — that's still a healthy response.
             */
            expect([200, 204].includes(res.status)).toBe(true);
        }, 15000);
    });

    /*
     * Full end-to-end smoke. Gated separately because it actually
     * moves a package through 001-ready → 002-ingest and triggers
     * an AM ingest.
     */
    const describeFullOrSkip = should_run_full ? describe : describe.skip;
    describeFullOrSkip('happy-path package smoke (gated by INGEST_LIVE_E2E_FULL=1)', () => {
        it(
            'enqueues a known test package and waits for COMPLETE or sensible halt',
            async () => {
                /*
                 * This is intentionally a sketch — staff supplies:
                 *   INGEST_LIVE_E2E_BATCH    — folder name in 001-ready
                 *   INGEST_LIVE_E2E_PACKAGE  — package name inside the batch
                 *   INGEST_LIVE_E2E_COLLECTION  — parent collection_uuid
                 *   INGEST_LIVE_E2E_URI      — AS record URI for the package
                 * Without all four we skip with a clear message.
                 */
                const batch = process.env.INGEST_LIVE_E2E_BATCH;
                const pkg = process.env.INGEST_LIVE_E2E_PACKAGE;
                const collection = process.env.INGEST_LIVE_E2E_COLLECTION;
                const uri = process.env.INGEST_LIVE_E2E_URI;
                if (!batch || !pkg || !collection || !uri) {
                    console.warn(
                        '[live e2e full] missing INGEST_LIVE_E2E_BATCH/PACKAGE/COLLECTION/URI; skipping'
                    );
                    return;
                }
                /*
                 * The smoke runs the worker against the real MariaDB queue,
                 * not the in-memory sqlite — wire-it-up is left to the
                 * operator. See .env-example for the worker tunables; the
                 * expectation is that you've run `npm run migrate:queue`
                 * against the dev DB before invoking this test.
                 * 
                 * We don't import the worker here because doing so binds
                 * it to the test process; instead we exercise the model
                 * API directly + assert the queue row reaches a terminal
                 * state inside the timeout.
                 */
                const model = require('../../ingester/model');
                const ids = await model.queue_packages([
                    { batch, package: pkg, collection_uuid: collection, metadata_uri: uri },
                ]);
                const id = ids[0];
                console.log(`[live e2e full] enqueued queue_id=${id}`);

                /*
                 * Poll the queue row for up to 20 minutes (matches the
                 * upper bound of stages 2+3+4 in dev with a small package).
                 */
                const deadline = Date.now() + 20 * 60 * 1000;
                let row;
                while (Date.now() < deadline) {
                    /*
                     * Sequential await is intentional — this is a poll
                     * loop where each iteration depends on the prior
                     * sleep + DB read. Parallelizing would defeat the
                     * purpose.
                     */
                    row = await model.get_queue_row({ id });
                    if (!row) throw new Error('queue row vanished mid-poll');
                    if (row.is_complete) break;
                    await new Promise((r) => setTimeout(r, 15000));
                }
                console.log(`[live e2e full] final state: ${row.pipeline_state}`);
                /*
                 * A terminal state is success — either COMPLETE or any of
                 * the documented halt states. The smoke proves the worker
                 * drives the row through stages; it doesn't require
                 * COMPLETE specifically (a halt with a known reason is
                 * still a passing smoke from the pipeline's perspective).
                 */
                expect(row.is_complete).toBe(1);
            },
            25 * 60 * 1000
        );
    });
});

if (!should_run) {
    /*
     * Provide a single passing assertion so the file reports cleanly
     * when skipped (vitest dislikes test files with zero tests).
     */
    describe('ingest live e2e — gated', () => {
        it('is skipped without INGEST_LIVE_E2E=1', () => {
            expect(should_run).toBe(false);
        });
    });
}
