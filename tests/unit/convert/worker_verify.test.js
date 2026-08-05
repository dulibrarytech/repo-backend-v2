'use strict';

/*
 * Unit tests for the convert worker's deferred verification flow. The
 * service ACKs 202 before converting (fire-and-forget), so a row is
 * only COMPLETE once GET /image confirms a real derivative on the NEXT
 * tick — libspec02's full disk shipped 0-byte JPGs while every row
 * read "OK" (repo/REPOV2_DISPLAY_RECORD_FINDINGS.md §8).
 *
 * The worker is driven tick-by-tick with a fake client + stubbed model.
 * describe / it / expect / vi are vitest globals (see vitest.config.js).
 */

const model = require('../../../convert/model');
const { create_worker } = require('../../../convert/worker');
const { UpstreamError } = require('../../../libs/errors');

function make_row(id, name = `thing-${id}.tif`) {
    return { id, object_name: name, sip_uuid: `sip-${id}`, file_name: `d/objects/${name}` };
}

/*
 * Fake convert client: scripted queues of convert + verify results. A
 * verify entry may be a verdict object or an Error to throw.
 */
function make_client({ converts = [], verifies = [] } = {}) {
    return {
        is_configured: () => true,
        convert: vi.fn(async () => {
            if (converts.length === 0) return { status: 202, body: { ack: true } };
            return converts.shift();
        }),
        verify_image: vi.fn(async () => {
            if (verifies.length === 0) return { outcome: 'ok', bytes: 1234 };
            const v = verifies.shift();
            if (v instanceof Error) throw v;
            return v;
        }),
    };
}

describe('convert/worker — deferred verification', () => {
    let claim_queue;
    let completed;
    let failed;
    let released;

    beforeEach(() => {
        process.env.TOKEN_SECRET = process.env.TOKEN_SECRET || 'x';
        claim_queue = [];
        completed = [];
        failed = [];
        released = [];
        vi.spyOn(model, 'claim_one').mockImplementation(async () => claim_queue.shift() || null);
        vi.spyOn(model, 'mark_complete').mockImplementation(async (id, extra) => {
            completed.push({ id, ...extra });
        });
        vi.spyOn(model, 'mark_failed').mockImplementation(async (row, extra) => {
            failed.push({ id: row.id, ...extra });
            return { terminal: false, attempts: 1 };
        });
        vi.spyOn(model, 'release').mockImplementation(async (id) => {
            released.push(id);
        });
        vi.spyOn(model, 'build_payload');
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('does not complete a row on ACK; completes on next-tick verify with bytes', async () => {
        const client = make_client({ verifies: [{ outcome: 'ok', bytes: 2048 }] });
        const worker = create_worker({ client });
        claim_queue.push(make_row(1));

        expect(await worker.tick()).toBe(true); // POST + ACK
        expect(completed).toHaveLength(0);
        expect(client.verify_image).not.toHaveBeenCalled();

        expect(await worker.tick()).toBe(true); // verify settles it
        expect(client.verify_image).toHaveBeenCalledWith('thing-1.jpg', expect.anything());
        expect(completed).toHaveLength(1);
        expect(completed[0].id).toBe(1);
        expect(completed[0].body.verified_bytes).toBe(2048);
        expect(failed).toHaveLength(0);
    });

    it('fails an EMPTY derivative with a disk-space hint (the ENOSPC signature)', async () => {
        const client = make_client({ verifies: [{ outcome: 'empty' }] });
        const worker = create_worker({ client });
        claim_queue.push(make_row(2));

        await worker.tick();
        await worker.tick();
        expect(completed).toHaveLength(0);
        expect(failed).toHaveLength(1);
        expect(failed[0].error).toMatch(/EMPTY/);
        expect(failed[0].error).toMatch(/disk space/i);
    });

    it('retries a MISSING derivative across ticks, then fails at the check cap', async () => {
        const client = make_client({
            verifies: [{ outcome: 'missing' }, { outcome: 'missing' }, { outcome: 'missing' }],
        });
        const worker = create_worker({ client });
        claim_queue.push(make_row(3));

        await worker.tick(); // POST
        await worker.tick(); // check 1 — missing, keep waiting
        await worker.tick(); // check 2 — missing
        expect(failed).toHaveLength(0);
        await worker.tick(); // check 3 — missing → cap (default 3) → fail
        expect(failed).toHaveLength(1);
        expect(failed[0].error).toMatch(/missing after 3 checks/);
    });

    it('a slow conversion that lands by the second check still completes', async () => {
        const client = make_client({
            verifies: [{ outcome: 'missing' }, { outcome: 'ok', bytes: 99 }],
        });
        const worker = create_worker({ client });
        claim_queue.push(make_row(4));

        await worker.tick(); // POST
        await worker.tick(); // missing — wait
        await worker.tick(); // ok
        expect(failed).toHaveLength(0);
        expect(completed).toHaveLength(1);
        expect(completed[0].body.verified_bytes).toBe(99);
    });

    it('falls back to unverified completion when the endpoint is unavailable', async () => {
        const client = make_client({ verifies: [{ outcome: 'unavailable' }] });
        const worker = create_worker({ client });
        claim_queue.push(make_row(5));

        await worker.tick();
        await worker.tick();
        expect(completed).toHaveLength(1);
        expect(completed[0].body.verified_bytes).toBeUndefined();
        expect(failed).toHaveLength(0);
    });

    it('transport failures retry then fail as unreachable', async () => {
        const client = make_client({
            verifies: [
                new UpstreamError('down'),
                new UpstreamError('down'),
                new UpstreamError('down'),
            ],
        });
        const worker = create_worker({ client });
        claim_queue.push(make_row(6));

        await worker.tick();
        await worker.tick();
        await worker.tick();
        expect(failed).toHaveLength(0);
        await worker.tick();
        expect(failed).toHaveLength(1);
        expect(failed[0].error).toMatch(/unreachable/);
    });

    it('verifies the previous row and POSTs the next in the same tick', async () => {
        const client = make_client({ verifies: [{ outcome: 'ok', bytes: 7 }] });
        const worker = create_worker({ client });
        claim_queue.push(make_row(7), make_row(8));

        await worker.tick(); // POST row 7
        await worker.tick(); // verify 7 + POST 8
        expect(completed.map((c) => c.id)).toEqual([7]);
        expect(client.convert).toHaveBeenCalledTimes(2);
        await worker.tick(); // verify 8
        expect(completed.map((c) => c.id)).toEqual([7, 8]);
    });

    it('an idle queue still settles a pending verification', async () => {
        const client = make_client({ verifies: [{ outcome: 'ok', bytes: 11 }] });
        const worker = create_worker({ client });
        claim_queue.push(make_row(9));

        await worker.tick(); // POST — queue now empty
        const did_work = await worker.tick(); // nothing to claim, but verify runs
        expect(did_work).toBe(true);
        expect(completed).toHaveLength(1);
    });

    it('CONVERT_VERIFY_ENABLED=false restores the old ACK-completes behavior', async () => {
        const saved = process.env.CONVERT_VERIFY_ENABLED;
        process.env.CONVERT_VERIFY_ENABLED = 'false';
        const app_config = require('../../../config/app');
        app_config._reset();
        try {
            const client = make_client();
            const worker = create_worker({ client });
            claim_queue.push(make_row(10));
            await worker.tick();
            expect(completed).toHaveLength(1);
            expect(client.verify_image).not.toHaveBeenCalled();
        } finally {
            if (saved === undefined) delete process.env.CONVERT_VERIFY_ENABLED;
            else process.env.CONVERT_VERIFY_ENABLED = saved;
            app_config._reset();
        }
    });
});
