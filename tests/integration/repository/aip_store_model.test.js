'use strict';

/*
 * Integration tests for repository/aip_store_model.js. Real sqlite
 * in-memory DB via the test harness; no curation-service or AM
 * contact — those are stubbed at the Stage 6 boundary, tested in
 * tests/integration/ingester/aip_store_stage.test.js.
 */

const { randomUUID } = require('node:crypto');

const model = require('../../../repository/aip_store_model');
const db_helper = require('../../helpers/db');
const { db } = require('../../../config/db');
const tables = require('../../../config/db_tables');
const { NotFoundError, ValidationError } = require('../../../libs/errors');

const AIP_STORE = tables.aip_store;

describe('repository/aip_store_model', () => {
    beforeAll(async () => {
        await db_helper.setup_schema();
    });
    beforeEach(async () => {
        await db_helper.reset_data();
    });
    afterAll(async () => {
        await db_helper.teardown();
    });

    describe('STATUS / SOURCE constants', () => {
        it('matches the legacy is_migrated codes', () => {
            expect(model.STATUS.LEGACY_NOT_FOUND).toBe(2);
            expect(model.STATUS.LEGACY_REQUEST_FAILED).toBe(3);
            expect(model.STATUS.LEGACY_MIGRATED_OK).toBe(5);
            // v2-ingest codes follow the legacy sequence.
            expect(model.STATUS.INGEST_COPIED_OK).toBe(6);
            expect(model.STATUS.INGEST_COPY_FAILED).toBe(7);
        });

        it('exposes a stable source label vocabulary', () => {
            expect(model.SOURCE.LEGACY_MIGRATION).toBe('legacy_migration');
            expect(model.SOURCE.INGEST_V2).toBe('ingest_v2');
        });
    });

    describe('is_terminal_success / is_failure / is_orphan', () => {
        it('treats both legacy_migrated_ok (5) and ingest_copied_ok (6) as success', () => {
            expect(model.is_terminal_success({ is_migrated: 5 })).toBe(true);
            expect(model.is_terminal_success({ is_migrated: 6 })).toBe(true);
        });
        it('treats not_found (2), request_failed (3), and ingest_copy_failed (7) as failure', () => {
            expect(model.is_failure({ is_migrated: 2 })).toBe(true);
            expect(model.is_failure({ is_migrated: 3 })).toBe(true);
            expect(model.is_failure({ is_migrated: 7 })).toBe(true);
        });
        it('treats AM_NOT_FOUND (8) as orphan, NOT as failure', () => {
            /*
             * Critical contract: dashboard's failure filter must NOT
             * include orphans (they need different UX — no Retry,
             * separate "Orphan" badge). is_orphan is the dedicated
             * predicate.
             */
            expect(model.is_orphan({ is_migrated: 8 })).toBe(true);
            expect(model.is_failure({ is_migrated: 8 })).toBe(false);
            expect(model.is_terminal_success({ is_migrated: 8 })).toBe(false);
        });
        it('treats initial (0) and unknown codes as neither', () => {
            expect(model.is_terminal_success({ is_migrated: 0 })).toBe(false);
            expect(model.is_failure({ is_migrated: 0 })).toBe(false);
            expect(model.is_orphan({ is_migrated: 0 })).toBe(false);
            expect(model.is_failure({ is_migrated: 99 })).toBe(false);
        });
        it('derive_display_status returns "orphan" for is_migrated=8', () => {
            expect(model.derive_display_status({ is_migrated: 8 })).toBe('orphan');
            expect(model.derive_display_status({ is_migrated: 7 })).toBe('failed');
            expect(model.derive_display_status({ is_migrated: 6 })).toBe('copied');
        });
    });

    describe('get_by_uuid', () => {
        it('returns null when no row exists for the PID', async () => {
            const result = await model.get_by_uuid(randomUUID());
            expect(result).toBeNull();
        });
        it('returns the row when one exists', async () => {
            const seeded = await db_helper.seed_aip_store({
                aip: 'M123.7z',
                is_migrated: 6,
            });
            const row = await model.get_by_uuid(seeded.uuid);
            expect(row).toBeTruthy();
            expect(row.aip).toBe('M123.7z');
            expect(row.is_migrated).toBe(6);
        });
        it('rejects a non-UUID input', async () => {
            await expect(model.get_by_uuid('not-a-uuid')).rejects.toBeInstanceOf(
                ValidationError
            );
        });
    });

    describe('upsert_by_uuid', () => {
        it('inserts a new row when none exists for the PID', async () => {
            const pid = randomUUID();
            const result = await model.upsert_by_uuid(pid, {
                aip: 'fresh.7z',
                source: model.SOURCE.INGEST_V2,
                is_migrated: model.STATUS.INGEST_COPIED_OK,
                bytes: 100,
            });
            expect(result.created).toBe(true);
            expect(result.id).toBeGreaterThan(0);
            const written = await db()(AIP_STORE).where({ id: result.id }).first();
            expect(written.uuid).toBe(pid);
            expect(written.aip).toBe('fresh.7z');
            expect(written.source).toBe('ingest_v2');
            expect(written.bytes).toBe(100);
        });

        it('overwrites an existing row with the same uuid', async () => {
            const seeded = await db_helper.seed_aip_store({
                aip: 'old.7z',
                is_migrated: 7, // copy_failed
            });
            const result = await model.upsert_by_uuid(seeded.uuid, {
                aip: 'new.7z',
                is_migrated: model.STATUS.INGEST_COPIED_OK,
                error: null,
            });
            expect(result.created).toBe(false);
            expect(result.id).toBe(seeded.id);
            const after = await db()(AIP_STORE).where({ id: seeded.id }).first();
            expect(after.aip).toBe('new.7z');
            expect(after.is_migrated).toBe(6);
        });

        it('backstops NOT NULL legacy columns with empty strings', async () => {
            /*
             * The caller's patch doesn't include `aip` or `aip_legacy`,
             * but the legacy schema declares them NOT NULL. The model
             * fills them with '' so a Stage 6 row that failed before
             * we knew the key still inserts cleanly.
             */
            const pid = randomUUID();
            await model.upsert_by_uuid(pid, {
                is_migrated: model.STATUS.INGEST_COPY_FAILED,
                error: 'oops',
            });
            const row = await db()(AIP_STORE).where({ uuid: pid }).first();
            expect(row.aip).toBe('');
            expect(row.aip_legacy).toBe('');
        });
    });

    describe('list', () => {
        it('returns paged results with derived display_status', async () => {
            await db_helper.seed_aip_store({ is_migrated: 6 });
            await db_helper.seed_aip_store({ is_migrated: 7, error: 'bad' });
            await db_helper.seed_aip_store({ is_migrated: 0 });
            const result = await model.list({});
            expect(result.total).toBe(3);
            const statuses = result.items.map((r) => r.display_status).sort();
            expect(statuses).toEqual(['copied', 'failed', 'in_progress']);
        });

        it('default sort floats attention rows (failed/in-flight) above copied rows', async () => {
            /*
             * Failed / in-flight rows never get copied_at, and MariaDB
             * sorts NULLs last under plain `copied_at DESC` — a failed
             * Stage 6 copy sank behind ~20k legacy rows (2026-07-31)
             * and staff concluded the AIP was missing. The default
             * sort must surface failed and in-flight rows first, with
             * the copied rows newest-first below them.
             */
            const old_ok = await db_helper.seed_aip_store({
                is_migrated: 6,
                copied_at: new Date('2026-01-01T00:00:00Z'),
            });
            const new_ok = await db_helper.seed_aip_store({
                is_migrated: 6,
                copied_at: new Date('2026-07-01T00:00:00Z'),
            });
            const failed = await db_helper.seed_aip_store({
                is_migrated: 7,
                error: 'copy failed',
                copied_at: null,
            });
            const in_flight = await db_helper.seed_aip_store({
                is_migrated: 0,
                copied_at: null,
            });
            const result = await model.list({});
            expect(result.items.map((r) => r.id)).toEqual([
                in_flight.id,
                failed.id,
                new_ok.id,
                old_ok.id,
            ]);
        });

        it('default sort sinks legacy migrated-OK and orphan rows below recent copies', async () => {
            /*
             * Regression: the previous default sort keyed on
             * `copied_at IS NULL` to float attention rows — but the
             * ~20k legacy migrated-OK rows (is_migrated=5) ALSO have
             * NULL copied_at, so every legacy row floated above the
             * timestamped v2 copies and "Most recent" showed the
             * legacy backlog instead of the most recently copied
             * AIPs. Terminal rows without a timestamp (legacy-OK,
             * orphans) must sort BELOW timestamped copies.
             */
            const legacy_ok = await db_helper.seed_aip_store({
                is_migrated: 5,
                source: 'legacy_migration',
                copied_at: null,
            });
            const orphan = await db_helper.seed_aip_store({
                is_migrated: 8,
                copied_at: null,
            });
            const recent_copy = await db_helper.seed_aip_store({
                is_migrated: 6,
                copied_at: new Date('2026-08-01T00:00:00Z'),
            });
            const result = await model.list({});
            expect(result.items.map((r) => r.id)).toEqual([
                recent_copy.id,
                orphan.id,
                legacy_ok.id,
            ]);
        });

        it('filters by status="failed"', async () => {
            await db_helper.seed_aip_store({ is_migrated: 6 });
            await db_helper.seed_aip_store({ is_migrated: 7 });
            await db_helper.seed_aip_store({ is_migrated: 3 });
            const result = await model.list({ status: 'failed' });
            expect(result.total).toBe(2);
            for (const r of result.items) expect(r.display_status).toBe('failed');
        });

        it('filters by status="orphan" returns only AM_NOT_FOUND rows', async () => {
            await db_helper.seed_aip_store({ is_migrated: 8 });
            await db_helper.seed_aip_store({ is_migrated: 8 });
            await db_helper.seed_aip_store({ is_migrated: 7 }); // failure, not orphan
            await db_helper.seed_aip_store({ is_migrated: 6 }); // copied
            const result = await model.list({ status: 'orphan' });
            expect(result.total).toBe(2);
            for (const r of result.items) expect(r.display_status).toBe('orphan');
        });

        it('status="failed" does NOT include orphans', async () => {
            /*
             * Regression: the previous list filter included is_migrated=8
             * in the "failed" bucket because the model didn't distinguish.
             * Now orphans are a separate filter — staff filtering for
             * retryable failures shouldn't see dead-end orphan rows.
             */
            await db_helper.seed_aip_store({ is_migrated: 7 });
            await db_helper.seed_aip_store({ is_migrated: 8 });
            const result = await model.list({ status: 'failed' });
            expect(result.total).toBe(1);
            expect(result.items[0].display_status).toBe('failed');
        });

        it('filter source="legacy_migration" matches explicit AND null', async () => {
            /*
             * One explicitly tagged legacy, one with source=null (the
             * pre-migration ~20k case), one v2.
             */
            await db_helper.seed_aip_store({ source: 'legacy_migration' });
            await db_helper.seed_aip_store({ source: null });
            await db_helper.seed_aip_store({ source: 'ingest_v2' });
            const result = await model.list({ source: 'legacy_migration' });
            expect(result.total).toBe(2);
        });

        it('q matches across uuid / aip / wasabi_key', async () => {
            const pid_a = '11111111-1111-1111-1111-111111111111';
            await db_helper.seed_aip_store({
                uuid: pid_a,
                aip: 'M123.7z',
                wasabi_key: 'aip-store/M123.7z',
            });
            await db_helper.seed_aip_store({ aip: 'M999.7z' });
            // Search by partial filename.
            const by_aip = await model.list({ q: 'M123' });
            expect(by_aip.total).toBe(1);
            // Search by partial PID.
            const by_uuid = await model.list({ q: '1111-1111-1111-1111' });
            expect(by_uuid.total).toBe(1);
        });
    });

    describe('derive_wasabi_key', () => {
        it('prefers wasabi_key when populated (v2 ingest path)', () => {
            const key = model.derive_wasabi_key({
                wasabi_key: 'aip-store/v2-row.7z',
                aip: 'v2-row.7z',
                aip_legacy: '/aip-store/abcd/.../v2-row_transfer.7z',
            });
            expect(key).toBe('aip-store/v2-row.7z');
        });

        it('falls back to aip when wasabi_key is empty (typical legacy row)', () => {
            const key = model.derive_wasabi_key({
                wasabi_key: null,
                aip: 'legacy-basename.7z',
                aip_legacy: '/aip-store/abcd/.../something.7z',
            });
            expect(key).toBe('legacy-basename.7z');
        });

        it('falls back to basename(aip_legacy) with _transfer stripped when aip empty', () => {
            /*
             * Regression: ~332 legacy rows have an empty `aip` column
             * (the migration's basename-extraction pass never ran).
             * derive_wasabi_key extracts the basename from aip_legacy
             * at request time so downloads work without a DB migration.
             */
            const key = model.derive_wasabi_key({
                wasabi_key: null,
                aip: '',
                aip_legacy:
                    '/aip-store/5819/82d8/197c/4401/8401/d390/25ec/e577/' +
                    'a5efb5d1-0484-429c-95a5-15c12ff40ca0_B002.01.0098.0035.00008' +
                    '_transfer-581982d8-197c-4401-8401-d39025ece577.7z',
            });
            expect(key).toBe(
                'a5efb5d1-0484-429c-95a5-15c12ff40ca0_B002.01.0098.0035.00008' +
                    '-581982d8-197c-4401-8401-d39025ece577.7z'
            );
        });

        it('returns null when all three columns are empty (true orphan)', () => {
            expect(
                model.derive_wasabi_key({ wasabi_key: null, aip: '', aip_legacy: null })
            ).toBeNull();
            expect(model.derive_wasabi_key({})).toBeNull();
            expect(model.derive_wasabi_key(null)).toBeNull();
        });

        it('handles aip_legacy without a leading slash', () => {
            const key = model.derive_wasabi_key({
                wasabi_key: null,
                aip: '',
                aip_legacy: 'aip-store/abcd/foo.7z',
            });
            expect(key).toBe('foo.7z');
        });
    });

    describe('reset_for_retry', () => {
        it('clears attempts + next_attempt_at + error + message, and resets is_migrated to INITIAL', async () => {
            const seeded = await db_helper.seed_aip_store({
                is_migrated: 7,
                attempts: 3,
                next_attempt_at: new Date(Date.now() + 60_000),
                error: 'wasabi timed out',
                message: 'COPY_FAILED',
            });
            const after = await model.reset_for_retry(seeded.id);
            expect(after.attempts).toBe(0);
            expect(after.next_attempt_at).toBeNull();
            expect(after.error).toBeNull();
            expect(after.message).toBeNull();
            /*
             * is_migrated reset to INITIAL so Stage 6 re-evaluates from
             * scratch — and so an orphan tag can't short-circuit the retry.
             */
            expect(after.is_migrated).toBe(model.STATUS.INITIAL);
        });

        it('clears an orphan tag (AM_NOT_FOUND → INITIAL) so "Re-check AM & retry" actually re-runs Stage 6', async () => {
            const seeded = await db_helper.seed_aip_store({
                is_migrated: model.STATUS.AM_NOT_FOUND,
                message: 'ORPHAN_AM_NOT_FOUND',
                error: 'AIP x not found in AM Storage Service',
            });
            expect(model.is_orphan(seeded)).toBe(true);
            const after = await model.reset_for_retry(seeded.id);
            /*
             * No longer an orphan → the Stage 6 entry short-circuit won't
             * fire, so the copy is actually attempted again.
             */
            expect(model.is_orphan(after)).toBe(false);
            expect(after.is_migrated).toBe(model.STATUS.INITIAL);
        });

        it('throws NotFoundError on missing id', async () => {
            await expect(model.reset_for_retry(999_999)).rejects.toBeInstanceOf(
                NotFoundError
            );
        });
    });

    describe('increment_downloaded', () => {
        it('atomically bumps the counter', async () => {
            const seeded = await db_helper.seed_aip_store({ downloaded: 7 });
            await model.increment_downloaded(seeded.id);
            await model.increment_downloaded(seeded.id);
            const row = await db()(AIP_STORE).where({ id: seeded.id }).first();
            expect(row.downloaded).toBe(9);
        });
    });
});
