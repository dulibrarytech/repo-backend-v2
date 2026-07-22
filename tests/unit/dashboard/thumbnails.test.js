'use strict';

/*
 * Unit tests for dashboard/thumbnails.js — the magic-byte gate,
 * the URL builder, and the atomic-write semantics. The multer-piped
 * upload path is covered by the e2e tests where we can drive a real
 * multipart body through the route.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const thumbnails = require('../../../dashboard/thumbnails');
const app_config = require('../../../config/app');
const { ValidationError } = require('../../../libs/errors');

describe('dashboard/thumbnails — is_jpeg', () => {
    it('accepts a buffer starting with FF D8 FF', () => {
        const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
        expect(thumbnails.is_jpeg(buf)).toBe(true);
    });

    it('rejects PNG magic bytes', () => {
        // PNG signature: 89 50 4E 47 0D 0A 1A 0A
        const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        expect(thumbnails.is_jpeg(buf)).toBe(false);
    });

    it('rejects an empty buffer', () => {
        expect(thumbnails.is_jpeg(Buffer.alloc(0))).toBe(false);
    });

    it('rejects undefined', () => {
        expect(thumbnails.is_jpeg(undefined)).toBe(false);
    });

    it('rejects a buffer shorter than the magic prefix', () => {
        expect(thumbnails.is_jpeg(Buffer.from([0xff, 0xd8]))).toBe(false);
    });
});

describe('dashboard/thumbnails — validate_uploaded_buffer', () => {
    it('throws ValidationError when no file present', () => {
        expect(() => thumbnails.validate_uploaded_buffer(undefined)).toThrow(ValidationError);
        expect(() => thumbnails.validate_uploaded_buffer({})).toThrow(ValidationError);
    });

    it('throws ValidationError when buffer is empty', () => {
        expect(() => thumbnails.validate_uploaded_buffer({ buffer: Buffer.alloc(0) })).toThrow(
            ValidationError
        );
    });

    it('throws ValidationError when buffer is not a JPEG', () => {
        // Content-Type spoofing simulation: a "JPEG" with PNG bytes.
        expect(() =>
            thumbnails.validate_uploaded_buffer({
                mimetype: 'image/jpeg',
                buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
            })
        ).toThrow(ValidationError);
    });

    it('returns the buffer unchanged on a valid JPEG', () => {
        const buf = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20, 0)]);
        expect(thumbnails.validate_uploaded_buffer({ buffer: buf })).toBe(buf);
    });
});

describe('dashboard/thumbnails — build_thumbnail_url', () => {
    let original_env;
    beforeEach(() => {
        original_env = { ...process.env };
    });
    afterEach(() => {
        /*
         * Restore env + clear the cached config so the next test picks
         * up its own settings cleanly.
         */
        process.env = original_env;
        app_config._reset();
    });

    it('uses PUBLIC_BASE_URL when set, regardless of incoming request host', () => {
        process.env.PUBLIC_BASE_URL = 'https://repo.du.edu';
        process.env.APP_PATH = '/repo';
        app_config._reset();
        const req = { protocol: 'http', get: () => 'attacker.example' };
        const url = thumbnails.build_thumbnail_url(req, 'abc');
        expect(url).toBe('https://repo.du.edu/repo/static/tn/abc.jpg');
    });

    it('strips a trailing slash from PUBLIC_BASE_URL so no double slashes appear', () => {
        process.env.PUBLIC_BASE_URL = 'https://repo.du.edu/';
        process.env.APP_PATH = '/repo';
        app_config._reset();
        const req = { protocol: 'http', get: () => 'localhost' };
        const url = thumbnails.build_thumbnail_url(req, 'abc');
        expect(url).toBe('https://repo.du.edu/repo/static/tn/abc.jpg');
    });

    it('falls back to the request host when PUBLIC_BASE_URL is empty', () => {
        delete process.env.PUBLIC_BASE_URL;
        process.env.APP_PATH = '/repo';
        app_config._reset();
        const req = { protocol: 'http', get: () => 'localhost:8000' };
        const url = thumbnails.build_thumbnail_url(req, 'abc');
        expect(url).toBe('http://localhost:8000/repo/static/tn/abc.jpg');
    });
});

describe('dashboard/thumbnails — write_thumbnail_atomically', () => {
    let tempdir;
    let original_env;

    beforeEach(async () => {
        original_env = { ...process.env };
        tempdir = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-tn-test-'));
        process.env.THUMBNAIL_UPLOAD_PATH = tempdir;
        app_config._reset();
    });
    afterEach(async () => {
        process.env = original_env;
        app_config._reset();
        await fs.rm(tempdir, { recursive: true, force: true });
    });

    it('writes the file under <pid>.jpg', async () => {
        const buf = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
        const written = await thumbnails.write_thumbnail_atomically('abc-123', buf);
        expect(written).toBe(path.join(tempdir, 'abc-123.jpg'));
        const on_disk = await fs.readFile(written);
        expect(on_disk.equals(buf)).toBe(true);
    });

    it('overwrites an existing file (subsequent uploads replace)', async () => {
        const first = Buffer.from([0xff, 0xd8, 0xff, 0x01]);
        const second = Buffer.from([0xff, 0xd8, 0xff, 0x02, 0x03, 0x04]);
        await thumbnails.write_thumbnail_atomically('replace-me', first);
        await thumbnails.write_thumbnail_atomically('replace-me', second);
        const on_disk = await fs.readFile(path.join(tempdir, 'replace-me.jpg'));
        expect(on_disk.equals(second)).toBe(true);
    });

    it('leaves no .tmp leftovers in the directory after success', async () => {
        await thumbnails.write_thumbnail_atomically('clean-up', Buffer.from([0xff, 0xd8, 0xff]));
        const entries = await fs.readdir(tempdir);
        // Only the final file should remain.
        expect(entries).toEqual(['clean-up.jpg']);
    });

    it('creates the upload directory if it does not exist', async () => {
        const nested = path.join(tempdir, 'nested', 'tn');
        process.env.THUMBNAIL_UPLOAD_PATH = nested;
        app_config._reset();
        await thumbnails.write_thumbnail_atomically('nested-pid', Buffer.from([0xff, 0xd8, 0xff]));
        const exists = await fs
            .stat(path.join(nested, 'nested-pid.jpg'))
            .then(() => true)
            .catch(() => false);
        expect(exists).toBe(true);
    });
});
