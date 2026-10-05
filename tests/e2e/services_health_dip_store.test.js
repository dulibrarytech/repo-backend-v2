'use strict';

/*
 * Services Health grid, through the real app and middleware: the
 * "DIP store (Wasabi)" card renders next to DuraCloud. No DIP_STORE_* vars
 * are set in the test env, so it renders as "not configured" (gray) and
 * no request leaves the process.
 */

const supertest = require('supertest');
const { make_app } = require('../helpers/app');
const db_helper = require('../helpers/db');
const jwt = require('../../libs/jwt');

let app;

async function admin_cookie() {
    const u = await db_helper.seed_user({ du_id: 'svc-health-admin', role: 'admin' });
    return `${jwt.COOKIE_NAME}=${jwt.sign({ sub: String(u.id), du_id: 'svc-health-admin' })}`;
}

describe('Services Health — DIP store card', () => {
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

    it('renders the DIP store card after DuraCloud, as not configured', async () => {
        const res = await supertest(app)
            .get('/repo/dashboard/admin/services/health')
            .set('Cookie', await admin_cookie());
        expect(res.status).toBe(200);
        const dip = res.text.indexOf('DIP store (Wasabi)');
        expect(dip).toBeGreaterThan(-1);
        expect(res.text.indexOf('DuraCloud')).toBeLessThan(dip);
        expect(res.text.slice(dip)).toMatch(/not configured/);
    });
});
