'use strict';

const PID = '8fd73006-4c1c-478a-989f-153cb8afdf13';
const TWIN = '1ee3d82a-c988-42a0-bbf3-38d23d86deed';
const GONE = 'fd9a67c7-b58c-42bf-a2d1-97175acaa96e';
const COLLECTION = '99abe952-8d4b-416f-84f7-175e1ecba29c';
const AO = '/repositories/2/archival_objects/192976';
const DO = '/repositories/2/digital_objects/48380';
const RESOURCE = '/repositories/2/resources/1277';

const handle = (pid) => `https://hdl.handle.net/10176/${pid}`;
const old_handle = (pid) => `http://hdl.handle.net/10176/${pid}`;

function row(overrides = {}) {
    return {
        pid: PID,
        uri: AO,
        handle: handle(PID),
        object_type: 'object',
        is_active: 1,
        created: new Date('2026-06-15T12:00:00Z'),
        ...overrides,
    };
}

function link_doc(location, overrides = {}) {
    return {
        jsonmodel_type: 'external_document',
        title: 'Special Collections @ DU',
        location,
        publish: true,
        ...overrides,
    };
}

function archival_object(overrides = {}) {
    return {
        uri: AO,
        lock_version: 14,
        external_documents: [],
        instances: [{ instance_type: 'digital_object', digital_object: { ref: DO } }],
        ...overrides,
    };
}

function digital_object(overrides = {}) {
    return { uri: DO, lock_version: 1, digital_object_id: 'B133.01.0003.00001', ...overrides };
}

function make_aspace(
    records,
    { update_statuses = [], configured = true, fail_reads = false } = {}
) {
    const store = new Map(records.map((record) => [record.uri, record]));
    const calls = { sets: [], gets: [], posts: [] };
    return {
        store,
        calls,
        is_configured: () => configured,
        async get_native_set(listing, ids) {
            calls.sets.push({ listing, ids });
            if (fail_reads) return { status: 503, data: { error: 'unavailable' } };
            const data = ids.map((id) => store.get(`${listing}/${id}`)).filter(Boolean);
            return { status: 200, data };
        },
        async get_native(uri) {
            calls.gets.push(uri);
            return store.has(uri)
                ? { status: 200, data: store.get(uri) }
                : { status: 404, data: { error: 'ArchivalObject not found' } };
        },
        async update_record(uri, record) {
            calls.posts.push({ uri, record });
            const status = update_statuses.shift() || 200;
            if (status !== 200) return { status, data: { error: `refused ${status}` } };
            store.set(uri, { ...record, lock_version: record.lock_version + 1 });
            return { status: 200, data: { status: 'Updated' } };
        },
    };
}

function make_deps(aspace, rows = []) {
    const output = [];
    return {
        aspace,
        output,
        write: (text) => output.push(text),
        load_rows: async () => rows,
        request: (call) => call('tok'),
    };
}

module.exports = {
    PID,
    TWIN,
    GONE,
    COLLECTION,
    AO,
    DO,
    RESOURCE,
    handle,
    old_handle,
    row,
    link_doc,
    archival_object,
    digital_object,
    make_aspace,
    make_deps,
};
