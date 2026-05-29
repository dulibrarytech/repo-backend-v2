'use strict';

// Express handlers for the users domain. Each is `async` and lets
// errors propagate — Express 5 forwards rejected promises to the
// central error handler in config/express.js.

const user_model = require('./model');
const { ValidationError } = require('../libs/errors');

async function list_users(req, res) {
    const include_inactive = req.query.include_inactive === '1';
    const data = await user_model.list({ include_inactive });
    res.json({ data });
}

async function get_user(req, res) {
    const data = await user_model.get(req.params.id);
    res.json({ data });
}

async function create_user(req, res) {
    if (!req.body || typeof req.body !== 'object') {
        throw new ValidationError('Body must be a JSON object');
    }
    const data = await user_model.create(req.body);
    res.status(201).json({ data });
}

async function update_user(req, res) {
    if (!req.body || typeof req.body !== 'object') {
        throw new ValidationError('Body must be a JSON object');
    }
    const data = await user_model.update(req.params.id, req.body);
    res.json({ data });
}

async function delete_user(req, res) {
    await user_model.soft_delete(req.params.id);
    res.status(204).end();
}

module.exports = {
    list_users,
    get_user,
    create_user,
    update_user,
    delete_user,
};
