'use strict';

// Live ArchivesSpace transformer parity test.
//
// SKIPPED by default — only runs when `INGEST_LIVE_E2E=1` is set
// (matches the existing live-test convention in ingest_live.test.js).
//
// Purpose: confirm that libs/archivesspace_transform.js produces the
// SAME flat shape per record as the legacy DU `/repository` plugin
// endpoint, for a sample of real records pulled from the live AS
// instance. This is the gate before flipping ASPACE_USE_TRANSFORMER=1
// in dev (and eventually prod).
//
// How to run:
//
//   INGEST_LIVE_E2E=1 \
//     ARCHIVESPACE_HOST=https://aspace.example/api \
//     ARCHIVESPACE_USER=svc \
//     ARCHIVESPACE_PASSWORD=*** \
//     ASPACE_PARITY_URIS="/repositories/2/archival_objects/12345,/repositories/2/resources/42" \
//     npx vitest run tests/e2e/aspace_transform_parity.test.js
//
// The ASPACE_PARITY_URIS env carries a comma-separated list of URIs
// to compare. Operator picks records that exercise the long tail —
// compound objects, resources with rich notes, records with multiple
// linked agents, etc.
//
// What's compared: every key in the transformed shape EXCEPT:
//   - `_transformer_version` (only the transformer path adds this)
//   - `names[*].relator` (plugin runs I18n.t() to translate to a
//     human-readable string; transformer emits raw enum keys until
//     we add a translation table)
//   - `parts[*].kaltura_id` (plugin fetches DigitalObjectComponent
//     records per child to populate; transformer defers this)
//
// On mismatch the test prints a diff so the operator can decide if
// the divergence is acceptable (e.g. the transformer correctly fixes
// a plugin bug) or a transformer regression.

const should_run = process.env.INGEST_LIVE_E2E === '1';
const describeOrSkip = should_run ? describe : describe.skip;

describeOrSkip('ArchivesSpace transformer parity (gated by INGEST_LIVE_E2E=1)', () => {
    let aspace_module;
    let app_config;
    let token;
    const uris = (process.env.ASPACE_PARITY_URIS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

    beforeAll(async () => {
        app_config = require('../../config/app');
        app_config._reset();
        aspace_module = require('../../libs/archivesspace');
        if (!aspace_module.is_configured()) {
            throw new Error('ARCHIVESPACE_* env vars not set; cannot run parity test');
        }
        token = await aspace_module.get_session_token();
    });

    afterAll(async () => {
        if (token) {
            try {
                await aspace_module.destroy_session_token(token);
            } catch {
                // best-effort
            }
        }
    });

    it('has at least one URI to compare (set ASPACE_PARITY_URIS env)', () => {
        expect(uris.length).toBeGreaterThan(0);
    });

    // One test per URI so a single-record regression doesn't mask the
    // others. vitest reports each as a separate pass/fail.
    for (const uri of uris) {
        it(`produces parity output for ${uri}`, async () => {
            // Plugin path: fetch with use_transformer=false.
            process.env.ASPACE_USE_TRANSFORMER = '0';
            app_config._reset();
            const plugin_client = aspace_module.create_client();
            const plugin_res = await plugin_client.get_record(uri, token);
            expect(plugin_res.status).toBe(200);

            // Transformer path: fetch with use_transformer=1.
            process.env.ASPACE_USE_TRANSFORMER = '1';
            app_config._reset();
            const xform_client = aspace_module.create_client();
            const xform_res = await xform_client.get_record(uri, token);
            expect(xform_res.status).toBe(200);

            const plugin_shape = normalize(plugin_res.data);
            const xform_shape = normalize(xform_res.data);

            // toEqual gives a structured diff on failure — easier to
            // read than a giant JSON dump when one of 30 fields drifts.
            expect(xform_shape).toEqual(plugin_shape);
        });
    }
});

// Drop the keys we KNOW differ between plugin and transformer
// (see header docstring). Everything else must match exactly.
function normalize(data) {
    if (!data || typeof data !== 'object') return data;
    const clone = JSON.parse(JSON.stringify(data));
    delete clone._transformer_version;
    if (Array.isArray(clone.names)) {
        clone.names = clone.names.map((n) => {
            const copy = { ...n };
            delete copy.relator;
            return copy;
        });
    }
    if (Array.isArray(clone.parts)) {
        clone.parts = clone.parts.map((p) => {
            const copy = { ...p };
            delete copy.kaltura_id;
            return copy;
        });
    }
    return clone;
}
