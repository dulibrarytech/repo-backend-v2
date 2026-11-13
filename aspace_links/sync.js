'use strict';

const link = require('../libs/aspace_link');

const RECORD_URI = /^\/repositories\/(\d+)\/(archival_objects|resources)\/(\d+)$/;
const DIGITAL_OBJECT_URI = /^(\/repositories\/\d+\/digital_objects)\/(\d+)$/;
const MAX_FAILURES_IN_A_ROW = 5;
const ATTENTION_STATES = Object.freeze([
    'failed',
    'contested',
    'needs_review',
    'record_not_found',
    'invalid_handle',
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

function digital_object_refs_for(target, record) {
    if (!record || target.live.length !== 1) return [];
    if (target.live[0].object_type === 'collection') return [];
    return link.digital_object_refs(record);
}

function assess(target, record, digital_objects, options) {
    const base = { uri: target.uri, pids: target.live.map((row) => row.pid) };
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
    if (link.handle_id(row.handle) !== `${options.prefix}/${row.pid}`.toLowerCase()) {
        return done('invalid_handle');
    }
    if (!record) return done('record_not_found');

    const plan_link = (source) => link.plan_link(source, row.handle, { publish: options.publish });
    const planned = plan_link(record);
    if (planned.action === 'ambiguous') {
        return done('needs_review', { note: 'The record has more than one repository link.' });
    }

    const changes = [];
    const detail = { handle: row.handle, link: planned.action, digital_object: 'absent' };
    if (planned.previous !== undefined) detail.link_previous = planned.previous;

    const refs = digital_object_refs_for(target, record);
    if (refs.length > 1) {
        detail.digital_object = 'multiple';
        detail.note = 'More than one digital object is attached to the record.';
    }
    if (refs.length === 1) {
        const digital_object = digital_objects.get(refs[0]);
        const plan_id = (source) => link.plan_digital_object(source, row.handle);
        const planned_id = digital_object ? plan_id(digital_object) : { action: 'not_found' };
        detail.digital_object = planned_id.action;
        detail.digital_object_uri = refs[0];
        if (!digital_object) {
            detail.note = 'The digital object attached to the record could not be read.';
        }
        if (planned_id.record) {
            detail.digital_object_previous = planned_id.previous;
            changes.push({ uri: refs[0], record: planned_id.record, replan: plan_id });
        }
    }
    if (planned.record) {
        changes.push({ uri: target.uri, record: planned.record, replan: plan_link });
    }

    let state = 'in_sync';
    if (changes.length > 0) state = 'pending';
    else if (detail.note) state = 'needs_review';
    else if (planned.action === 'unpublished') state = 'unpublished_link';
    return { result: { ...base, state, ...detail }, changes };
}

function error_text(res) {
    const error = res.data && res.data.error;
    if (!error) return `HTTP ${res.status}`;
    return `HTTP ${res.status}: ${typeof error === 'string' ? error : JSON.stringify(error)}`;
}

async function read_set(listing, ids, deps) {
    const records = new Map();
    if (ids.length === 0) return records;
    const res = await deps.request(
        (token) => deps.aspace.get_native_set(listing, ids, token),
        listing
    );
    if (res.status !== 200 || !Array.isArray(res.data)) {
        throw new Error(`ArchivesSpace could not list ${listing} (${error_text(res)})`);
    }
    for (const record of res.data) records.set(record.uri, record);
    return records;
}

async function read_digital_objects(refs, deps) {
    const by_listing = new Map();
    for (const ref of refs) {
        const match = DIGITAL_OBJECT_URI.exec(ref);
        if (!match) continue;
        if (!by_listing.has(match[1])) by_listing.set(match[1], []);
        by_listing.get(match[1]).push(Number(match[2]));
    }
    const records = new Map();
    for (const [listing, ids] of by_listing) {
        for (const [uri, record] of await read_set(listing, ids, deps)) records.set(uri, record);
    }
    return records;
}

async function write_change(change, deps) {
    const post = (record) =>
        deps.request((token) => deps.aspace.update_record(change.uri, record, token), change.uri);

    let res = await post(change.record);
    if (res.status === 409) {
        const fresh = await deps.request(
            (token) => deps.aspace.get_native(change.uri, token),
            change.uri
        );
        if (fresh.status !== 200) return { ok: false, error: error_text(fresh) };
        const replanned = change.replan(fresh.data);
        if (!replanned.record) {
            return ['none', 'unpublished'].includes(replanned.action)
                ? { ok: true }
                : { ok: false, error: 'the record changed while it was being updated; run again' };
        }
        res = await post(replanned.record);
    }
    if (res.status === 200) return { ok: true };
    const hint =
        res.status === 403
            ? ' (the ArchivesSpace account may not be allowed to update this kind of record)'
            : '';
    return { ok: false, error: `${error_text(res)}${hint}` };
}

async function apply_changes(assessed, deps) {
    const errors = [];
    for (const change of assessed.changes) {
        try {
            const outcome = await write_change(change, deps);
            if (!outcome.ok) errors.push(`${change.uri}: ${outcome.error}`);
        } catch (err) {
            errors.push(`${change.uri}: ${err.message}`);
        }
    }
    assessed.result.state = errors.length > 0 ? 'failed' : 'updated';
    if (errors.length > 0) assessed.result.error = errors.join('; ');
    return errors.length === 0;
}

async function sync_targets(targets, options, deps) {
    const by_listing = new Map();
    for (const target of targets) {
        if (!by_listing.has(target.listing)) by_listing.set(target.listing, []);
        by_listing.get(target.listing).push(target);
    }

    const outcomes = [];
    let failures_in_a_row = options.failures_in_a_row || 0;
    for (const [listing, group] of by_listing) {
        const readable = group.filter((target) => target.live.length <= 1);
        const records = await read_set(
            listing,
            readable.map((target) => target.id),
            deps
        );
        const refs = group
            .map((target) => digital_object_refs_for(target, records.get(target.uri)))
            .filter((found) => found.length === 1)
            .map((found) => found[0]);
        const digital_objects = await read_digital_objects(refs, deps);

        for (const target of group) {
            const assessed = assess(target, records.get(target.uri), digital_objects, options);
            if (assessed && options.execute && assessed.changes.length > 0) {
                const applied = await apply_changes(assessed, deps);
                failures_in_a_row = applied ? 0 : failures_in_a_row + 1;
            }
            outcomes.push({ target, result: assessed ? assessed.result : null });
            if (failures_in_a_row >= MAX_FAILURES_IN_A_ROW) {
                return {
                    outcomes,
                    failures_in_a_row,
                    halted:
                        `${MAX_FAILURES_IN_A_ROW} updates in a row failed. ` +
                        `Last: ${assessed.result.error}`,
                };
            }
        }
    }
    return { outcomes, failures_in_a_row, halted: null };
}

module.exports = {
    ATTENTION_STATES,
    MAX_FAILURES_IN_A_ROW,
    record_uri,
    build_targets,
    assess,
    write_change,
    sync_targets,
};
