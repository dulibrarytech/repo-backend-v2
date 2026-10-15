'use strict';

/*
 * The dip-store gateway through the real middleware stack: the
 * app from config/express.js, with a fake S3 client injected into the
 * gateway. Pins the contract the frontend depends on: Basic auth, the
 * path allow-list, HEAD answered with HeadObject, a whole-body GET that
 * ignores Range, 404 for missing, and 500 (never 502) for any other
 * upstream trouble.
 *
 * app_config is one cached object for the whole process, so each
 * describe block builds its app (and so its config) in beforeAll, and the
 * blocks run one after another.
 */

const http = require('node:http');
const { Readable } = require('node:stream');
const supertest = require('supertest');

const { make_app } = require('../helpers/app');
const app_config = require('../../config/app');
const dip_store = require('../../libs/dip_store');
const gateway = require('../../dip_store_gateway/gateway');

const USER = 'frontend';
const PASSWORD = 'Gateway-Pass_1.2~x';
const AUTH = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`;

const ENV = {
    DIP_STORE_LOCATION: 's3://test-dip-store/dip-store/',
    DIP_STORE_ENDPOINT: 'https://s3.test.example',
    DIP_STORE_REGION: 'us-west-1',
    DIP_STORE_ACCESS_KEY_ID: 'test-key',
    DIP_STORE_SECRET_ACCESS_KEY: 'test-secret',
    DIP_GATEWAY_ENABLED: 'true',
    DIP_GATEWAY_USER: USER,
    DIP_GATEWAY_PASSWORD: PASSWORD,
};

const FOLDER = '0000/f75f/3cf8/4b3d/b494/e0ec/2017/2508/pkg-uuid_U158.03.0157.00096';
const FILE = `${FOLDER}/objects/3f2b-page.pdf`;
const URL_PATH = `/repo/api/v2/dip-store/${FILE}`;

function s3_error(status, name) {
    return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
}

// Fake S3 client: `handlers` maps a command class name to (input, opts) => output.
function fake_client(handlers) {
    const calls = [];
    return {
        calls,
        async send(command, opts) {
            const name = command.constructor.name;
            calls.push({ name, input: command.input, opts });
            const handler = handlers[name];
            if (!handler) throw new Error(`unexpected ${name}`);
            return handler(command.input, opts);
        },
    };
}

function pdf_object(text = '%PDF-1.7 body') {
    return {
        $metadata: { httpStatusCode: 200 },
        Body: Readable.from([Buffer.from(text)]),
        ContentType: 'application/pdf',
        ContentLength: Buffer.byteLength(text),
        ETag: '"abc123"',
        LastModified: new Date('2026-09-23T12:00:00Z'),
    };
}

function binary(req) {
    return req.buffer(true).parse((res, cb) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
}

function app_with(env) {
    gateway._reset();
    dip_store._reset();
    return make_app({ env });
}

afterAll(() => {
    gateway._reset();
    dip_store._reset();
    app_config._reset();
});

describe('dip-store gateway — switched off', () => {
    let app;
    beforeAll(() => {
        app = app_with({ ...ENV, DIP_GATEWAY_ENABLED: 'false' });
    });

    it('answers 500 to the frontend (its credential presented): a misrouted frontend, not a missing file', async () => {
        /*
         * The frontend reads a 404 as "missing" and its purge job then
         * deletes the cached copy; a 500 keeps it.
         */
        const s3 = fake_client({});
        gateway._set_client(s3);
        const get = await supertest(app).get(URL_PATH).set('Authorization', AUTH);
        expect(get.status).toBe(500);
        expect(get.body.message).toBe('DIP store unavailable');
        await supertest(app).head(URL_PATH).set('Authorization', AUTH).expect(500);
        expect(s3.calls).toHaveLength(0);
    });

    it('answers 404 to anyone else, without a challenge and without asking the store', async () => {
        const s3 = fake_client({});
        gateway._set_client(s3);
        const wrong = `Basic ${Buffer.from(`${USER}:nope`).toString('base64')}`;
        for (const headers of [{}, { Authorization: wrong }]) {
            const res = await supertest(app).get(URL_PATH).set(headers);
            expect(res.status).toBe(404);
            expect(res.headers['www-authenticate']).toBeUndefined();
        }
        expect(s3.calls).toHaveLength(0);
    });
});

describe('dip-store gateway — misconfigured', () => {
    it('answers 500 when the gateway credential is not set', async () => {
        const app = app_with({ ...ENV, DIP_GATEWAY_USER: '', DIP_GATEWAY_PASSWORD: '' });
        const s3 = fake_client({});
        gateway._set_client(s3);
        const res = await supertest(app).get(URL_PATH).set('Authorization', AUTH);
        expect(res.status).toBe(500);
        expect(s3.calls).toHaveLength(0);
    });

    it('answers 500, not the central 502, when the store is not configured', async () => {
        const app = app_with({ ...ENV, DIP_STORE_ACCESS_KEY_ID: '' });
        gateway._set_client(fake_client({}));
        const get = await supertest(app).get(URL_PATH).set('Authorization', AUTH);
        expect(get.status).toBe(500);
        expect(get.body.message).toBe('DIP store unavailable');
        const head = await supertest(app).head(URL_PATH).set('Authorization', AUTH);
        expect(head.status).toBe(500);
    });
});

describe('dip-store gateway — enabled', () => {
    let app;
    beforeAll(() => {
        app = app_with(ENV);
    });
    beforeEach(() => {
        gateway._reset();
        dip_store._reset();
    });

    describe('auth', () => {
        it('401s without credentials, with a Basic challenge', async () => {
            const s3 = fake_client({});
            gateway._set_client(s3);
            const res = await supertest(app).get(URL_PATH).expect(401);
            expect(res.headers['www-authenticate']).toBe('Basic realm="dip-store"');
            expect(s3.calls).toHaveLength(0);
        });

        it('401s a wrong password, a wrong user and a malformed header', async () => {
            const s3 = fake_client({});
            gateway._set_client(s3);
            const wrong = (u, p) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;
            for (const header of [
                wrong(USER, 'nope'),
                wrong('someone', PASSWORD),
                'Basic not-base64!',
                `Bearer ${PASSWORD}`,
            ]) {
                await supertest(app).get(URL_PATH).set('Authorization', header).expect(401);
            }
            expect(s3.calls).toHaveLength(0);
        });

        it('accepts the credential the frontend sends from URL userinfo', async () => {
            gateway._set_client(fake_client({ GetObjectCommand: () => pdf_object() }));
            const res = await binary(supertest(app).get(URL_PATH).auth(USER, PASSWORD));
            expect(res.status).toBe(200);
        });
    });

    describe('path allow-list', () => {
        it('404s anything that is not <8 hex segments>/<folder>/objects|thumbnails/<file>', async () => {
            const s3 = fake_client({});
            gateway._set_client(s3);
            for (const bad of [
                'x.pdf',
                `${FOLDER}/METS.4b3d.xml`,
                `${FOLDER}/objects/sub/x.pdf`,
                `${FOLDER}/other/x.pdf`,
                '0000/f75f/3cf8/4b3d/b494/e0ec/2017/zzzz/pkg/objects/x.pdf',
                '0000/f75f/3cf8/4b3d/b494/e0ec/2017/2508/../objects/x.pdf',
                '0000/f75f/3cf8/4b3d/b494/e0ec/2017/2508/../../aip-store/x.7z',
                // An encoded slash puts a '/' inside one decoded segment.
                '0000/f75f/3cf8/4b3d/b494/e0ec/2017/2508%2F../objects/x.pdf',
                `${FOLDER}/thumbnails/a%2Fb.jpg`,
                `${FOLDER}/thumbnails/%2e%2e/x.jpg`,
            ]) {
                const res = await supertest(app)
                    .get(`/repo/api/v2/dip-store/${bad}`)
                    .set('Authorization', AUTH);
                expect(res.status, bad).toBe(404);
            }
            expect(s3.calls).toHaveLength(0);
        });
    });

    describe('HEAD', () => {
        it('answers 200 from HeadObject, with the headers verbatim and no body', async () => {
            const s3 = fake_client({
                HeadObjectCommand: () => ({
                    $metadata: { httpStatusCode: 200 },
                    ContentType: 'text/plain',
                    ContentLength: 1234,
                    ContentEncoding: 'gzip',
                    ContentDisposition: 'inline; filename="a.txt"',
                    ETag: '"abc123"',
                }),
            });
            gateway._set_client(s3);
            const res = await supertest(app).head(URL_PATH).set('Authorization', AUTH);
            expect(res.status).toBe(200);
            expect(res.headers['content-length']).toBe('1234');
            // Verbatim: no charset appended, the encoding and disposition passed on.
            expect(res.headers['content-type']).toBe('text/plain');
            expect(res.headers['content-encoding']).toBe('gzip');
            expect(res.headers['content-disposition']).toBe('inline; filename="a.txt"');
            expect(res.headers.etag).toBe('"abc123"');
            expect(s3.calls.map((c) => c.name)).toEqual(['HeadObjectCommand']);
            expect(s3.calls[0].input).toEqual({
                Bucket: 'test-dip-store',
                Key: `dip-store/${FILE}`,
            });
        });

        it('answers 404 for a missing key', async () => {
            gateway._set_client(
                fake_client({
                    HeadObjectCommand: () => {
                        throw s3_error(404, 'NotFound');
                    },
                })
            );
            const res = await supertest(app).head(URL_PATH).set('Authorization', AUTH);
            expect(res.status).toBe(404);
        });

        it('answers 500 for a transport failure', async () => {
            gateway._set_client(
                fake_client({
                    HeadObjectCommand: () => {
                        throw Object.assign(new Error('socket hang up'), { name: 'TimeoutError' });
                    },
                })
            );
            const res = await supertest(app).head(URL_PATH).set('Authorization', AUTH);
            expect(res.status).toBe(500);
        });
    });

    describe('GET', () => {
        it('streams the whole object with its headers, and nothing may re-encode it', async () => {
            const s3 = fake_client({ GetObjectCommand: () => pdf_object('%PDF-1.7 hello') });
            gateway._set_client(s3);
            const res = await binary(supertest(app).get(URL_PATH).set('Authorization', AUTH));
            expect(res.status).toBe(200);
            expect(res.body.toString()).toBe('%PDF-1.7 hello');
            expect(res.headers['content-type']).toBe('application/pdf');
            expect(res.headers['content-length']).toBe('14');
            expect(res.headers['cache-control']).toBe('no-transform');
            expect(res.headers['content-encoding']).toBeUndefined();
            expect(res.headers['accept-ranges']).toBeUndefined();
            expect(s3.calls[0].input).toEqual({
                Bucket: 'test-dip-store',
                Key: `dip-store/${FILE}`,
            });
        });

        it('serves thumbnails/ keys too', async () => {
            const s3 = fake_client({
                GetObjectCommand: () => ({
                    $metadata: { httpStatusCode: 200 },
                    Body: Readable.from([Buffer.from('jpeg')]),
                    ContentType: 'image/jpeg',
                }),
            });
            gateway._set_client(s3);
            const res = await binary(
                supertest(app)
                    .get(`/repo/api/v2/dip-store/${FOLDER}/thumbnails/3f2b.jpg`)
                    .set('Authorization', AUTH)
            );
            expect(res.status).toBe(200);
            expect(s3.calls[0].input.Key).toBe(`dip-store/${FOLDER}/thumbnails/3f2b.jpg`);
        });

        it('ignores Range: 200 with the whole body, and no Range sent upstream', async () => {
            const s3 = fake_client({ GetObjectCommand: () => pdf_object('%PDF-1.7 whole') });
            gateway._set_client(s3);
            const res = await binary(
                supertest(app).get(URL_PATH).set('Authorization', AUTH).set('Range', 'bytes=0-3')
            );
            expect(res.status).toBe(200);
            expect(res.body.toString()).toBe('%PDF-1.7 whole');
            expect(s3.calls[0].input.Range).toBeUndefined();
        });

        it('answers 404 for a missing key', async () => {
            gateway._set_client(
                fake_client({
                    GetObjectCommand: () => {
                        throw s3_error(404, 'NoSuchKey');
                    },
                })
            );
            const res = await supertest(app).get(URL_PATH).set('Authorization', AUTH);
            expect(res.status).toBe(404);
        });

        it('answers 404 when a 403 turns out to be a missing key', async () => {
            gateway._set_client(
                fake_client({
                    GetObjectCommand: () => {
                        throw s3_error(403, 'AccessDenied');
                    },
                    ListObjectsV2Command: () => ({ Contents: [] }),
                })
            );
            const res = await supertest(app).get(URL_PATH).set('Authorization', AUTH);
            expect(res.status).toBe(404);
        });

        it('answers 500 for a policy 403 on a key that exists', async () => {
            gateway._set_client(
                fake_client({
                    GetObjectCommand: () => {
                        throw s3_error(403, 'AccessDenied');
                    },
                    ListObjectsV2Command: () => ({ Contents: [{ Key: `dip-store/${FILE}` }] }),
                })
            );
            const res = await supertest(app).get(URL_PATH).set('Authorization', AUTH);
            expect(res.status).toBe(500);
        });

        it('answers 500, never 502, for a transport failure or a store 5xx', async () => {
            for (const failure of [
                Object.assign(new Error('socket hang up'), { name: 'TimeoutError' }),
                s3_error(503, 'SlowDown'),
            ]) {
                gateway._set_client(
                    fake_client({
                        GetObjectCommand: () => {
                            throw failure;
                        },
                    })
                );
                const res = await supertest(app).get(URL_PATH).set('Authorization', AUTH);
                expect(res.status).toBe(500);
                expect(res.body.message).toBe('DIP store unavailable');
            }
        });

        it('carries no rate-limit headers: no api_limiter() on this route', async () => {
            gateway._set_client(fake_client({ GetObjectCommand: () => pdf_object() }));
            const res = await binary(supertest(app).get(URL_PATH).set('Authorization', AUTH));
            expect(res.status).toBe(200);
            expect(res.headers.ratelimit).toBeUndefined();
            expect(res.headers['ratelimit-policy']).toBeUndefined();
        });

        it('uses its own client, never the shared one', async () => {
            const shared = fake_client({});
            dip_store._set_client(shared);
            const own = fake_client({ GetObjectCommand: () => pdf_object() });
            gateway._set_client(own);
            await binary(supertest(app).get(URL_PATH).set('Authorization', AUTH)).expect(200);
            expect(own.calls).toHaveLength(1);
            expect(shared.calls).toHaveLength(0);
        });

        it('aborts the S3 request when the client goes away mid-body', async () => {
            let signal;
            const body = new Readable({ read() {} });
            body.push('%PDF-1.7 first chunk');
            gateway._set_client(
                fake_client({
                    GetObjectCommand: (input, opts) => {
                        signal = opts.abortSignal;
                        signal.addEventListener('abort', () =>
                            body.destroy(
                                Object.assign(new Error('aborted'), { name: 'AbortError' })
                            )
                        );
                        return {
                            $metadata: { httpStatusCode: 200 },
                            Body: body,
                            ContentType: 'application/pdf',
                        };
                    },
                })
            );
            const server = app.listen(0, '127.0.0.1');
            await new Promise((resolve) => server.once('listening', resolve));
            try {
                await new Promise((resolve) => {
                    const req = http.get(
                        `http://127.0.0.1:${server.address().port}${URL_PATH}`,
                        { headers: { Authorization: AUTH } },
                        (res) => {
                            res.once('data', () => {
                                req.destroy();
                                resolve();
                            });
                        }
                    );
                    req.on('error', () => {});
                });
                await vi.waitFor(() => expect(signal.aborted).toBe(true), { timeout: 2000 });
                expect(body.destroyed).toBe(true);
            } finally {
                server.closeAllConnections();
                await new Promise((resolve) => server.close(resolve));
            }
        });
    });
});
