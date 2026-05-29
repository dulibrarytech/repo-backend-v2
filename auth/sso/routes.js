'use strict';

const app_config = require('../../config/app');
const { login_limiter } = require('../rate_limit');
const { require_trusted_source } = require('./middleware');
const controller = require('./controller');

module.exports = function mount(app) {
    const cfg = app_config();
    const base = `${cfg.path}/auth/sso`;

    // GET — kick off the redirect to the upstream SSO server.
    // No auth, no rate limit — it's just a redirect.
    app.get(`${base}/start`, controller.sso_start);

    // POST — the SSO callback. This is the security-critical path:
    //   1. login_limiter caps brute force from a single source IP
    //   2. require_trusted_source enforces Layer 1 (IP allowlist)
    //   3. controller enforces Layers 2/3/0 + user lookup
    app.post(
        base,
        login_limiter({ limit: 20, windowMs: 60_000 }),
        require_trusted_source,
        controller.sso_callback
    );
};
