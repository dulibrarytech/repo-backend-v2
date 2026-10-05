'use strict';

/*
 * tbl_dip_store schema (knex/migrations/repo/20261005000001_dip_store.js),
 * run through the real migration on the sqlite test DB: the table exists,
 * a bare row gets the documented defaults, and pid is one row per object.
 */

const db_helper = require('../../helpers/db');
const { db } = require('../../../config/db');
const tables = require('../../../config/db_tables');

const PID = '0f3a7d2e-5b1c-4c8e-9a6f-2d4b8e1c7a90';

describe('tbl_dip_store schema', () => {
    beforeAll(async () => {
        await db_helper.setup_schema();
    });

    beforeEach(async () => {
        await db_helper.reset_data();
    });

    afterAll(async () => {
        await db_helper.teardown();
    });

    it('is created by the repo migrations', async () => {
        expect(await db().schema.hasTable(tables.dip_store)).toBe(true);
        for (const column of [
            'pid',
            'sip_uuid',
            'dip_uuid',
            'bucket',
            'prefix',
            'files_total',
            'bytes_total',
            'expected_bytes',
            'mode',
            'status',
            'attempts',
            'next_attempt_at',
            'last_error',
            'copied_at',
            'verified_at',
            'created_at',
            'updated_at',
        ]) {
            expect(await db().schema.hasColumn(tables.dip_store, column), column).toBe(true);
        }
    });

    it('defaults a new row to a pending ingest-mode copy with no attempts', async () => {
        await db()(tables.dip_store).insert({ pid: PID });
        const row = await db()(tables.dip_store).where({ pid: PID }).first();
        expect(row).toMatchObject({ mode: 'ingest', status: 'pending', attempts: 0 });
        expect(row.created_at).toBeTruthy();
        expect(row.copied_at).toBeNull();
    });

    it('allows one row per pid', async () => {
        await db()(tables.dip_store).insert({ pid: PID });
        await expect(db()(tables.dip_store).insert({ pid: PID })).rejects.toThrow();
    });
});
