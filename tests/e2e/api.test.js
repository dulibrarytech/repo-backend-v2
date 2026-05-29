'use strict';

// E2E for the public API.
//
// Most of the substantive search/get/list logic lives in
// tests/unit/api/model.test.js where we drive the model with a fake
// ES client. What this file checks is the HTTP surface itself:
//   - routes are mounted at the right paths
//   - no auth is required (key property of a PUBLIC api)
//   - CORS allows wide-open origin
//   - validation errors surface as 400s with the right shape
//   - eligibility gating works on the thumbnail proxy (placeholder
//     when ES says ineligible)
//
// We don't have a real ES in the test env, so endpoints that hit ES
// will surface UpstreamError → 5xx. We avoid asserting on those
// paths and focus on the wiring.

const supertest = require('supertest');
const { make_app } = require('../helpers/app');
const db_helper = require('../helpers/db');

let app;

describe('public API — e2e', () => {
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

    describe('GET /api/v1/health', () => {
        it('returns 200 with service info, no auth required', async () => {
            const res = await supertest(app).get('/repo/api/v1/health');
            expect(res.status).toBe(200);
            expect(res.body.status).toBe('ok');
            expect(res.body.service).toBe('public-api');
            expect(res.body.version).toBeDefined();
        });

        it('sends Cache-Control: max-age=0 so monitors get fresh checks', async () => {
            const res = await supertest(app).get('/repo/api/v1/health');
            expect(res.headers['cache-control']).toMatch(/max-age=0/);
        });
    });

    describe('CORS', () => {
        it('responds to OPTIONS preflight with Access-Control-Allow-Origin: *', async () => {
            const res = await supertest(app)
                .options('/repo/api/v1/health')
                .set('Origin', 'https://random-3rd-party.example')
                .set('Access-Control-Request-Method', 'GET');
            // 204 from cors() on a successful preflight.
            expect([200, 204]).toContain(res.status);
            expect(res.headers['access-control-allow-origin']).toBe('*');
        });

        it('exposes the X-Request-Id header so consumers can correlate bugs', async () => {
            const res = await supertest(app)
                .get('/repo/api/v1/health')
                .set('Origin', 'https://random-3rd-party.example');
            // Whether 'cors' echoes the exposed header on the response
            // depends on the request; verify the preflight side too.
            const opts = await supertest(app)
                .options('/repo/api/v1/health')
                .set('Origin', 'https://random-3rd-party.example')
                .set('Access-Control-Request-Method', 'GET');
            expect(opts.headers['access-control-expose-headers']).toMatch(/X-Request-Id/i);
            expect(res.headers['x-request-id']).toBeDefined();
        });

        it('does NOT include Access-Control-Allow-Credentials (we use *)', async () => {
            const res = await supertest(app)
                .options('/repo/api/v1/health')
                .set('Origin', 'https://random-3rd-party.example')
                .set('Access-Control-Request-Method', 'GET');
            // credentials:false in our config → header omitted.
            expect(res.headers['access-control-allow-credentials']).toBeUndefined();
        });
    });

    describe('GET /api/v1/search — validation', () => {
        // These return 400 because the validator fires BEFORE the
        // model tries to talk to ES. Confirms our query-builder
        // surface area without needing ES configured.
        it('400s on bogus object_type', async () => {
            const res = await supertest(app).get('/repo/api/v1/search?object_type=video');
            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/object_type/);
        });

        it('400s on bogus is_compound', async () => {
            const res = await supertest(app).get('/repo/api/v1/search?is_compound=maybe');
            expect(res.status).toBe(400);
        });

        it('400s on bogus collection UUID', async () => {
            const res = await supertest(app).get('/repo/api/v1/search?collection=not-a-uuid');
            expect(res.status).toBe(400);
        });

        it('400s on overly long q', async () => {
            const res = await supertest(app).get('/repo/api/v1/search?q=' + 'x'.repeat(201));
            expect(res.status).toBe(400);
        });

        it('400s on bogus sort key', async () => {
            const res = await supertest(app).get('/repo/api/v1/search?sort=random');
            expect(res.status).toBe(400);
        });
    });

    describe('GET /api/v1/objects/:pid — validation', () => {
        it('400s on a non-UUID pid', async () => {
            const res = await supertest(app).get('/repo/api/v1/objects/not-a-uuid');
            expect(res.status).toBe(400);
        });
    });

    describe('GET /api/v1/objects/:pid/thumbnail — eligibility gate', () => {
        // When ES isn't configured, model.is_eligible returns false
        // (the ES call throws and the model swallows it). Result:
        // placeholder for everyone. We assert the placeholder path
        // because it doesn't require ES — and proves the gate is
        // working: no row leaks its thumbnail to public callers.
        it('returns the SVG placeholder when the row is not eligible', async () => {
            const o = await db_helper.seed_object({
                is_published: 1,
                thumbnail: 'https://cdn.example.com/anything.jpg',
            });
            const res = await supertest(app).get(`/repo/api/v1/objects/${o.pid}/thumbnail`);
            // 200 + placeholder. The proxy never returns 404 for the
            // thumbnail (would surface a broken-image icon to the
            // browser).
            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toMatch(/image\/svg/);
        });

        it('returns the placeholder for an unknown pid', async () => {
            const res = await supertest(app).get(
                '/repo/api/v1/objects/00000000-0000-0000-0000-000000000000/thumbnail'
            );
            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toMatch(/image\/svg/);
        });
    });

    describe('rate limiting', () => {
        it('exposes the draft-7 combined RateLimit header on responses', async () => {
            const res = await supertest(app).get('/repo/api/v1/health');
            // draft-7 emits a single combined `RateLimit` header
            // (e.g. "limit=300, remaining=299, reset=60"). draft-6
            // split it into RateLimit-Limit / -Remaining / -Reset.
            // We use draft-7 — verify the combined form is present.
            expect(res.headers['ratelimit']).toBeDefined();
            expect(res.headers['ratelimit']).toMatch(/limit=\d+/);
            expect(res.headers['ratelimit']).toMatch(/remaining=\d+/);
        });
    });

    describe('no auth required', () => {
        it('responds without a session cookie or any auth header', async () => {
            // The biggest single thing this test class is checking:
            // the public API is not behind require_dashboard_auth.
            const res = await supertest(app).get('/repo/api/v1/health');
            expect(res.status).toBe(200);
            // No Set-Cookie either (we shouldn't be issuing sessions).
            expect(res.headers['set-cookie']).toBeUndefined();
        });
    });
});
