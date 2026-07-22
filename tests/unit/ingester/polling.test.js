'use strict';

const { poll, sleep_or_abort } = require('../../../ingester/lib/polling');
const { ValidationError } = require('../../../libs/errors');

describe('ingester/lib/polling — poll', () => {
    it('returns the value when check signals done on the first attempt', async () => {
        const check = async () => ({ done: true, value: 'first' });
        const outcome = await poll(check, { interval_ms: 10, timeout_ms: 1000 });
        expect(outcome.result).toBe('first');
        expect(outcome.attempts).toBe(1);
        expect(outcome.timed_out).toBe(false);
        expect(outcome.aborted).toBe(false);
    });

    it('keeps polling until done is true', async () => {
        let n = 0;
        const check = async () => {
            n += 1;
            return n >= 3 ? { done: true, value: n } : { done: false };
        };
        const outcome = await poll(check, { interval_ms: 5, timeout_ms: 1000 });
        expect(outcome.result).toBe(3);
        expect(outcome.attempts).toBe(3);
    });

    it('times out cleanly when check never resolves done', async () => {
        const check = async () => ({ done: false });
        const outcome = await poll(check, { interval_ms: 10, timeout_ms: 50 });
        expect(outcome.timed_out).toBe(true);
        expect(outcome.aborted).toBe(false);
        expect(outcome.result).toBeNull();
        expect(outcome.attempts).toBeGreaterThan(0);
    });

    it('respects an AbortSignal fired mid-poll', async () => {
        const controller = new AbortController();
        const check = async () => {
            /*
             * Fire the abort during the first probe so the next sleep
             * wakes immediately.
             */
            controller.abort();
            return { done: false };
        };
        const outcome = await poll(check, {
            interval_ms: 10_000, // would otherwise hang the test
            timeout_ms: 60_000,
            signal: controller.signal,
        });
        expect(outcome.aborted).toBe(true);
        expect(outcome.timed_out).toBe(false);
    });

    it('returns immediately if the signal is already aborted', async () => {
        const controller = new AbortController();
        controller.abort();
        const check = async () => ({ done: true, value: 'should not be returned' });
        const outcome = await poll(check, {
            interval_ms: 10,
            timeout_ms: 1000,
            signal: controller.signal,
        });
        expect(outcome.aborted).toBe(true);
        expect(outcome.attempts).toBe(0);
        expect(outcome.result).toBeNull();
    });

    it('throws thrown errors by default', async () => {
        const check = async () => {
            throw new Error('boom');
        };
        await expect(poll(check, { interval_ms: 5, timeout_ms: 50 })).rejects.toThrow('boom');
    });

    it('calls on_attempt(error) and continues polling when on_attempt returns true', async () => {
        let n = 0;
        const seen = [];
        const check = async () => {
            n += 1;
            if (n < 3) throw new Error(`err-${n}`);
            return { done: true, value: 'finally' };
        };
        const outcome = await poll(check, {
            interval_ms: 5,
            timeout_ms: 500,
            on_attempt: async ({ error }) => {
                seen.push(error.message);
                return true;
            },
        });
        expect(outcome.result).toBe('finally');
        expect(seen).toEqual(['err-1', 'err-2']);
    });

    it('rejects invalid inputs early', async () => {
        await expect(poll(null, { interval_ms: 5, timeout_ms: 100 })).rejects.toBeInstanceOf(
            ValidationError
        );
        await expect(
            poll(async () => ({ done: false }), { interval_ms: -1, timeout_ms: 100 })
        ).rejects.toBeInstanceOf(ValidationError);
        await expect(
            poll(async () => ({ done: false }), { interval_ms: 5, timeout_ms: 0 })
        ).rejects.toBeInstanceOf(ValidationError);
    });
});

describe('ingester/lib/polling — sleep_or_abort', () => {
    it('resolves after ms when no signal is given', async () => {
        const start = Date.now();
        await sleep_or_abort(30, null);
        const elapsed = Date.now() - start;
        expect(elapsed).toBeGreaterThanOrEqual(25);
    });

    it('resolves immediately when signal fires', async () => {
        const controller = new AbortController();
        const start = Date.now();
        const p = sleep_or_abort(10_000, controller.signal);
        controller.abort();
        await p;
        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(100);
    });

    it('resolves immediately when the signal is already aborted', async () => {
        const controller = new AbortController();
        controller.abort();
        const start = Date.now();
        await sleep_or_abort(10_000, controller.signal);
        expect(Date.now() - start).toBeLessThan(50);
    });
});
