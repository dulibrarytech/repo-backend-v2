#!/usr/bin/env node
'use strict';

/*
 * Verify the Handle.net admin credentials end to end, without touching any
 * real object's handle.
 *
 * Writes go through the DuHandleTool Java helper on the native protocol
 * (libs/handle_writer.js), which no unit test can exercise — it needs a
 * JVM, the real private key and the real server. Run this after building
 * the helper, and again on the production host before the first ingest
 * that mints a handle.
 *
 * Usage:
 *   node scripts/verify_handle_auth.js                 # read + auth only
 *   node scripts/verify_handle_auth.js --write         # + mint/delete a scratch handle
 *   node scripts/verify_handle_auth.js --probe <uuid>  # resolve a specific handle
 *
 * Without --write nothing is modified: it resolves a handle (public read)
 * and completes the authentication handshake, which is enough to prove the
 * key, the passphrase, the admin id and the network path are all correct.
 *
 * With --write it mints a handle for a freshly generated random uuid —
 * one that no object references — resolves it to confirm the value landed,
 * then deletes it. That round trip is what proves admin WRITE authority.
 * It is reversible and touches nothing in tbl_objects.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PASS = '  PASS';
const FAIL = '  FAIL';

function report(ok, label, detail) {
    process.stdout.write(`${ok ? PASS : FAIL}  ${label}\n`);
    if (detail) process.stdout.write(`        ${detail}\n`);
    return ok;
}

async function main() {
    const args = process.argv.slice(2);
    const do_write = args.includes('--write');
    const probe_index = args.indexOf('--probe');
    const probe_uuid = probe_index !== -1 ? args[probe_index + 1] : null;

    const app_config = require('../config/app');
    const handles = require('../libs/handles');
    const handle_writer = require('../libs/handle_writer');

    const cfg = app_config().handles;
    let ok = true;

    process.stdout.write('\nHandle.net credential + handshake check\n\n');

    /* --- 1. configuration --------------------------------------------- */
    process.stdout.write('Configuration\n');
    process.stdout.write(`        admin_url  ${cfg.admin_url || '(unset)'}\n`);
    process.stdout.write(`        admin_id   ${cfg.admin_id || '(unset)'}\n`);
    process.stdout.write(`        key        ${cfg.admin_key_path || '(unset)'}\n`);
    process.stdout.write(`        target     ${cfg.target || '(unset)'}\n`);
    process.stdout.write(`        prefix     ${cfg.prefix || '(unset)'}\n`);
    process.stdout.write(`        server     ${cfg.server || '(unset)'}\n`);
    process.stdout.write(`        client lib ${cfg.client_lib || '(unset)'}\n`);
    process.stdout.write(`        classpath  ${cfg.helper_classpath || '(empty)'}\n`);
    process.stdout.write(
        `        passphrase ${cfg.admin_passphrase ? '(set)' : '(none — key must be unencrypted)'}\n\n`
    );

    /*
     * Name the missing variables individually. Reporting only that the set
     * is "incomplete" is useless when every value above looks populated —
     * the one that fails is often a derived field with no line of its own.
     */
    const missing = [
        ['HANDLE_ADMIN_URL', cfg.admin_url],
        ['HANDLE_ADMIN_ID', cfg.admin_id],
        ['HANDLE_ADMIN_KEY_PATH', cfg.admin_key_path],
        ['HANDLE_CLIENT_LIB (or HANDLE_HELPER_CLASSPATH)', cfg.helper_classpath],
        ['HANDLE_TARGET', cfg.target],
        ['HANDLE_PREFIX', cfg.prefix],
        ['HANDLE_SERVER', cfg.server],
    ].filter(([, value]) => !value).map(([name]) => name);

    ok = report(missing.length === 0, 'required HANDLE_* vars present',
        missing.length ? `missing: ${missing.join(', ')}` : '') && ok;

    /*
     * A set HANDLE_CLIENT_LIB that yields no classpath means this checkout's
     * config/app.js predates the derived-classpath change and is still
     * looking for HANDLE_HELPER_CLASSPATH. Deploying .env and code out of
     * step is easy to do; say so rather than leaving it to be puzzled out.
     */
    if (process.env.HANDLE_CLIENT_LIB && !cfg.helper_classpath) {
        process.stdout.write(
            '\n        HANDLE_CLIENT_LIB is set but no classpath was derived from it.\n'
            + '        This copy of config/app.js is out of date — re-deploy the code,\n'
            + '        or set HANDLE_HELPER_CLASSPATH explicitly as a stopgap:\n'
            + `          <repov2>/java/duhandletool.jar:${process.env.HANDLE_CLIENT_LIB}/*\n`
        );
    }

    if (missing.length) {
        process.stdout.write('\nStopping: configuration incomplete.\n');
        return 1;
    }

    /*
     * Shape checks. These three mistakes are easy to make when adapting an
     * old .env (the retired service's endpoint carried a /api/v1/handles
     * path) or when copying .env-example without swapping the placeholder
     * prefix. Each produces a confusing downstream error — a path on
     * admin_url makes the server parse "api/sessions" as a handle name —
     * so name them here instead.
     */
    if (/\/api(\/|$)/.test(cfg.admin_url)) {
        ok = report(false, 'HANDLE_ADMIN_URL must be an origin only, with no path',
            `got "${cfg.admin_url}" — drop everything after the port`) && ok;
    }

    const admin_id_match = /^(\d+):0\.NA\/(.+)$/.exec(cfg.admin_id);
    if (!admin_id_match) {
        ok = report(false, 'HANDLE_ADMIN_ID should look like "<index>:0.NA/<prefix>"',
            `got "${cfg.admin_id}"`) && ok;
    } else if (admin_id_match[2] !== cfg.prefix) {
        ok = report(false, 'HANDLE_ADMIN_ID prefix does not match HANDLE_PREFIX',
            `admin_id names "${admin_id_match[2]}", HANDLE_PREFIX is "${cfg.prefix}"`) && ok;
    }

    if (!ok) {
        process.stdout.write('\nStopping: fix the configuration above first.\n');
        return 1;
    }

    /*
     * --- 2. the Java helper --------------------------------------------
     *
     * Writes go through DuHandleTool on the native protocol, because the
     * handle server serves no authentication over HTTP. Confirm the helper
     * is present and runnable before anything else — a missing classpath
     * or JVM is by far the most likely setup mistake.
     */
    process.stdout.write('Write helper (DuHandleTool)\n');
    process.stdout.write(`        java       ${cfg.java_bin}\n`);

    /*
     * Check the classpath entries exist before spawning. A missing jar or
     * lib directory otherwise surfaces as an opaque NoClassDefFoundError
     * from the JVM.
     */
    for (const entry of cfg.helper_classpath.split(path.delimiter)) {
        const target = entry.endsWith(`${path.sep}*`) ? path.dirname(entry) : entry;
        if (!fs.existsSync(target)) {
            ok = report(false, 'classpath entry does not exist', target) && ok;
        }
    }
    process.stdout.write('\n');

    /* --- 3. public resolution (no auth) -------------------------------- */
    process.stdout.write('Resolution (public read, no auth)\n');
    if (probe_uuid) {
        try {
            const found = await handles.get_handle(probe_uuid);
            if (found) {
                const url = (found.values || []).find((v) => v.type === 'URL');
                report(true, `resolved ${cfg.prefix}/${probe_uuid}`,
                    url ? `-> ${url.data.value}` : '(no URL value)');
            } else {
                ok = report(false, `${cfg.prefix}/${probe_uuid} does not exist`) && ok;
            }
        } catch (err) {
            ok = report(false, 'resolve failed', err.message) && ok;
        }
    } else {
        process.stdout.write('        skipped (pass --probe <uuid> to resolve a known handle)\n');
    }
    process.stdout.write('\n');

    /*
     * --- 4. authentication ---------------------------------------------
     *
     * The helper's "check" op resolves the admin handle with credentials
     * attached: it proves the key file, the passphrase, the admin identity
     * and the route to port 2641 in one round trip, and writes nothing.
     */
    process.stdout.write('Reachability (native protocol, port 2641)\n');
    let auth_ok = false;
    try {
        const result = await handle_writer.check();
        auth_ok = report(Boolean(result.ok),
            'key loads, prefix resolves, handle server reachable',
            result.ok ? '' : `responseCode ${result.responseCode}: ${result.message}`);
        ok = auth_ok && ok;
    } catch (err) {
        ok = report(false, 'helper could not run', err.message) && ok;
    }
    if (auth_ok) {
        process.stdout.write(
            '        NOTE: this does not prove the credential is ACCEPTED —\n'
            + '        the server answers not-found before authenticating, so no\n'
            + '        read-only probe can tell a good key from a bad one. Only\n'
            + '        --write below verifies that.\n'
        );
    }

    if (!auth_ok) {
        process.stdout.write(
            '\n        Check, in order: HANDLE_HELPER_CLASSPATH includes java/build and\n'
            + '        the handle client lib/*; the key at HANDLE_ADMIN_KEY_PATH is\n'
            + '        Handle binary format (admpriv.bin, NOT the PEM) and the\n'
            + '        passphrase decrypts it; HANDLE_ADMIN_ID names the index and\n'
            + '        handle holding the HS_PUBKEY (typically 300:0.NA/<prefix>);\n'
            + '        TCP 2641 on the handle server is reachable from this host.\n\n'
        );
        process.stdout.write('Write authority\n');
        process.stdout.write('        blocked — requires authentication\n\n');
        return 1;
    }
    process.stdout.write('\n');

    /* --- 5. write round trip (opt-in) ---------------------------------- */
    process.stdout.write('Write authority\n');
    if (!do_write) {
        process.stdout.write('        skipped (pass --write to mint and delete a scratch handle)\n\n');
        process.stdout.write(ok
            ? 'Pre-flight checks passed. Credential acceptance NOT yet verified —\n'
              + 'run again with --write to confirm it.\n'
            : 'Some checks failed.\n');
        return ok ? 0 : 1;
    }

    /*
     * A freshly generated uuid — no object references it, so the handle
     * is scratch by construction and the delete at the end is safe.
     */
    const scratch = crypto.randomUUID();
    let minted = false;
    try {
        const created = await handles.create_handle(scratch);
        minted = created.status === 201 && Boolean(created.handle);
        ok = report(minted, `minted scratch handle ${cfg.prefix}/${scratch}`,
            minted ? created.handle : `status ${created.status}`) && ok;

        if (minted) {
            const found = await handles.get_handle(scratch);
            const url = found && (found.values || []).find((v) => v.type === 'URL');
            ok = report(
                Boolean(url) && url.data.value === `${cfg.target}${scratch}`,
                'value landed with the configured target',
                url ? `-> ${url.data.value}` : '(no URL value returned)'
            ) && ok;
        }
    } catch (err) {
        ok = report(false, 'mint failed', err.message) && ok;
    } finally {
        if (minted) {
            try {
                const removed = await handles.delete_handle(scratch);
                ok = report(removed.deleted, 'scratch handle cleaned up',
                    removed.deleted ? '' : `status ${removed.status} — REMOVE MANUALLY: ${cfg.prefix}/${scratch}`) && ok;
            } catch (err) {
                ok = report(false, 'cleanup failed — remove manually',
                    `${cfg.prefix}/${scratch}: ${err.message}`) && ok;
            }
        }
    }

    process.stdout.write(`\n${ok ? 'All checks passed.' : 'Some checks failed.'}\n`);
    return ok ? 0 : 1;
}

if (require.main === module) {
    require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env') });
    main()
        .then((code) => process.exit(code))
        .catch((err) => {
            process.stderr.write(`\nUnexpected error: ${err.stack || err.message}\n`);
            process.exit(1);
        });
}

module.exports = { main };
