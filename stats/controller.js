'use strict';

const stats_model = require('./model');

async function summary(_req, res) {
    const [counts, users] = await Promise.all([stats_model.summary(), stats_model.active_users()]);
    res.json({ ...counts, active_users: users });
}

async function by_collection(req, res) {
    const items = await stats_model.by_collection({ limit: req.query.limit });
    res.json({ items });
}

async function recent_ingests(req, res) {
    const items = await stats_model.recent_ingests({ limit: req.query.limit });
    res.json({ items });
}

module.exports = { summary, by_collection, recent_ingests };
