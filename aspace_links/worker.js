'use strict';

const app_config = require('../config/app');
const log = require('../libs/log');
const aspace_default = require('../libs/archivesspace');
const aspace_session = require('../libs/aspace_session');
const model_default = require('./model');
const sync = require('./sync');

const BUSY_DELAY_MS = 1000;
const POLL_MS = 60000;
const MAX_BATCH_SIZE = 250;

function create_worker({ aspace = aspace_default, model = model_default, request } = {}) {
    let running = false;
    let stopping = false;
    let timer = null;
    let in_flight = Promise.resolve();

    const send =
        request || ((call, label) => aspace_session.request_with_retry(call, { aspace, label }));

    async function tick_once() {
        if (stopping) return 'idle';
        const cfg = app_config();
        const prefix = String(cfg.handles.prefix || '').replace(/^\/+|\/+$/g, '');
        if (!aspace.is_configured() || !prefix) return 'idle';

        const claimed = await model.claim(Math.min(cfg.aspace_links.batch_size, MAX_BATCH_SIZE));
        if (claimed.length === 0) return 'idle';

        try {
            const built = sync.build_targets(await model.load_object_rows());
            const targets = new Map(built.targets.map((target) => [target.uri, target]));
            const row_of = new Map(claimed.map((row) => [row.uri, row]));
            const options = {
                prefix,
                publish: false,
                execute: cfg.archivespace.writes_enabled,
            };
            const { outcomes, halted } = await sync.sync_targets(
                claimed.filter((row) => targets.has(row.uri)).map((row) => targets.get(row.uri)),
                options,
                { aspace, request: send }
            );

            const gone = claimed.filter((row) => !targets.has(row.uri)).map((row) => row.id);
            const states = {};
            for (const { target, result } of outcomes) {
                const row = row_of.get(target.uri);
                if (!result) {
                    gone.push(row.id);
                    continue;
                }
                await model.record(row, result);
                states[result.state] = (states[result.state] || 0) + 1;
            }
            await model.remove(gone);
            const summary = {
                event: 'aspace_links_batch',
                checked: outcomes.length,
                removed: gone.length,
                states,
            };
            if (!halted) {
                log.info(summary);
                return 'worked';
            }
            await model.defer(claimed, halted);
            log.warn({ ...summary, halted });
            return 'failed';
        } catch (err) {
            await model.defer(claimed, err.message).catch(() => {});
            log.warn({
                event: 'aspace_links_batch_failed',
                rows: claimed.length,
                err: err.message,
            });
            return 'failed';
        }
    }

    function schedule(ms) {
        timer = setTimeout(run, ms);
        if (timer.unref) timer.unref();
    }

    async function run() {
        if (stopping) return;
        in_flight = tick_once();
        let outcome = 'idle';
        try {
            outcome = await in_flight;
        } catch (err) {
            log.error({ event: 'aspace_links_tick_error', err: err.message });
        }
        if (stopping) return;
        schedule(outcome === 'worked' ? BUSY_DELAY_MS : POLL_MS);
    }

    async function start() {
        if (running) return;
        const cfg = app_config();
        if (!cfg.aspace_links.enabled) {
            log.info({
                event: 'aspace_links_worker_disabled',
                reason: 'ASPACE_LINKS_WORKER_ENABLED=false',
            });
            return;
        }
        running = true;
        stopping = false;
        log.info({
            event: 'aspace_links_worker_started',
            poll_ms: POLL_MS,
            batch_size: cfg.aspace_links.batch_size,
            writes_enabled: cfg.archivespace.writes_enabled,
        });
        schedule(0);
    }

    async function stop({ timeout_ms = 8000 } = {}) {
        if (!running) return;
        stopping = true;
        if (timer) clearTimeout(timer);
        timer = null;
        await Promise.race([
            in_flight.catch(() => {}),
            new Promise((resolve) => setTimeout(resolve, timeout_ms)),
        ]);
        running = false;
        log.info({ event: 'aspace_links_worker_stopped' });
    }

    return { start, stop, tick: tick_once, _is_running: () => running };
}

module.exports = { create_worker };
