'use strict';

const search_model = require('./model');
const projection = require('../libs/object_projection');

async function search_objects(req, res) {
    const result = await search_model.search({
        q: req.query.q,
        collection: req.query.collection,
        object_type: req.query.object_type,
        is_published:
            req.query.is_published === '1'
                ? true
                : req.query.is_published === '0'
                  ? false
                  : undefined,
        is_active: req.query.is_active === '0' ? false : true,
        page: req.query.page,
        page_size: req.query.page_size,
    });
    res.json({
        ...result,
        // API responses surface the enriched fields (title, handle,
        // uri parsed from display_record) but never the raw blob.
        items: projection.enrich_all(result.items),
    });
}

async function quick_lookup(req, res) {
    const items = await search_model.quick_lookup(String(req.query.q || ''));
    res.json({ items: projection.enrich_all(items) });
}

module.exports = { search_objects, quick_lookup };
