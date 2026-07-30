'use strict';

/*
 * Unit tests for libs/aspace_session — the shared ASpace session
 * holder + retrying fetch added after the 95-package burst incident
 * (2026-07-29). All timing is injected (sleep fake), no network.
 */

const {
    create_holder,
    holder_for,
    fetch_record_with_retry,
} = require('../../../libs/aspace_session');

function make_aspace({ tokens = ['tok-1', 'tok-2', 'tok-3'], responses = [] } = {}) {
    let token_i = 0;
    const calls = { logins: 0, gets: [] };
    return {
        calls,
        async get_session_token() {
            calls.logins++;
            return tokens[Math.min(token_i++, tokens.length - 1)];
        },
        async get_record(uri, token) {
            calls.gets.push({ uri, token });
            const next = responses.shift();
            if (next instanceof Error) throw next;
            return next || { status: 200, data: { title: 'T' } };
        },
    };
}

const no_sleep = async () => {};

describe('libs/aspace_session', () => {
    describe('create_holder', () => {
        it('mints once and reuses the token across calls', async () => {
            const aspace = make_aspace();
            const holder = create_holder(aspace);
            expect(await holder.get()).toBe('tok-1');
            expect(await holder.get()).toBe('tok-1');
            expect(aspace.calls.logins).toBe(1);
        });

        it('concurrent callers share ONE in-flight login (no login burst)', async () => {
            const aspace = make_aspace();
            const holder = create_holder(aspace);
            const tokens = await Promise.all([holder.get(), holder.get(), holder.get()]);
            expect(tokens).toEqual(['tok-1', 'tok-1', 'tok-1']);
            expect(aspace.calls.logins).toBe(1);
        });

        it('invalidate forces a fresh mint', async () => {
            const aspace = make_aspace();
            const holder = create_holder(aspace);
            await holder.get();
            holder.invalidate();
            expect(await holder.get()).toBe('tok-2');
            expect(aspace.calls.logins).toBe(2);
        });
    });

    describe('holder_for', () => {
        it('returns the same holder for the same client instance', async () => {
            const aspace = make_aspace();
            expect(holder_for(aspace)).toBe(holder_for(aspace));
            // Distinct clients get distinct holders.
            expect(holder_for(make_aspace())).not.toBe(holder_for(aspace));
        });
    });

    describe('fetch_record_with_retry', () => {
        it('returns definitive statuses immediately (no retry on 404)', async () => {
            const aspace = make_aspace({ responses: [{ status: 404, data: null }] });
            const res = await fetch_record_with_retry('/r/1', { aspace, sleep: no_sleep });
            expect(res.status).toBe(404);
            expect(aspace.calls.gets).toHaveLength(1);
        });

        it('refreshes the session once on 401 and re-fetches', async () => {
            const aspace = make_aspace({
                responses: [
                    { status: 401, data: null },
                    { status: 200, data: { title: 'ok' } },
                ],
            });
            const res = await fetch_record_with_retry('/r/2', { aspace, sleep: no_sleep });
            expect(res.status).toBe(200);
            expect(aspace.calls.logins).toBe(2); // initial mint + refresh
            expect(aspace.calls.gets[1].token).toBe('tok-2');
        });

        it('retries transport errors with backoff, then succeeds', async () => {
            const sleeps = [];
            const aspace = make_aspace({
                responses: [
                    new Error('ArchivesSpace fetch failed: read ECONNRESET'),
                    new Error('ArchivesSpace fetch failed: read ECONNRESET'),
                    { status: 200, data: { title: 'recovered' } },
                ],
            });
            const res = await fetch_record_with_retry('/r/3', {
                aspace,
                base_ms: 100,
                sleep: async (ms) => sleeps.push(ms),
            });
            expect(res.status).toBe(200);
            expect(res.data.title).toBe('recovered');
            expect(sleeps).toHaveLength(2);
            // Exponential shape with 0.5–1.5 jitter: 50–150, then 100–300.
            expect(sleeps[0]).toBeGreaterThanOrEqual(50);
            expect(sleeps[0]).toBeLessThanOrEqual(150);
            expect(sleeps[1]).toBeGreaterThanOrEqual(100);
            expect(sleeps[1]).toBeLessThanOrEqual(300);
        });

        it('retries 5xx responses and throws after attempts are exhausted', async () => {
            const aspace = make_aspace({
                responses: [
                    { status: 503, data: null },
                    { status: 503, data: null },
                    { status: 503, data: null },
                ],
            });
            await expect(
                fetch_record_with_retry('/r/4', { aspace, attempts: 3, sleep: no_sleep })
            ).rejects.toThrow(/HTTP 503/);
            expect(aspace.calls.gets).toHaveLength(3);
        });

        it('paces consecutive fetches by min_interval_ms (one request per interval)', async () => {
            const sleeps = [];
            const aspace = make_aspace({
                responses: [
                    { status: 200, data: { title: 'a' } },
                    { status: 200, data: { title: 'b' } },
                ],
            });
            const sleep = async (ms) => sleeps.push(ms);
            await fetch_record_with_retry('/p/1', { aspace, sleep, min_interval_ms: 5000 });
            await fetch_record_with_retry('/p/2', { aspace, sleep, min_interval_ms: 5000 });
            /*
             * The calls themselves are instant, so the second fetch
             * must wait out (nearly) the whole interval. The first
             * fetch never waits — pacing starts the clock, it doesn't
             * delay an idle pipeline.
             */
            expect(sleeps).toHaveLength(1);
            expect(sleeps[0]).toBeGreaterThan(4500);
            expect(sleeps[0]).toBeLessThanOrEqual(5000);
        });

        it('injected clients are unpaced by default (tests, special callers)', async () => {
            const sleeps = [];
            const aspace = make_aspace({
                responses: [
                    { status: 200, data: {} },
                    { status: 200, data: {} },
                ],
            });
            const sleep = async (ms) => sleeps.push(ms);
            await fetch_record_with_retry('/u/1', { aspace, sleep });
            await fetch_record_with_retry('/u/2', { aspace, sleep });
            expect(sleeps).toHaveLength(0);
        });

        it('throws the last transport error when every attempt fails', async () => {
            const aspace = make_aspace({
                responses: [
                    new Error('read ECONNRESET'),
                    new Error('read ECONNRESET'),
                    new Error('read ECONNRESET'),
                ],
            });
            await expect(
                fetch_record_with_retry('/r/5', { aspace, attempts: 3, sleep: no_sleep })
            ).rejects.toThrow(/ECONNRESET/);
            /*
             * Each transport failure invalidates the token, so every
             * attempt re-mints — proving a dead connection can't pin a
             * dead session.
             */
            expect(aspace.calls.logins).toBe(3);
        });
    });
});
