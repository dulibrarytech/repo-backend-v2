'use strict';

const { randomUUID } = require('node:crypto');

const supertest = require('supertest');
const { make_app } = require('../helpers/app');
const db_helper = require('../helpers/db');
const { db } = require('../../config/db');
const tables = require('../../config/db_tables');
const jwt = require('../../libs/jwt');
const repo_model = require('../../repository/model');

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
            /*
             * We default to 'count' for unknown sort — not 400. Make
             * sure that contract holds.
             */
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
            expect(res.text).toMatch(/title="Manage Collections"/);
        });

        it('Collections list shell page renders with search + sort controls', async () => {
            const cookie = await cookie_for('list-shell');
            const res = await supertest(app)
                .get('/repo/dashboard/collections')
                .set('Cookie', cookie)
                .expect(200);
            expect(res.text).toMatch(/<h1[^>]*>Manage Collections<\/h1>/);
            expect(res.text).toMatch(/id="collections-table"/);
            expect(res.text).toMatch(/name="sort"/);
            expect(res.text).toMatch(/name="q"/);
        });

        it('does NOT render the "+ New collection" button on the list view', async () => {
            /*
             * TEMPORARY (2026-07-27): the button is hidden by request via
             * show_new_collection in views/dashboard/collections.ejs.
             * The /collections/new route stays live for direct URLs —
             * covered by the create-form tests below. Drop this test
             * when the flag flips back to true.
             */
            const cookie = await cookie_for('list-no-new-btn');
            const res = await supertest(app)
                .get('/repo/dashboard/collections')
                .set('Cookie', cookie)
                .expect(200);
            expect(res.text).not.toContain('+ New collection');
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

        it('does NOT render the "+ Create sub-collection" button on the detail page', async () => {
            /*
             * TEMPORARY (2026-07-27): the button is hidden by request via
             * show_create_subcollection in
             * views/dashboard/collection_detail.ejs. The
             * /collections/new?parent=<pid> route stays live for direct
             * URLs — covered by the sub-collection form tests below.
             * Drop this test when the flag flips back to true.
             */
            const cookie = await cookie_for('detail-no-sub-btn');
            const c = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('No Sub Button Coll'),
            });
            const res = await supertest(app)
                .get(`/repo/dashboard/collections/${c.pid}`)
                .set('Cookie', cookie)
                .expect(200);
            expect(res.text).not.toContain('+ Create sub-collection');
        });

        it('Collection detail page returns 404 for unknown pid', async () => {
            const cookie = await cookie_for('detail-404');
            const res = await supertest(app)
                .get(`/repo/dashboard/collections/${randomUUID()}`)
                .set('Cookie', cookie);
            expect(res.status).toBe(404);
        });
    });

    describe('dashboard create collection (GET form + POST create)', () => {
        /*
         * Stub ArchivesSpace so provision_collection can "fetch" the resource.
         * (No live AS in tests; the real module is unconfigured.)
         */
        const aspace = require('../../libs/archivesspace');
        let aspace_orig;
        beforeEach(() => {
            aspace_orig = {
                is_configured: aspace.is_configured,
                get_session_token: aspace.get_session_token,
                get_record: aspace.get_record,
                destroy_session_token: aspace.destroy_session_token,
            };
            aspace.is_configured = () => true;
            aspace.get_session_token = async () => 'test-token';
            aspace.get_record = async () => ({
                status: 200,
                data: { title: 'Mock Resource', abstract: 'Mock abstract.' },
            });
            aspace.destroy_session_token = async () => {};
        });
        afterEach(() => {
            Object.assign(aspace, aspace_orig);
        });

        it('GET /dashboard/collections/new renders the create form', async () => {
            const cookie = await cookie_for('coll-new-form');
            const res = await supertest(app)
                .get('/repo/dashboard/collections/new')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toContain('New Collection');
            expect(res.text).toMatch(/name="uri"/);
        });

        it('GET /dashboard/collections/new?parent=<pid> renders the sub-collection form', async () => {
            const parent = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Parent Coll'),
            });
            const cookie = await cookie_for('coll-sub-form');
            const res = await supertest(app)
                .get(`/repo/dashboard/collections/new?parent=${parent.pid}`)
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toContain('Create Sub-collection');
            expect(res.text).toContain('Parent Coll');
            expect(res.text).toContain(`name="parent_collection_pid" value="${parent.pid}"`);
        });

        it('POST /dashboard/collections accepts an archival_object URI (staff use them as collections)', async () => {
            const cookie = await cookie_for('coll-ao');
            const res = await supertest(app)
                .post('/repo/dashboard/collections')
                .set('Cookie', cookie)
                .type('form')
                .send({ uri: '/repositories/2/archival_objects/426' });
            expect(res.status).toBe(303);
            const created = await repo_model.find_collection_by_uri(
                '/repositories/2/archival_objects/426'
            );
            expect(created).toBeTruthy();
            expect(created.object_type).toBe('collection');
        });

        it('POST /dashboard/collections rejects a bare numeric ID (full URI now required)', async () => {
            const cookie = await cookie_for('coll-bare');
            const res = await supertest(app)
                .post('/repo/dashboard/collections')
                .set('Cookie', cookie)
                .type('form')
                .send({ uri: '4242' });
            expect(res.status).toBe(200);
            expect(res.text).toMatch(/Couldn't create the collection/i);
            expect(res.text).toMatch(/full ArchivesSpace URI/i);
            // Nothing was created from the ambiguous bare ID.
            const repo_id = require('../../config/app')().archivespace.repository_id || '2';
            const created = await repo_model.find_collection_by_uri(
                `/repositories/${repo_id}/resources/4242`
            );
            expect(created).toBeFalsy();
        });

        it('POST /dashboard/collections creates a TOP-LEVEL collection and redirects', async () => {
            const cookie = await cookie_for('coll-create-top');
            const res = await supertest(app)
                .post('/repo/dashboard/collections')
                .set('Cookie', cookie)
                .type('form')
                .send({ uri: '/repositories/2/resources/7777' });
            expect(res.status).toBe(303);
            const created = await repo_model.find_collection_by_uri('/repositories/2/resources/7777');
            expect(created).toBeTruthy();
            expect(created.object_type).toBe('collection');
            expect(created.is_member_of_collection).toBe('');
            expect(res.headers.location).toContain(`/collections/${created.pid}`);
        });

        it('POST /dashboard/collections with a parent creates a SUB-collection nested under it', async () => {
            const parent = await db_helper.seed_object({
                object_type: 'collection',
                uri: '/repositories/2/resources/8000',
            });
            const cookie = await cookie_for('coll-create-sub');
            const res = await supertest(app)
                .post('/repo/dashboard/collections')
                .set('Cookie', cookie)
                .type('form')
                .send({ uri: '/repositories/2/resources/8001', parent_collection_pid: parent.pid });
            expect(res.status).toBe(303);
            const sub = await repo_model.find_collection_by_uri('/repositories/2/resources/8001');
            expect(sub).toBeTruthy();
            expect(sub.is_member_of_collection).toBe(parent.pid);
        });

        it('POST /dashboard/collections nests a SUB-collection bound to an archival_object URI', async () => {
            const parent = await db_helper.seed_object({
                object_type: 'collection',
                uri: '/repositories/2/resources/8100',
            });
            const cookie = await cookie_for('coll-sub-ao');
            const res = await supertest(app)
                .post('/repo/dashboard/collections')
                .set('Cookie', cookie)
                .type('form')
                .send({
                    uri: '/repositories/2/archival_objects/8101',
                    parent_collection_pid: parent.pid,
                });
            expect(res.status).toBe(303);
            const sub = await repo_model.find_collection_by_uri(
                '/repositories/2/archival_objects/8101'
            );
            expect(sub).toBeTruthy();
            expect(sub.is_member_of_collection).toBe(parent.pid);
        });

        it('POST /dashboard/collections surfaces "already exists" for a duplicate resource URI', async () => {
            await db_helper.seed_object({
                object_type: 'collection',
                uri: '/repositories/2/resources/9000',
            });
            const cookie = await cookie_for('coll-dup');
            const res = await supertest(app)
                .post('/repo/dashboard/collections')
                .set('Cookie', cookie)
                .type('form')
                .send({ uri: '/repositories/2/resources/9000' });
            expect(res.status).toBe(200);
            expect(res.text).toMatch(/already exists/i);
        });

        it('viewer cannot load the form or create (403)', async () => {
            const u = await db_helper.seed_user({ du_id: 'coll-viewer', role: 'viewer' });
            const cookie = `${jwt.COOKIE_NAME}=${jwt.sign({ sub: String(u.id), du_id: 'coll-viewer' })}`;
            const g = await supertest(app)
                .get('/repo/dashboard/collections/new')
                .set('Cookie', cookie);
            expect(g.status).toBe(403);
            const p = await supertest(app)
                .post('/repo/dashboard/collections')
                .set('Cookie', cookie)
                .type('form')
                .send({ uri: '/repositories/2/resources/1' });
            expect(p.status).toBe(403);
        });
    });

    describe('dashboard add objects to a collection (Phase 2)', () => {
        it('GET /collections/:pid/add-objects renders the live-search shell (no Search button)', async () => {
            const c = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Target Coll'),
            });
            const cookie = await cookie_for('add-form');
            const res = await supertest(app)
                .get(`/repo/dashboard/collections/${c.pid}/add-objects`)
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toContain('Add objects');
            // Live search like the rest of the app: debounced input, no button.
            expect(res.text).toMatch(/name="q"/);
            expect(res.text).toMatch(/hx-trigger="keyup changed delay:300ms, search"/);
            expect(res.text).toContain('id="add-objects-results"');
            expect(res.text).toContain(`/collections/${c.pid}/add-objects/list`);
            // The form posts the (persisted) selection to /members.
            expect(res.text).toContain(`/collections/${c.pid}/members`);
        });

        it('GET .../add-objects/list lists candidates, excluding collections and current members', async () => {
            const c = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Target Coll'),
            });
            // A free object that matches — should be offered as a candidate.
            const alpha = await db_helper.seed_object({
                is_member_of_collection: 'codu:root',
                display_record: dr('Alpha zzqcandidate'),
            });
            // A collection that matches the query — must NOT be a candidate.
            const otherColl = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Beta zzqcandidate'),
            });
            // An object already in THIS collection — adding would be a no-op.
            const gamma = await db_helper.seed_object({
                is_member_of_collection: c.pid,
                display_record: dr('Gamma zzqcandidate'),
            });
            const cookie = await cookie_for('add-search');
            const res = await supertest(app)
                .get(`/repo/dashboard/collections/${c.pid}/add-objects/list?q=zzqcandidate`)
                .set('Cookie', cookie)
                .expect(200);
            // Candidate checkboxes carry data-pid="<pid>" (UI-only, no name).
            expect(res.text).toContain(`data-pid="${alpha.pid}"`);
            expect(res.text).not.toContain(`data-pid="${otherColl.pid}"`);
            expect(res.text).not.toContain(`data-pid="${gamma.pid}"`);
            // The header "select all on this page" checkbox is present.
            expect(res.text).toContain('id="add-objects-select-page"');
            // Fragment, not a full page.
            expect(res.text).not.toMatch(/<html/);
        });

        it('GET .../add-objects/list shows each candidate’s current collection by name', async () => {
            const target = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Target Coll'),
            });
            const home = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Home Collection'),
            });
            // A candidate currently in 'home' (resolves to its title).
            await db_helper.seed_object({
                is_member_of_collection: home.pid,
                display_record: dr('Wanderer zhomenametoken'),
            });
            // A candidate in no collection (renders the — dash, no title).
            await db_helper.seed_object({
                is_member_of_collection: '',
                display_record: dr('Orphan zhomenametoken'),
            });
            const cookie = await cookie_for('add-current-name');
            const res = await supertest(app)
                .get(`/repo/dashboard/collections/${target.pid}/add-objects/list?q=zhomenametoken`)
                .set('Cookie', cookie)
                .expect(200);
            // The current collection is shown by NAME.
            expect(res.text).toContain('Home Collection');
        });

        it('GET .../add-objects/list paginates eligible candidates 25 per page', async () => {
            const c = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Big Target'),
            });
            // 30 eligible free objects sharing a distinctive search token.
            for (let i = 0; i < 30; i++) {
                await db_helper.seed_object({
                    is_member_of_collection: 'codu:root',
                    display_record: dr(`Item zpagetoken ${i}`),
                });
            }
            const cookie = await cookie_for('add-page');
            const p1 = await supertest(app)
                .get(`/repo/dashboard/collections/${c.pid}/add-objects/list?q=zpagetoken`)
                .set('Cookie', cookie)
                .expect(200);
            // True total surfaced + first page holds 25 rows + a Next control.
            expect(p1.text).toMatch(/30 eligible objects/);
            expect((p1.text.match(/add-object-checkbox/g) || []).length).toBe(25);
            expect(p1.text).toMatch(/Next/);
            // Page 2 holds the remaining 5.
            const p2 = await supertest(app)
                .get(`/repo/dashboard/collections/${c.pid}/add-objects/list?q=zpagetoken&page=2`)
                .set('Cookie', cookie)
                .expect(200);
            expect((p2.text.match(/add-object-checkbox/g) || []).length).toBe(5);
        });

        it('POST /collections/:pid/members moves the selected objects and redirects to the detail', async () => {
            const c = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Target Coll'),
            });
            const a = await db_helper.seed_object({ is_member_of_collection: 'codu:root' });
            const b = await db_helper.seed_object({ is_member_of_collection: 'codu:other' });
            const cookie = await cookie_for('add-post');
            const res = await supertest(app)
                .post(`/repo/dashboard/collections/${c.pid}/members`)
                .set('Cookie', cookie)
                .type('form')
                .send({ pids: [a.pid, b.pid] });
            expect(res.status).toBe(303);
            expect(res.headers.location).toContain(`/collections/${c.pid}`);

            const rows = await db()(tables.objects)
                .whereIn('pid', [a.pid, b.pid])
                .select('is_member_of_collection', 'is_updated');
            for (const r of rows) {
                expect(r.is_member_of_collection).toBe(c.pid);
                expect(r.is_updated).toBe(1);
            }
        });

        it('POST /collections/:pid/members with nothing selected returns to the picker', async () => {
            const c = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Target Coll'),
            });
            const cookie = await cookie_for('add-empty');
            const res = await supertest(app)
                .post(`/repo/dashboard/collections/${c.pid}/members`)
                .set('Cookie', cookie)
                .type('form')
                .send({});
            expect(res.status).toBe(303);
            expect(res.headers.location).toContain(`/collections/${c.pid}/add-objects`);
        });

        it('detail page shows a Sub-collections section (Add objects button hidden)', async () => {
            const parent = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Parent Coll'),
            });
            await db_helper.seed_object({ is_member_of_collection: parent.pid });
            await db_helper.seed_object({
                object_type: 'collection',
                is_member_of_collection: parent.pid,
                display_record: dr('Nested Child Coll'),
            });
            const cookie = await cookie_for('detail-subs');
            const res = await supertest(app)
                .get(`/repo/dashboard/collections/${parent.pid}`)
                .set('Cookie', cookie)
                .expect(200);
            /*
             * TEMPORARY (2026-07-28): the "+ Add objects" button is hidden
             * by request via show_add_objects in
             * views/dashboard/collection_detail.ejs. The
             * /collections/:pid/add-objects route stays live for direct
             * URLs — covered by the add-objects form tests above. Restore
             * the toContain assertion when the flag flips back to true.
             */
            expect(res.text).not.toContain('+ Add objects');
            expect(res.text).not.toContain(`/collections/${parent.pid}/add-objects`);
            // Sub-collections section + the child collection's title.
            expect(res.text).toMatch(/Sub-collections/);
            expect(res.text).toContain('Nested Child Coll');
            // Member list embed carries the exclude_collections flag.
            expect(res.text).toMatch(/exclude_collections=1/);
        });

        it('member list partial excludes nested collections when exclude_collections=1', async () => {
            const parent = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Parent Coll'),
            });
            const member = await db_helper.seed_object({
                is_member_of_collection: parent.pid,
                display_record: dr('Plain Member Obj'),
            });
            const child = await db_helper.seed_object({
                object_type: 'collection',
                is_member_of_collection: parent.pid,
                display_record: dr('Nested Child Coll'),
            });
            const cookie = await cookie_for('exclude-list');

            // With the flag: the nested collection is filtered out.
            const filtered = await supertest(app)
                .get(
                    `/repo/dashboard/objects/list?collection=${parent.pid}&is_active=1&exclude_collections=1`
                )
                .set('Cookie', cookie)
                .expect(200);
            expect(filtered.text).toContain(`object-${member.pid}`);
            expect(filtered.text).not.toContain(`object-${child.pid}`);

            /*
             * Without it: the nested collection would show (proves the filter
             * is what's doing the work, not some other exclusion).
             */
            const unfiltered = await supertest(app)
                .get(`/repo/dashboard/objects/list?collection=${parent.pid}&is_active=1`)
                .set('Cookie', cookie)
                .expect(200);
            expect(unfiltered.text).toContain(`object-${child.pid}`);
        });

        it('viewer cannot add objects (403 on picker + POST), and the detail hides the button', async () => {
            const c = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Target Coll'),
            });
            const u = await db_helper.seed_user({ du_id: 'add-viewer', role: 'viewer' });
            const cookie = `${jwt.COOKIE_NAME}=${jwt.sign({ sub: String(u.id), du_id: 'add-viewer' })}`;

            const g = await supertest(app)
                .get(`/repo/dashboard/collections/${c.pid}/add-objects`)
                .set('Cookie', cookie);
            expect(g.status).toBe(403);

            const l = await supertest(app)
                .get(`/repo/dashboard/collections/${c.pid}/add-objects/list?q=x`)
                .set('Cookie', cookie);
            expect(l.status).toBe(403);

            const p = await supertest(app)
                .post(`/repo/dashboard/collections/${c.pid}/members`)
                .set('Cookie', cookie)
                .type('form')
                .send({ pids: [randomUUID()] });
            expect(p.status).toBe(403);

            // Viewer can still VIEW the collection, but without the Add button.
            const detail = await supertest(app)
                .get(`/repo/dashboard/collections/${c.pid}`)
                .set('Cookie', cookie)
                .expect(200);
            expect(detail.text).not.toContain(`/collections/${c.pid}/add-objects`);
        });
    });

    describe('dashboard delete empty sub-collection', () => {
        it('soft-deletes an empty sub-collection (200) and the row leaves the DB as inactive', async () => {
            const parent = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Parent Coll'),
            });
            const empty = await db_helper.seed_object({
                object_type: 'collection',
                is_member_of_collection: parent.pid,
                display_record: dr('Empty Sub'),
            });
            const cookie = await cookie_for('del-empty');
            const res = await supertest(app)
                .post(`/repo/dashboard/collections/${empty.pid}/delete`)
                .set('Cookie', cookie);
            expect(res.status).toBe(200);

            const row = await db()(tables.objects)
                .where({ pid: empty.pid })
                .first('is_active', 'is_updated');
            expect(row.is_active).toBe(0);
            expect(row.is_updated).toBe(1);

            // No longer listed under the parent.
            const detail = await supertest(app)
                .get(`/repo/dashboard/collections/${parent.pid}`)
                .set('Cookie', cookie)
                .expect(200);
            expect(detail.text).not.toContain('Empty Sub');
        });

        it('refuses to delete a non-empty sub-collection (409) and leaves it active', async () => {
            const parent = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Parent Coll'),
            });
            const full = await db_helper.seed_object({
                object_type: 'collection',
                is_member_of_collection: parent.pid,
                display_record: dr('Full Sub'),
            });
            await db_helper.seed_object({ is_member_of_collection: full.pid });
            const cookie = await cookie_for('del-full');
            const res = await supertest(app)
                .post(`/repo/dashboard/collections/${full.pid}/delete`)
                .set('Cookie', cookie);
            expect(res.status).toBe(409);

            const row = await db()(tables.objects).where({ pid: full.pid }).first('is_active');
            expect(row.is_active).toBe(1);
        });

        it('detail page offers Delete only for EMPTY sub-collections', async () => {
            const parent = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Parent Coll'),
            });
            const empty = await db_helper.seed_object({
                object_type: 'collection',
                is_member_of_collection: parent.pid,
                display_record: dr('Empty Sub'),
            });
            const full = await db_helper.seed_object({
                object_type: 'collection',
                is_member_of_collection: parent.pid,
                display_record: dr('Full Sub'),
            });
            await db_helper.seed_object({ is_member_of_collection: full.pid });
            const cookie = await cookie_for('del-detail');
            const res = await supertest(app)
                .get(`/repo/dashboard/collections/${parent.pid}`)
                .set('Cookie', cookie)
                .expect(200);
            // Empty sub → delete affordance present; full sub → absent.
            expect(res.text).toContain(`/collections/${empty.pid}/delete`);
            expect(res.text).not.toContain(`/collections/${full.pid}/delete`);
        });

        it('viewer cannot delete (403) and the detail hides the Delete affordance', async () => {
            const parent = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Parent Coll'),
            });
            const empty = await db_helper.seed_object({
                object_type: 'collection',
                is_member_of_collection: parent.pid,
                display_record: dr('Empty Sub'),
            });
            const u = await db_helper.seed_user({ du_id: 'del-viewer', role: 'viewer' });
            const cookie = `${jwt.COOKIE_NAME}=${jwt.sign({ sub: String(u.id), du_id: 'del-viewer' })}`;

            const res = await supertest(app)
                .post(`/repo/dashboard/collections/${empty.pid}/delete`)
                .set('Cookie', cookie);
            expect(res.status).toBe(403);

            const detail = await supertest(app)
                .get(`/repo/dashboard/collections/${parent.pid}`)
                .set('Cookie', cookie)
                .expect(200);
            expect(detail.text).not.toContain(`/collections/${empty.pid}/delete`);
        });
    });

    describe('dashboard move / re-parent a collection', () => {
        it('GET /collections/:pid/move/form renders the modal with eligible parents (not self/descendants)', async () => {
            const a = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Alpha Coll'),
            });
            const b = await db_helper.seed_object({
                object_type: 'collection',
                is_member_of_collection: a.pid,
                display_record: dr('Bravo Sub'),
            });
            const z = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Zulu Coll'),
            });
            const cookie = await cookie_for('move-form');
            const res = await supertest(app)
                .get(`/repo/dashboard/collections/${a.pid}/move/form`)
                .set('Cookie', cookie)
                .expect(200);
            expect(res.text).toContain('Move collection');
            expect(res.text).toContain('name="new_parent_pid"');
            expect(res.text).toContain('(Top level'); // un-nest option
            expect(res.text).toContain(`value="${z.pid}"`); // eligible
            expect(res.text).not.toContain(`value="${a.pid}"`); // self excluded
            expect(res.text).not.toContain(`value="${b.pid}"`); // descendant excluded
        });

        it('POST /collections/:pid/move nests a collection under a parent', async () => {
            const parent = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Parent Coll'),
            });
            const child = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Child Coll'),
            });
            const cookie = await cookie_for('move-nest');
            const res = await supertest(app)
                .post(`/repo/dashboard/collections/${child.pid}/move`)
                .set('Cookie', cookie)
                .type('form')
                .send({ new_parent_pid: parent.pid });
            expect(res.status).toBe(200);
            const row = await db()(tables.objects)
                .where({ pid: child.pid })
                .first('is_member_of_collection', 'is_updated');
            expect(row.is_member_of_collection).toBe(parent.pid);
            expect(row.is_updated).toBe(1);
        });

        it('POST /collections/:pid/move with empty parent moves it to the top level', async () => {
            const parent = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Parent Coll'),
            });
            const child = await db_helper.seed_object({
                object_type: 'collection',
                is_member_of_collection: parent.pid,
                display_record: dr('Child Coll'),
            });
            const cookie = await cookie_for('move-top');
            const res = await supertest(app)
                .post(`/repo/dashboard/collections/${child.pid}/move`)
                .set('Cookie', cookie)
                .type('form')
                .send({ new_parent_pid: '' });
            expect(res.status).toBe(200);
            const row = await db()(tables.objects)
                .where({ pid: child.pid })
                .first('is_member_of_collection');
            expect(row.is_member_of_collection).toBe('');
        });

        it('POST move rejects a cycle (under its own descendant) with 400', async () => {
            const a = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('A'),
            });
            const b = await db_helper.seed_object({
                object_type: 'collection',
                is_member_of_collection: a.pid,
                display_record: dr('B'),
            });
            const cookie = await cookie_for('move-cycle');
            const res = await supertest(app)
                .post(`/repo/dashboard/collections/${a.pid}/move`)
                .set('Cookie', cookie)
                .type('form')
                .send({ new_parent_pid: b.pid });
            expect(res.status).toBe(400);
            // A stayed top-level.
            const row = await db()(tables.objects).where({ pid: a.pid }).first('is_member_of_collection');
            expect(row.is_member_of_collection).not.toBe(b.pid);
        });

        it('the collection kebab offers Move under collection (editor)', async () => {
            await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Movable Coll'),
            });
            const cookie = await cookie_for('move-kebab');
            const res = await supertest(app)
                .get('/repo/dashboard/collections/list')
                .set('Cookie', cookie)
                .expect(200);
            expect(res.text).toMatch(/\/move\/form/);
        });

        it('viewer cannot move (403 on form + POST)', async () => {
            const a = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('A'),
            });
            const b = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('B'),
            });
            const u = await db_helper.seed_user({ du_id: 'move-viewer', role: 'viewer' });
            const cookie = `${jwt.COOKIE_NAME}=${jwt.sign({ sub: String(u.id), du_id: 'move-viewer' })}`;
            const g = await supertest(app)
                .get(`/repo/dashboard/collections/${a.pid}/move/form`)
                .set('Cookie', cookie);
            expect(g.status).toBe(403);
            const p = await supertest(app)
                .post(`/repo/dashboard/collections/${a.pid}/move`)
                .set('Cookie', cookie)
                .type('form')
                .send({ new_parent_pid: b.pid });
            expect(p.status).toBe(403);
        });
    });
});
