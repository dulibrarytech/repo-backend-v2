'use strict';

// Render the workspace_action_result partial directly with ejs and
// inspect the resulting HTML. The previous implementation injected
// an inline <script> tag for the deferred redirect; our CSP
// (script-src 'self' only) blocks that, leaving the
// redirect silently broken. This test pins the CSP-safe pattern:
// no inline scripts under any rendering path, and a
// .workspace-deferred-redirect sentinel <div> when a redirect is
// requested so dashboard.js section 10 can pick it up.

const path = require('node:path');
const ejs = require('ejs');

const PARTIAL = path.resolve(
    __dirname,
    '../../../views/dashboard/partials/workspace_action_result.ejs'
);

function render(locals) {
    return ejs.renderFile(PARTIAL, locals, { async: false });
}

describe('workspace_action_result partial — CSP-safe deferred redirect', () => {
    it('never emits an inline <script> tag (CSP forbids inline scripts)', async () => {
        // Cover both the success-with-redirect AND the bare-success
        // paths — the inline <script> only ever rode the success
        // branch, so that's where regressions land.
        const variants = [
            // Success + redirect — the path that ALWAYS used to emit
            // <script>.
            {
                ok: true,
                action: 'Submit to Ingest',
                folder: 'col-x',
                message: 'queued',
                redirect_to: '/repo/dashboard/ingest',
                redirect_delay_ms: 2000,
            },
            // Success no redirect.
            {
                ok: true,
                action: 'Submit to Ingest',
                folder: 'col-x',
                message: 'done',
            },
            // Failure (no redirect path).
            {
                ok: false,
                action: 'Submit to Ingest',
                folder: 'col-x',
                message: 'failed',
                errors: ['bad'],
            },
        ];
        for (const locals of variants) {
            const html = await render(locals);
            expect(html).not.toMatch(/<script\b/i);
        }
    });

    it('drops a .workspace-deferred-redirect sentinel when ok && redirect_to', async () => {
        const html = await render({
            ok: true,
            action: 'Submit to Ingest',
            folder: 'col-x',
            message: 'queued',
            redirect_to: '/repo/dashboard/ingest',
            redirect_delay_ms: 1500,
        });
        // Sentinel present with the right data-* attrs.
        expect(html).toMatch(
            /<div[^>]*class="workspace-deferred-redirect"[^>]*data-redirect-target="\/repo\/dashboard\/ingest"[^>]*data-redirect-delay="1500"/
        );
        // hidden attribute keeps it invisible.
        expect(html).toMatch(/class="workspace-deferred-redirect"[^>]*hidden/);
    });

    it('skips the sentinel when ok && !redirect_to', async () => {
        const html = await render({
            ok: true,
            action: 'Submit to Ingest',
            folder: 'col-x',
            message: 'done',
        });
        expect(html).not.toMatch(/workspace-deferred-redirect/);
    });

    it('skips the sentinel when !ok (even if redirect_to is set)', async () => {
        // Defense-in-depth: the partial gate `ok && redirect_to`
        // already excludes this combo, but tests pin both halves
        // so a future edit can't accidentally redirect on failures.
        const html = await render({
            ok: false,
            action: 'Submit to Ingest',
            folder: 'col-x',
            message: 'failed',
            errors: ['bad'],
            redirect_to: '/repo/dashboard/ingest',
        });
        expect(html).not.toMatch(/workspace-deferred-redirect/);
    });
});
