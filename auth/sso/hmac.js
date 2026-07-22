'use strict';

/*
 * Layer 3: HMAC-SHA256 signature verification.
 * 
 * The upstream proxy computes:
 *     signature = hex( HMAC-SHA256(employeeID + '|' + timestamp + '|' + nonce, secret) )
 * and includes it in the POST body. Backend recomputes locally and
 * compares via constant-time equality.
 * 
 * Two-secret rollover: if SSO_HMAC_SECRET_NEXT is also configured,
 * either secret produces a valid signature. Set the new secret as
 * "next", deploy, then promote it to "current" once upstream is
 * signing with it. Removes downtime from rotation.
 */

const { createHmac, timingSafeEqual } = require('node:crypto');

const { UnauthorizedError, ValidationError } = require('../../libs/errors');

const ALGO = 'sha256';
const DIGEST = 'hex';
// SHA-256 hex digest = 64 chars.
const EXPECTED_HEX_LEN = 64;

/**
 * Compute the canonical signature for a payload.
 *
 * @param {string} employee_id
 * @param {string|number} timestamp
 * @param {string} nonce
 * @param {string} secret
 * @returns {string} hex-encoded signature
 */
function sign(employee_id, timestamp, nonce, secret) {
    if (!secret) throw new Error('hmac.sign: secret is required');
    const message = `${employee_id}|${timestamp}|${nonce}`;
    return createHmac(ALGO, secret).update(message).digest(DIGEST);
}

/**
 * Verify a signature against one or more candidate secrets.
 * Returns silently on success. Throws on any failure.
 *
 * @param {object} body                   the POST body
 * @param {string[]} secrets              non-empty list of secrets to try
 * @throws ValidationError                if signature shape is invalid
 * @throws UnauthorizedError              if signature does not match
 */
function verify(body, secrets) {
    if (!Array.isArray(secrets) || secrets.length === 0) {
        throw new Error('hmac.verify: at least one secret is required');
    }
    if (
        !body ||
        typeof body.signature !== 'string' ||
        body.signature.length !== EXPECTED_HEX_LEN ||
        !/^[0-9a-f]+$/i.test(body.signature)
    ) {
        throw new ValidationError('Missing or malformed signature');
    }
    if (body.employeeID === undefined || body.timestamp === undefined || body.nonce === undefined) {
        throw new ValidationError('Cannot verify signature without employeeID, timestamp, nonce');
    }

    const provided = Buffer.from(body.signature.toLowerCase(), 'hex');
    if (provided.length !== 32) {
        throw new ValidationError('Signature is not a 256-bit digest');
    }

    for (const secret of secrets) {
        if (!secret) continue;
        const expected = Buffer.from(
            sign(String(body.employeeID), String(body.timestamp), String(body.nonce), secret),
            'hex'
        );
        /*
         * timingSafeEqual requires equal-length buffers; provided is
         * already guaranteed 32 bytes.
         */
        if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
            return true;
        }
    }
    throw new UnauthorizedError('Invalid signature');
}

module.exports = { sign, verify };
