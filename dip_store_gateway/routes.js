'use strict';

/*
 * DIP store gateway routes, read by the public frontend's server.
 * HEAD is registered first, or Express would answer it with the GET
 * handler and download the whole file. No api_limiter(): every request
 * comes from one or two frontend IPs, so a per-IP limit would throttle
 * the whole site.
 */

const app_config = require('../config/app');
const { create_gateway } = require('./gateway');

module.exports = function mount(app) {
    const gateway = create_gateway();
    const route = `${app_config().path}/api/v2/dip-store/*key`;
    app.head(route, gateway.head);
    app.get(route, gateway.get);
};
