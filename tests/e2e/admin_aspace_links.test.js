'use strict';

const supertest = require('supertest');
const { make_app } = require('../helpers/app');
const db_helper = require('../helpers/db');
const jwt = require('../../libs/jwt');
const app_config = require('../../config/app');
const model = require('../../aspace_links/model');
const { db_queue } = require('../../config/db');
const tables = require('../../config/db_tables');
const { PID, TWIN, AO, RESOURCE, handle } = require('../helpers/aspace_links');

const BASE = '/repo/dashboard/admin/aspace-links';
const SECOND = '/repositories/2/archival_objects/2';

let app;

async function cookie_for(du_id, role) {
    const user = await db_helper.seed_user({ du_id, role });
    return `${jwt.COOKIE_NAME}=${jwt.sign({ sub: String(user.id), du_id })}`;
}

const row_for = (uri) => db_queue()(tables.aspace_links).where({ uri }).first();

async function seed_checked(uri, result) {
    await model.enqueue([uri]);
    await model.record(await row_for(uri), { uri, pids: [PID], ...result });
}

async function with_env(values, run) {
    const original = { ...process.env };
    Object.assign(process.env, values);
    app_config._reset();
    try {
        await run();
    } finally {
        process.env = original;
        app_config._reset();
    }
}

describe('admin ArchivesSpace links — e2e', () => {
    beforeAll(async () => {
        app = make_app();
        await db_helper.setup_schema();
    });
    beforeEach(async () => {
        await db_helper.reset_data();
    });
    afterAll(async () => {
        await db_helper.teardown();
    });

    describe('GET /dashboard/admin/aspace-links (page)', () => {
        it('redirects unauthed users to login', async () => {
            const res = await supertest(app).get(BASE);
            expect(res.status).toBe(302);
        });

        it('renders for an admin with the status panel, the list and the action', async () => {
            const cookie = await cookie_for('links-admin-1', 'admin');
            const res = await supertest(app).get(BASE).set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toContain('<h1 class="page-title">ArchivesSpace Links</h1>');
            expect(res.text).toContain('id="aspace-links-status"');
            expect(res.text).toContain(`${BASE}/status`);
            expect(res.text).toContain('id="aspace-links-list"');
            expect(res.text).toContain('Check all records');
            expect(res.text).toContain('No records need attention.');
        });

        it('marks its entry in the Admin Utils rail as the current page', async () => {
            const cookie = await cookie_for('links-admin-2', 'admin');
            const res = await supertest(app).get(BASE).set('Cookie', cookie);
            expect(res.text).toMatch(
                /aria-current="page"[^>]*aria-label="ArchivesSpace Links \(admin\)"/
            );
        });

        it.each(['staff', 'viewer'])('is forbidden for %s', async (role) => {
            const cookie = await cookie_for(`links-${role}-1`, role);
            const res = await supertest(app).get(BASE).set('Cookie', cookie);
            expect(res.status).toBe(403);
        });

        it.each([
            [{}, 'Automatic checking is off, so nothing is checked until it is turned on.'],
            [{ ASPACE_LINKS_WORKER_ENABLED: '1' }, 'Nothing will be changed.'],
            [
                { ASPACE_LINKS_WORKER_ENABLED: '1', ASPACE_WRITES_ENABLED: '1' },
                'update the ones that are out of date',
            ],
        ])('words the confirmation for %j', async (env, wording) => {
            const cookie = await cookie_for(
                `links-admin-confirm-${Object.keys(env).length}`,
                'admin'
            );
            await with_env(env, async () => {
                const res = await supertest(app).get(BASE).set('Cookie', cookie);
                expect(res.text).toContain(wording);
            });
        });

        it('keeps the action outside the part of the page that refreshes itself', async () => {
            const cookie = await cookie_for('links-admin-outside', 'admin');
            const page = await supertest(app).get(BASE).set('Cookie', cookie);
            const partial = await supertest(app).get(`${BASE}/status`).set('Cookie', cookie);
            expect(page.text).toContain('Check all records');
            expect(partial.text).not.toContain('Check all records');
        });
    });

    describe('GET /status (polled partial)', () => {
        it('says automatic checking is off by default', async () => {
            const cookie = await cookie_for('links-admin-3', 'admin');
            const res = await supertest(app).get(`${BASE}/status`).set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toContain('Automatic checking is off.');
            expect(res.text).toContain('ASPACE_LINKS_WORKER_ENABLED');
            expect(res.text).not.toContain('<html');
        });

        it('says nothing is written when the worker is on and writes are off', async () => {
            const cookie = await cookie_for('links-admin-4', 'admin');
            await with_env({ ASPACE_LINKS_WORKER_ENABLED: '1' }, async () => {
                const res = await supertest(app).get(`${BASE}/status`).set('Cookie', cookie);
                expect(res.text).toContain('Nothing is being written to ArchivesSpace.');
                expect(res.text).not.toContain('Automatic checking is off.');
            });
        });

        it('shows neither warning when the worker and writes are both on', async () => {
            const cookie = await cookie_for('links-admin-5', 'admin');
            await with_env(
                { ASPACE_LINKS_WORKER_ENABLED: '1', ASPACE_WRITES_ENABLED: '1' },
                async () => {
                    const res = await supertest(app).get(`${BASE}/status`).set('Cookie', cookie);
                    expect(res.text).not.toContain('alert-warning');
                }
            );
        });

        it('counts waiting records and checked records by result', async () => {
            const cookie = await cookie_for('links-admin-6', 'admin');
            await seed_checked(AO, { state: 'contested' });
            await seed_checked(SECOND, { state: 'in_sync' });
            await model.enqueue([RESOURCE]);

            const res = await supertest(app).get(`${BASE}/status`).set('Cookie', cookie);
            const text = res.text.replace(/\s+/g, ' ');
            expect(text).toMatch(/Waiting to be checked<\/dt> <dd[^>]*><strong>1<\/strong>/);
            expect(text).toMatch(/More than one object shares this record<\/dt> <dd[^>]*>1</);
            expect(text).toMatch(/Up to date<\/dt> <dd[^>]*>1</);
            expect(text).not.toContain('Update failed');
        });

        it('shows why waiting records were put off', async () => {
            const cookie = await cookie_for('links-admin-7', 'admin');
            await model.enqueue([AO]);
            await model.defer([await row_for(AO)], 'ArchivesSpace could not list records');

            const res = await supertest(app).get(`${BASE}/status`).set('Cookie', cookie);
            expect(res.text).toContain('The last check could not be completed.');
            expect(res.text).toContain('ArchivesSpace could not list records');
        });

        it('is forbidden for staff', async () => {
            const cookie = await cookie_for('links-staff-2', 'staff');
            const res = await supertest(app).get(`${BASE}/status`).set('Cookie', cookie);
            expect(res.status).toBe(403);
        });
    });

    describe('GET /list (records partial)', () => {
        it('lists the records that need attention by default, with what was found', async () => {
            const cookie = await cookie_for('links-admin-8', 'admin');
            await seed_checked(AO, { state: 'contested', pids: [PID, TWIN] });
            await seed_checked(SECOND, { state: 'in_sync' });
            await seed_checked(RESOURCE, {
                state: 'failed',
                link: 'update',
                link_previous: handle(TWIN),
                error: `${RESOURCE}: HTTP 400: refused`,
            });

            const res = await supertest(app).get(`${BASE}/list`).set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toContain(`<code>${AO}</code>`);
            expect(res.text).toContain(`<code>${TWIN}</code>`);
            expect(res.text).toContain('More than one object shares this record');
            expect(res.text).toContain('Update failed');
            expect(res.text).toContain(`Found the link pointing at ${handle(TWIN)}`);
            expect(res.text).toContain('HTTP 400: refused');
            expect(res.text).not.toContain(`<code>${SECOND}</code>`);
            expect(res.text).not.toContain('Check these again');
        });

        it('shows why a record needs a review, in the default view', async () => {
            const cookie = await cookie_for('links-admin-review', 'admin');
            await seed_checked(AO, {
                state: 'needs_review',
                note: 'The record has more than one repository link.',
            });
            const res = await supertest(app).get(`${BASE}/list`).set('Cookie', cookie);
            expect(res.text).toContain(`<code>${AO}</code>`);
            expect(res.text).toContain('Needs review');
            expect(res.text).toContain('The record has more than one repository link.');
        });

        it('has a label for every result that needs attention', () => {
            const { STATE_LABELS } = require('../../aspace_links/controller');
            const { ATTENTION_STATES } = require('../../aspace_links/sync');
            for (const state of ATTENTION_STATES) {
                expect(STATE_LABELS[state], state).toBeTruthy();
            }
        });

        it('filters by one result and offers to check those again', async () => {
            const cookie = await cookie_for('links-admin-9', 'admin');
            await seed_checked(AO, { state: 'contested' });
            await seed_checked(SECOND, { state: 'in_sync' });

            const res = await supertest(app)
                .get(`${BASE}/list?state=in_sync`)
                .set('Cookie', cookie);
            expect(res.text).toContain(`<code>${SECOND}</code>`);
            expect(res.text).not.toContain(`<code>${AO}</code>`);
            expect(res.text).toContain('<option value="in_sync" selected>Up to date</option>');
            expect(res.text).toContain('Check these again');
            expect(res.text).toContain('name="state" value="in_sync"');
        });

        it('falls back to the default view for an unknown result', async () => {
            const cookie = await cookie_for('links-admin-10', 'admin');
            await seed_checked(AO, { state: 'contested' });
            const res = await supertest(app)
                .get(`${BASE}/list?state=constructor`)
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toContain('<option value="" selected>Needs attention</option>');
            expect(res.text).toContain(`<code>${AO}</code>`);
        });

        it('escapes what ArchivesSpace sent back', async () => {
            const cookie = await cookie_for('links-admin-11', 'admin');
            await seed_checked(AO, { state: 'failed', error: '<script>alert(1)</script>' });
            const res = await supertest(app).get(`${BASE}/list`).set('Cookie', cookie);
            expect(res.text).not.toContain('<script>alert(1)</script>');
            expect(res.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
        });

        it('says so when a filter matches nothing', async () => {
            const cookie = await cookie_for('links-admin-12', 'admin');
            const res = await supertest(app)
                .get(`${BASE}/list?state=orphan_link`)
                .set('Cookie', cookie);
            expect(res.text).toContain('No records with this result.');
        });
    });

    describe('POST /check-all', () => {
        it('queues every record a repository object points at and reports the count', async () => {
            const cookie = await cookie_for('links-admin-13', 'admin');
            await db_helper.seed_object({ pid: PID, uri: AO });
            await db_helper.seed_object({ pid: TWIN, uri: SECOND, is_active: 0 });
            await db_helper.seed_object({ uri: '' });

            const res = await supertest(app).post(`${BASE}/check-all`).set('Cookie', cookie);
            expect(res.status).toBe(200);
            const fired = JSON.parse(res.headers['hx-trigger']);
            expect(fired.toast).toEqual({
                level: 'success',
                message: 'Queued 2 records to check.',
            });
            expect(fired['aspace-links-changed']).toBe(true);
            expect(res.text).toMatch(/Waiting to be checked<\/dt>\s*<dd[^>]*><strong>2<\/strong>/);
            expect(await row_for(AO)).toMatchObject({ status: 'PENDING' });
            expect(await row_for(SECOND)).toMatchObject({ status: 'PENDING' });
        });

        it('is forbidden for staff and queues nothing', async () => {
            const cookie = await cookie_for('links-staff-3', 'staff');
            await db_helper.seed_object({ pid: PID, uri: AO });
            const res = await supertest(app).post(`${BASE}/check-all`).set('Cookie', cookie);
            expect(res.status).toBe(403);
            expect(await row_for(AO)).toBeUndefined();
        });
    });

    describe('POST /recheck', () => {
        it('queues the records with the chosen result again', async () => {
            const cookie = await cookie_for('links-admin-14', 'admin');
            await seed_checked(AO, { state: 'pending' });
            await seed_checked(SECOND, { state: 'in_sync' });

            const res = await supertest(app)
                .post(`${BASE}/recheck`)
                .set('Cookie', cookie)
                .type('form')
                .send({ state: 'pending' });
            expect(res.status).toBe(200);
            const fired = JSON.parse(res.headers['hx-trigger']);
            expect(fired.toast).toEqual({
                level: 'success',
                message: 'Queued 1 record to check again.',
            });
            expect(fired['aspace-links-status']).toBe(true);
            expect(await row_for(AO)).toMatchObject({ status: 'PENDING' });
            expect(await row_for(SECOND)).toMatchObject({ status: 'DONE' });
            expect(res.text).toContain('No records with this result.');
        });

        it('changes nothing and says so for an unknown result', async () => {
            const cookie = await cookie_for('links-admin-15', 'admin');
            await seed_checked(AO, { state: 'pending' });

            const res = await supertest(app)
                .post(`${BASE}/recheck`)
                .set('Cookie', cookie)
                .type('form')
                .send({ state: 'everything' });
            expect(res.status).toBe(200);
            expect(JSON.parse(res.headers['hx-trigger']).toast.level).toBe('error');
            expect(await row_for(AO)).toMatchObject({ status: 'DONE' });
        });

        it('is forbidden for viewers', async () => {
            const cookie = await cookie_for('links-viewer-2', 'viewer');
            const res = await supertest(app)
                .post(`${BASE}/recheck`)
                .set('Cookie', cookie)
                .type('form')
                .send({ state: 'pending' });
            expect(res.status).toBe(403);
        });
    });
});
