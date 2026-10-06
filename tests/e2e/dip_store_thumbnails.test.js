'use strict';

/*
 * The two thumbnail proxies' third step after the serving cutover (plan
 * P2): with DIP_GATEWAY_ENABLED on, a dip-store path is read from the
 * DIP store (Wasabi) instead of DuraCloud. Covers the dashboard route
 * (cookie auth, row exists) and the public API route (the index says
 * published). A fake S3 client stands in for the store; the TN service
 * and DuraCloud are unconfigured, so the DIP store is the only source in
 * play.
 *
 * app_config is one cached object per process, so each describe block
 * builds its app (and so its config) in beforeAll.
 */

const fs = require('node:fs');
const http = require('node:http');
const { Readable } = require('node:stream');
const supertest = require('supertest');

const { make_app } = require('../helpers/app');
const db_helper = require('../helpers/db');
const jwt = require('../../libs/jwt');
const app_config = require('../../config/app');
const dip_store = require('../../libs/dip_store');
const es = require('../../libs/elasticsearch');

const ENV = {
    DIP_STORE_LOCATION: 's3://library-repository/dip-store/',
    DIP_STORE_ENDPOINT: 'https://s3.us-west-1.wasabisys.com',
    DIP_STORE_REGION: 'us-west-1',
    DIP_STORE_ACCESS_KEY_ID: 'test-key',
    DIP_STORE_SECRET_ACCESS_KEY: 'test-secret',
    DIP_GATEWAY_ENABLED: 'true',
};

const STORED = '0000/f75f/3cf8/4b3d/b494/e0ec/2017/2508/pkg/thumbnails/3f2b.jpg';

function s3_error(status, name) {
    return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
}

function fake_client(get_object) {
    const calls = [];
    return {
        calls,
        async send(command, opts) {
            calls.push({ name: command.constructor.name, input: command.input, opts });
            if (command.constructor.name !== 'GetObjectCommand') {
                throw new Error(`unexpected ${command.constructor.name}`);
            }
            return get_object(command.input, opts);
        },
    };
}

async function cookie_for(du_id) {
    const u = await db_helper.seed_user({ du_id, first_name: 'Ada' });
    return `${jwt.COOKIE_NAME}=${jwt.sign({ sub: String(u.id), du_id })}`;
}

function binary(req) {
    return req.buffer(true).parse((res, cb) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
}

// A store that answers only when the caller aborts: a slow Wasabi.
function store_that_waits() {
    const aborts = [];
    return {
        aborts,
        send: (command, opts) =>
            new Promise((resolve, reject) => {
                opts.abortSignal.addEventListener('abort', () => {
                    aborts.push(command.input.Key);
                    reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' }));
                });
            }),
    };
}

/*
 * Issue `count` requests to `url` and cancel each after `after_ms`, like
 * a browser navigating away while thumbnails load. Resolves once the
 * store has seen every abort. Returns how many placeholder streams the
 * handler opened for them (none is right: the client is gone).
 */
async function cancel_requests(app, url, headers, count, store) {
    const placeholders = vi.spyOn(fs, 'createReadStream');
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
        for (let i = 0; i < count; i += 1) {
            await new Promise((resolve) => {
                const req = http.get(`http://127.0.0.1:${server.address().port}${url}`, {
                    headers,
                });
                req.on('error', () => {});
                setTimeout(() => {
                    req.destroy();
                    resolve();
                }, 30);
            });
        }
        await vi.waitFor(() => expect(store.aborts).toHaveLength(count), { timeout: 3000 });
        await new Promise((resolve) => setTimeout(resolve, 100));
        return placeholders.mock.calls.length;
    } finally {
        placeholders.mockRestore();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
}

beforeAll(async () => {
    await db_helper.setup_schema();
});
beforeEach(async () => {
    await db_helper.reset_data();
    dip_store._reset();
});
afterAll(async () => {
    await db_helper.teardown();
    dip_store._reset();
    app_config._reset();
});

describe('dashboard thumbnail — serving from the DIP store', () => {
    let app;
    beforeAll(() => {
        app = make_app({ env: ENV });
    });

    it('streams the thumbnail from the DIP store', async () => {
        const s3 = fake_client(() => ({
            $metadata: { httpStatusCode: 200 },
            Body: Readable.from([Buffer.from('jpeg-bytes')]),
            ContentType: 'image/jpeg',
        }));
        dip_store._set_client(s3);
        const cookie = await cookie_for('tn-dip');
        const o = await db_helper.seed_object({ thumbnail: STORED });
        const res = await binary(
            supertest(app)
                .get(`/repo/dashboard/objects/${o.pid}/thumbnail/raw`)
                .set('Cookie', cookie)
        );
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toBe('image/jpeg');
        expect(res.headers['cache-control']).toMatch(/private/);
        expect(res.body.toString()).toBe('jpeg-bytes');
        expect(s3.calls[0].input).toEqual({
            Bucket: 'library-repository',
            Key: `dip-store/${STORED}`,
        });
        // The abort is wired before the request goes out (pipe_to).
        expect(s3.calls[0].opts.abortSignal).toBeInstanceOf(AbortSignal);
    });

    it('falls back to the placeholder when the store has no such key', async () => {
        dip_store._set_client(
            fake_client(() => {
                throw s3_error(404, 'NoSuchKey');
            })
        );
        const cookie = await cookie_for('tn-dip-404');
        const o = await db_helper.seed_object({ thumbnail: STORED });
        const res = await supertest(app)
            .get(`/repo/dashboard/objects/${o.pid}/thumbnail/raw`)
            .set('Cookie', cookie);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/image\/svg/);
    });

    it('falls back to the placeholder when the store fails', async () => {
        dip_store._set_client(
            fake_client(() => {
                throw Object.assign(new Error('socket hang up'), { name: 'TimeoutError' });
            })
        );
        const cookie = await cookie_for('tn-dip-down');
        const o = await db_helper.seed_object({ thumbnail: STORED });
        const res = await supertest(app)
            .get(`/repo/dashboard/objects/${o.pid}/thumbnail/raw`)
            .set('Cookie', cookie);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/image\/svg/);
    });
});

describe('dashboard thumbnail — a client that cancels', () => {
    let app;
    beforeAll(() => {
        app = make_app({ env: ENV });
    });

    it('aborts the store request and opens no placeholder for a client that has gone', async () => {
        const store = store_that_waits();
        dip_store._set_client(store);
        const cookie = await cookie_for('tn-dip-cancel');
        const o = await db_helper.seed_object({ thumbnail: STORED });
        const opened = await cancel_requests(
            app,
            `/repo/dashboard/objects/${o.pid}/thumbnail/raw`,
            { Cookie: cookie },
            5,
            store
        );
        expect(store.aborts).toHaveLength(5);
        // A placeholder written to a destroyed response would never end: one descriptor per cancel.
        expect(opened).toBe(0);
    });
});

describe('public API thumbnail — serving from the DIP store', () => {
    let app;
    let eligible;
    beforeAll(() => {
        app = make_app({ env: ENV });
    });
    beforeEach(() => {
        // The index says every pid is published; the row still comes from the DB.
        eligible = vi.spyOn(es, 'get_document').mockResolvedValue({ is_published: 1 });
    });
    afterEach(() => {
        eligible.mockRestore();
    });

    it('streams the thumbnail from the DIP store, publicly cacheable', async () => {
        const s3 = fake_client(() => ({
            $metadata: { httpStatusCode: 200 },
            Body: Readable.from([Buffer.from('jpeg-bytes')]),
            ContentType: 'image/jpeg',
        }));
        dip_store._set_client(s3);
        const o = await db_helper.seed_object({ is_published: 1, thumbnail: STORED });
        const res = await binary(supertest(app).get(`/repo/api/v1/objects/${o.pid}/thumbnail`));
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toBe('image/jpeg');
        expect(res.headers['cache-control']).toMatch(/public/);
        expect(res.body.toString()).toBe('jpeg-bytes');
        expect(s3.calls[0].input.Key).toBe(`dip-store/${STORED}`);
        expect(s3.calls[0].opts.abortSignal).toBeInstanceOf(AbortSignal);
    });

    it('uses image/jpeg when the store sends no content type', async () => {
        dip_store._set_client(
            fake_client(() => ({
                $metadata: { httpStatusCode: 200 },
                Body: Readable.from([Buffer.from('jpeg-bytes')]),
            }))
        );
        const o = await db_helper.seed_object({ is_published: 1, thumbnail: STORED });
        const res = await binary(supertest(app).get(`/repo/api/v1/objects/${o.pid}/thumbnail`));
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toBe('image/jpeg');
    });

    it('falls back to the placeholder when the store has no such key', async () => {
        dip_store._set_client(
            fake_client(() => {
                throw s3_error(404, 'NoSuchKey');
            })
        );
        const o = await db_helper.seed_object({ is_published: 1, thumbnail: STORED });
        const res = await supertest(app).get(`/repo/api/v1/objects/${o.pid}/thumbnail`);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/image\/svg/);
    });

    it('falls back to the placeholder, never a 5xx, when the store fails', async () => {
        dip_store._set_client(
            fake_client(() => {
                throw Object.assign(new Error('socket hang up'), { name: 'TimeoutError' });
            })
        );
        const o = await db_helper.seed_object({ is_published: 1, thumbnail: STORED });
        const res = await supertest(app).get(`/repo/api/v1/objects/${o.pid}/thumbnail`);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/image\/svg/);
    });

    it('aborts the store request and opens no placeholder for a client that has gone', async () => {
        const store = store_that_waits();
        dip_store._set_client(store);
        const o = await db_helper.seed_object({ is_published: 1, thumbnail: STORED });
        const opened = await cancel_requests(
            app,
            `/repo/api/v1/objects/${o.pid}/thumbnail`,
            {},
            5,
            store
        );
        expect(store.aborts).toHaveLength(5);
        expect(opened).toBe(0);
    });

    it('never asks the DIP store while DIP_GATEWAY_ENABLED is off', async () => {
        const off = make_app({ env: { ...ENV, DIP_GATEWAY_ENABLED: 'false' } });
        const s3 = fake_client(() => {
            throw new Error('should not be called');
        });
        dip_store._set_client(s3);
        const o = await db_helper.seed_object({ is_published: 1, thumbnail: STORED });
        const res = await supertest(off).get(`/repo/api/v1/objects/${o.pid}/thumbnail`);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/image\/svg/);
        expect(s3.calls).toHaveLength(0);
    });
});

describe('dashboard thumbnail — before the cutover', () => {
    let app;
    beforeAll(() => {
        app = make_app({ env: { ...ENV, DIP_GATEWAY_ENABLED: 'false' } });
    });

    it('never asks the DIP store while DIP_GATEWAY_ENABLED is off', async () => {
        const s3 = fake_client(() => {
            throw new Error('should not be called');
        });
        dip_store._set_client(s3);
        const cookie = await cookie_for('tn-dip-off');
        const o = await db_helper.seed_object({ thumbnail: STORED });
        const res = await supertest(app)
            .get(`/repo/dashboard/objects/${o.pid}/thumbnail/raw`)
            .set('Cookie', cookie);
        // DuraCloud is unconfigured in tests, so the chain ends at the placeholder.
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/image\/svg/);
        expect(s3.calls).toHaveLength(0);
    });
});
