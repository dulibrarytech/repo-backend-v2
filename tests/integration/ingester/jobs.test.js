'use strict';

const jobs = require('../../../ingester/jobs');
const db_helper = require('../../helpers/db');
const { db_queue } = require('../../../config/db');
const tables = require('../../../config/db_tables');
const { ValidationError } = require('../../../libs/errors');

describe('ingester/jobs', () => {
    beforeAll(async () => {
        await db_helper.setup_schema();
    });
    beforeEach(async () => {
        await db_helper.reset_data();
    });
    afterAll(async () => {
        await db_helper.teardown();
    });

    describe('record_job', () => {
        it('inserts a row with denormalized actor_name from tbl_users', async () => {
            const u = await db_helper.seed_user({
                du_id: 'eferguson',
                first_name: 'Elizabeth',
                last_name: 'Ferguson',
            });
            const uuid = await jobs.record_job({
                job_type: 'make_digital_objects',
                status: 'SUCCESSFUL',
                collection_folder: 'new_B463_Alan_Golin_Gass-resources_1373',
                packages: [
                    'B463.01.0005.0003.0003',
                    'B463.01.0005.0003.0004',
                    'B463.01.0005.0003.0005',
                ],
                actor: u.du_id,
            });
            expect(uuid).toMatch(/-/);
            const row = await db_queue()(tables.ingest_jobs).where({ job_uuid: uuid }).first();
            expect(row).toBeTruthy();
            expect(row.job_type).toBe('make_digital_objects');
            expect(row.status).toBe('SUCCESSFUL');
            expect(row.collection_folder).toBe('new_B463_Alan_Golin_Gass-resources_1373');
            expect(row.actor).toBe('eferguson');
            expect(row.actor_name).toBe('Elizabeth Ferguson');
            // packages stored as JSON text — parse and verify.
            expect(JSON.parse(row.packages)).toEqual([
                'B463.01.0005.0003.0003',
                'B463.01.0005.0003.0004',
                'B463.01.0005.0003.0005',
            ]);
        });

        it('stores empty actor_name when du_id is unknown', async () => {
            const uuid = await jobs.record_job({
                job_type: 'archivesspace_description_qa',
                status: 'SUCCESSFUL',
                collection_folder: 'col-x',
                packages: ['p1'],
                actor: 'ghost-user',
            });
            const row = await db_queue()(tables.ingest_jobs).where({ job_uuid: uuid }).first();
            expect(row.actor).toBe('ghost-user');
            expect(row.actor_name).toBe('');
        });

        it('truncates very long error text to 1000 chars', async () => {
            const uuid = await jobs.record_job({
                job_type: 'make_digital_objects',
                status: 'FAILED',
                collection_folder: 'col-x',
                packages: [],
                actor: 'svc',
                error: 'x'.repeat(5000),
            });
            const row = await db_queue()(tables.ingest_jobs).where({ job_uuid: uuid }).first();
            expect(row.error.length).toBe(1000);
        });

        it('rejects unknown job_type / status', async () => {
            await expect(
                jobs.record_job({
                    job_type: 'nope',
                    status: 'SUCCESSFUL',
                    collection_folder: 'x',
                    packages: [],
                    actor: 'svc',
                })
            ).rejects.toBeInstanceOf(ValidationError);

            await expect(
                jobs.record_job({
                    job_type: 'make_digital_objects',
                    status: 'PENDING',
                    collection_folder: 'x',
                    packages: [],
                    actor: 'svc',
                })
            ).rejects.toBeInstanceOf(ValidationError);
        });

        it('requires collection_folder', async () => {
            await expect(
                jobs.record_job({
                    job_type: 'make_digital_objects',
                    status: 'SUCCESSFUL',
                    collection_folder: '',
                    packages: [],
                    actor: 'svc',
                })
            ).rejects.toBeInstanceOf(ValidationError);
        });

        it('honors a pre-resolved actor_name (skips user lookup)', async () => {
            const uuid = await jobs.record_job({
                job_type: 'packaging_and_ingesting',
                status: 'SUCCESSFUL',
                collection_folder: 'col-x',
                packages: ['p1'],
                actor: 'svc-no-user-row',
                resolved_actor_name: 'Service Account',
            });
            const row = await db_queue()(tables.ingest_jobs).where({ job_uuid: uuid }).first();
            expect(row.actor_name).toBe('Service Account');
        });
    });

    describe('list_jobs', () => {
        beforeEach(async () => {
            // Seed three jobs across the three workflow types.
            await db_helper.seed_user({
                du_id: 'staff-a',
                first_name: 'Aida',
                last_name: 'Lovelace',
            });
            // Stagger created timestamps so order is deterministic.
            for (let i = 0; i < 3; i++) {
                await jobs.record_job({
                    job_type: [
                        'make_digital_objects',
                        'archivesspace_description_qa',
                        'packaging_and_ingesting',
                    ][i],
                    status: i === 2 ? 'FAILED' : 'SUCCESSFUL',
                    collection_folder: `col-${i}`,
                    packages: [`p-${i}-0`, `p-${i}-1`],
                    actor: 'staff-a',
                    error: i === 2 ? 'something exploded' : null,
                });
                // Small delay so created timestamps differ.
                await new Promise((r) => setTimeout(r, 5));
            }
        });

        it('returns newest first by default', async () => {
            const data = await jobs.list_jobs();
            expect(data.rows).toHaveLength(3);
            // Last inserted should be first.
            expect(data.rows[0].collection_folder).toBe('col-2');
            expect(data.rows[2].collection_folder).toBe('col-0');
            expect(data.total).toBe(3);
        });

        it('parses packages back to an array for each row', async () => {
            const data = await jobs.list_jobs();
            expect(data.rows[0].packages).toEqual(['p-2-0', 'p-2-1']);
        });

        it('filters by job_type', async () => {
            const data = await jobs.list_jobs({ job_type: 'archivesspace_description_qa' });
            expect(data.rows).toHaveLength(1);
            expect(data.rows[0].collection_folder).toBe('col-1');
            expect(data.total).toBe(1);
        });

        it('filters by status', async () => {
            const data = await jobs.list_jobs({ status: 'FAILED' });
            expect(data.rows).toHaveLength(1);
            expect(data.rows[0].status).toBe('FAILED');
            expect(data.rows[0].error).toBe('something exploded');
        });

        it('filters by collection_folder (exact match for deep links)', async () => {
            const data = await jobs.list_jobs({ collection_folder: 'col-1' });
            expect(data.rows).toHaveLength(1);
        });

        it('q filter matches folder substring (case-insensitive)', async () => {
            const data = await jobs.list_jobs({ q: 'COL-2' });
            expect(data.rows.length).toBeGreaterThanOrEqual(1);
            data.rows.forEach((r) => expect(r.collection_folder).toMatch(/col-2/i));
        });

        it('q filter matches job_uuid prefix', async () => {
            const all = await jobs.list_jobs();
            const target = all.rows[0].job_uuid;
            // Use the first 8 hex chars as a prefix.
            const data = await jobs.list_jobs({ q: target.slice(0, 8) });
            expect(data.rows.length).toBeGreaterThanOrEqual(1);
            expect(data.rows.find((r) => r.job_uuid === target)).toBeTruthy();
        });

        it('paginates via limit + offset', async () => {
            const page1 = await jobs.list_jobs({}, { limit: 2, offset: 0 });
            const page2 = await jobs.list_jobs({}, { limit: 2, offset: 2 });
            expect(page1.rows).toHaveLength(2);
            expect(page2.rows).toHaveLength(1);
            expect(page1.total).toBe(3);
            expect(page2.total).toBe(3);
        });

        it('caps limit at 200', async () => {
            const data = await jobs.list_jobs({}, { limit: 99999 });
            expect(data.limit).toBe(200);
        });

        it('returns an empty rows array + total=0 when nothing matches', async () => {
            const data = await jobs.list_jobs({
                job_type: 'make_digital_objects',
                status: 'FAILED',
            });
            expect(data.rows).toEqual([]);
            expect(data.total).toBe(0);
        });
    });

    describe('get_qa_passed_folders', () => {
        /*
         * Source of truth for the ASpace QA view's "hide folders
         * already QA'd" filter. The rule: a folder is qa-passed iff
         * its MOST RECENT job (any job_type) is a SUCCESSFUL
         * archivesspace_description_qa.
         */
        async function record(folder, job_type, status, ms_ago = 0) {
            const uuid = await jobs.record_job({
                job_type,
                status,
                collection_folder: folder,
                actor: 'tester',
            });
            /*
             * Backdate so newest-first ordering is deterministic.
             * The model defaults `created` to now(); we override it
             * here so consecutive inserts in the same millisecond
             * don't tie-break by insertion order alone.
             */
            if (ms_ago > 0) {
                await db_queue()(tables.ingest_jobs)
                    .where({ job_uuid: uuid })
                    .update({ created: new Date(Date.now() - ms_ago) });
            }
        }

        it('returns the empty set when no jobs have been recorded', async () => {
            expect(await jobs.get_qa_passed_folders()).toEqual(new Set());
        });

        it('includes a folder whose latest job is a SUCCESSFUL QA', async () => {
            await record('col-passed', 'archivesspace_description_qa', 'SUCCESSFUL');
            const passed = await jobs.get_qa_passed_folders();
            expect(passed.has('col-passed')).toBe(true);
        });

        it('excludes a folder whose latest job is a FAILED QA', async () => {
            await record('col-failed', 'archivesspace_description_qa', 'FAILED');
            expect((await jobs.get_qa_passed_folders()).has('col-failed')).toBe(false);
        });

        it('excludes a folder whose latest job is a non-QA action (MDO re-run)', async () => {
            /*
             * 5s ago: QA succeeded. Now: MDO re-run. Latest is MDO,
             * not QA → folder should NOT be considered qa-passed.
             */
            await record('col-rerun', 'archivesspace_description_qa', 'SUCCESSFUL', 5000);
            await record('col-rerun', 'make_digital_objects', 'SUCCESSFUL', 0);
            const passed = await jobs.get_qa_passed_folders();
            expect(passed.has('col-rerun')).toBe(false);
        });

        it('excludes a folder whose latest job is a packaging action (post-submit)', async () => {
            await record('col-submitted', 'archivesspace_description_qa', 'SUCCESSFUL', 5000);
            await record('col-submitted', 'packaging_and_ingesting', 'SUCCESSFUL', 0);
            const passed = await jobs.get_qa_passed_folders();
            expect(passed.has('col-submitted')).toBe(false);
        });

        it('treats older failures as superseded by a newer SUCCESSFUL QA', async () => {
            await record('col-flaky', 'archivesspace_description_qa', 'FAILED', 5000);
            await record('col-flaky', 'archivesspace_description_qa', 'SUCCESSFUL', 0);
            const passed = await jobs.get_qa_passed_folders();
            expect(passed.has('col-flaky')).toBe(true);
        });

        it('returns a per-folder verdict — does not bleed across folders', async () => {
            await record('col-a', 'archivesspace_description_qa', 'SUCCESSFUL');
            await record('col-b', 'archivesspace_description_qa', 'FAILED');
            await record('col-c', 'make_digital_objects', 'SUCCESSFUL');
            const passed = await jobs.get_qa_passed_folders();
            expect([...passed].sort()).toEqual(['col-a']);
        });
    });
});
