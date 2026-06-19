'use strict';

const repo_model = require('./model');
const user_model = require('../users/model');
const projection = require('../libs/object_projection');

async function list_objects(req, res) {
    const data = await repo_model.list({
        collection: req.query.collection,
        object_type: req.query.object_type,
        is_published:
            req.query.is_published === undefined ? undefined : req.query.is_published === '1',
        is_active: req.query.is_active === undefined ? undefined : req.query.is_active === '1',
        page: req.query.page,
        page_size: req.query.page_size,
    });
    res.json({
        ...data,
        // API responses surface the enriched fields (title, handle,
        // uri parsed from display_record) but never the raw blob.
        items: projection.enrich_all(data.items),
    });
}

async function get_object(req, res) {
    const data = await repo_model.get(req.params.pid);
    res.json({ data: projection.enrich(data) });
}

async function publish_object(req, res) {
    const data = await repo_model.publish(req.params.pid);
    res.json({ data: projection.enrich(data) });
}

async function suppress_object(req, res) {
    const data = await repo_model.suppress(req.params.pid);
    res.json({ data: projection.enrich(data) });
}

async function delete_object(req, res) {
    // delete_reason is required — forwarded to Archivematica as the
    // event_reason on the AIP deletion request. The model also
    // refuses to delete published objects (must suppress first).
    const delete_reason = req.body && req.body.delete_reason;
    // Audit actor: "First Last (du_id)" so the AM admin can identify who
    // initiated the delete by name, with the du_id as the unambiguous key.
    const actor = await user_model.actor_label(req.user);
    const result = await repo_model.soft_delete(req.params.pid, {
        delete_reason,
        actor,
    });
    res.status(200).json(result);
}

module.exports = {
    list_objects,
    get_object,
    publish_object,
    suppress_object,
    delete_object,
};
