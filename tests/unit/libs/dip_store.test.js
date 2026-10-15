'use strict';

/*
 * Unit tests for libs/dip_store — the Wasabi DIP store client. A fake S3
 * client (injected with _set_client) stands in for @aws-sdk/client-s3: it
 * records each command and answers from per-command handlers, so no
 * network or credentials are needed. One block runs the real SDK against
 * local servers, for the behaviours a fake can't show: timeouts, a
 * stalled body, an undecodable response.
 */

const http = require('node:http');
const { Readable } = require('node:stream');
const express = require('express');
const supertest = require('supertest');

const dip_store = require('../../../libs/dip_store');
const app_config = require('../../../config/app');
const log = require('../../../libs/log');
const { UpstreamError, ValidationError } = require('../../../libs/errors');

const ENV = {
    DIP_STORE_LOCATION: 's3://test-dip-store/dip-store/',
    DIP_STORE_ENDPOINT: 'https://s3.test.example',
    DIP_STORE_REGION: 'us-west-1',
    DIP_STORE_ACCESS_KEY_ID: 'test-key',
    DIP_STORE_SECRET_ACCESS_KEY: 'test-secret',
};

const FOLDER = '0000/f75f/3cf8/4b3d/b494/e0ec/2017/2508/pkg-uuid_U158.03.0157.00096';

function s3_error(status, name) {
    return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
}

// Network-level failure: no HTTP status at all.
function transport_error(message) {
    return Object.assign(new Error(message), { name: 'TimeoutError' });
}

/*
 * Fake S3 client. `handlers` maps a command class name to
 * (input, call_index, opts) => output | throws. Every call is recorded.
 */
function fake_client(handlers) {
    const calls = [];
    return {
        calls,
        send: vi.fn(async (command, opts) => {
            const name = command.constructor.name;
            calls.push({ name, input: command.input, opts });
            const handler = handlers[name];
            if (!handler) throw new Error(`unexpected ${name}`);
            return handler(command.input, calls.filter((c) => c.name === name).length - 1, opts);
        }),
    };
}

// A send() that settles only when its abort signal fires.
function hangs_until_aborted() {
    return (input, index, opts) =>
        new Promise((resolve, reject) => {
            opts.abortSignal.addEventListener('abort', () =>
                reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' }))
            );
        });
}

function body_of(text) {
    const stream = Readable.from([Buffer.from(text)]);
    stream.transformToString = async () => text;
    return stream;
}

describe('libs/dip_store', () => {
    let original_env;

    beforeEach(() => {
        original_env = { ...process.env };
        Object.assign(process.env, ENV);
        app_config._reset();
        dip_store._reset();
    });

    afterEach(() => {
        process.env = original_env;
        app_config._reset();
        dip_store._reset();
    });

    describe('is_configured', () => {
        it('is true with location, endpoint, region and a key pair', () => {
            expect(dip_store.is_configured()).toBe(true);
        });

        it('is false when any one of them is missing', () => {
            for (const name of Object.keys(ENV)) {
                process.env = { ...original_env, ...ENV, [name]: '' };
                app_config._reset();
                expect(dip_store.is_configured(), name).toBe(false);
            }
        });
    });

    describe('parse_location', () => {
        it('splits s3://bucket/prefix/ into bucket and prefix', () => {
            expect(dip_store.parse_location('s3://test-dip-store/dip-store/')).toEqual({
                bucket: 'test-dip-store',
                prefix: 'dip-store/',
            });
        });

        it('accepts a bare bucket, a nested prefix without trailing slash, and S3://', () => {
            expect(dip_store.parse_location('bucket')).toEqual({ bucket: 'bucket', prefix: '' });
            expect(dip_store.parse_location('s3://bucket/a/b')).toEqual({
                bucket: 'bucket',
                prefix: 'a/b/',
            });
            expect(dip_store.parse_location('S3://bucket/a/')).toEqual({
                bucket: 'bucket',
                prefix: 'a/',
            });
        });

        it('refuses a URL with another scheme, or no bucket at all', () => {
            expect(() =>
                dip_store.parse_location('https://s3.test.example/test-dip-store/')
            ).toThrow(/must be s3:\/\//);
            expect(() => dip_store.parse_location('s3://')).toThrow(/no bucket/);
            expect(() => dip_store.parse_location('')).toThrow(/DIP_STORE_LOCATION/);
        });
    });

    describe('key_for', () => {
        it('prefixes the stored path and drops leading slashes', () => {
            expect(dip_store.key_for(`/${FOLDER}/thumbnails/a.jpg`)).toBe(
                `dip-store/${FOLDER}/thumbnails/a.jpg`
            );
        });

        it('refuses . and .. segments and empty paths', () => {
            expect(() => dip_store.key_for('../aip-store/x.7z')).toThrow(ValidationError);
            expect(() => dip_store.key_for(`${FOLDER}/./objects/a.jpg`)).toThrow(ValidationError);
            expect(() => dip_store.key_for('')).toThrow(ValidationError);
            expect(() => dip_store.key_for('///')).toThrow(ValidationError);
        });

        it('refuses anything but a string (an Express 5 wildcard is an array)', () => {
            expect(() => dip_store.key_for(['0000', 'f75f', 'objects', 'a.pdf'])).toThrow(
                /must be a string/
            );
            expect(() => dip_store.key_for(['a', '..', '..', 'aip-store', 'x.7z'])).toThrow(
                ValidationError
            );
            expect(() => dip_store.key_for(42)).toThrow(ValidationError);
            expect(() => dip_store.key_for(undefined)).toThrow(/required/);
        });
    });

    describe('mets_path', () => {
        it('places METS.<sip>.xml directly in the DIP folder', () => {
            expect(dip_store.mets_path('sip-1', FOLDER)).toBe(`${FOLDER}/METS.sip-1.xml`);
        });

        it('requires both arguments', () => {
            expect(() => dip_store.mets_path('', FOLDER)).toThrow(/mets_path/);
        });
    });

    describe('_client_options', () => {
        it('builds explicit credentials, region, checksum, retry and pool settings', () => {
            const opts = dip_store._client_options(app_config().dip_store);
            expect(opts).toMatchObject({
                endpoint: ENV.DIP_STORE_ENDPOINT,
                region: 'us-west-1',
                credentials: { accessKeyId: 'test-key', secretAccessKey: 'test-secret' },
                requestChecksumCalculation: 'WHEN_REQUIRED',
                responseChecksumValidation: 'WHEN_REQUIRED',
                maxAttempts: 3,
                requestHandler: {
                    requestTimeout: 15000,
                    throwOnRequestTimeout: true,
                    connectionTimeout: 5000,
                    httpAgent: { maxSockets: dip_store.MAX_SOCKETS },
                    httpsAgent: { maxSockets: dip_store.MAX_SOCKETS },
                },
            });
            expect(dip_store.MAX_SOCKETS).toBe(50);
        });
    });

    // The real SDK against local servers: what the fake client can't show.
    describe('real SDK client against local servers', () => {
        let server;
        let requests;
        let connections;

        beforeEach(async () => {
            requests = [];
            connections = () =>
                new Promise((resolve) => server.getConnections((e, n) => resolve(n)));
            server = http.createServer((req, res) => {
                requests.push(req.url);
                if (req.url.includes('/silent/')) return; // never answers
                if (req.url.includes('/stall/')) {
                    // Headers and part of the body, then nothing.
                    res.writeHead(200, { 'Content-Type': 'text/xml', 'Content-Length': '1000' });
                    res.write('<mets>'.padEnd(100, 'x'));
                    return;
                }
                if (req.url.includes('/bad-date/')) {
                    res.writeHead(200, {
                        'Content-Type': 'image/jpeg',
                        'Content-Length': '4',
                        'Last-Modified': 'not a date',
                    });
                    res.end(req.method === 'HEAD' ? undefined : 'abcd');
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'text/xml', 'Content-Length': '7' });
                res.end(req.method === 'HEAD' ? undefined : '<mets/>');
            });
            await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
            process.env.DIP_STORE_ENDPOINT = `http://127.0.0.1:${server.address().port}`;
            process.env.DIP_STORE_TIMEOUT_MS = '300';
            app_config._reset();
            dip_store._reset();
        });

        afterEach(async () => {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        });

        it('fails a request with no response headers after DIP_STORE_TIMEOUT_MS, in one attempt', async () => {
            const started = Date.now();
            await expect(dip_store.head(`${FOLDER}/silent/a.pdf`)).rejects.toThrow(
                /request timed out after 300 ms/
            );
            // Three attempts would take at least 900 ms; the deadline is total.
            expect(Date.now() - started).toBeLessThan(900);
            expect(requests).toHaveLength(1);
        }, 10000);

        it('fails a text read whose body stalls after the headers', async () => {
            const started = Date.now();
            await expect(dip_store.fetch_text(`${FOLDER}/stall/METS.x.xml`)).rejects.toThrow(
                /read timed out after 300 ms/
            );
            expect(Date.now() - started).toBeLessThan(1500);
        }, 10000);

        it('ends a stalled text read when the caller aborts', async () => {
            const controller = new AbortController();
            setTimeout(() => controller.abort(), 50);
            await expect(
                dip_store.fetch_text(`${FOLDER}/stall/METS.x.xml`, { signal: controller.signal })
            ).rejects.toThrow(/aborted by the caller/);
        }, 10000);

        it('treats a 2xx the SDK cannot decode as a failure and releases its connection', async () => {
            await expect(dip_store.get_stream(`${FOLDER}/bad-date/a.jpg`)).rejects.toBeInstanceOf(
                UpstreamError
            );
            // The unread body no longer holds the socket.
            for (let i = 0; i < 20 && (await connections()) > 0; i += 1) {
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
            expect(await connections()).toBe(0);
        }, 10000);

        it('reads a text body within the deadline', async () => {
            const res = await dip_store.fetch_text(`${FOLDER}/METS.x.xml`);
            expect(res).toMatchObject({ status: 200, data: '<mets/>' });
        });
    });

    describe('head', () => {
        it('returns 200 with pass-through headers for an existing key', async () => {
            const client = fake_client({
                HeadObjectCommand: () => ({
                    $metadata: { httpStatusCode: 200 },
                    ContentType: 'image/jpeg',
                    ContentLength: 1234,
                    ContentEncoding: 'gzip',
                    ContentDisposition: 'inline; filename="a.jpg"',
                    ETag: '"abc"',
                    LastModified: new Date('2026-10-05T12:00:00Z'),
                }),
            });
            dip_store._set_client(client);
            const res = await dip_store.head(`${FOLDER}/thumbnails/a.jpg`);
            expect(res.status).toBe(200);
            expect(res.data).toBeNull();
            expect(res.headers).toEqual({
                'content-type': 'image/jpeg',
                'content-length': '1234',
                'content-encoding': 'gzip',
                'content-disposition': 'inline; filename="a.jpg"',
                etag: '"abc"',
                'last-modified': 'Mon, 05 Oct 2026 12:00:00 GMT',
            });
            expect(client.calls[0].input).toEqual({
                Bucket: 'test-dip-store',
                Key: `dip-store/${FOLDER}/thumbnails/a.jpg`,
            });
        });

        it('maps a 404 to 404 without further calls', async () => {
            const client = fake_client({
                HeadObjectCommand: () => {
                    throw s3_error(404, 'NotFound');
                },
            });
            dip_store._set_client(client);
            const res = await dip_store.head(`${FOLDER}/objects/missing.tif`);
            expect(res.status).toBe(404);
            expect(client.calls).toHaveLength(1);
        });

        it('turns a 403 into 404 when listing shows the key is absent', async () => {
            const client = fake_client({
                HeadObjectCommand: () => {
                    throw s3_error(403, 'Forbidden');
                },
                ListObjectsV2Command: () => ({ Contents: [] }),
            });
            dip_store._set_client(client);
            const res = await dip_store.head(`${FOLDER}/objects/missing.tif`);
            expect(res.status).toBe(404);
            expect(client.calls[1].input).toEqual({
                Bucket: 'test-dip-store',
                Prefix: `dip-store/${FOLDER}/objects/missing.tif`,
                MaxKeys: 1,
            });
        });

        it('keeps a 403 when the key exists (a policy problem, not a miss)', async () => {
            const key = `dip-store/${FOLDER}/objects/a.tif`;
            const client = fake_client({
                HeadObjectCommand: () => {
                    throw s3_error(403, 'Forbidden');
                },
                ListObjectsV2Command: () => ({ Contents: [{ Key: key }] }),
            });
            dip_store._set_client(client);
            expect((await dip_store.head(`${FOLDER}/objects/a.tif`)).status).toBe(403);
        });

        it('is 404 when only a longer key shares the prefix', async () => {
            const client = fake_client({
                HeadObjectCommand: () => {
                    throw s3_error(403, 'Forbidden');
                },
                ListObjectsV2Command: () => ({
                    Contents: [{ Key: `dip-store/${FOLDER}/objects/a.tif.bak` }],
                }),
            });
            dip_store._set_client(client);
            expect((await dip_store.head(`${FOLDER}/objects/a.tif`)).status).toBe(404);
        });

        it('keeps a 403 when the existence listing itself fails', async () => {
            // Never "missing": a 404 makes the frontend delete its cached file.
            const client = fake_client({
                HeadObjectCommand: () => {
                    throw s3_error(403, 'Forbidden');
                },
                ListObjectsV2Command: () => {
                    throw s3_error(403, 'AccessDenied');
                },
            });
            dip_store._set_client(client);
            expect((await dip_store.head(`${FOLDER}/objects/a.tif`)).status).toBe(403);
        });

        it('forwards the caller signal to the existence listing, and throws if it was aborted', async () => {
            const controller = new AbortController();
            const client = fake_client({
                HeadObjectCommand: () => {
                    throw s3_error(403, 'Forbidden');
                },
                ListObjectsV2Command: (input, index, opts) => {
                    expect(opts.abortSignal).toBeInstanceOf(AbortSignal);
                    controller.abort();
                    throw Object.assign(new Error('Request aborted'), { name: 'AbortError' });
                },
            });
            dip_store._set_client(client);
            await expect(
                dip_store.head(`${FOLDER}/objects/a.tif`, { signal: controller.signal })
            ).rejects.toThrow(/aborted by the caller/);
            expect(client.calls).toHaveLength(2);
        });

        it('returns a 5xx as a status, not an error', async () => {
            dip_store._set_client(
                fake_client({
                    HeadObjectCommand: () => {
                        throw s3_error(503, 'ServiceUnavailable');
                    },
                })
            );
            expect((await dip_store.head(`${FOLDER}/objects/a.tif`)).status).toBe(503);
        });

        it('throws UpstreamError on a transport failure', async () => {
            dip_store._set_client(
                fake_client({
                    HeadObjectCommand: () => {
                        throw transport_error('socket hang up');
                    },
                })
            );
            await expect(dip_store.head(`${FOLDER}/objects/a.tif`)).rejects.toBeInstanceOf(
                UpstreamError
            );
        });

        it('throws UpstreamError when the caller aborted before the headers', async () => {
            const controller = new AbortController();
            setTimeout(() => controller.abort(), 10);
            dip_store._set_client(fake_client({ HeadObjectCommand: hangs_until_aborted() }));
            await expect(
                dip_store.head(`${FOLDER}/objects/a.tif`, { signal: controller.signal })
            ).rejects.toThrow(/request aborted by the caller/);
        });

        it('throws UpstreamError when not configured', async () => {
            process.env.DIP_STORE_ACCESS_KEY_ID = '';
            app_config._reset();
            await expect(dip_store.head(`${FOLDER}/objects/a.tif`)).rejects.toThrow(
                /not configured/
            );
        });
    });

    describe('get_stream', () => {
        it('returns the body stream and headers, and forwards the abort signal', async () => {
            const body = body_of('%PDF');
            const client = fake_client({
                GetObjectCommand: () => ({
                    $metadata: { httpStatusCode: 200 },
                    Body: body,
                    ContentType: 'application/pdf',
                    ContentLength: 4,
                }),
            });
            dip_store._set_client(client);
            const controller = new AbortController();
            const res = await dip_store.get_stream(`${FOLDER}/objects/a.pdf`, {
                signal: controller.signal,
            });
            expect(res.status).toBe(200);
            expect(res.data).toBe(body);
            expect(res.headers).toEqual({
                'content-type': 'application/pdf',
                'content-length': '4',
            });
            expect(client.calls[0].input).toEqual({
                Bucket: 'test-dip-store',
                Key: `dip-store/${FOLDER}/objects/a.pdf`,
            });
            // The SDK gets a signal that follows the caller's.
            const sent = client.calls[0].opts.abortSignal;
            expect(sent).toBeInstanceOf(AbortSignal);
            expect(sent.aborted).toBe(false);
            controller.abort();
            expect(sent.aborted).toBe(true);
        });

        it('maps a missing key to 404 with one call', async () => {
            const client = fake_client({
                GetObjectCommand: () => {
                    throw s3_error(404, 'NoSuchKey');
                },
            });
            dip_store._set_client(client);
            expect((await dip_store.get_stream(`${FOLDER}/objects/x.pdf`)).status).toBe(404);
            expect(client.calls).toHaveLength(1);
        });

        it('confirms a 403 by listing, for GET as for HEAD', async () => {
            const client = fake_client({
                GetObjectCommand: () => {
                    throw s3_error(403, 'Forbidden');
                },
                ListObjectsV2Command: () => ({ Contents: [] }),
            });
            dip_store._set_client(client);
            expect((await dip_store.get_stream(`${FOLDER}/objects/x.pdf`)).status).toBe(404);
            expect(client.calls.map((c) => c.name)).toEqual([
                'GetObjectCommand',
                'ListObjectsV2Command',
            ]);
        });
    });

    describe('fetch_text', () => {
        it('returns the body as text on a 200', async () => {
            dip_store._set_client(
                fake_client({
                    GetObjectCommand: () => ({
                        $metadata: { httpStatusCode: 200 },
                        Body: body_of('<mets/>'),
                        ContentType: 'text/xml',
                    }),
                })
            );
            const res = await dip_store.fetch_text(dip_store.mets_path('sip-1', FOLDER));
            expect(res).toMatchObject({ status: 200, data: '<mets/>' });
            expect(res.headers['content-type']).toBe('text/xml');
        });

        it('returns an empty body with the status otherwise', async () => {
            dip_store._set_client(
                fake_client({
                    GetObjectCommand: () => {
                        throw s3_error(404, 'NoSuchKey');
                    },
                })
            );
            expect(await dip_store.fetch_text(`${FOLDER}/METS.x.xml`)).toEqual({
                status: 404,
                data: '',
                headers: {},
            });
        });

        it('throws UpstreamError when the body read fails', async () => {
            const body = body_of('');
            body.transformToString = async () => {
                throw new Error('aborted');
            };
            dip_store._set_client(
                fake_client({
                    GetObjectCommand: () => ({ $metadata: { httpStatusCode: 200 }, Body: body }),
                })
            );
            await expect(dip_store.fetch_text(`${FOLDER}/METS.x.xml`)).rejects.toThrow(
                /DIP store read failed/
            );
        });
    });

    describe('is_serving', () => {
        it('needs DIP_GATEWAY_ENABLED and a configured store', () => {
            expect(dip_store.is_serving()).toBe(false);
            process.env.DIP_GATEWAY_ENABLED = 'true';
            app_config._reset();
            expect(dip_store.is_serving()).toBe(true);
            process.env.DIP_STORE_ACCESS_KEY_ID = '';
            app_config._reset();
            expect(dip_store.is_serving()).toBe(false);
        });
    });

    describe('the s3 option and create_client', () => {
        it('sends through the given client, never the shared one', async () => {
            const shared = fake_client({});
            const own = fake_client({
                HeadObjectCommand: () => ({ $metadata: { httpStatusCode: 200 }, ContentLength: 3 }),
            });
            dip_store._set_client(shared);
            const res = await dip_store.head(`${FOLDER}/thumbnails/a.jpg`, { s3: own });
            expect(res.status).toBe(200);
            expect(own.calls).toHaveLength(1);
            expect(shared.calls).toHaveLength(0);
        });

        it('confirms a 403 through the same given client', async () => {
            const shared = fake_client({});
            const own = fake_client({
                GetObjectCommand: () => {
                    throw s3_error(403, 'AccessDenied');
                },
                ListObjectsV2Command: () => ({ Contents: [] }),
            });
            dip_store._set_client(shared);
            const res = await dip_store.get_stream(`${FOLDER}/objects/a.pdf`, { s3: own });
            expect(res.status).toBe(404);
            expect(own.calls.map((c) => c.name)).toEqual([
                'GetObjectCommand',
                'ListObjectsV2Command',
            ]);
            expect(shared.calls).toHaveLength(0);
        });

        it('create_client builds a new client, with its own pool, from the config', async () => {
            const a = dip_store.create_client();
            const b = dip_store.create_client();
            try {
                expect(a).not.toBe(b);
                expect(await a.config.region()).toBe('us-west-1');
            } finally {
                a.destroy();
                b.destroy();
            }
        });
    });

    describe('pipe_to', () => {
        /*
         * A one-route app around pipe_to. A non-200 answers 418 with the
         * upstream status, which it could not do if pipe_to had already
         * written anything; a throw answers 503 with the error's name.
         */
        function app_for(path, seen = []) {
            const app = express();
            app.get('/t', async (req, res) => {
                const listeners = res.listenerCount('close');
                try {
                    const status = await dip_store.pipe_to(res, path, {
                        on_200: (headers) => {
                            seen.push(headers);
                            res.status(200);
                            res.set('Content-Type', headers['content-type']);
                        },
                    });
                    if (status !== 200) {
                        res.status(418).json({
                            upstream: status,
                            leaked_listeners: res.listenerCount('close') - listeners,
                        });
                    }
                } catch (err) {
                    res.status(503).json({ error: err.name });
                }
            });
            return app;
        }

        it('streams a 200 after on_200 has set the status and headers', async () => {
            const seen = [];
            dip_store._set_client(
                fake_client({
                    GetObjectCommand: () => ({
                        $metadata: { httpStatusCode: 200 },
                        Body: body_of('%PDF-1.7'),
                        ContentType: 'application/pdf',
                        ContentLength: 8,
                    }),
                })
            );
            const res = await supertest(app_for(`${FOLDER}/objects/a.pdf`, seen))
                .get('/t')
                .buffer(true)
                .parse((r, cb) => {
                    const chunks = [];
                    r.on('data', (c) => chunks.push(c));
                    r.on('end', () => cb(null, Buffer.concat(chunks)));
                });
            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toBe('application/pdf');
            expect(res.body.toString()).toBe('%PDF-1.7');
            expect(seen).toEqual([{ 'content-type': 'application/pdf', 'content-length': '8' }]);
        });

        it('returns a non-200 without writing anything, and removes its listener', async () => {
            dip_store._set_client(
                fake_client({
                    GetObjectCommand: () => {
                        throw s3_error(404, 'NoSuchKey');
                    },
                })
            );
            const res = await supertest(app_for(`${FOLDER}/objects/x.pdf`)).get('/t');
            expect(res.status).toBe(418);
            expect(res.body).toEqual({ upstream: 404, leaked_listeners: 0 });
        });

        it('throws UpstreamError like get_stream, with nothing written', async () => {
            dip_store._set_client(
                fake_client({
                    GetObjectCommand: () => {
                        throw transport_error('socket hang up');
                    },
                })
            );
            const res = await supertest(app_for(`${FOLDER}/objects/x.pdf`)).get('/t');
            expect(res.status).toBe(503);
            expect(res.body.error).toBe('UpstreamError');
        });

        it('aborts the S3 request when the client goes away mid-body', async () => {
            const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
            let signal;
            const body = new Readable({ read() {} });
            body.push('first chunk');
            dip_store._set_client(
                fake_client({
                    GetObjectCommand: (input, index, opts) => {
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
            const server = app_for(`${FOLDER}/objects/big.pdf`).listen(0, '127.0.0.1');
            await new Promise((resolve) => server.once('listening', resolve));
            try {
                await new Promise((resolve) => {
                    const req = http.get(`http://127.0.0.1:${server.address().port}/t`, (res) => {
                        res.once('data', () => {
                            req.destroy();
                            resolve();
                        });
                    });
                    req.on('error', () => {});
                });
                await vi.waitFor(() => expect(signal.aborted).toBe(true), { timeout: 2000 });
                expect(body.destroyed).toBe(true);
                // A client leaving is not an upstream failure: nothing is logged.
                await new Promise((resolve) => setTimeout(resolve, 50));
                expect(warn.mock.calls.map((c) => c[0].event)).not.toContain(
                    'dip_store_stream_failed'
                );
            } finally {
                warn.mockRestore();
                server.closeAllConnections();
                await new Promise((resolve) => server.close(resolve));
            }
        });

        /*
         * A real response whose client has gone: the server waits for the
         * client to leave before `handler` runs, so pipe_to sees a closed
         * `res`. Resolves with whatever `handler` returns.
         */
        async function with_gone_client(handler) {
            let settle;
            const outcome = new Promise((resolve) => {
                settle = resolve;
            });
            const server = http.createServer(async (req, res) => {
                await vi.waitFor(() => expect(res.destroyed).toBe(true), { timeout: 2000 });
                settle(await handler(res));
            });
            server.listen(0, '127.0.0.1');
            await new Promise((resolve) => server.once('listening', resolve));
            try {
                const req = http.get(`http://127.0.0.1:${server.address().port}/t`);
                req.on('error', () => {});
                req.on('socket', () => setTimeout(() => req.destroy(), 20));
                return await outcome;
            } finally {
                server.closeAllConnections();
                await new Promise((resolve) => server.close(resolve));
            }
        }

        it('throws "aborted by the caller" before any request when the client has already left', async () => {
            const client = fake_client({
                GetObjectCommand: () => ({ $metadata: { httpStatusCode: 200 } }),
            });
            dip_store._set_client(client);
            const error = await with_gone_client((res) =>
                dip_store.pipe_to(res, `${FOLDER}/objects/a.pdf`).then(
                    () => null,
                    (err) => err.message
                )
            );
            expect(error).toMatch(/aborted by the caller/);
            expect(client.calls).toHaveLength(0);
        });

        it('destroys the body and throws when the client leaves while the store is answering', async () => {
            const body = new Readable({ read() {} });
            body.push('jpeg');
            // A store that ignores the abort and answers anyway.
            dip_store._set_client(
                fake_client({
                    GetObjectCommand: () =>
                        new Promise((resolve) =>
                            setTimeout(
                                () =>
                                    resolve({
                                        $metadata: { httpStatusCode: 200 },
                                        Body: body,
                                        ContentType: 'image/jpeg',
                                    }),
                                50
                            )
                        ),
                })
            );
            let settle;
            const outcome = new Promise((resolve) => {
                settle = resolve;
            });
            const server = http.createServer((req, res) => {
                const listeners = res.listenerCount('close');
                dip_store.pipe_to(res, `${FOLDER}/thumbnails/a.jpg`).then(
                    () => settle({ error: null }),
                    (err) =>
                        settle({
                            error: err.message,
                            leaked: res.listenerCount('close') - listeners,
                        })
                );
            });
            server.listen(0, '127.0.0.1');
            await new Promise((resolve) => server.once('listening', resolve));
            try {
                const req = http.get(`http://127.0.0.1:${server.address().port}/t`);
                req.on('error', () => {});
                req.on('socket', () => setTimeout(() => req.destroy(), 10));
                const out = await outcome;
                expect(out.error).toMatch(/aborted by the caller/);
                expect(body.destroyed).toBe(true);
                expect(out.leaked).toBe(0);
            } finally {
                server.closeAllConnections();
                await new Promise((resolve) => server.close(resolve));
            }
        });

        it('logs dip_store_stream_failed when the upstream body fails mid-stream', async () => {
            const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
            const body = new Readable({ read() {} });
            body.push('first chunk');
            dip_store._set_client(
                fake_client({
                    GetObjectCommand: () => ({
                        $metadata: { httpStatusCode: 200 },
                        Body: body,
                        ContentType: 'application/pdf',
                    }),
                })
            );
            const server = app_for(`${FOLDER}/objects/cut.pdf`).listen(0, '127.0.0.1');
            await new Promise((resolve) => server.once('listening', resolve));
            try {
                const outcome = await new Promise((resolve) => {
                    http.get(`http://127.0.0.1:${server.address().port}/t`, (res) => {
                        res.once('data', () =>
                            body.destroy(new Error('connection reset by Wasabi'))
                        );
                        res.on('error', (err) => resolve(err.code));
                        res.on('end', () => resolve('end'));
                    }).on('error', (err) => resolve(err.code));
                });
                expect(outcome).not.toBe('end');
                await vi.waitFor(
                    () =>
                        expect(warn.mock.calls.map((c) => c[0].event)).toContain(
                            'dip_store_stream_failed'
                        ),
                    { timeout: 2000 }
                );
            } finally {
                warn.mockRestore();
                server.closeAllConnections();
                await new Promise((resolve) => server.close(resolve));
            }
        });
    });

    describe('ping', () => {
        it('lists one key under the prefix, then reads it, under one deadline', async () => {
            const key = `dip-store/${FOLDER}/thumbnails/a.jpg`;
            const client = fake_client({
                ListObjectsV2Command: () => ({ KeyCount: 1, Contents: [{ Key: key }] }),
                HeadObjectCommand: () => ({ $metadata: { httpStatusCode: 200 } }),
            });
            dip_store._set_client(client);
            expect(await dip_store.ping()).toBe(true);
            expect(client.calls.map((c) => c.name)).toEqual([
                'ListObjectsV2Command',
                'HeadObjectCommand',
            ]);
            expect(client.calls[0].input).toEqual({
                Bucket: 'test-dip-store',
                Prefix: 'dip-store/',
                MaxKeys: 1,
            });
            expect(client.calls[1].input).toEqual({ Bucket: 'test-dip-store', Key: key });
            expect(client.calls[0].opts.abortSignal).toBeInstanceOf(AbortSignal);
            expect(client.calls[1].opts.abortSignal).toBe(client.calls[0].opts.abortSignal);
        });

        it('is true for an empty folder', async () => {
            const client = fake_client({ ListObjectsV2Command: () => ({ KeyCount: 0 }) });
            dip_store._set_client(client);
            expect(await dip_store.ping()).toBe(true);
            expect(client.calls).toHaveLength(1);
        });

        it('is false (and never throws) when the listing fails', async () => {
            dip_store._set_client(
                fake_client({
                    ListObjectsV2Command: () => {
                        throw s3_error(403, 'AccessDenied');
                    },
                })
            );
            expect(await dip_store.ping()).toBe(false);
        });

        it('is false when the key can list but not read', async () => {
            dip_store._set_client(
                fake_client({
                    ListObjectsV2Command: () => ({ Contents: [{ Key: 'dip-store/x/a.jpg' }] }),
                    HeadObjectCommand: () => {
                        throw s3_error(403, 'Forbidden');
                    },
                })
            );
            expect(await dip_store.ping()).toBe(false);
        });

        it('gives up after DIP_STORE_TIMEOUT_MS when the store never answers', async () => {
            process.env.DIP_STORE_TIMEOUT_MS = '50';
            app_config._reset();
            dip_store._set_client(fake_client({ ListObjectsV2Command: hangs_until_aborted() }));
            const started = Date.now();
            expect(await dip_store.ping()).toBe(false);
            expect(Date.now() - started).toBeLessThan(1000);
        });

        it('is false without a client call when not configured', async () => {
            process.env.DIP_STORE_LOCATION = '';
            app_config._reset();
            const client = fake_client({});
            dip_store._set_client(client);
            expect(await dip_store.ping()).toBe(false);
            expect(client.calls).toHaveLength(0);
        });
    });
});
