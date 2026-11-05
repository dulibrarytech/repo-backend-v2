'use strict';

// Unit tests for the kaltura/service SDK client: HTTPS by default, nothing secret on the console.

const http = require('node:http');

const service = require('../../../kaltura/service');
const app_config = require('../../../config/app');

const SECRET = 'test-admin-secret';
const SESSION_TOKEN = 'TEST_SESSION_TOKEN';

function start_fake_kaltura(requests) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let raw = '';
            req.on('data', (chunk) => {
                raw += chunk;
            });
            req.on('end', () => {
                requests.push({ url: req.url, body: JSON.parse(raw) });
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify(SESSION_TOKEN));
            });
        });
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

describe('kaltura/service — SDK client', () => {
    let original_env;
    let server;
    let requests;
    let console_spies;

    beforeEach(async () => {
        original_env = { ...process.env };
        requests = [];
        server = await start_fake_kaltura(requests);
        process.env.KALTURA_PARTNER_ID = '12345';
        process.env.KALTURA_USER_ID = 'admin';
        process.env.KALTURA_SECRET_KEY = SECRET;
        process.env.KALTURA_SERVICE_URL = `http://127.0.0.1:${server.address().port}`;
        app_config._reset();
        console_spies = ['log', 'info', 'warn', 'error', 'debug'].map((method) =>
            vi.spyOn(console, method).mockImplementation(() => {})
        );
    });

    afterEach(async () => {
        console_spies.forEach((spy) => spy.mockRestore());
        process.env = original_env;
        app_config._reset();
        await new Promise((resolve) => server.close(resolve));
    });

    it('defaults to the HTTPS service URL', () => {
        delete process.env.KALTURA_SERVICE_URL;
        app_config._reset();

        expect(app_config().kaltura.service_url).toBe('https://www.kaltura.com');
    });

    it('sends requests to the configured service URL', async () => {
        const ks = await service.start_session();

        expect(ks).toBe(SESSION_TOKEN);
        expect(requests).toHaveLength(1);
        expect(requests[0].url).toBe('/api_v3/service/session/action/start');
    });

    it('keeps the secret and session token off the console', async () => {
        await service.start_session();

        expect(requests[0].body.secret).toBe(SECRET);
        const printed = console_spies
            .flatMap((spy) => spy.mock.calls)
            .flat()
            .join('\n');
        expect(printed).not.toContain(SECRET);
        expect(printed).not.toContain(SESSION_TOKEN);
    });
});
