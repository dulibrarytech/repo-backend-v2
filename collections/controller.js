'use strict';

const collections_model = require('./model');

async function list_collections(req, res) {
    const data = await collections_model.list_collections({
        q: req.query.q,
        sort: req.query.sort,
        page: req.query.page,
        page_size: req.query.page_size,
    });
    res.json(data);
}

async function get_collection(req, res) {
    const data = await collections_model.get_collection(req.params.pid);
    res.json({ data });
}

async function get_members(req, res) {
    const data = await collections_model.members(req.params.pid, {
        page: req.query.page,
        page_size: req.query.page_size,
        is_published:
            req.query.is_published === '1'
                ? true
                : req.query.is_published === '0'
                  ? false
                  : undefined,
    });
    res.json(data);
}

module.exports = {
    list_collections,
    get_collection,
    get_members,
};
