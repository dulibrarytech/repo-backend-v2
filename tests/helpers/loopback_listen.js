'use strict';

const net = require('node:net');

const LOOPBACK = '127.0.0.1';
const IPV4 = 4;

function left_to_the_system(address, port, fd) {
    return !address && port === 0 && typeof fd !== 'number';
}

function install() {
    const listen = net.Server.prototype._listen2;
    if (typeof listen !== 'function' || listen.binds_loopback) return;

    function listen_on_loopback(address, port, address_type, ...rest) {
        const [, fd] = rest;
        return left_to_the_system(address, port, fd)
            ? listen.call(this, LOOPBACK, port, IPV4, ...rest)
            : listen.call(this, address, port, address_type, ...rest);
    }
    listen_on_loopback.binds_loopback = true;
    net.Server.prototype._listen2 = listen_on_loopback;
}

module.exports = { LOOPBACK, left_to_the_system, install };
