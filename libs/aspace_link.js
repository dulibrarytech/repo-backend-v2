'use strict';

const LINK_TITLE = 'Special Collections @ DU';
const HANDLE_URL = /^https?:\/\/hdl\.handle\.net\/([^/\s]+)\/(\S+)$/i;

function handle_id(value) {
    if (typeof value !== 'string') return null;
    const match = HANDLE_URL.exec(value.trim());
    return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

function is_link_title(title) {
    return typeof title === 'string' && /^specialcollections?@du$/i.test(title.replace(/\s+/g, ''));
}

function documents_of(record) {
    return Array.isArray(record.external_documents) ? record.external_documents : [];
}

function plan_link(record, handle, options = {}) {
    const id = handle_id(handle);
    const documents = documents_of(record);
    const titled = documents.filter((doc) => is_link_title(doc.title));
    if (titled.length > 1) return { action: 'ambiguous' };

    const { position: _position, ...kept } = record;
    const current = titled[0] || documents.find((doc) => handle_id(doc.location) === id);
    if (!current) {
        const added = {
            jsonmodel_type: 'external_document',
            title: LINK_TITLE,
            location: handle,
            publish: true,
        };
        return { action: 'add', record: { ...kept, external_documents: [...documents, added] } };
    }

    const replace_with = (changes) => ({
        ...kept,
        external_documents: documents.map((doc) =>
            doc === current ? { ...doc, ...changes } : doc
        ),
    });

    if (handle_id(current.location) !== id) {
        return {
            action: 'update',
            previous: current.location,
            record: replace_with({ location: handle, publish: true }),
        };
    }
    if (current.publish === true) return { action: 'none' };
    if (!options.publish) return { action: 'unpublished' };
    return { action: 'publish', record: replace_with({ publish: true }) };
}

function linked_handle_ids(record) {
    return documents_of(record)
        .map((doc) => handle_id(doc.location))
        .filter(Boolean);
}

function digital_object_refs(record) {
    const instances = Array.isArray(record.instances) ? record.instances : [];
    return instances
        .map((instance) => instance && instance.digital_object && instance.digital_object.ref)
        .filter((ref) => typeof ref === 'string' && ref !== '');
}

function plan_digital_object(record, handle) {
    if (handle_id(record.digital_object_id) === handle_id(handle)) return { action: 'none' };
    return {
        action: 'update',
        previous: record.digital_object_id,
        record: { ...record, digital_object_id: handle },
    };
}

module.exports = {
    LINK_TITLE,
    handle_id,
    is_link_title,
    plan_link,
    linked_handle_ids,
    digital_object_refs,
    plan_digital_object,
};
