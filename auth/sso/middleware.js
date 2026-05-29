'use strict';

// Layer 1: source IP allowlist for the SSO callback.
//
// Compiles SSO_TRUSTED_IPS (IPs and/or CIDRs) into a node:net BlockList
// once at boot, then matches every incoming SSO request's req.ip
// against it. Empty allowlist disables the layer entirely (useful in
// dev). Production should always populate.
//
// req.ip comes from Express; trust-proxy must be configured correctly
// at the app level for this to reflect the real client. We set
// `trust proxy = 1` in production in config/express.js.

const { BlockList } = require('node:net');

const app_config = require('../../config/app');
const log = require('../../libs/log');
const { ForbiddenError } = require('../../libs/errors');

// Lazy, memoized.
let compiled = null;

function compile(trusted_ips) {
    const block = new BlockList();
    for (const entry of trusted_ips) {
        const trimmed = entry.trim();
        if (!trimmed) continue;
        try {
            if (trimmed.includes('/')) {
                const [addr, prefix] = trimmed.split('/');
                const family = addr.includes(':') ? 'ipv6' : 'ipv4';
                block.addSubnet(addr, Number.parseInt(prefix, 10), family);
            } else {
                const family = trimmed.includes(':') ? 'ipv6' : 'ipv4';
                block.addAddress(trimmed, family);
            }
        } catch (err) {
            // Don't fail boot on a single bad entry — log loudly and skip.
            log.error({
                event: 'sso_allowlist_bad_entry',
                entry: trimmed,
                err: err.message,
            });
        }
    }
    return block;
}

function get_block_list() {
    if (compiled === null) {
        const cfg = app_config();
        compiled = compile(cfg.sso.trusted_ips || []);
    }
    return compiled;
}

function ip_family(ip) {
    return ip && ip.includes(':') ? 'ipv6' : 'ipv4';
}

// Middleware: rejects requests whose source IP is not in the allowlist.
// If the allowlist is empty, the layer is disabled and every request
// passes through (still logged at debug level for auditability).
function require_trusted_source(req, _res, next) {
    const cfg = app_config();
    const allowlist = cfg.sso.trusted_ips || [];

    if (allowlist.length === 0) {
        log.debug({
            event: 'sso_layer1_disabled',
            request_id: req.id,
            ip: req.ip,
        });
        return next();
    }

    const block = get_block_list();
    const raw_ip = req.ip || '';
    // Express may give us IPv4-mapped IPv6 like "::ffff:127.0.0.1"; strip.
    const ip = raw_ip.replace(/^::ffff:/, '');
    if (!ip) {
        log.warn({ event: 'sso_layer1_no_ip', request_id: req.id });
        return next(new ForbiddenError('Source not trusted'));
    }

    let allowed = false;
    try {
        allowed = block.check(ip, ip_family(ip));
    } catch {
        allowed = false;
    }

    if (!allowed) {
        log.warn({
            event: 'sso_layer1_rejected',
            request_id: req.id,
            ip,
            allowlist_size: allowlist.length,
        });
        return next(new ForbiddenError('Source not trusted'));
    }

    return next();
}

// Test-only — recompile after env mutation.
function _reset() {
    compiled = null;
}

module.exports = {
    require_trusted_source,
    compile, // exported for unit tests
    _reset,
};
