'use strict';

/*
 * Integration coverage for convert/model.status_summary's "By" labels:
 * the panel shows the operator's FULL NAME resolved from tbl_users by
 * the du_id stored in batch.actor — healing legacy batches that stored
 * the email in actor_name — while system batches ('Ingest (auto)') and
 * unknown actors fall back to the stored strings.
 */

const model = require('../../../convert/model');
const db_helper = require('../../helpers/db');
const { db_queue } = require('../../../config/db');
const tables = require('../../../config/db_tables');

async function seed_batch(overrides = {}) {
    const [id] = await db_queue()(tables.convert_batches).insert({
        scope_type: 'object',
        sip_uuid: overrides.sip_uuid || 'sip-x',
        total: 1,
        actor: overrides.actor || '',
        actor_name: overrides.actor_name || '',
    });
    return id;
}

describe('convert/model — status_summary actor labels', () => {
    beforeAll(async () => {
        await db_helper.setup_schema();
    });
    beforeEach(async () => {
        await db_helper.reset_data();
    });
    afterAll(async () => {
        await db_helper.teardown();
    });

    it('resolves du_id actors to full names, healing legacy email rows', async () => {
        await db_helper.seed_user({
            du_id: '871095226',
            first_name: 'Fernando',
            last_name: 'Reyes',
        });
        /* Legacy-shaped batch: du_id in actor, EMAIL in actor_name. */
        await seed_batch({ actor: '871095226', actor_name: 'fernando.reyes@du.edu' });

        const s = await model.status_summary();
        expect(s.latest.actor).toBe('Fernando Reyes');
        expect(s.history[0].actor).toBe('Fernando Reyes');
    });

    it('leaves system batches and unknown actors on their stored labels', async () => {
        await seed_batch({ actor: 'system', actor_name: 'Ingest (auto)', sip_uuid: 'sip-a' });
        await seed_batch({ actor: 'gone-user-999', actor_name: '', sip_uuid: 'sip-b' });

        const s = await model.status_summary();
        const labels = new Map(s.history.map((b) => [b.scope_label, b.actor]));
        expect(labels.get('sip-a')).toBe('Ingest (auto)');
        // No name on file, no actor_name → the raw actor is the last resort.
        expect(labels.get('sip-b')).toBe('gone-user-999');
    });
});
