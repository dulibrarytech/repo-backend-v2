'use strict';

/*
 * Unit tests for libs/dip_store — the Wasabi DIP store client. A fake S3
 * client (injected with _set_client) stands in for @aws-sdk/client-s3: it
 * records each command and answers from per-command handlers, so no
 * network or credentials are needed.
 */

const http = require('node:http');
const { Readable } = require('node:stream');

const dip_store = require('../../../libs/dip_store');
const app_config = require('../../../config/app');
const { UpstreamError, ValidationError } = require('../../../libs/errors');

const ENV = {
    DIP_STORE_LOCATION: 's3://library-repository/dip-store/',
    DIP_STORE_ENDPOINT: 'https://s3.us-west-1.wasabisys.com',
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
 * (input, call_index) => output | throws. Every call is recorded.
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
            return handler(command.input, calls.filter((c) => c.name === name).length - 1);
        }),
    };
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
            expect(dip_store.parse_location('s3://library-repository/dip-store/')).toEqual({
                bucket: 'library-repository',
                prefix: 'dip-store/',
            });
        });

        it('accepts a bare bucket and a nested prefix without trailing slash', () => {
            expect(dip_store.parse_location('bucket')).toEqual({ bucket: 'bucket', prefix: '' });
            expect(dip_store.parse_location('s3://bucket/a/b')).toEqual({
                bucket: 'bucket',
                prefix: 'a/b/',
            });
        });

        it('throws when unset', () => {
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
        it('builds explicit credentials, region and conservative checksum settings', () => {
            const opts = dip_store._client_options(app_config().dip_store);
            expect(opts).toMatchObject({
                endpoint: ENV.DIP_STORE_ENDPOINT,
                region: 'us-west-1',
                credentials: { accessKeyId: 'test-key', secretAccessKey: 'test-secret' },
                requestChecksumCalculation: 'WHEN_REQUIRED',
                responseChecksumValidation: 'WHEN_REQUIRED',
                requestHandler: {
                    requestTimeout: 15000,
                    throwOnRequestTimeout: true,
                    connectionTimeout: 5000,
                },
            });
        });
    });

    /*
     * The real SDK against a local server that takes each request and never
     * answers. The fake client can't show whether the configured timeout
     * actually ends a request; this can.
     */
    describe('timeouts (real SDK client, silent local server)', () => {
        let server;
        let requests;

        beforeEach(async () => {
            requests = 0;
            server = http.createServer(() => {
                requests += 1;
            });
            await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
            process.env.DIP_STORE_ENDPOINT = `http://127.0.0.1:${server.address().port}`;
            process.env.DIP_STORE_TIMEOUT_MS = '200';
            app_config._reset();
            dip_store._reset();
        });

        afterEach(async () => {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        });

        it('ends a request that gets no response headers within DIP_STORE_TIMEOUT_MS', async () => {
            const started = Date.now();
            await expect(dip_store.head(`${FOLDER}/objects/a.pdf`)).rejects.toThrow(
                /requestTimeout/
            );
            expect(requests).toBeGreaterThan(0);
            expect(Date.now() - started).toBeLessThan(5000);
        }, 10000);
    });

    describe('head', () => {
        it('returns 200 with pass-through headers for an existing key', async () => {
            const client = fake_client({
                HeadObjectCommand: () => ({
                    $metadata: { httpStatusCode: 200 },
                    ContentType: 'image/jpeg',
                    ContentLength: 1234,
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
                etag: '"abc"',
                'last-modified': 'Mon, 05 Oct 2026 12:00:00 GMT',
            });
            expect(client.calls[0].input).toEqual({
                Bucket: 'library-repository',
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
                Bucket: 'library-repository',
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
            const signal = new AbortController().signal;
            const res = await dip_store.get_stream(`${FOLDER}/objects/a.pdf`, { signal });
            expect(res.status).toBe(200);
            expect(res.data).toBe(body);
            expect(res.headers).toEqual({
                'content-type': 'application/pdf',
                'content-length': '4',
            });
            expect(client.calls[0].input).toEqual({
                Bucket: 'library-repository',
                Key: `dip-store/${FOLDER}/objects/a.pdf`,
            });
            expect(client.calls[0].opts.abortSignal).toBe(signal);
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
    });

    describe('ping', () => {
        it('lists one key under the prefix, with a deadline', async () => {
            const client = fake_client({ ListObjectsV2Command: () => ({ KeyCount: 0 }) });
            dip_store._set_client(client);
            expect(await dip_store.ping()).toBe(true);
            expect(client.calls[0].input).toEqual({
                Bucket: 'library-repository',
                Prefix: 'dip-store/',
                MaxKeys: 1,
            });
            expect(client.calls[0].opts.abortSignal).toBeInstanceOf(AbortSignal);
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
