'use strict';

// Render the services_banner partial directly with ejs and inspect the HTML.
// Two branches matter: it renders NOTHING when no service is degraded (so the
// hx-swap="outerHTML" mount vanishes and no banner shows), and it renders a
// dismissible, CSP-safe alert naming the affected services + their user-facing
// capability when some are down. The probe/filtering logic lives in
// ingester/dashboard.js (services_banner_partial); this pins the view contract.

const path = require('node:path');
const ejs = require('ejs');

const PARTIAL = path.resolve(
    __dirname,
    '../../../views/dashboard/partials/services_banner.ejs'
);

describe('services_banner partial', () => {
    it('renders nothing when no services are degraded', async () => {
        const html = await ejs.renderFile(PARTIAL, {
            degraded: [],
            dashboard_base: '/repo/dashboard',
        });
        expect(html.trim()).toBe('');
    });

    it('renders a dismissible alert listing degraded services + capabilities', async () => {
        const html = await ejs.renderFile(PARTIAL, {
            degraded: [
                { label: 'Elasticsearch', capability: 'search & browse' },
                { label: 'ArchivesSpace', capability: 'metadata sync' },
            ],
            dashboard_base: '/repo/dashboard',
        });
        expect(html).toMatch(/alert-warning/);
        expect(html).toContain('Elasticsearch');
        expect(html).toContain('search &amp; browse'); // EJS-escaped
        expect(html).toContain('ArchivesSpace');
        expect(html).toContain('metadata sync');
        // Dismissible via Bootstrap (no inline JS), links to the full page.
        expect(html).toContain('data-bs-dismiss="alert"');
        expect(html).toContain('/repo/dashboard/admin/services');
        // CSP: never an inline <script>.
        expect(html).not.toMatch(/<script\b/i);
    });

    it('omits the parenthetical when a service has no capability label', async () => {
        const html = await ejs.renderFile(PARTIAL, {
            degraded: [{ label: 'Curation API', capability: '' }],
            dashboard_base: '/repo/dashboard',
        });
        expect(html).toContain('Curation API');
        expect(html).not.toContain('Curation API (');
    });
});
