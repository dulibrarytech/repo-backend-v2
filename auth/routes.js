'use strict';

const app_config = require('../config/app');
const { require_auth, optional_auth } = require('./middleware');
const { login_limiter } = require('./rate_limit');
const controller = require('./controller');

module.exports = function mount(app) {
    const cfg = app_config();
    const base = `${cfg.path}/auth`;

    // Public + rate-limited. login_limiter caps brute force.
    app.post(`${base}/login`, login_limiter(), controller.login);
    app.post(`${base}/refresh`, login_limiter(), controller.refresh);

    /*
     * optional_auth on logout — we still want to clear the cookie even
     * if the token's expired/missing. logout reads req.user when present.
     */
    app.post(`${base}/logout`, optional_auth, controller.logout);

    // me requires a valid session.
    app.get(`${base}/me`, require_auth, controller.me);

    /*
     * SSO endpoints (callback + start). Documented in auth/sso/ — has
     * its own routes module to keep the surface obvious.
     */
    require('./sso/routes')(app);
};
