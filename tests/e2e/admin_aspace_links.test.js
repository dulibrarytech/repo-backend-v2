'use strict';

const supertest = require('supertest');
const { JSDOM } = require('jsdom');
const { make_app } = require('../helpers/app');
const db_helper = require('../helpers/db');
const jwt = require('../../libs/jwt');
const app_config = require('../../config/app');
const model = require('../../aspace_links/model');
const { LINKED_STATES } = require('../../aspace_links/sync');
const { db_queue } = require('../../config/db');
const tables = require('../../config/db_tables');
const { PID, TWIN, AO, RESOURCE } = require('../helpers/aspace_links');

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
            expect(res.text).toContain('A record that already has a link is never changed.');
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
                'Records already known to have a link are skipped.',
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

        it.each([
            [{ ASPACE_LINKS_WORKER_ENABLED: '1' }, true],
            [{ ASPACE_LINKS_WORKER_ENABLED: '1', ASPACE_WRITES_ENABLED: '1' }, true],
            [{}, false],
        ])('says how long a first check takes, for %j: %j', async (env, said) => {
            const cookie = await cookie_for(`links-admin-hour-${Object.keys(env).length}`, 'admin');
            await with_env(env, async () => {
                const res = await supertest(app).get(BASE).set('Cookie', cookie);
                expect(res.text).toContain('known to have a link');
                expect(
                    res.text.includes(
                        'The first time it reads every record, which takes about an hour.'
                    )
                ).toBe(said);
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

    describe('screen readers', () => {
        it('does not announce the self-refreshing status panel every 10 seconds', async () => {
            const cookie = await cookie_for('links-admin-40', 'admin');
            const page = await supertest(app).get(BASE).set('Cookie', cookie);
            const panel = /<div id="aspace-links-status"[^>]*>/.exec(page.text)[0];
            expect(panel).toContain('every 10s');
            expect(panel).not.toMatch(/aria-live|role=/);

            const status = await supertest(app).get(`${BASE}/status`).set('Cookie', cookie);
            expect(status.text).toContain('Automatic checking is off.');
            expect(status.text).not.toContain('role="alert"');
        });

        it('has a polite region outside the panel that knows the stall already shown', async () => {
            const cookie = await cookie_for('links-admin-41', 'admin');
            await model.enqueue([AO]);
            await model.defer([await row_for(AO)], 'ArchivesSpace could not list records');

            const page = await supertest(app).get(BASE).set('Cookie', cookie);
            const doc = new JSDOM(page.text).window.document;
            const region = doc.getElementById('aspace-links-announce');
            expect(region.getAttribute('aria-live')).toBe('polite');
            expect(region.getAttribute('data-last')).toBe('ArchivesSpace could not list records');
            expect(doc.getElementById('aspace-links-status').contains(region)).toBe(false);
            expect(doc.querySelector('#aspace-links-status [data-stall]')).not.toBeNull();

            const status = await supertest(app).get(`${BASE}/status`).set('Cookie', cookie);
            expect(status.text).toContain('data-stall="ArchivesSpace could not list records"');
            expect(status.text).not.toContain('aspace-links-announce');
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

        it('names the second switch when a development server would write to another machine', async () => {
            const cookie = await cookie_for('links-admin-dev', 'admin');
            await with_env(
                {
                    NODE_ENV: 'development',
                    ARCHIVESPACE_HOST: 'https://archivesspace.example.edu',
                    ASPACE_LINKS_WORKER_ENABLED: '1',
                    ASPACE_WRITES_ENABLED: '1',
                    ASPACE_WRITES_FROM_DEV: '',
                },
                async () => {
                    const res = await supertest(app).get(`${BASE}/status`).set('Cookie', cookie);
                    expect(res.text).toContain('Nothing is being written to ArchivesSpace.');
                    expect(res.text).toContain('<code>ASPACE_WRITES_FROM_DEV</code>');
                    expect(res.text).not.toContain('turn on <code>ASPACE_WRITES_ENABLED</code>');

                    const page = await supertest(app).get(BASE).set('Cookie', cookie);
                    expect(page.text).toContain('<code>ASPACE_WRITES_FROM_DEV</code>');
                    expect(page.text).toContain('Nothing will be changed.');
                }
            );
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
                link: 'add',
                error: `${RESOURCE}: HTTP 400: refused`,
            });

            const res = await supertest(app).get(`${BASE}/list`).set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toContain(`<code>${AO}</code>`);
            expect(res.text).toContain(`<code>${TWIN}</code>`);
            expect(res.text).toContain('More than one object shares this record');
            expect(res.text).toContain('Update failed');
            expect(res.text).toContain('Found no repository link on the record.');
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
            await seed_checked(SECOND, { state: 'failed' });

            const res = await supertest(app)
                .get(`${BASE}/list?state=contested`)
                .set('Cookie', cookie);
            expect(res.text).toContain(`<code>${AO}</code>`);
            expect(res.text).not.toContain(`<code>${SECOND}</code>`);
            expect(res.text).toContain(
                '<option value="contested" selected>More than one object shares this record</option>'
            );
            expect(res.text).toContain('Check these again');
            expect(res.text).toContain('name="state" value="contested"');
        });

        it.each(LINKED_STATES)(
            'lists the records with the result %s and offers to check those again',
            async (state) => {
                const cookie = await cookie_for(`links-admin-linked-${state}`, 'admin');
                await seed_checked(SECOND, { state });
                const res = await supertest(app)
                    .get(`${BASE}/list?state=${state}`)
                    .set('Cookie', cookie);
                expect(res.text).toContain(`<code>${SECOND}</code>`);
                expect(res.text).toContain('Check these again');
                expect(res.text).toContain(`name="state" value="${state}"`);
            }
        );

        it('names a record whose link was removed in ArchivesSpace', async () => {
            const cookie = await cookie_for('links-admin-removed', 'admin');
            await seed_checked(SECOND, { state: 'link_removed', link: 'add' });
            const res = await supertest(app)
                .get(`${BASE}/list?state=link_removed`)
                .set('Cookie', cookie);
            expect(res.text).toContain(
                '<option value="link_removed" selected>Link was removed in ArchivesSpace</option>'
            );
            expect(res.text).toContain('Found no repository link on the record.');
        });

        it('offers Check these again on the page for the chosen result, never for the default view', async () => {
            const cookie = await cookie_for('links-admin-page-recheck', 'admin');
            await seed_checked(AO, { state: 'failed' });
            await seed_checked(SECOND, { state: 'updated' });

            const failed = await supertest(app).get(`${BASE}?state=failed`).set('Cookie', cookie);
            expect(failed.text).toContain('Check these again');
            const updated = await supertest(app).get(`${BASE}?state=updated`).set('Cookie', cookie);
            expect(updated.text).toContain(`<code>${SECOND}</code>`);
            expect(updated.text).toContain('Check these again');
            const attention = await supertest(app).get(BASE).set('Cookie', cookie);
            expect(attention.text).toContain(`<code>${AO}</code>`);
            expect(attention.text).not.toContain('Check these again');
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

    describe('before the queue tables exist', () => {
        const missing =
            'The ArchivesSpace links tables are missing. ' +
            'Run npm run migrate:queue on this server first.';

        it('says so on the page and in the status panel instead of failing', async () => {
            const cookie = await cookie_for('links-admin-30', 'admin');
            const ready = vi.spyOn(model, 'is_ready').mockResolvedValue(false);
            try {
                const page = await supertest(app).get(BASE).set('Cookie', cookie);
                expect(page.status).toBe(200);
                expect(page.text).toContain('The ArchivesSpace links tables are missing.');

                const status = await supertest(app).get(`${BASE}/status`).set('Cookie', cookie);
                expect(status.status).toBe(200);
                expect(status.text).toContain('<code>npm run migrate:queue</code>');
                expect(status.text).not.toContain('Automatic checking is off.');

                const list = await supertest(app).get(`${BASE}/list`).set('Cookie', cookie);
                expect(list.status).toBe(200);
                expect(list.text).toContain('No records need attention.');
            } finally {
                ready.mockRestore();
            }
        });

        it('refuses Check all and Check these again with a message, and queues nothing', async () => {
            const cookie = await cookie_for('links-admin-31', 'admin');
            await db_helper.seed_object({ pid: PID, uri: AO });
            const ready = vi.spyOn(model, 'is_ready').mockResolvedValue(false);
            try {
                const all = await supertest(app).post(`${BASE}/check-all`).set('Cookie', cookie);
                expect(all.status).toBe(200);
                expect(JSON.parse(all.headers['hx-trigger']).toast).toEqual({
                    level: 'error',
                    message: missing,
                });

                const again = await supertest(app)
                    .post(`${BASE}/recheck`)
                    .set('Cookie', cookie)
                    .type('form')
                    .send({ state: 'failed' });
                expect(again.status).toBe(200);
                expect(JSON.parse(again.headers['hx-trigger']).toast).toEqual({
                    level: 'error',
                    message: missing,
                });
            } finally {
                ready.mockRestore();
            }
            expect(await row_for(AO)).toBeUndefined();
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

        it('leaves out the records that already have a link', async () => {
            const cookie = await cookie_for('links-admin-13-linked', 'admin');
            await db_helper.seed_object({ pid: PID, uri: AO });
            await db_helper.seed_object({ pid: TWIN, uri: SECOND });
            await seed_checked(AO, { state: 'in_sync' });

            const res = await supertest(app).post(`${BASE}/check-all`).set('Cookie', cookie);
            expect(JSON.parse(res.headers['hx-trigger']).toast.message).toBe(
                'Queued 1 record to check.'
            );
            expect(await row_for(AO)).toMatchObject({ status: 'DONE', state: 'in_sync' });
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

        it.each(LINKED_STATES)(
            'queues the records with the result %s again, keeping what was found',
            async (state) => {
                const cookie = await cookie_for(`links-admin-recheck-${state}`, 'admin');
                await seed_checked(AO, { state });

                const res = await supertest(app)
                    .post(`${BASE}/recheck`)
                    .set('Cookie', cookie)
                    .type('form')
                    .send({ state });
                expect(res.status).toBe(200);
                expect(JSON.parse(res.headers['hx-trigger']).toast).toEqual({
                    level: 'success',
                    message: 'Queued 1 record to check again.',
                });
                expect(await row_for(AO)).toMatchObject({ status: 'PENDING', state });
            }
        );

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
