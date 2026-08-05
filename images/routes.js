'use strict';

/*
 * Public derivative-image gateway routes. Consumers: the digitaldu
 * frontend's datastream (tif → remote) and the Cantaloupe delegate's
 * HttpSource. Api-key gated in the controller (IMAGES_API_KEY — no JWT:
 * the callers are servers, and JWTs must not appear in URLs), with the
 * public API's per-IP rate limiter as the outer backstop.
 */

const app_config = require('../config/app');
const { api_limiter } = require('../auth/rate_limit');
const { create_gateway } = require('./gateway');

module.exports = function mount(app) {
    const cfg = app_config();
    const gateway = create_gateway();
    const base = `${cfg.path}/api/v2`;

    app.get(`${base}/image/:filename`, api_limiter(), gateway.serve_image);
};
