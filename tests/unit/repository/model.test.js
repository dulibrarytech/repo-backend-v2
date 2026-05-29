'use strict';

const repo_model = require('../../../repository/model');
const { ValidationError } = require('../../../libs/errors');

describe('repository/model — input validation', () => {
    it('rejects missing pid', async () => {
        await expect(repo_model.get()).rejects.toBeInstanceOf(ValidationError);
        await expect(repo_model.publish()).rejects.toBeInstanceOf(ValidationError);
    });

    it('rejects non-UUID pid', async () => {
        await expect(repo_model.get('not-a-uuid')).rejects.toMatchObject({
            code: 'VALIDATION_ERROR',
            message: expect.stringMatching(/UUID/i),
        });
    });

    it('list rejects unknown object_type', async () => {
        await expect(repo_model.list({ object_type: 'video' })).rejects.toMatchObject({
            code: 'VALIDATION_ERROR',
        });
    });

    it('ALLOWED_OBJECT_TYPES is the closed set', () => {
        expect([...repo_model.ALLOWED_OBJECT_TYPES].sort()).toEqual([
            'collection',
            'compound',
            'object',
        ]);
    });

    describe('bulk input validation', () => {
        it('bulk_publish rejects a non-array', async () => {
            await expect(repo_model.bulk_publish(undefined)).rejects.toMatchObject({
                code: 'VALIDATION_ERROR',
            });
            await expect(repo_model.bulk_publish('not-array')).rejects.toMatchObject({
                code: 'VALIDATION_ERROR',
            });
        });

        it('bulk_publish rejects an empty array', async () => {
            await expect(repo_model.bulk_publish([])).rejects.toMatchObject({
                code: 'VALIDATION_ERROR',
            });
        });

        it('bulk_publish rejects more than MAX_BULK_PIDS', async () => {
            // 101 distinct real v4 UUIDs — we want the cap check to fire,
            // not the per-pid validator (which would catch all-zero fakes).
            const { randomUUID } = require('node:crypto');
            const huge = Array.from({ length: 101 }, () => randomUUID());
            await expect(repo_model.bulk_publish(huge)).rejects.toMatchObject({
                code: 'VALIDATION_ERROR',
                message: expect.stringMatching(/capped/i),
            });
        });

        it('bulk_publish rejects when any pid is not a UUID', async () => {
            const { randomUUID } = require('node:crypto');
            await expect(repo_model.bulk_publish([randomUUID(), 'garbage'])).rejects.toMatchObject({
                code: 'VALIDATION_ERROR',
            });
        });

        it('bulk_soft_delete uses the same validator', async () => {
            await expect(repo_model.bulk_soft_delete([])).rejects.toMatchObject({
                code: 'VALIDATION_ERROR',
            });
            await expect(repo_model.bulk_soft_delete(['nope'])).rejects.toMatchObject({
                code: 'VALIDATION_ERROR',
            });
        });

        it('MAX_BULK_PIDS is the closed limit', () => {
            expect(repo_model.MAX_BULK_PIDS).toBe(100);
        });
    });

    it('PUBLIC_FIELDS does not leak long-text columns', () => {
        // mods / transcript / transcript_search are never returned —
        // they're huge ASpace blobs. display_record IS included here
        // (the dashboard parses it for title/handle/uri at render time)
        // but the API controllers strip it before responding.
        const forbidden = ['mods', 'transcript', 'transcript_search'];
        for (const f of forbidden) {
            expect(repo_model.PUBLIC_FIELDS).not.toContain(f);
        }
    });
});
