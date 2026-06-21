'use strict';

const { randomUUID } = require('node:crypto');
const repo_model = require('../../../repository/model');
const db_helper = require('../../helpers/db');
const { NotFoundError, ValidationError } = require('../../../libs/errors');

describe('repository/model — DB integration', () => {
    beforeAll(async () => {
        await db_helper.setup_schema();
    });
    beforeEach(async () => {
        await db_helper.reset_data();
    });
    afterAll(async () => {
        await db_helper.teardown();
    });

    it('list returns paginated results with total count', async () => {
        for (let i = 0; i < 5; i++) {
            await db_helper.seed_object({ is_published: i % 2 });
        }
        const page1 = await repo_model.list({ page: 1, page_size: 2 });
        expect(page1.items).toHaveLength(2);
        expect(page1.total).toBe(5);
        expect(page1.page).toBe(1);
        const page3 = await repo_model.list({ page: 3, page_size: 2 });
        expect(page3.items).toHaveLength(1);
    });

    it('list filters by is_published', async () => {
        await db_helper.seed_object({ is_published: 1 });
        await db_helper.seed_object({ is_published: 0 });
        await db_helper.seed_object({ is_published: 0 });
        const published = await repo_model.list({ is_published: true });
        expect(published.total).toBe(1);
        const unpublished = await repo_model.list({ is_published: false });
        expect(unpublished.total).toBe(2);
    });

    it('list filters by collection', async () => {
        await db_helper.seed_object({ is_member_of_collection: 'codu:A' });
        await db_helper.seed_object({ is_member_of_collection: 'codu:A' });
        await db_helper.seed_object({ is_member_of_collection: 'codu:B' });
        const a = await repo_model.list({ collection: 'codu:A' });
        expect(a.total).toBe(2);
    });

    it('list filters by object_type', async () => {
        await db_helper.seed_object({ object_type: 'collection' });
        await db_helper.seed_object({ object_type: 'object' });
        const cols = await repo_model.list({ object_type: 'collection' });
        expect(cols.total).toBe(1);
    });

    it('list filters by created_since (recent-ingests window)', async () => {
        // Backs the Recent Ingests view: only objects created at/after the
        // cutoff are returned. `created` defaults to now() on seed, so an
        // explicit old created is excluded by a recent cutoff.
        await db_helper.seed_object({ pid: 'codu:old', created: '2020-01-01 00:00:00' });
        await db_helper.seed_object({ pid: 'codu:fresh' });
        const cutoff = new Date(Date.now() - 30 * 86400000)
            .toISOString()
            .slice(0, 19)
            .replace('T', ' ');
        const r = await repo_model.list({ created_since: cutoff });
        const pids = r.items.map((row) => row.pid);
        expect(pids).toContain('codu:fresh');
        expect(pids).not.toContain('codu:old');
        expect(r.total).toBe(1);
    });

    it('get by pid returns the public projection', async () => {
        const seeded = await db_helper.seed_object({ object_type: 'collection' });
        const found = await repo_model.get(seeded.pid);
        expect(found.pid).toBe(seeded.pid);
        // Model layer returns display_record so the controller can
        // enrich it; mods/transcript are NEVER returned. The controller
        // strips display_record before responding — see the e2e test.
        expect(found.mods).toBeUndefined();
        expect(found.transcript).toBeUndefined();
    });

    it('publish flips is_published to 1', async () => {
        const seeded = await db_helper.seed_object({ is_published: 0 });
        const updated = await repo_model.publish(seeded.pid);
        expect(updated.is_published).toBe(1);
    });

    it('suppress flips is_published to 0', async () => {
        const seeded = await db_helper.seed_object({ is_published: 1 });
        const updated = await repo_model.suppress(seeded.pid);
        expect(updated.is_published).toBe(0);
    });

    it('soft_delete marks is_active=0 and stamps a delete_id', async () => {
        const seeded = await db_helper.seed_object({ is_active: 1, is_published: 0 });
        const result = await repo_model.soft_delete(seeded.pid, {
            delete_reason: 'test cleanup',
            actor: 'tester@example.com',
        });
        expect(result.ok).toBe(true);
        expect(result.delete_id).toMatch(/-/);
        // Subsequent delete: row exists but is_active=0 → NotFoundError
        await expect(
            repo_model.soft_delete(seeded.pid, { delete_reason: 'r', actor: 'a' })
        ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('get on missing pid throws NotFoundError', async () => {
        await expect(repo_model.get(randomUUID())).rejects.toBeInstanceOf(NotFoundError);
    });

    it('page_size is capped at 200', async () => {
        const list = await repo_model.list({ page_size: 9999 });
        expect(list.page_size).toBe(200);
    });

    describe('bulk operations', () => {
        it('bulk_publish flips is_published=1 AND dirties for ES indexing', async () => {
            const a = await db_helper.seed_object({ is_published: 0 });
            const b = await db_helper.seed_object({ is_published: 0 });
            const c = await db_helper.seed_object({ is_published: 0 });
            const result = await repo_model.bulk_publish([a.pid, b.pid, c.pid]);
            expect(result.affected).toBe(3);
            for (const pid of [a.pid, b.pid, c.pid]) {
                const row = await repo_model.get(pid);
                expect(row.is_published).toBe(1);
            }
            // Publish dirties: the indexer claims and INDEXes each
            // row on its next tick. Single-click workflow.
            const { db } = require('../../../config/db');
            const raw = await db()('tbl_objects')
                .select('pid', 'is_updated')
                .whereIn('pid', [a.pid, b.pid, c.pid]);
            for (const r of raw) expect(Boolean(r.is_updated)).toBe(true);
        });

        it('bulk_suppress dirties for ES removal', async () => {
            // Symmetric: suppress also dirties so the indexer claims
            // and DELETEs each row from ES.
            const a = await db_helper.seed_object({ is_published: 1 });
            const b = await db_helper.seed_object({ is_published: 1 });
            const result = await repo_model.bulk_suppress([a.pid, b.pid]);
            expect(result.affected).toBe(2);
            const { db } = require('../../../config/db');
            const raw = await db()('tbl_objects')
                .select('pid', 'is_updated')
                .whereIn('pid', [a.pid, b.pid]);
            for (const r of raw) expect(Boolean(r.is_updated)).toBe(true);
        });

        it('bulk_soft_delete also dirties rows for ES removal', async () => {
            const a = await db_helper.seed_object({ is_active: 1, is_published: 0 });
            await repo_model.bulk_soft_delete([a.pid], {
                delete_reason: 'r',
                actor: 'a',
            });
            const { db } = require('../../../config/db');
            const raw = await db()('tbl_objects')
                .select('is_updated', 'is_active')
                .where({ pid: a.pid })
                .first();
            expect(raw.is_active).toBe(0);
            expect(Boolean(raw.is_updated)).toBe(true);
        });

        it('bulk_suppress flips is_published=0', async () => {
            const a = await db_helper.seed_object({ is_published: 1 });
            const b = await db_helper.seed_object({ is_published: 1 });
            const result = await repo_model.bulk_suppress([a.pid, b.pid]);
            expect(result.affected).toBe(2);
            const row = await repo_model.get(a.pid);
            expect(row.is_published).toBe(0);
        });

        it('bulk publish/suppress skips soft-deleted rows', async () => {
            const live = await db_helper.seed_object({ is_published: 0, is_active: 1 });
            const dead = await db_helper.seed_object({ is_published: 0, is_active: 0 });
            const result = await repo_model.bulk_publish([live.pid, dead.pid]);
            expect(result.affected).toBe(1);
            const dead_after = await repo_model.get(dead.pid);
            expect(dead_after.is_published).toBe(0); // unchanged
        });

        it('bulk publish de-duplicates the pid list', async () => {
            const a = await db_helper.seed_object({ is_published: 0 });
            // Pass the same pid twice; the model dedupes before the SQL
            // so the affected count is 1, not 2.
            const result = await repo_model.bulk_publish([a.pid, a.pid, a.pid]);
            expect(result.affected).toBe(1);
            expect(result.pids).toEqual([a.pid]);
        });

        it('bulk publish returns affected=0 when no pid matches an active row', async () => {
            // Use real v4 UUIDs — validator.isUUID rejects the
            // all-1s literal because its variant bits aren't valid.
            const result = await repo_model.bulk_publish([randomUUID(), randomUUID()]);
            expect(result.affected).toBe(0);
        });

        it('bulk_soft_delete tombstones each active row with a fresh delete_id', async () => {
            const a = await db_helper.seed_object({ is_active: 1, is_published: 0 });
            const b = await db_helper.seed_object({ is_active: 1, is_published: 0 });
            const result = await repo_model.bulk_soft_delete([a.pid, b.pid], {
                delete_reason: 'cleanup',
                actor: 'a',
            });
            expect(result.affected).toBe(2);
            // Verify via raw query because get() doesn't pull delete_id.
            const { db } = require('../../../config/db');
            const rows = await db()('tbl_objects')
                .select('pid', 'is_active', 'delete_id')
                .whereIn('pid', [a.pid, b.pid]);
            expect(rows).toHaveLength(2);
            for (const r of rows) {
                expect(r.is_active).toBe(0);
                // Each row gets its OWN delete_id, mirroring v1.
                expect(r.delete_id).toMatch(
                    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
                );
            }
            // Confirm the two delete_ids are distinct.
            expect(rows[0].delete_id).not.toBe(rows[1].delete_id);
        });

        it('bulk_soft_delete is idempotent (already-deleted rows are skipped)', async () => {
            const a = await db_helper.seed_object({ is_active: 0 });
            const b = await db_helper.seed_object({ is_active: 1, is_published: 0 });
            const result = await repo_model.bulk_soft_delete([a.pid, b.pid], {
                delete_reason: 'r',
                actor: 'a',
            });
            // Only b was active; a is unchanged.
            expect(result.affected).toBe(1);
        });
    });

    describe('delete contract (v1 parity)', () => {
        // The 2026-05-26 work brought v2's delete in line with v1:
        //   - delete_reason required
        //   - published guard (no override)
        //   - AM AIP deletion request fires for active rows with sip_uuid
        //
        // These tests pin those behaviors; AM is stubbed at the
        // libs/archivematica boundary because we don't want real
        // network calls in the suite.

        const archivematica = require('../../../libs/archivematica');
        const { ConflictError } = require('../../../libs/errors');

        let original_delete_aip;
        let original_is_storage_configured;

        beforeEach(() => {
            original_delete_aip = archivematica.delete_aip_request;
            original_is_storage_configured = archivematica.is_storage_configured;
            // Default: AM configured + happy 202 response.
            archivematica.is_storage_configured = () => true;
            archivematica.delete_aip_request = vi
                .fn()
                .mockResolvedValue({ status: 202, data: { id: 'am-req-123' } });
        });
        afterEach(() => {
            archivematica.delete_aip_request = original_delete_aip;
            archivematica.is_storage_configured = original_is_storage_configured;
        });

        it('soft_delete refuses without a delete_reason', async () => {
            const seeded = await db_helper.seed_object({
                is_active: 1,
                is_published: 0,
            });
            await expect(
                repo_model.soft_delete(seeded.pid, { actor: 'a' })
            ).rejects.toThrow(/delete_reason is required/);
            await expect(
                repo_model.soft_delete(seeded.pid, { delete_reason: '   ', actor: 'a' })
            ).rejects.toThrow(/delete_reason is required/);
        });

        it('soft_delete REFUSES published objects with 409 Conflict', async () => {
            const seeded = await db_helper.seed_object({
                is_active: 1,
                is_published: 1,
            });
            await expect(
                repo_model.soft_delete(seeded.pid, {
                    delete_reason: 'duplicate of pid X',
                    actor: 'tester',
                })
            ).rejects.toBeInstanceOf(ConflictError);
            // CRITICAL: the published guard runs BEFORE the AM call.
            // (v1 had this backwards and orphaned AM requests.)
            expect(archivematica.delete_aip_request).not.toHaveBeenCalled();
            // Row stays active — nothing was changed.
            const after = await repo_model.get(seeded.pid);
            expect(after.is_active).toBe(1);
        });

        it('soft_delete fires AM with the sip_uuid + actor-prefixed reason', async () => {
            const seeded = await db_helper.seed_object({
                is_active: 1,
                is_published: 0,
                sip_uuid: 'sip-abc-123',
            });
            const result = await repo_model.soft_delete(seeded.pid, {
                delete_reason: 'duplicate of pid X',
                actor: 'jdoe@du.edu',
            });
            expect(archivematica.delete_aip_request).toHaveBeenCalledTimes(1);
            const call = archivematica.delete_aip_request.mock.calls[0][0];
            expect(call.uuid).toBe('sip-abc-123');
            // Reason text includes the actor + date + original reason.
            expect(call.delete_reason).toMatch(/jdoe@du\.edu/);
            expect(call.delete_reason).toMatch(/duplicate of pid X/);
            // delete_id captured from AM's response (data.id) — v1 parity.
            expect(result.delete_id).toBe('am-req-123');
            expect(result.am.ok).toBe(true);
        });

        it('soft_delete falls back to a fresh UUID when sip_uuid is missing (legacy rows)', async () => {
            const seeded = await db_helper.seed_object({
                is_active: 1,
                is_published: 0,
                sip_uuid: null,
            });
            const result = await repo_model.soft_delete(seeded.pid, {
                delete_reason: 'legacy cleanup',
                actor: 'a',
            });
            // AM not called — no SIP to delete.
            expect(archivematica.delete_aip_request).not.toHaveBeenCalled();
            expect(result.am.ok).toBe(true);
            expect(result.am.skipped).toBe('no_sip_uuid');
            // Row still soft-deleted.
            const { db } = require('../../../config/db');
            const after = await db()('tbl_objects')
                .where({ pid: seeded.pid })
                .first();
            expect(after.is_active).toBe(0);
            expect(after.delete_id).toMatch(/-/);
        });

        it('soft_delete still flips is_active=0 when AM returns 5xx (best-effort contract)', async () => {
            archivematica.delete_aip_request = vi
                .fn()
                .mockResolvedValue({ status: 500, data: null });
            const seeded = await db_helper.seed_object({
                is_active: 1,
                is_published: 0,
                sip_uuid: 'sip-xyz',
            });
            const result = await repo_model.soft_delete(seeded.pid, {
                delete_reason: 'test',
                actor: 'a',
            });
            // The user-visible soft-delete commits even though AM was sad.
            expect(result.am.ok).toBe(false);
            expect(result.am.status).toBe(500);
            const after = await repo_model.get(seeded.pid);
            expect(after.is_active).toBe(0);
        });

        it('soft_delete tolerates AM throws (transport error) — same best-effort behavior', async () => {
            archivematica.delete_aip_request = vi
                .fn()
                .mockRejectedValue(new Error('ECONNREFUSED'));
            const seeded = await db_helper.seed_object({
                is_active: 1,
                is_published: 0,
                sip_uuid: 'sip-xyz',
            });
            const result = await repo_model.soft_delete(seeded.pid, {
                delete_reason: 'test',
                actor: 'a',
            });
            expect(result.am.ok).toBe(false);
            expect(result.am.error).toMatch(/ECONNREFUSED/);
            const after = await repo_model.get(seeded.pid);
            expect(after.is_active).toBe(0);
        });

        it('bulk_soft_delete REFUSES the entire batch if ANY row is published', async () => {
            const ok1 = await db_helper.seed_object({
                is_active: 1,
                is_published: 0,
            });
            const ok2 = await db_helper.seed_object({
                is_active: 1,
                is_published: 0,
            });
            const pub = await db_helper.seed_object({
                is_active: 1,
                is_published: 1,
            });
            await expect(
                repo_model.bulk_soft_delete([ok1.pid, ok2.pid, pub.pid], {
                    delete_reason: 'test',
                    actor: 'a',
                })
            ).rejects.toBeInstanceOf(ConflictError);
            // No AM calls, no DB writes — all-or-nothing.
            expect(archivematica.delete_aip_request).not.toHaveBeenCalled();
            for (const pid of [ok1.pid, ok2.pid, pub.pid]) {
                const row = await repo_model.get(pid);
                expect(row.is_active).toBe(1);
            }
        });

        it('bulk_soft_delete fires one AM request per row + surfaces per-row failures', async () => {
            archivematica.delete_aip_request = vi
                .fn()
                .mockResolvedValueOnce({ status: 202, data: { id: 'r-1' } })
                .mockResolvedValueOnce({ status: 500, data: null });
            const a = await db_helper.seed_object({
                is_active: 1,
                is_published: 0,
                sip_uuid: 'sip-a',
            });
            const b = await db_helper.seed_object({
                is_active: 1,
                is_published: 0,
                sip_uuid: 'sip-b',
            });
            const result = await repo_model.bulk_soft_delete([a.pid, b.pid], {
                delete_reason: 'test',
                actor: 'a',
            });
            expect(result.affected).toBe(2);
            expect(result.am_failed).toBe(1);
            expect(archivematica.delete_aip_request).toHaveBeenCalledTimes(2);
            // Both rows soft-deleted regardless of per-row AM outcome.
            for (const pid of [a.pid, b.pid]) {
                const { db } = require('../../../config/db');
                const after = await db()('tbl_objects').where({ pid }).first();
                expect(after.is_active).toBe(0);
            }
        });
    });

    describe('set_thumbnail', () => {
        it('updates the column AND mirrors the URL into display_record', async () => {
            const seeded = await db_helper.seed_object({
                thumbnail: null,
                display_record: JSON.stringify({ title: 'Sample', f_subjects: ['x'] }),
            });
            const updated = await repo_model.set_thumbnail(
                seeded.pid,
                'https://example.com/repo/static/tn/abc.jpg'
            );
            expect(updated.thumbnail).toBe('https://example.com/repo/static/tn/abc.jpg');

            // The JSON blob now carries the new thumbnail URL, AND keeps
            // every field it had before — the patch is non-destructive.
            const parsed = JSON.parse(updated.display_record);
            expect(parsed.thumbnail).toBe('https://example.com/repo/static/tn/abc.jpg');
            expect(parsed.title).toBe('Sample');
            expect(parsed.f_subjects).toEqual(['x']);
        });

        it('initializes display_record when previously empty', async () => {
            const seeded = await db_helper.seed_object({
                thumbnail: null,
                display_record: null,
            });
            const updated = await repo_model.set_thumbnail(
                seeded.pid,
                'https://example.com/repo/static/tn/empty.jpg'
            );
            const parsed = JSON.parse(updated.display_record);
            expect(parsed.thumbnail).toBe('https://example.com/repo/static/tn/empty.jpg');
        });

        it('recovers from corrupt display_record JSON', async () => {
            // Garbage JSON in the column — set_thumbnail must not 500;
            // it overwrites with a minimal { thumbnail } object. Losing
            // a previously-corrupt blob is the correct trade-off here.
            const seeded = await db_helper.seed_object({
                display_record: '{not valid json',
            });
            const updated = await repo_model.set_thumbnail(
                seeded.pid,
                'https://example.com/repo/static/tn/recover.jpg'
            );
            const parsed = JSON.parse(updated.display_record);
            expect(parsed).toEqual({
                thumbnail: 'https://example.com/repo/static/tn/recover.jpg',
            });
        });

        it('dirties is_updated so the indexer picks up the new thumbnail', async () => {
            // Thumbnail is part of the indexed doc projection; a
            // change should reach public search on the next worker
            // tick. Single-click principle, same as publish.
            const seeded = await db_helper.seed_object({ is_updated: 0 });
            await repo_model.set_thumbnail(
                seeded.pid,
                'https://example.com/repo/static/tn/touch.jpg'
            );
            const raw = await require('../../../config/db')
                .db()('tbl_objects')
                .select('is_updated')
                .where({ pid: seeded.pid })
                .first();
            expect(Boolean(raw.is_updated)).toBe(true);
        });

        it('rejects a non-http(s) URL', async () => {
            const seeded = await db_helper.seed_object();
            await expect(
                repo_model.set_thumbnail(seeded.pid, 'javascript:alert(1)')
            ).rejects.toBeInstanceOf(ValidationError);
            await expect(
                repo_model.set_thumbnail(seeded.pid, 'file:///etc/passwd')
            ).rejects.toBeInstanceOf(ValidationError);
        });

        it('rejects an empty URL', async () => {
            const seeded = await db_helper.seed_object();
            await expect(repo_model.set_thumbnail(seeded.pid, '')).rejects.toBeInstanceOf(
                ValidationError
            );
        });

        it('rejects a missing pid', async () => {
            await expect(repo_model.set_thumbnail(undefined, 'https://x/y')).rejects.toBeInstanceOf(
                ValidationError
            );
        });

        it('throws NotFoundError when the pid does not exist', async () => {
            await expect(
                repo_model.set_thumbnail(randomUUID(), 'https://example.com/tn.jpg')
            ).rejects.toBeInstanceOf(NotFoundError);
        });
    });

    describe('collection auto-creation gate (used by submit_to_ingest)', () => {
        describe('find_collection_by_uri', () => {
            it('returns the row when a matching collection exists', async () => {
                const seeded = await db_helper.seed_object({
                    object_type: 'collection',
                    uri: '/repositories/2/resources/1204',
                });
                const found = await repo_model.find_collection_by_uri(
                    '/repositories/2/resources/1204'
                );
                expect(found).toBeTruthy();
                expect(found.pid).toBe(seeded.pid);
                expect(found.object_type).toBe('collection');
            });

            it('returns undefined when no collection has the URI', async () => {
                expect(
                    await repo_model.find_collection_by_uri('/repositories/2/resources/missing')
                ).toBeUndefined();
            });

            it('ignores non-collection rows even when their URI matches', async () => {
                // A stray archival_object with the same URI must NOT
                // satisfy the collection lookup — the object_type
                // filter on the query is what makes the gate safe.
                await db_helper.seed_object({
                    object_type: 'object',
                    uri: '/repositories/2/resources/8000',
                });
                expect(
                    await repo_model.find_collection_by_uri('/repositories/2/resources/8000')
                ).toBeUndefined();
            });

            it('returns undefined on empty / non-string input', async () => {
                expect(await repo_model.find_collection_by_uri('')).toBeUndefined();
                expect(await repo_model.find_collection_by_uri(null)).toBeUndefined();
            });
        });

        describe('create_collection', () => {
            it('inserts a tbl_objects row with object_type=collection + sane defaults', async () => {
                const created = await repo_model.create_collection({
                    uri: '/repositories/2/resources/1204',
                    mods: { title: 'Glenn Miller Collection', abstract: 'About Miller.' },
                    handle: 'https://hdl.invalid/20.500.12345/abc',
                });
                expect(created.pid).toMatch(/-/); // UUID-shaped
                expect(created.object_type).toBe('collection');
                expect(created.uri).toBe('/repositories/2/resources/1204');
                expect(created.handle).toBe('https://hdl.invalid/20.500.12345/abc');
                expect(created.is_active).toBe(1);
                expect(created.is_published).toBe(0);
                expect(created.is_member_of_collection).toBe('');
                // Verify the row really landed in the DB.
                const re_fetched = await repo_model.find_collection_by_uri(
                    '/repositories/2/resources/1204'
                );
                expect(re_fetched.pid).toBe(created.pid);
            });

            it('hoists title + abstract from mods into the display_record envelope', async () => {
                // The dashboard projection (libs/object_projection.js)
                // reads dr.title / dr.abstract from the envelope's
                // top level — NOT from the nested mods. Pre-flight
                // gate must lay them out so the collection appears
                // with its title immediately without a metadata
                // refresh first.
                await repo_model.create_collection({
                    uri: '/repositories/2/resources/2000',
                    mods: { title: 'A Test Title', abstract: 'A Test Abstract.' },
                });
                const { db } = require('../../../config/db');
                const tables = require('../../../config/db_tables');
                const row = await db()(tables.objects)
                    .select('display_record')
                    .where({ uri: '/repositories/2/resources/2000' })
                    .first();
                const dr = JSON.parse(row.display_record);
                expect(dr.title).toBe('A Test Title');
                expect(dr.abstract).toBe('A Test Abstract.');
            });

            it('rejects missing uri / mods', async () => {
                await expect(
                    repo_model.create_collection({ mods: { title: 't' } })
                ).rejects.toBeInstanceOf(ValidationError);
                await expect(repo_model.create_collection({ uri: '/r/1' })).rejects.toBeInstanceOf(
                    ValidationError
                );
            });

            it('survives a concurrent-duplicate-insert race by returning the existing row', async () => {
                // With the partial unique index in place (migration
                // 20260524000001_unique_collection_uri), the SECOND
                // call to create_collection hits a duplicate-key
                // error on the DB insert. The function's try/catch
                // recognizes /duplicate|unique/ in the error message,
                // re-fetches the row that already exists, and returns
                // it instead of bubbling the error up.
                //
                // End-to-end effect: two concurrent submits for the
                // same folder both succeed and both end up linking
                // packages to the SAME collection row — no orphans,
                // no duplicate collection mirrors.
                const uri = '/repositories/2/resources/race';
                const first = await repo_model.create_collection({
                    uri,
                    mods: { title: 'Race' },
                });
                expect(first.pid).toMatch(/-/);
                const second = await repo_model.create_collection({
                    uri,
                    mods: { title: 'Race' },
                });
                expect(second.pid).toBe(first.pid);
                // Sanity: the table holds exactly one collection row
                // for this URI.
                const { db } = require('../../../config/db');
                const tables = require('../../../config/db_tables');
                const rows = await db()(tables.objects)
                    .select('pid')
                    .where({ uri, object_type: 'collection' });
                expect(rows).toHaveLength(1);
            });

            it('does NOT constrain non-collection rows sharing the same URI', async () => {
                // The unique index is partial — it only applies to
                // collection rows. Two object rows can share a URI
                // (rare but legitimate: e.g. two archival_objects
                // pointing at the same AS resource URI before staff
                // cleans up). Likewise, an empty uri is allowed.
                const uri = '/repositories/2/resources/shared';
                await db_helper.seed_object({ object_type: 'object', uri });
                await expect(
                    db_helper.seed_object({ object_type: 'object', uri })
                ).resolves.toBeTruthy();
                // And we can still seed a collection with that URI:
                await expect(
                    db_helper.seed_object({ object_type: 'collection', uri })
                ).resolves.toBeTruthy();
                // But not a SECOND collection with the same URI.
                await expect(
                    db_helper.seed_object({ object_type: 'collection', uri })
                ).rejects.toThrow(/unique|duplicate/i);
            });
        });
    });
});
