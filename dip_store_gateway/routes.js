'use strict';

/*
 * DIP store gateway routes (plan P2). The caller is the public frontend's
 * server, which reads DIP files here instead of from DuraCloud.
 *
 * HEAD has its own handler, registered first: Express would otherwise run
 * the GET handler for a HEAD and download the whole file to answer it.
 * No api_limiter(): every frontend request arrives from one or two server
 * IPs, so a per-IP limit would throttle the whole site.
 */

const app_config = require('../config/app');
const { create_gateway } = require('./gateway');

module.exports = function mount(app) {
    const gateway = create_gateway();
    const route = `${app_config().path}/api/v2/dip-store/*key`;
    app.head(route, gateway.head);
    app.get(route, gateway.get);
};
