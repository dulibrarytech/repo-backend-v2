'use strict';

const supertest = require('supertest');
const { make_app } = require('../helpers/app');
const health = require('../../libs/health');
const db_health = require('../../config/db_health');

describe('GET /repo/health', () => {
    let app;
    beforeAll(() => {
        app = make_app();
    });
    beforeEach(() => {
        /*
         * Start each test from a clean registry, then re-add the DB
         * checks the factory normally would. This isolates extra checks
         * a test adds while keeping the DB-check baseline deterministic.
         */
        health.clear();
        db_health.register_all();
    });

    it('auto-registers DB liveness checks when the factory runs', async () => {
        const res = await supertest(app).get('/repo/health').expect(200);
        expect(res.body.status).toBe('ok');
        expect(res.body.components.db_repo.ok).toBe(true);
        expect(res.body.components.db_repo_queue.ok).toBe(true);
        expect(res.body.app).toBeTruthy();
        expect(res.body.version).toBeTruthy();
        expect(res.body.env).toBe('test');
    });

    it('reports aggregated ok when extra checks pass', async () => {
        health.register('extra', async () => ({ ok: true }));
        const res = await supertest(app).get('/repo/health').expect(200);
        expect(res.body.status).toBe('ok');
        expect(res.body.components.extra.ok).toBe(true);
    });

    it('returns 503 when any check fails', async () => {
        health.register('flaky', async () => ({ ok: false, error: 'down' }));
        const res = await supertest(app).get('/repo/health').expect(503);
        expect(res.body.status).toBe('degraded');
        expect(res.body.components.flaky.error).toBe('down');
    });
});

describe('GET /repo/version', () => {
    let app;
    beforeAll(() => {
        app = make_app();
    });

    it('returns name + version + env + request id', async () => {
        const res = await supertest(app).get('/repo/version').expect(200);
        expect(res.body.name).toBeTruthy();
        expect(res.body.version).toMatch(/^\d+\.\d+\.\d+/);
        expect(res.body.env).toBe('test');
        expect(res.body.request_id).toMatch(/-/);
    });
});
