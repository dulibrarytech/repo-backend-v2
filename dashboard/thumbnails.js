'use strict';

// Thumbnail upload pipeline for the dashboard.
//
// What this module owns:
//   - The multer instance that buffers a single uploaded file in memory.
//     We intentionally use memoryStorage (not diskStorage) so we can
//     inspect the bytes BEFORE committing anything to disk — multer's
//     disk path writes the file under a random name first and lets the
//     route handler decide what to do, which complicates rollback if the
//     buffer fails validation.
//   - The JPEG magic-byte check. Browsers will happily send any
//     Content-Type they like; trusting that header is what got the
//     legacy uploader into trouble. The only authority is the file's
//     first three bytes (FF D8 FF for any flavor of JPEG/JFIF).
//   - The atomic write: temp file in the same dir, then rename. This
//     prevents a half-written file from being served to a concurrent
//     reader and means a crash mid-write leaves either the old image
//     or no image at all — never a corrupt one.
//   - The URL construction from PUBLIC_BASE_URL (or a best-effort fall-
//     back built from the incoming request). This is the URL stored in
//     tbl_objects.thumbnail AND in display_record.thumbnail; both must
//     match so the indexer and the dashboard never disagree.

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const multer = require('multer');

const app_config = require('../config/app');
const { ValidationError } = require('../libs/errors');

// JFIF / EXIF / raw JPEG all start with these three bytes. A spoofed
// JPEG that gets through here would still need to render in a browser,
// which is a much harder bar than passing a content-type check.
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

function is_jpeg(buffer) {
    if (!buffer || buffer.length < JPEG_MAGIC.length) return false;
    return buffer.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC);
}

// multer instance — memory storage, single file under field name
// `thumbnail`, hard byte cap from config. Type filter rejects anything
// whose declared content-type isn't image/jpeg; the real validation
// happens after upload via is_jpeg() because content-type is forgeable.
function make_upload_middleware() {
    const cfg = app_config();
    return multer({
        storage: multer.memoryStorage(),
        limits: {
            fileSize: cfg.thumbnail_max_bytes,
            files: 1,
            // We don't strictly need text fields, but some HTTP clients
            // (notably supertest under test) sprinkle in a stray field
            // boundary or two. Allow a small budget so a legitimate
            // request never trips the `LIMIT_PART_COUNT` error — the
            // route ignores req.body entirely.
            fields: 4,
        },
        fileFilter(_req, file, cb) {
            // Reject obviously-wrong types fast so we don't even buffer
            // them. is_jpeg() is the authoritative check, but this
            // skips the read entirely for a clearly bogus upload.
            if (file.mimetype !== 'image/jpeg') {
                return cb(
                    Object.assign(new Error('Only JPEG files (image/jpeg) are accepted'), {
                        code: 'INVALID_FILE_TYPE',
                        status: 400,
                    })
                );
            }
            cb(null, true);
        },
    }).single('thumbnail');
}

// Build the public URL we'll store in the DB. PUBLIC_BASE_URL is the
// source of truth in production. When unset (dev / tests), build it
// from the incoming request so links resolve relative to wherever the
// dashboard is being viewed from. Never trust user-supplied Host
// headers in production: relying on cfg.public_base_url means an
// attacker can't poison a stored URL by spoofing the Host header.
function build_thumbnail_url(req, pid) {
    const cfg = app_config();
    if (cfg.public_base_url) {
        return `${cfg.public_base_url.replace(/\/+$/, '')}${cfg.path}/static/tn/${pid}.jpg`;
    }
    // Fallback used by tests and `npm run dev`. The Host header is fine
    // here because the only callers without PUBLIC_BASE_URL set are
    // developers running locally.
    const protocol = req.protocol || 'http';
    const host = req.get && req.get('host');
    return `${protocol}://${host}${cfg.path}/static/tn/${pid}.jpg`;
}

// Persist the uploaded buffer to <upload_dir>/<pid>.jpg atomically:
// write to a uniquely-named sibling file first, then rename. Rename on
// the same filesystem is atomic on POSIX, so a concurrent GET will see
// either the old file or the new file — never a partial one.
async function write_thumbnail_atomically(pid, buffer) {
    const cfg = app_config();
    await fs.mkdir(cfg.thumbnail_upload_path, { recursive: true });

    const final_path = path.join(cfg.thumbnail_upload_path, `${pid}.jpg`);
    const temp_suffix = randomBytes(6).toString('hex');
    const temp_path = `${final_path}.${temp_suffix}.tmp`;

    try {
        await fs.writeFile(temp_path, buffer, { flag: 'wx' });
        await fs.rename(temp_path, final_path);
    } catch (err) {
        // Best-effort cleanup; ignore ENOENT (temp file never landed).
        await fs.unlink(temp_path).catch(() => {});
        throw err;
    }
    return final_path;
}

// Validate the uploaded buffer after multer. Throws ValidationError on
// any failure so the controller can map it to a 400. Returns the
// buffer unchanged on success so the call site reads cleanly.
function validate_uploaded_buffer(file) {
    if (!file || !file.buffer || file.buffer.length === 0) {
        throw new ValidationError('No thumbnail file uploaded');
    }
    if (!is_jpeg(file.buffer)) {
        // This catches BOTH renamed PNGs/GIFs/etc. AND content-type
        // spoofing of arbitrary binary content. is_jpeg is the only
        // authoritative gate — the multer fileFilter only sees the
        // forgeable mimetype string.
        throw new ValidationError('Uploaded file is not a valid JPEG');
    }
    return file.buffer;
}

module.exports = {
    make_upload_middleware,
    validate_uploaded_buffer,
    write_thumbnail_atomically,
    build_thumbnail_url,
    // Exposed for unit tests — magic-byte checks are easy to get wrong.
    is_jpeg,
};
