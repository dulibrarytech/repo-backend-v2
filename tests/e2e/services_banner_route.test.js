'use strict';

/*
 * Regression test for the post-sign-in services-banner ROUTE registration.
 *
 * The banner partial had unit coverage, but nothing hit the actual HTTP
 * route — so a path mismatch shipped: the route was mistakenly registered
 * under `${base}` (= /repo/dashboard/ingest) as
 * /repo/dashboard/ingest/_services/banner, while the home page mounts
 * hx-get="<dashboard_base>/_services/banner" = /repo/dashboard/_services/banner.
 * Result: the browser's lazy load 404'd. These tests pin the contract:
 * the served path must equal the path the home page requests.
 */

const supertest = require('supertest');
const { make_app } = require('../helpers/app');

describe('services banner route registration', () => {
    let app;
    beforeAll(() => {
        app = make_app();
    });

    it('GET /repo/dashboard/_services/banner is registered (auth-gated, NOT 404)', async () => {
        const res = await supertest(app).get('/repo/dashboard/_services/banner');
        /*
         * An unauthed full-page GET is redirected to login by
         * require_dashboard_auth. The point of this assertion is that it is
         * NOT 404 — i.e. the route exists at the path the home page requests.
         */
        expect(res.status).not.toBe(404);
        expect(res.status).toBe(302);
        expect(res.headers.location).toMatch(/\/repo\/dashboard\/login/);
    });

    it('HX-Request to the banner path returns 401 + HX-Redirect (not 404)', async () => {
        const res = await supertest(app)
            .get('/repo/dashboard/_services/banner')
            .set('HX-Request', 'true');
        expect(res.status).toBe(401);
        expect(res.headers['hx-redirect']).toMatch(/\/login/);
    });

    it('the old (buggy) /repo/dashboard/ingest/_services/banner path is NOT served', async () => {
        const res = await supertest(app).get('/repo/dashboard/ingest/_services/banner');
        expect(res.status).toBe(404);
    });
});
