'use strict';

const link = require('../libs/aspace_link');

const RECORD_URI = /^\/repositories\/(\d+)\/(archival_objects|resources)\/(\d+)$/;
const DIGITAL_OBJECT_URI = /^(\/repositories\/\d+\/digital_objects)\/(\d+)$/;
const MAX_FAILURES_IN_A_ROW = 5;
const MAX_REPLANS = 3;
const ATTENTION_STATES = Object.freeze([
    'failed',
    'contested',
    'needs_review',
    'record_not_found',
    'invalid_handle',
]);
const LINKED_STATES = Object.freeze([
    'in_sync',
    'updated',
    'unpublished_link',
    'link_removed',
    'orphan_link',
]);

function record_uri(value) {
    const uri = typeof value === 'string' ? value.trim() : '';
    return RECORD_URI.test(uri) ? uri : null;
}

function build_targets(rows) {
    const targets = new Map();
    const invalid = [];
    for (const row of rows) {
        const uri = record_uri(row.uri);
        if (!uri) {
            if (row.is_active === 1) invalid.push(row);
            continue;
        }
        if (!targets.has(uri)) {
            const match = RECORD_URI.exec(uri);
            targets.set(uri, {
                uri,
                listing: `/repositories/${match[1]}/${match[2]}`,
                id: Number(match[3]),
                live: [],
                deleted: [],
            });
        }
        targets.get(uri)[row.is_active === 1 ? 'live' : 'deleted'].push(row);
    }
    return { targets: [...targets.values()], invalid };
}

async function load_targets(uris, loaders) {
    const by_uri = (rows) =>
        new Map(build_targets(rows).targets.map((target) => [target.uri, target]));
    let found = by_uri(await loaders.load_rows_for(uris));
    if (!uris.every((uri) => found.has(uri))) found = by_uri(await loaders.load_rows());
    if (loaders.linked_handles) {
        for (const [uri, handle] of await loaders.linked_handles(uris)) {
            if (found.has(uri)) found.get(uri).linked = handle;
        }
    }
    return found;
}

function own_handle(row, options) {
    return link.handle_id(row.handle) === `${options.prefix}/${row.pid}`.toLowerCase();
}

function kept_link(target) {
    const id = link.handle_id(target.linked);
    return Boolean(id) && target.live.some((row) => link.handle_id(row.handle) === id);
}

function base_of(target) {
    const base = { uri: target.uri, pids: target.live.map((row) => row.pid) };
    return kept_link(target) ? { ...base, linked: target.linked } : base;
}

function digital_object_refs_for(target, record) {
    if (!record || target.live.length !== 1 || kept_link(target)) return [];
    const row = target.live[0];
    if (row.object_type === 'collection') return [];
    if (link.plan_link(record, row.handle).action !== 'add') return [];
    return link.digital_object_refs(record);
}

function assess(target, record, digital_objects, options) {
    const base = base_of(target);
    const done = (state, extra = {}) => ({ result: { ...base, state, ...extra }, changes: [] });

    if (target.live.length > 1) return done('contested');

    if (target.live.length === 0) {
        const deleted = new Map(target.deleted.map((row) => [link.handle_id(row.handle), row.pid]));
        const orphan = record
            ? link.linked_handle_ids(record).find((id) => deleted.has(id))
            : undefined;
        return orphan ? done('orphan_link', { pids: [deleted.get(orphan)] }) : null;
    }

    const row = target.live[0];
    if (!own_handle(row, options)) return done('invalid_handle');
    if (!record) return done('record_not_found');

    const plan_link = (source) => link.plan_link(source, row.handle);
    const planned = plan_link(record);
    if (planned.action === 'ambiguous') {
        return done('needs_review', { note: 'The record has more than one repository link.' });
    }
    const detail = { handle: row.handle, link: planned.action };
    if (planned.action === 'other_link') {
        return done('needs_review', {
            ...detail,
            link_previous: planned.previous,
            note:
                `The record already links to ${planned.previous}. To replace it, remove ` +
                'that link in ArchivesSpace, then use Check these again.',
        });
    }
    if (planned.action === 'none') return done('in_sync', detail);
    if (planned.action === 'unpublished') return done('unpublished_link', detail);
    if (base.linked) return done('link_removed', detail);

    const refs = row.object_type === 'collection' ? [] : link.digital_object_refs(record);
    if (refs.length > 1) {
        return done('needs_review', {
            ...detail,
            digital_object: 'multiple',
            note: 'More than one digital object is attached to the record.',
        });
    }

    const changes = [];
    detail.digital_object = 'absent';
    if (refs.length === 1) {
        const digital_object = digital_objects.get(refs[0]);
        detail.digital_object_uri = refs[0];
        if (!digital_object) {
            return done('needs_review', {
                ...detail,
                digital_object: 'not_found',
                note: 'The digital object attached to the record could not be read.',
            });
        }
        if (link.linked_records(digital_object).some((linked) => linked !== target.uri)) {
            return done('needs_review', {
                ...detail,
                digital_object: 'shared',
                note: 'The digital object is also attached to another record.',
            });
        }
        const plan_id = (source) => link.plan_digital_object(source, row.handle);
        const planned_id = plan_id(digital_object);
        detail.digital_object = planned_id.action;
        if (planned_id.record) {
            detail.digital_object_previous = planned_id.previous;
            changes.push({
                uri: refs[0],
                field: 'digital_object_id',
                ...planned_id,
                replan: plan_id,
            });
        }
    }
    changes.push({ uri: target.uri, field: 'link', ...planned, replan: plan_link });
    return { result: { ...base, state: 'pending', ...detail }, changes };
}

function error_text(res) {
    const error = res.data && res.data.error;
    if (!error) return `HTTP ${res.status}`;
    return `HTTP ${res.status}: ${typeof error === 'string' ? error : JSON.stringify(error)}`;
}

function auth_failure(err) {
    return err.status === 401 || err.status === 412;
}

async function read_set(listing, ids, deps) {
    const records = new Map();
    if (ids.length === 0) return records;
    const res = await deps.request(
        (token) => deps.aspace.get_native_set(listing, ids, token),
        listing
    );
    if (res.status !== 200 || !Array.isArray(res.data)) {
        const err = new Error(`ArchivesSpace could not list ${listing} (${error_text(res)})`);
        err.status = res.status;
        throw err;
    }
    for (const record of res.data) records.set(record.uri, record);
    return records;
}

async function reachable(listing, deps) {
    const repository = listing.split('/').slice(0, 3).join('/');
    try {
        await deps.request((token) => deps.aspace.get_native(repository, token), repository);
        return true;
    } catch (err) {
        if (auth_failure(err)) throw err;
        return false;
    }
}

async function read_ids(listing, ids, deps, reads) {
    try {
        const records = await read_set(listing, ids, deps);
        reads.unread_in_a_row = 0;
        return records;
    } catch (err) {
        if (auth_failure(err)) throw err;
        const refused = err.status >= 400 && err.status < 500;
        if (!refused && !(await reachable(listing, deps))) throw err;
        if (refused || ids.length === 1) {
            for (const id of ids) reads.unreadable.set(`${listing}/${id}`, err);
            if (!refused) reads.unread_in_a_row += 1;
            if (reads.unread_in_a_row >= MAX_FAILURES_IN_A_ROW) throw err;
            return new Map();
        }
        const middle = Math.ceil(ids.length / 2);
        const first = await read_ids(listing, ids.slice(0, middle), deps, reads);
        const second = await read_ids(listing, ids.slice(middle), deps, reads);
        return new Map([...first, ...second]);
    }
}

async function read_digital_objects(refs, deps, reads) {
    const by_listing = new Map();
    for (const ref of refs) {
        const match = DIGITAL_OBJECT_URI.exec(ref);
        if (!match) continue;
        if (!by_listing.has(match[1])) by_listing.set(match[1], []);
        by_listing.get(match[1]).push(Number(match[2]));
    }
    const records = new Map();
    for (const [listing, ids] of by_listing) {
        for (const [uri, record] of await read_ids(listing, ids, deps, reads)) {
            records.set(uri, record);
        }
    }
    return records;
}

async function write_change(change, deps) {
    const post = (record) =>
        deps.request((token) => deps.aspace.update_record(change.uri, record, token), change.uri);

    let plan = change;
    let res = await post(plan.record);
    for (let replans = 0; res.status === 409 && replans < MAX_REPLANS; replans += 1) {
        const fresh = await deps.request(
            (token) => deps.aspace.get_native(change.uri, token),
            change.uri
        );
        if (fresh.status !== 200) return { ok: false, error: error_text(fresh) };
        plan = change.replan(fresh.data);
        if (!plan.record) {
            if (plan.action === 'none') {
                return {
                    ok: true,
                    written: { action: change.action, previous: change.previous ?? null },
                };
            }
            if (plan.action === 'unpublished') return { ok: true };
            return { ok: false, error: 'the record changed while it was being updated; run again' };
        }
        res = await post(plan.record);
    }
    if (res.status === 200) {
        return { ok: true, written: { action: plan.action, previous: plan.previous ?? null } };
    }
    const hint =
        res.status === 403
            ? ' (the ArchivesSpace account may not be allowed to update this kind of record)'
            : '';
    return { ok: false, error: `${error_text(res)}${hint}` };
}

async function apply_changes(assessed, deps) {
    for (const change of assessed.changes) {
        let outcome;
        try {
            outcome = await write_change(change, deps);
        } catch (err) {
            if (auth_failure(err)) throw err;
            outcome = { ok: false, error: err.message, transient: true };
        }
        if (outcome.written && deps.on_written) {
            await deps.on_written({
                record_uri: assessed.result.uri,
                uri: change.uri,
                field: change.field,
                ...outcome.written,
                value: assessed.result.handle,
                pids: assessed.result.pids,
            });
        }
        if (!outcome.ok) {
            assessed.result.state = 'failed';
            assessed.result.error = `${change.uri}: ${outcome.error}`;
            return Boolean(outcome.transient);
        }
    }
    assessed.result.state = 'updated';
    return false;
}

async function settle(run, target, result) {
    const outcome = { target, result };
    run.outcomes.push(outcome);
    if (run.deps.on_outcome) await run.deps.on_outcome(outcome);
}

function unreadable_result(target, err) {
    return { ...base_of(target), state: 'needs_review', error: err.message };
}

async function current(run, target) {
    if (!run.deps.loaders) return target;
    const fresh = await load_targets([target.uri], run.deps.loaders);
    return fresh.get(target.uri) || { ...target, live: [], deleted: [] };
}

async function sync_group(run, group, read) {
    for (const target of group) {
        if (run.should_stop()) return true;
        const failure = read.unreadable.get(target.uri);
        if (failure) {
            await settle(run, target, unreadable_result(target, failure));
            continue;
        }
        const record = read.records.get(target.uri);
        const to_write = (found) => found && run.options.execute && found.changes.length > 0;
        let assessed = assess(target, record, read.digital_objects, run.options);
        if (to_write(assessed)) {
            const fresh = await current(run, target);
            assessed = assess(fresh, record, read.digital_objects, run.options);
        }
        if (to_write(assessed)) {
            const transient = await apply_changes(assessed, run.deps);
            run.failures_in_a_row = transient ? run.failures_in_a_row + 1 : 0;
        }
        await settle(run, target, assessed ? assessed.result : null);
        if (run.failures_in_a_row >= MAX_FAILURES_IN_A_ROW) {
            run.halted =
                `${MAX_FAILURES_IN_A_ROW} updates in a row failed. ` +
                `Last: ${assessed.result.error}`;
            return true;
        }
    }
    return false;
}

async function sync_targets(targets, options, deps) {
    const by_listing = new Map();
    for (const target of targets) {
        if (!by_listing.has(target.listing)) by_listing.set(target.listing, []);
        by_listing.get(target.listing).push(target);
    }

    const run = {
        options,
        deps,
        outcomes: [],
        failures_in_a_row: Math.min(options.failures_in_a_row || 0, MAX_FAILURES_IN_A_ROW - 1),
        halted: null,
        should_stop: () => Boolean(deps.should_stop && deps.should_stop()),
    };
    const finish = () => ({
        outcomes: run.outcomes,
        failures_in_a_row: run.failures_in_a_row,
        halted: run.halted,
    });

    for (const [listing, group] of by_listing) {
        if (run.should_stop()) return finish();
        const reads = { unreadable: new Map(), unread_in_a_row: 0 };
        const readable = group.filter(
            (target) =>
                target.live.length === 0 ||
                (target.live.length === 1 && own_handle(target.live[0], options))
        );
        const records = await read_ids(
            listing,
            readable.map((target) => target.id),
            deps,
            reads
        );
        const refs = group
            .map((target) => digital_object_refs_for(target, records.get(target.uri)))
            .filter((found) => found.length === 1)
            .map((found) => found[0]);
        const digital_objects = await read_digital_objects(refs, deps, reads);
        if (await sync_group(run, group, { records, digital_objects, ...reads })) {
            return finish();
        }
    }
    return finish();
}

module.exports = {
    ATTENTION_STATES,
    LINKED_STATES,
    MAX_FAILURES_IN_A_ROW,
    auth_failure,
    record_uri,
    build_targets,
    load_targets,
    assess,
    write_change,
    sync_targets,
};
