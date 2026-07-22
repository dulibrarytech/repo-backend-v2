'use strict';

const { randomUUID } = require('node:crypto');

/*
 * Express middleware: attach a stable request id to every request.
 * 
 * Honors an inbound `X-Request-Id` header if present (so upstream load
 * balancers / API gateways can propagate trace IDs); otherwise mints a
 * fresh UUID v4. The same id is echoed in the response so clients and
 * log aggregators can correlate.
 */

module.exports = function request_id(req, res, next) {
    const inbound = req.get('x-request-id');
    const id = inbound && inbound.length > 0 && inbound.length <= 128 ? inbound : randomUUID();
    req.id = id;
    res.set('x-request-id', id);
    next();
};
