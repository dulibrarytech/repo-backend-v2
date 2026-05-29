'use strict';

// End-to-end SSO callback flow. Drives the full Express factory via
// supertest with each defense layer toggled independently.

const supertest = require('supertest');
const { make_app } = require('../helpers/app');
const db_helper = require('../helpers/db');
const app_config = require('../../config/app');
const replay_guard = require('../../auth/sso/replay_guard');
const sso_middleware = require('../../auth/sso/middleware');
const hmac = require('../../auth/sso/hmac');
const jwt = require('../../libs/jwt');

function with_env(overrides) {
    const saved = {};
    for (const k of Object.keys(overrides)) {
        saved[k] = process.env[k];
        if (overrides[k] === null) delete process.env[k];
        else process.env[k] = overrides[k];
    }
    app_config._reset();
    sso_middleware._reset();
    replay_guard._reset();
    return () => {
        for (const k of Object.keys(saved)) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
        app_config._reset();
        sso_middleware._reset();
        replay_guard._reset();
    };
}

const VALID_EMPLOYEE = '871095226';

async function seed_employee(du_id = VALID_EMPLOYEE) {
    return db_helper.seed_user({
        du_id,
        email: `${du_id}@du.edu`,
        first_name: 'Employee',
        last_name: du_id,
    });
}

function fresh_payload(overrides = {}) {
    return {
        employeeID: VALID_EMPLOYEE,
        HTTP_HOST: 'authproxy.example.invalid',
        timestamp: String(Math.floor(Date.now() / 1000)),
        nonce: `nonce-${Math.random().toString(36).slice(2)}-${Date.now()}`,
        ...overrides,
    };
}

describe('SSO callback — e2e', () => {
    beforeAll(async () => {
        await db_helper.setup_schema();
    });
    beforeEach(async () => {
        await db_helper.reset_data();
        replay_guard._reset();
    });
    afterAll(async () => {
        await db_helper.teardown();
    });

    describe('Layer 0: legacy HTTP_HOST check + happy path', () => {
        it('issues cookie + 303 redirect when HTTP_HOST matches expected', async () => {
            const restore = with_env({ SSO_HOST: 'authproxy.example.invalid' });
            try {
                const app = make_app();
                await seed_employee();
                const res = await supertest(app)
                    .post('/repo/auth/sso')
                    .type('form')
                    .send(fresh_payload());
                expect(res.status).toBe(303);
                expect(res.headers.location).toBe('/repo/dashboard/');
                const set_cookie = res.headers['set-cookie'];
                const cookie = Array.isArray(set_cookie) ? set_cookie[0] : set_cookie;
                expect(cookie).toMatch(new RegExp(`^${jwt.COOKIE_NAME}=`));
                expect(cookie).toMatch(/HttpOnly/);
            } finally {
                restore();
            }
        });

        it('rejects when HTTP_HOST mismatches', async () => {
            const restore = with_env({ SSO_HOST: 'authproxy.example.invalid' });
            try {
                const app = make_app();
                await seed_employee();
                const res = await supertest(app)
                    .post('/repo/auth/sso')
                    .type('form')
                    .send(fresh_payload({ HTTP_HOST: 'attacker.example' }));
                expect(res.status).toBe(401);
                expect(res.body.code).toBe('UNAUTHORIZED');
            } finally {
                restore();
            }
        });

        it('skips Layer 0 entirely when SSO_HOST is empty', async () => {
            const restore = with_env({ SSO_HOST: '' });
            try {
                const app = make_app();
                await seed_employee();
                const res = await supertest(app)
                    .post('/repo/auth/sso')
                    .type('form')
                    .send(fresh_payload({ HTTP_HOST: undefined }));
                expect(res.status).toBe(303);
            } finally {
                restore();
            }
        });
    });

    describe('shape validation', () => {
        it('rejects missing employeeID', async () => {
            const restore = with_env({ SSO_HOST: 'authproxy.example.invalid' });
            try {
                const app = make_app();
                const res = await supertest(app)
                    .post('/repo/auth/sso')
                    .type('form')
                    .send(fresh_payload({ employeeID: '' }));
                expect(res.status).toBe(400);
                expect(res.body.code).toBe('VALIDATION_ERROR');
            } finally {
                restore();
            }
        });

        it('rejects non-numeric employeeID', async () => {
            const restore = with_env({ SSO_HOST: 'authproxy.example.invalid' });
            try {
                const app = make_app();
                const res = await supertest(app)
                    .post('/repo/auth/sso')
                    .type('form')
                    .send(fresh_payload({ employeeID: 'admin' }));
                expect(res.status).toBe(400);
                expect(res.body.error).toMatch(/numeric/i);
            } finally {
                restore();
            }
        });

        it('rejects employeeID > 10 digits', async () => {
            const restore = with_env({ SSO_HOST: 'authproxy.example.invalid' });
            try {
                const app = make_app();
                const res = await supertest(app)
                    .post('/repo/auth/sso')
                    .type('form')
                    .send(fresh_payload({ employeeID: '12345678901' }));
                expect(res.status).toBe(400);
            } finally {
                restore();
            }
        });
    });

    describe('user lookup', () => {
        it('returns 401 for an unknown employeeID (no user existence leak)', async () => {
            const restore = with_env({ SSO_HOST: 'authproxy.example.invalid' });
            try {
                const app = make_app();
                const res = await supertest(app)
                    .post('/repo/auth/sso')
                    .type('form')
                    .send(fresh_payload({ employeeID: '9999999999' }));
                expect(res.status).toBe(401);
                expect(res.body.error).toBe('Authentication failed');
            } finally {
                restore();
            }
        });

        it('returns 401 for a deactivated user', async () => {
            const restore = with_env({ SSO_HOST: 'authproxy.example.invalid' });
            try {
                const app = make_app();
                await db_helper.seed_user({ du_id: VALID_EMPLOYEE, is_active: 0 });
                const res = await supertest(app)
                    .post('/repo/auth/sso')
                    .type('form')
                    .send(fresh_payload());
                expect(res.status).toBe(401);
            } finally {
                restore();
            }
        });
    });

    describe('Layer 2: timestamp + nonce freshness', () => {
        it('rejects stale timestamp', async () => {
            const restore = with_env({
                SSO_HOST: 'authproxy.example.invalid',
                SSO_REQUIRE_FRESHNESS: '1',
                SSO_MAX_SKEW_SECONDS: '60',
            });
            try {
                const app = make_app();
                await seed_employee();
                const stale_ts = String(Math.floor(Date.now() / 1000) - 3600);
                const res = await supertest(app)
                    .post('/repo/auth/sso')
                    .type('form')
                    .send(fresh_payload({ timestamp: stale_ts }));
                expect(res.status).toBe(401);
                expect(res.body.error).toMatch(/timestamp/i);
            } finally {
                restore();
            }
        });

        it('rejects replayed nonce within the freshness window', async () => {
            const restore = with_env({
                SSO_HOST: 'authproxy.example.invalid',
                SSO_REQUIRE_FRESHNESS: '1',
                SSO_MAX_SKEW_SECONDS: '60',
            });
            try {
                const app = make_app();
                await seed_employee();
                const payload = fresh_payload();
                const first = await supertest(app)
                    .post('/repo/auth/sso')
                    .type('form')
                    .send(payload);
                expect(first.status).toBe(303);
                const replay = await supertest(app)
                    .post('/repo/auth/sso')
                    .type('form')
                    .send(payload);
                expect(replay.status).toBe(401);
                expect(replay.body.error).toMatch(/replay/i);
            } finally {
                restore();
            }
        });

        it('accepts an unrelated request after the first', async () => {
            const restore = with_env({
                SSO_HOST: 'authproxy.example.invalid',
                SSO_REQUIRE_FRESHNESS: '1',
                SSO_MAX_SKEW_SECONDS: '60',
            });
            try {
                const app = make_app();
                await seed_employee();
                const a = await supertest(app)
                    .post('/repo/auth/sso')
                    .type('form')
                    .send(fresh_payload());
                expect(a.status).toBe(303);
                const b = await supertest(app)
                    .post('/repo/auth/sso')
                    .type('form')
                    .send(fresh_payload());
                expect(b.status).toBe(303);
            } finally {
                restore();
            }
        });

        it('rejects missing timestamp / nonce when freshness is on', async () => {
            const restore = with_env({
                SSO_HOST: 'authproxy.example.invalid',
                SSO_REQUIRE_FRESHNESS: '1',
            });
            try {
                const app = make_app();
                await seed_employee();
                const no_ts = await supertest(app)
                    .post('/repo/auth/sso')
                    .type('form')
                    .send(fresh_payload({ timestamp: undefined }));
                expect(no_ts.status).toBe(400);
                const no_nonce = await supertest(app)
                    .post('/repo/auth/sso')
                    .type('form')
                    .send(fresh_payload({ nonce: undefined }));
                expect(no_nonce.status).toBe(400);
            } finally {
                restore();
            }
        });
    });

    describe('Layer 3: HMAC signature', () => {
        const SECRET = 'test-shared-secret-must-be-32+chars-long';

        it('rejects when SSO_REQUIRE_HMAC=1 but no signature provided', async () => {
            const restore = with_env({
                SSO_HOST: 'authproxy.example.invalid',
                SSO_REQUIRE_HMAC: '1',
                SSO_HMAC_SECRET: SECRET,
            });
            try {
                const app = make_app();
                await seed_employee();
                const res = await supertest(app)
                    .post('/repo/auth/sso')
                    .type('form')
                    .send(fresh_payload());
                expect(res.status).toBe(400);
                expect(res.body.error).toMatch(/signature/i);
            } finally {
                restore();
            }
        });

        it('accepts a correctly signed payload', async () => {
            const restore = with_env({
                SSO_HOST: 'authproxy.example.invalid',
                SSO_REQUIRE_HMAC: '1',
                SSO_HMAC_SECRET: SECRET,
            });
            try {
                const app = make_app();
                await seed_employee();
                const body = fresh_payload();
                body.signature = hmac.sign(body.employeeID, body.timestamp, body.nonce, SECRET);
                const res = await supertest(app).post('/repo/auth/sso').type('form').send(body);
                expect(res.status).toBe(303);
            } finally {
                restore();
            }
        });

        it('rejects a tampered employeeID even if the signature is valid for a different one', async () => {
            const restore = with_env({
                SSO_HOST: 'authproxy.example.invalid',
                SSO_REQUIRE_HMAC: '1',
                SSO_HMAC_SECRET: SECRET,
            });
            try {
                const app = make_app();
                await seed_employee();
                const body = fresh_payload();
                // Sign for the legit employee
                const sig_for_legit = hmac.sign(VALID_EMPLOYEE, body.timestamp, body.nonce, SECRET);
                // Swap the employeeID to a different (but seeded) user
                await db_helper.seed_user({ du_id: '999999999' });
                body.employeeID = '999999999';
                body.signature = sig_for_legit;
                const res = await supertest(app).post('/repo/auth/sso').type('form').send(body);
                expect(res.status).toBe(401);
            } finally {
                restore();
            }
        });

        it('accepts either secret during rotation', async () => {
            const NEW = 'rotated-new-secret-32-chars-long-zz';
            const restore = with_env({
                SSO_HOST: 'authproxy.example.invalid',
                SSO_REQUIRE_HMAC: '1',
                SSO_HMAC_SECRET: SECRET,
                SSO_HMAC_SECRET_NEXT: NEW,
            });
            try {
                const app = make_app();
                await seed_employee();
                const body_old = fresh_payload();
                body_old.signature = hmac.sign(
                    body_old.employeeID,
                    body_old.timestamp,
                    body_old.nonce,
                    SECRET
                );
                const old_res = await supertest(app)
                    .post('/repo/auth/sso')
                    .type('form')
                    .send(body_old);
                expect(old_res.status).toBe(303);

                const body_new = fresh_payload();
                body_new.signature = hmac.sign(
                    body_new.employeeID,
                    body_new.timestamp,
                    body_new.nonce,
                    NEW
                );
                const new_res = await supertest(app)
                    .post('/repo/auth/sso')
                    .type('form')
                    .send(body_new);
                expect(new_res.status).toBe(303);
            } finally {
                restore();
            }
        });

        it('fails closed when SSO_REQUIRE_HMAC=1 but no secrets configured', async () => {
            const restore = with_env({
                SSO_HOST: 'authproxy.example.invalid',
                SSO_REQUIRE_HMAC: '1',
                SSO_HMAC_SECRET: '',
                SSO_HMAC_SECRET_NEXT: '',
            });
            try {
                const app = make_app();
                await seed_employee();
                const body = fresh_payload();
                body.signature = 'a'.repeat(64);
                const res = await supertest(app).post('/repo/auth/sso').type('form').send(body);
                expect(res.status).toBe(500);
            } finally {
                restore();
            }
        });
    });

    describe('Layer 1: IP allowlist (route-level)', () => {
        // Note: supertest doesn't easily spoof req.ip without trust-proxy
        // setup. The unit tests in tests/unit/auth/sso/middleware.test.js
        // exercise the matcher directly. Here we just confirm the
        // middleware is mounted: a non-empty allowlist that excludes
        // 127.0.0.1 should block.
        it('blocks when the local source IP is not in the allowlist', async () => {
            const restore = with_env({
                SSO_HOST: 'authproxy.example.invalid',
                SSO_TRUSTED_IPS: '10.99.99.99',
            });
            try {
                const app = make_app();
                await seed_employee();
                const res = await supertest(app)
                    .post('/repo/auth/sso')
                    .type('form')
                    .send(fresh_payload());
                expect(res.status).toBe(403);
                expect(res.body.code).toBe('FORBIDDEN');
            } finally {
                restore();
            }
        });

        it('allows when 127.0.0.1 is in the allowlist', async () => {
            const restore = with_env({
                SSO_HOST: 'authproxy.example.invalid',
                SSO_TRUSTED_IPS: '127.0.0.1,::1',
            });
            try {
                const app = make_app();
                await seed_employee();
                const res = await supertest(app)
                    .post('/repo/auth/sso')
                    .type('form')
                    .send(fresh_payload());
                expect(res.status).toBe(303);
            } finally {
                restore();
            }
        });
    });

    describe('GET /auth/sso/start', () => {
        it('redirects to SSO_URL with next= preserved', async () => {
            const restore = with_env({
                SSO_URL: 'https://authproxy.example.invalid/secure/',
            });
            try {
                const app = make_app();
                const res = await supertest(app).get(
                    '/repo/auth/sso/start?next=/repo/dashboard/users'
                );
                expect(res.status).toBe(302);
                expect(res.headers.location).toMatch(
                    /^https:\/\/authproxy\.example\.invalid\/secure\/\?next=/
                );
                expect(res.headers.location).toContain(encodeURIComponent('/repo/dashboard/users'));
            } finally {
                restore();
            }
        });

        it('rejects open-redirect attempts in next=', async () => {
            const restore = with_env({
                SSO_URL: 'https://authproxy.example.invalid/secure/',
            });
            try {
                const app = make_app();
                const res = await supertest(app).get(
                    '/repo/auth/sso/start?next=https://evil.example/x'
                );
                // safe_next rejects → falls back to default redirect
                expect(res.headers.location).toContain(encodeURIComponent('/repo/dashboard/'));
            } finally {
                restore();
            }
        });

        it('403 when SSO_URL is empty', async () => {
            const restore = with_env({ SSO_URL: '' });
            try {
                const app = make_app();
                const res = await supertest(app).get('/repo/auth/sso/start');
                expect(res.status).toBe(403);
            } finally {
                restore();
            }
        });
    });

    describe('login page shows the SSO button when SSO_URL is set', () => {
        it('renders the button on the login page', async () => {
            const restore = with_env({
                SSO_URL: 'https://authproxy.example.invalid/secure/',
            });
            try {
                const app = make_app();
                const res = await supertest(app).get('/repo/dashboard/login');
                expect(res.status).toBe(200);
                // SSO button is the only login surface. Match the link
                // text + the start-handler URL it points at.
                expect(res.text).toMatch(/\/repo\/auth\/sso\/start/);
                expect(res.text).toMatch(/>\s*Sign in\s*<\/a>/);
                // "SSO not configured" warning must NOT show when it is.
                expect(res.text).not.toMatch(/SSO is not configured/);
            } finally {
                restore();
            }
        });

        it('shows a configuration warning when SSO_URL is empty', async () => {
            const restore = with_env({ SSO_URL: '' });
            try {
                const app = make_app();
                const res = await supertest(app).get('/repo/dashboard/login');
                // No start link rendered…
                expect(res.text).not.toMatch(/\/repo\/auth\/sso\/start/);
                // …and the dev-friendly warning explains why.
                expect(res.text).toMatch(/SSO is not configured/);
            } finally {
                restore();
            }
        });
    });
});
