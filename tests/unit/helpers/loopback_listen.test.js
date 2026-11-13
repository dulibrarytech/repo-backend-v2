'use strict';

const http = require('node:http');
const net = require('node:net');
const supertest = require('supertest');
const { LOOPBACK, left_to_the_system, install } = require('../../helpers/loopback_listen');

const close = (server) => new Promise((resolve) => server.close(resolve));

function bound_address_of_each_request() {
    const bound = [];
    const app = (req, res) => {
        bound.push(req.socket.server.address().address);
        res.end('ok');
    };
    return { app, bound };
}

describe('tests/helpers/loopback_listen', () => {
    it('is installed by the test setup', () => {
        expect(net.Server.prototype._listen2.binds_loopback).toBe(true);
    });

    it('binds a server that names no address and no port to 127.0.0.1, at once', async () => {
        const server = http.createServer().listen(0);
        try {
            expect(server.address()).toMatchObject({ address: LOOPBACK, family: 'IPv4' });
            expect(server.address().port).toBeGreaterThan(0);
        } finally {
            await close(server);
        }
    });

    it('is what supertest sends its requests through', async () => {
        const { app, bound } = bound_address_of_each_request();
        const res = await supertest(app).post('/any').send({});
        expect(res.text).toBe('ok');
        expect(bound).toEqual([LOOPBACK]);
    });

    it('covers supertest agents too', async () => {
        const { app, bound } = bound_address_of_each_request();
        const agent = supertest.agent(app);
        await agent.get('/one');
        await agent.get('/two');
        expect(bound).toEqual([LOOPBACK, LOOPBACK]);
    });

    it('is installed once, however often it is asked for', () => {
        const installed = net.Server.prototype._listen2;
        install();
        install();
        expect(net.Server.prototype._listen2).toBe(installed);
    });

    it.each([
        [null, 0, undefined, true],
        [undefined, 0, undefined, true],
        ['127.0.0.1', 0, undefined, false],
        ['::', 0, undefined, false],
        [null, 8765, undefined, false],
        [null, -1, undefined, false],
        [null, 0, 3, false],
        ['/tmp/app.sock', -1, undefined, false],
    ])('left_to_the_system(%j, %j, %j) is %j', (address, port, fd, expected) => {
        expect(left_to_the_system(address, port, fd)).toBe(expected);
    });
});
