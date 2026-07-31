#!/usr/bin/env node
'use strict';

/*
 * Verify the Handle.net admin credentials and the HS_PUBKEY session
 * handshake, without touching any real object's handle.
 *
 * libs/handle_auth implements the handshake from the Handle 9 technical
 * manual, but the signature step cannot be exercised from a unit test —
 * it needs the real private key and the real server. Run this once after
 * converting admpriv.bin, and again on the production host before the
 * first ingest that mints a handle.
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
    const handle_auth = require('../libs/handle_auth');

    const cfg = app_config().handles;
    let ok = true;

    process.stdout.write('\nHandle.net credential + handshake check\n\n');

    /* --- 1. configuration --------------------------------------------- */
    process.stdout.write('Configuration\n');
    ok = report(handles.is_configured(), 'required HANDLE_* vars present') && ok;
    process.stdout.write(`        admin_url  ${cfg.admin_url || '(unset)'}\n`);
    process.stdout.write(`        admin_id   ${cfg.admin_id || '(unset)'}\n`);
    process.stdout.write(`        key        ${cfg.admin_key_path || '(unset)'}\n`);
    process.stdout.write(`        target     ${cfg.target || '(unset)'}\n`);
    process.stdout.write(
        `        passphrase ${cfg.admin_passphrase ? '(set)' : '(none — PEM must be unencrypted)'}\n\n`
    );
    if (!handles.is_configured()) {
        process.stdout.write('Stopping: configuration incomplete.\n');
        return 1;
    }

    /*
     * --- 2. private key ------------------------------------------------
     *
     * A missing or undecryptable key is NOT fatal here. Everything up to
     * the handshake — config, network path, prefix, resolution — is worth
     * confirming on its own, and while the admin passphrase is being
     * recovered that is the only part testable at all.
     */
    let key_ok = false;
    process.stdout.write('Private key\n');
    try {
        const key = handle_auth.load_private_key();
        const alg = handle_auth.signature_algorithm(key);
        key_ok = report(true, `loaded and decrypted (${key.asymmetricKeyType.toUpperCase()})`,
            `signing with ${alg.node}`);
    } catch (err) {
        ok = report(false, 'could not load key', err.message) && ok;
        process.stdout.write(
            '\n        Convert Handle\'s binary key format to PKCS#8 PEM:\n'
            + '        hdl-convert-key -crypt admpriv.bin -format pem -o handle_admin.pem\n'
            + '        The passphrase is HANDLE_PASSPHRASE in the retired Python\n'
            + '        service\'s .env on libsftp01. Continuing with read-only checks.\n'
        );
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

    /* --- 4. the handshake --------------------------------------------- */
    process.stdout.write('Authentication (HS_PUBKEY session handshake)\n');
    if (!key_ok) {
        process.stdout.write('        blocked — no usable private key (see above)\n\n');
        process.stdout.write('Write authority\n');
        process.stdout.write('        blocked — requires authentication\n\n');
        process.stdout.write(
            'Read-only checks complete. Authentication cannot be verified until the\n'
            + 'admin key is recoverable or replaced.\n'
        );
        return 1;
    }
    try {
        handle_auth.reset_session();
        const session_id = await handle_auth.authenticate();
        report(true, 'authenticated as prefix administrator',
            `sessionId ${String(session_id).slice(0, 12)}…`);
    } catch (err) {
        ok = report(false, 'handshake rejected', err.message) && ok;
        process.stdout.write(
            '\n        Check, in order: the passphrase decrypts the key; HANDLE_ADMIN_ID\n'
            + '        matches the index and handle holding the HS_PUBKEY (typically\n'
            + '        300:0.NA/<prefix>); the admin_url host is reachable and its\n'
            + '        HS_SITE record advertises admin=true for that port.\n'
        );
        return 1;
    }
    process.stdout.write('\n');

    /* --- 5. write round trip (opt-in) ---------------------------------- */
    process.stdout.write('Write authority\n');
    if (!do_write) {
        process.stdout.write('        skipped (pass --write to mint and delete a scratch handle)\n\n');
        process.stdout.write(ok ? 'All checks passed.\n' : 'Some checks failed.\n');
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
