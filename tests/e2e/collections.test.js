'use strict';

const { randomUUID } = require('node:crypto');

const supertest = require('supertest');
const { make_app } = require('../helpers/app');
const db_helper = require('../helpers/db');
const jwt = require('../../libs/jwt');

let app;

async function bearer_for(du_id) {
    const u = await db_helper.seed_user({ du_id });
    return `Bearer ${jwt.sign({ sub: String(u.id), du_id })}`;
}

async function cookie_for(du_id) {
    const u = await db_helper.seed_user({ du_id });
    return `${jwt.COOKIE_NAME}=${jwt.sign({ sub: String(u.id), du_id })}`;
}

function dr(title, extra = {}) {
    return JSON.stringify({ title, thumbnail: `tn-${title}`, ...extra });
}

describe('collections — e2e', () => {
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

    describe('GET /repo/collections', () => {
        it('requires auth', async () => {
            const res = await supertest(app).get('/repo/collections');
            expect(res.status).toBe(401);
        });

        it('returns collections enriched with display_record', async () => {
            await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('JCRS Records'),
            });
            const bearer = await bearer_for('admin-c');
            const res = await supertest(app)
                .get('/repo/collections')
                .set('Authorization', bearer)
                .expect(200);
            expect(res.body.total).toBe(1);
            expect(res.body.items[0].title).toBe('JCRS Records');
            expect(res.body.items[0].member_count).toBe(0);
        });

        it('rejects unknown sort with default fallback (count)', async () => {
            // We default to 'count' for unknown sort — not 400. Make
            // sure that contract holds.
            await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('X'),
            });
            const bearer = await bearer_for('admin-c2');
            const res = await supertest(app)
                .get('/repo/collections?sort=invalid')
                .set('Authorization', bearer);
            expect(res.status).toBe(200);
            expect(res.body.sort).toBe('count');
        });
    });

    describe('GET /repo/collections/:pid', () => {
        it('returns a single collection with counts', async () => {
            const c = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Sets in Order'),
            });
            await db_helper.seed_object({
                is_member_of_collection: c.pid,
                is_published: 1,
            });
            const bearer = await bearer_for('admin-c3');
            const res = await supertest(app)
                .get(`/repo/collections/${c.pid}`)
                .set('Authorization', bearer)
                .expect(200);
            expect(res.body.data.title).toBe('Sets in Order');
            expect(res.body.data.member_count).toBe(1);
            expect(res.body.data.published_count).toBe(1);
        });

        it('returns 404 for an unknown pid', async () => {
            const bearer = await bearer_for('admin-c4');
            const res = await supertest(app)
                .get(`/repo/collections/${randomUUID()}`)
                .set('Authorization', bearer);
            expect(res.status).toBe(404);
        });

        it('returns 404 for a non-collection object', async () => {
            const obj = await db_helper.seed_object({ object_type: 'object' });
            const bearer = await bearer_for('admin-c5');
            const res = await supertest(app)
                .get(`/repo/collections/${obj.pid}`)
                .set('Authorization', bearer);
            expect(res.status).toBe(404);
        });
    });

    describe('GET /repo/collections/:pid/members', () => {
        it('lists member objects, filtered by collection_pid', async () => {
            const c = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('C'),
            });
            for (let i = 0; i < 3; i++) {
                await db_helper.seed_object({
                    is_member_of_collection: c.pid,
                });
            }
            const bearer = await bearer_for('admin-c6');
            const res = await supertest(app)
                .get(`/repo/collections/${c.pid}/members`)
                .set('Authorization', bearer)
                .expect(200);
            expect(res.body.total).toBe(3);
        });
    });

    describe('Dashboard collection pages', () => {
        it('renders the Collections sidebar link on every dashboard page', async () => {
            const cookie = await cookie_for('side');
            const res = await supertest(app)
                .get('/repo/dashboard/')
                .set('Cookie', cookie)
                .expect(200);
            expect(res.text).toMatch(/href="\/repo\/dashboard\/collections"/);
            expect(res.text).toMatch(/title="Collections"/);
        });

        it('Collections list shell page renders with search + sort controls', async () => {
            const cookie = await cookie_for('list-shell');
            const res = await supertest(app)
                .get('/repo/dashboard/collections')
                .set('Cookie', cookie)
                .expect(200);
            expect(res.text).toMatch(/<h1[^>]*>Collections<\/h1>/);
            expect(res.text).toMatch(/id="collections-table"/);
            expect(res.text).toMatch(/name="sort"/);
            expect(res.text).toMatch(/name="q"/);
        });

        it('Collections list partial returns the table fragment', async () => {
            const cookie = await cookie_for('list-partial');
            await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('My Collection'),
            });
            const res = await supertest(app)
                .get('/repo/dashboard/collections/list')
                .set('Cookie', cookie)
                .expect(200);
            expect(res.text).toMatch(/<table class="queue-table">/);
            expect(res.text).toMatch(/My Collection/);
            expect(res.text).toMatch(/Objects/); // the "Objects" (view objects) action
            // Fragment, not full page
            expect(res.text).not.toMatch(/<html/);
        });

        it('Collections list q filter narrows the result set', async () => {
            const cookie = await cookie_for('list-q');
            await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Apples'),
            });
            await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Bananas'),
            });
            const res = await supertest(app)
                .get('/repo/dashboard/collections/list?q=banana')
                .set('Cookie', cookie)
                .expect(200);
            expect(res.text).toMatch(/Bananas/);
            expect(res.text).not.toMatch(/Apples/);
        });

        it('Collection detail page renders the metadata header + embeds the members table', async () => {
            const cookie = await cookie_for('detail');
            const c = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Clarion Newspaper', {
                    abstract: 'A long-running student newspaper of the University of Denver.',
                    f_subjects: ['Newspapers', 'Student journalism'],
                    handle: 'https://hdl.invalid/test',
                }),
            });
            for (let i = 0; i < 2; i++) {
                await db_helper.seed_object({
                    is_member_of_collection: c.pid,
                });
            }
            const res = await supertest(app)
                .get(`/repo/dashboard/collections/${c.pid}`)
                .set('Cookie', cookie)
                .expect(200);
            expect(res.text).toMatch(/Clarion Newspaper/);
            expect(res.text).toMatch(/A long-running student newspaper/);
            expect(res.text).toMatch(/Newspapers/);
            expect(res.text).toMatch(/hdl\.invalid\/test/);
            // The embedded objects table — driven via HTMX from /objects/list
            expect(res.text).toMatch(/id="objects-table"/);
            // Counts in the subtitle
            expect(res.text).toMatch(/2 objects/);
        });

        it('Collection detail page returns 404 for unknown pid', async () => {
            const cookie = await cookie_for('detail-404');
            const res = await supertest(app)
                .get(`/repo/dashboard/collections/${randomUUID()}`)
                .set('Cookie', cookie);
            expect(res.status).toBe(404);
        });
    });
});
