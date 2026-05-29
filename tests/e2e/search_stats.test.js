'use strict';

const supertest = require('supertest');
const { make_app } = require('../helpers/app');
const db_helper = require('../helpers/db');
const stats_model = require('../../stats/model');
const jwt = require('../../libs/jwt');

let app;
let bearer;

async function bearer_for(du_id) {
    const u = await db_helper.seed_user({ du_id });
    return `Bearer ${jwt.sign({ sub: String(u.id), du_id })}`;
}

describe('search + stats — e2e', () => {
    beforeAll(async () => {
        app = make_app();
        await db_helper.setup_schema();
    });
    beforeEach(async () => {
        await db_helper.reset_data();
        stats_model._reset();
        bearer = await bearer_for('admin');
    });
    afterAll(async () => {
        await db_helper.teardown();
    });

    describe('GET /repo/search/objects', () => {
        it('requires auth', async () => {
            const res = await supertest(app).get('/repo/search/objects');
            expect(res.status).toBe(401);
        });

        it('returns paginated search results', async () => {
            await db_helper.seed_object({ file_name: 'photo-1.jpg' });
            await db_helper.seed_object({ file_name: 'photo-2.jpg' });
            await db_helper.seed_object({ file_name: 'doc.pdf' });
            const res = await supertest(app)
                .get('/repo/search/objects?q=photo')
                .set('Authorization', bearer)
                .expect(200);
            expect(res.body.total).toBe(2);
            expect(res.body.q).toBe('photo');
            expect(res.body.items).toHaveLength(2);
        });

        it('respects is_published filter via query string', async () => {
            await db_helper.seed_object({ file_name: 'a.jpg', is_published: 1 });
            await db_helper.seed_object({ file_name: 'b.jpg', is_published: 0 });
            const res = await supertest(app)
                .get('/repo/search/objects?is_published=1')
                .set('Authorization', bearer)
                .expect(200);
            expect(res.body.total).toBe(1);
        });

        it('rejects wildcard-only queries with 400', async () => {
            const res = await supertest(app)
                .get('/repo/search/objects?q=%25%25%25')
                .set('Authorization', bearer);
            expect(res.status).toBe(400);
            expect(res.body.code).toBe('VALIDATION_ERROR');
        });

        it('caps page_size at 200', async () => {
            const res = await supertest(app)
                .get('/repo/search/objects?page_size=9999')
                .set('Authorization', bearer)
                .expect(200);
            expect(res.body.page_size).toBe(200);
        });
    });

    describe('GET /repo/search/lookup', () => {
        it('returns matches for a partial query', async () => {
            await db_helper.seed_object({ file_name: 'staffphoto-1.jpg' });
            const res = await supertest(app)
                .get('/repo/search/lookup?q=staffphoto')
                .set('Authorization', bearer)
                .expect(200);
            expect(res.body.items).toHaveLength(1);
        });

        it('ignores too-short queries', async () => {
            const res = await supertest(app)
                .get('/repo/search/lookup?q=a')
                .set('Authorization', bearer)
                .expect(200);
            expect(res.body.items).toEqual([]);
        });
    });

    describe('GET /repo/stats/summary', () => {
        it('requires auth', async () => {
            const res = await supertest(app).get('/repo/stats/summary');
            expect(res.status).toBe(401);
        });

        it('returns the full counts shape', async () => {
            await db_helper.seed_object({ is_published: 1 });
            await db_helper.seed_object({ is_published: 0 });
            const res = await supertest(app)
                .get('/repo/stats/summary')
                .set('Authorization', bearer)
                .expect(200);
            // admin user counts in active_users
            expect(res.body.active_users).toBeGreaterThanOrEqual(1);
            expect(res.body.total).toBe(2);
            expect(res.body.published).toBe(1);
        });
    });

    describe('GET /repo/stats/by-collection', () => {
        it('returns top-N collections', async () => {
            for (let i = 0; i < 3; i++) {
                await db_helper.seed_object({ is_member_of_collection: 'codu:A' });
            }
            await db_helper.seed_object({ is_member_of_collection: 'codu:B' });
            const res = await supertest(app)
                .get('/repo/stats/by-collection?limit=10')
                .set('Authorization', bearer)
                .expect(200);
            expect(res.body.items[0].collection).toBe('codu:A');
            expect(res.body.items[0].count).toBe(3);
        });

        it('rejects out-of-range limit', async () => {
            const res = await supertest(app)
                .get('/repo/stats/by-collection?limit=999')
                .set('Authorization', bearer);
            expect(res.status).toBe(400);
        });
    });

    describe('GET /repo/stats/recent-ingests', () => {
        it('returns latest objects newest first', async () => {
            const seeded = [];
            for (let i = 0; i < 4; i++) {
                seeded.push(await db_helper.seed_object({ file_name: `r-${i}.dat` }));
            }
            const res = await supertest(app)
                .get('/repo/stats/recent-ingests?limit=2')
                .set('Authorization', bearer)
                .expect(200);
            expect(res.body.items).toHaveLength(2);
            expect(res.body.items[0].file_name).toBe('r-3.dat');
        });
    });

    describe('Dashboard /objects/list integrates search', () => {
        // Cookies, since the dashboard uses cookie auth
        async function cookie_for(du_id) {
            const u = await db_helper.seed_user({ du_id });
            return `${jwt.COOKIE_NAME}=${jwt.sign({ sub: String(u.id), du_id })}`;
        }

        it('renders the search input on the shell page', async () => {
            const cookie = await cookie_for('shell-search');
            const res = await supertest(app).get('/repo/dashboard/objects').set('Cookie', cookie);
            expect(res.text).toMatch(/<input[^>]*type="search"/);
            expect(res.text).toMatch(/name="q"/);
        });

        it('routes through search when ?q= is set', async () => {
            const cookie = await cookie_for('search-list');
            await db_helper.seed_object({ file_name: 'targeted-photo.jpg' });
            await db_helper.seed_object({ file_name: 'other.dat' });
            const res = await supertest(app)
                .get('/repo/dashboard/objects/list?q=targeted-photo')
                .set('Cookie', cookie)
                .expect(200);
            // Only one matching row, no <tr> for the other.
            const tr_count = (res.text.match(/<tr id="object-/g) || []).length;
            expect(tr_count).toBe(1);
        });

        it('falls back to plain list when q is absent', async () => {
            const cookie = await cookie_for('search-list-plain');
            await db_helper.seed_object();
            await db_helper.seed_object();
            const res = await supertest(app)
                .get('/repo/dashboard/objects/list')
                .set('Cookie', cookie)
                .expect(200);
            const tr_count = (res.text.match(/<tr id="object-/g) || []).length;
            expect(tr_count).toBe(2);
        });
    });

    describe('Dashboard home partials', () => {
        async function cookie_for(du_id) {
            const u = await db_helper.seed_user({ du_id });
            return `${jwt.COOKIE_NAME}=${jwt.sign({ sub: String(u.id), du_id })}`;
        }

        it('top-collections partial returns the list fragment', async () => {
            const cookie = await cookie_for('home-collections');
            await db_helper.seed_object({ is_member_of_collection: 'codu:home' });
            const res = await supertest(app)
                .get('/repo/dashboard/_home/top-collections')
                .set('Cookie', cookie)
                .expect(200);
            expect(res.text).toMatch(/codu:home/);
            // Fragment, not a full page
            expect(res.text).not.toMatch(/<html/);
        });

        it('recent-ingests partial returns the list fragment', async () => {
            const cookie = await cookie_for('home-recent');
            await db_helper.seed_object({ file_name: 'home-photo.jpg' });
            const res = await supertest(app)
                .get('/repo/dashboard/_home/recent-ingests')
                .set('Cookie', cookie)
                .expect(200);
            expect(res.text).toMatch(/home-photo\.jpg/);
            expect(res.text).not.toMatch(/<html/);
        });
    });
});
