'use strict';

const model = require('../../../kaltura/model');
const db_helper = require('../../helpers/db');
const { db_queue } = require('../../../config/db');
const tables = require('../../../config/db_tables');
const { ValidationError } = require('../../../libs/errors');

describe('kaltura/model', () => {
    beforeAll(async () => {
        await db_helper.setup_schema();
    });
    beforeEach(async () => {
        await db_helper.reset_data();
    });
    afterAll(async () => {
        await db_helper.teardown();
    });

    describe('queue_packages', () => {
        it('inserts each package as a row with JSON-stringified files', async () => {
            await model.queue_packages([
                { package: 'pkg-A', files: ['a.mp4', 'b.mp4'] },
                { package: 'pkg-B', files: ['c.mp4'] },
            ]);
            const rows = await db_queue()(tables.kaltura_package_queue).orderBy('id');
            expect(rows).toHaveLength(2);
            expect(rows[0].package).toBe('pkg-A');
            expect(JSON.parse(rows[0].files)).toEqual(['a.mp4', 'b.mp4']);
            expect(Number(rows[0].is_processed)).toBe(0);
        });

        it('accepts a pre-stringified files value', async () => {
            await model.queue_packages([{ package: 'pkg-X', files: '["x.mp4"]' }]);
            const row = await db_queue()(tables.kaltura_package_queue).first();
            expect(JSON.parse(row.files)).toEqual(['x.mp4']);
        });

        it('rejects an empty input array', async () => {
            await expect(model.queue_packages([])).rejects.toThrow(ValidationError);
        });

        it('rejects rows missing the package field', async () => {
            await expect(
                model.queue_packages([{ files: ['a.mp4'] }])
            ).rejects.toThrow(ValidationError);
        });
    });

    describe('get_next_package / mark_package_processed', () => {
        it('returns rows in insertion order and skips processed ones', async () => {
            await model.queue_packages([
                { package: 'pkg-A', files: ['a'] },
                { package: 'pkg-B', files: ['b'] },
                { package: 'pkg-C', files: ['c'] },
            ]);
            let next = await model.get_next_package();
            expect(next.package).toBe('pkg-A');
            await model.mark_package_processed('pkg-A');
            next = await model.get_next_package();
            expect(next.package).toBe('pkg-B');
        });

        it('returns null when the queue is fully drained', async () => {
            await model.queue_packages([{ package: 'pkg-A', files: ['a'] }]);
            await model.mark_package_processed('pkg-A');
            expect(await model.get_next_package()).toBeNull();
        });
    });

    describe('save_entry_ids / list_entry_ids / get_entry_id_for_file', () => {
        it('persists rows and lists them newest-first', async () => {
            await model.save_entry_ids([
                {
                    package: 'pkg-A',
                    file: 'a.mp4',
                    entry_id: '1_a',
                    status: 1,
                    message: 'Success.',
                },
                {
                    package: 'pkg-A',
                    file: 'b.mp4',
                    entry_id: '0_0',
                    status: 0,
                    message: 'Not found.',
                },
            ]);
            const rows = await model.list_entry_ids();
            expect(rows).toHaveLength(2);
            // newest-first → b.mp4 inserted last, returned first.
            expect(rows[0].file).toBe('b.mp4');
        });

        it('returns the entry_id when status=1 and null otherwise', async () => {
            await model.save_entry_ids([
                { package: 'pkg-A', file: 'good.mp4', entry_id: '1_g', status: 1, message: 'ok' },
                {
                    package: 'pkg-A',
                    file: 'bad.mp4',
                    entry_id: '0_0',
                    status: 0,
                    message: 'no',
                },
            ]);
            expect(await model.get_entry_id_for_file('pkg-A', 'good.mp4')).toBe('1_g');
            expect(await model.get_entry_id_for_file('pkg-A', 'bad.mp4')).toBeNull();
            expect(await model.get_entry_id_for_file('pkg-A', 'missing.mp4')).toBeNull();
        });

        it('no-ops on empty input', async () => {
            const result = await model.save_entry_ids([]);
            expect(result).toEqual({ count: 0 });
            expect(await model.list_entry_ids()).toEqual([]);
        });
    });

    describe('clear_queue', () => {
        it('deletes both tables and returns the row counts', async () => {
            await model.queue_packages([{ package: 'pkg-A', files: ['a'] }]);
            await model.save_entry_ids([
                {
                    package: 'pkg-A',
                    file: 'a',
                    entry_id: '1_a',
                    status: 1,
                    message: 'ok',
                },
            ]);
            const result = await model.clear_queue();
            expect(result.queue).toBe(1);
            expect(result.ids).toBe(1);
            expect(await db_queue()(tables.kaltura_package_queue).count('* as n').first()).toEqual({
                n: 0,
            });
            expect(await db_queue()(tables.kaltura_ids).count('* as n').first()).toEqual({ n: 0 });
        });
    });
});
