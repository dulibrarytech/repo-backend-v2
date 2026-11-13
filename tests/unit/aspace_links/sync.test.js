'use strict';

const sync = require('../../../aspace_links/sync');
const {
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
} = require('../../helpers/aspace_links');

const OPTIONS = { prefix: '10176', publish: false };

function target_of(...rows) {
    return sync.build_targets(rows).targets[0];
}

describe('aspace_links/sync', () => {
    describe('record_uri', () => {
        it('trims a stored uri and accepts archival objects and resources', () => {
            expect(sync.record_uri(`${AO}\n`)).toBe(AO);
            expect(sync.record_uri(RESOURCE)).toBe(RESOURCE);
        });

        it.each([
            ['', 'an empty string'],
            [null, 'null'],
            ['&#x2F;repositories&#x2F;2&#x2F;resources&#x2F;196', 'an encoded uri'],
            [DO, 'a digital object uri'],
            [`${AO}/tree`, 'a longer path'],
        ])('returns null for %j (%s)', (value) => {
            expect(sync.record_uri(value)).toBeNull();
        });
    });

    describe('build_targets', () => {
        it('groups the rows that share a record into live and deleted', () => {
            const built = sync.build_targets([
                row(),
                row({ pid: GONE, handle: handle(GONE), is_active: 0, uri: `${AO}\n` }),
                row({ pid: COLLECTION, uri: RESOURCE, object_type: 'collection' }),
            ]);
            expect(built.invalid).toEqual([]);
            expect(built.targets).toHaveLength(2);
            expect(built.targets[0]).toMatchObject({
                uri: AO,
                listing: '/repositories/2/archival_objects',
                id: 192976,
            });
            expect(built.targets[0].live.map((r) => r.pid)).toEqual([PID]);
            expect(built.targets[0].deleted.map((r) => r.pid)).toEqual([GONE]);
            expect(built.targets[1]).toMatchObject({
                uri: RESOURCE,
                listing: '/repositories/2/resources',
                id: 1277,
            });
        });

        it('sets aside live rows whose uri cannot be used, and drops deleted ones', () => {
            const encoded = '&#x2F;repositories&#x2F;2&#x2F;resources&#x2F;196';
            const built = sync.build_targets([
                row({ uri: '' }),
                row({ pid: TWIN, uri: encoded }),
                row({ pid: GONE, uri: null, is_active: 0 }),
            ]);
            expect(built.targets).toEqual([]);
            expect(built.invalid.map((r) => r.pid)).toEqual([PID, TWIN]);
        });
    });

    describe('assess', () => {
        const no_digital_objects = new Map();

        it('reports a record that two live objects share, with no change', () => {
            const target = target_of(row(), row({ pid: TWIN, handle: handle(TWIN) }));
            const assessed = sync.assess(target, undefined, no_digital_objects, OPTIONS);
            expect(assessed).toEqual({
                result: { uri: AO, pids: [PID, TWIN], state: 'contested' },
                changes: [],
            });
        });

        it('reports a link left behind by a deleted object', () => {
            const target = target_of(row({ pid: GONE, handle: handle(GONE), is_active: 0 }));
            const record = archival_object({ external_documents: [link_doc(old_handle(GONE))] });
            const assessed = sync.assess(target, record, no_digital_objects, OPTIONS);
            expect(assessed).toEqual({
                result: { uri: AO, pids: [GONE], state: 'orphan_link' },
                changes: [],
            });
        });

        it('says nothing about a deleted object whose record carries no link to it', () => {
            const target = target_of(row({ pid: GONE, handle: handle(GONE), is_active: 0 }));
            const unlinked = archival_object({ external_documents: [link_doc(old_handle(PID))] });
            expect(sync.assess(target, unlinked, no_digital_objects, OPTIONS)).toBeNull();
            expect(sync.assess(target, undefined, no_digital_objects, OPTIONS)).toBeNull();
        });

        it.each([
            ['an error message', 'Error: [/libs/handles lib (create_handle)] Unable to create'],
            ['a test value', 'test-handle'],
            ['the handle of another object', handle(TWIN)],
            ['a handle under another prefix', `https://hdl.handle.net/10136/${PID}`],
            ['nothing', null],
        ])('refuses to write when the stored handle is %s', (_label, stored) => {
            const assessed = sync.assess(
                target_of(row({ handle: stored })),
                archival_object(),
                no_digital_objects,
                OPTIONS
            );
            expect(assessed.result.state).toBe('invalid_handle');
            expect(assessed.changes).toEqual([]);
        });

        it('reports a record ArchivesSpace no longer has', () => {
            const assessed = sync.assess(target_of(row()), undefined, no_digital_objects, OPTIONS);
            expect(assessed.result.state).toBe('record_not_found');
        });

        it('reports a record with two repository links, with no change', () => {
            const record = archival_object({
                external_documents: [link_doc(old_handle(PID)), link_doc(old_handle(GONE))],
            });
            const assessed = sync.assess(target_of(row()), record, no_digital_objects, OPTIONS);
            expect(assessed.result).toEqual({
                uri: AO,
                pids: [PID],
                state: 'needs_review',
                note: 'The record has more than one repository link.',
            });
            expect(assessed.changes).toEqual([]);
        });

        it('finds a record in sync when link and identifier hold the http form', () => {
            const record = archival_object({ external_documents: [link_doc(old_handle(PID))] });
            const digital_objects = new Map([
                [DO, digital_object({ digital_object_id: old_handle(PID) })],
            ]);
            const assessed = sync.assess(target_of(row()), record, digital_objects, OPTIONS);
            expect(assessed).toEqual({
                result: {
                    uri: AO,
                    pids: [PID],
                    state: 'in_sync',
                    handle: handle(PID),
                    link: 'none',
                    digital_object: 'none',
                    digital_object_uri: DO,
                },
                changes: [],
            });
        });

        it('plans the identifier first and the link second for a new object', () => {
            const digital_objects = new Map([[DO, digital_object()]]);
            const assessed = sync.assess(
                target_of(row()),
                archival_object(),
                digital_objects,
                OPTIONS
            );
            expect(assessed.result).toEqual({
                uri: AO,
                pids: [PID],
                state: 'pending',
                handle: handle(PID),
                link: 'add',
                digital_object: 'update',
                digital_object_uri: DO,
                digital_object_previous: 'B133.01.0003.00001',
            });
            expect(assessed.changes.map((change) => change.uri)).toEqual([DO, AO]);
            expect(assessed.changes[0].record.digital_object_id).toBe(handle(PID));
            expect(assessed.changes[1].record.external_documents[0].location).toBe(handle(PID));
        });

        it('repoints a link that a deleted object left on the record', () => {
            const target = target_of(row(), row({ pid: GONE, handle: handle(GONE), is_active: 0 }));
            const record = archival_object({ external_documents: [link_doc(old_handle(GONE))] });
            const digital_objects = new Map([
                [DO, digital_object({ digital_object_id: old_handle(GONE) })],
            ]);
            const assessed = sync.assess(target, record, digital_objects, OPTIONS);
            expect(assessed.result).toMatchObject({
                state: 'pending',
                link: 'update',
                link_previous: old_handle(GONE),
                digital_object: 'update',
                digital_object_previous: old_handle(GONE),
            });
        });

        it('leaves the digital objects of a collection record alone', () => {
            const target = target_of(row({ object_type: 'collection' }));
            const record = archival_object({ external_documents: [link_doc(old_handle(PID))] });
            const assessed = sync.assess(target, record, no_digital_objects, OPTIONS);
            expect(assessed.result).toMatchObject({ state: 'in_sync', digital_object: 'absent' });
        });

        it('asks for a review when the digital object could not be read', () => {
            const record = archival_object({ external_documents: [link_doc(old_handle(PID))] });
            const assessed = sync.assess(target_of(row()), record, no_digital_objects, OPTIONS);
            expect(assessed.result).toMatchObject({
                state: 'needs_review',
                digital_object: 'not_found',
                note: 'The digital object attached to the record could not be read.',
            });
            expect(assessed.changes).toEqual([]);
        });

        it('asks for a review when the record has more than one digital object', () => {
            const second = { instance_type: 'digital_object', digital_object: { ref: `${DO}9` } };
            const record = archival_object({ external_documents: [link_doc(old_handle(PID))] });
            record.instances.push(second);
            const assessed = sync.assess(target_of(row()), record, no_digital_objects, OPTIONS);
            expect(assessed.result).toMatchObject({
                state: 'needs_review',
                digital_object: 'multiple',
                note: 'More than one digital object is attached to the record.',
            });
            expect(assessed.changes).toEqual([]);
        });

        it('still plans the link, and keeps the note, when only the digital object needs a review', () => {
            const second = { instance_type: 'digital_object', digital_object: { ref: `${DO}9` } };
            const record = archival_object();
            record.instances.push(second);
            const assessed = sync.assess(target_of(row()), record, no_digital_objects, OPTIONS);
            expect(assessed.result).toMatchObject({
                state: 'pending',
                link: 'add',
                note: 'More than one digital object is attached to the record.',
            });
            expect(assessed.changes.map((change) => change.uri)).toEqual([AO]);
        });

        it('reports an unpublished link, and publishes it only when asked', () => {
            const record = archival_object({
                instances: [],
                external_documents: [link_doc(old_handle(PID), { publish: false })],
            });
            const reported = sync.assess(target_of(row()), record, no_digital_objects, OPTIONS);
            expect(reported.result).toMatchObject({
                state: 'unpublished_link',
                link: 'unpublished',
            });
            expect(reported.changes).toEqual([]);

            const published = sync.assess(target_of(row()), record, no_digital_objects, {
                ...OPTIONS,
                publish: true,
            });
            expect(published.result).toMatchObject({ state: 'pending', link: 'publish' });
            expect(published.changes[0].record.external_documents[0]).toMatchObject({
                location: old_handle(PID),
                publish: true,
            });
        });
    });

    describe('write_change', () => {
        function change_for(aspace) {
            const digital_objects = new Map([[DO, aspace.store.get(DO)]]);
            const assessed = sync.assess(
                target_of(row()),
                aspace.store.get(AO),
                digital_objects,
                OPTIONS
            );
            return assessed.changes[assessed.changes.length - 1];
        }

        it('posts the planned record once when ArchivesSpace accepts it', async () => {
            const aspace = make_aspace([archival_object(), digital_object()]);
            const outcome = await sync.write_change(change_for(aspace), make_deps(aspace));
            expect(outcome).toEqual({ ok: true });
            expect(aspace.calls.posts).toHaveLength(1);
            expect(aspace.calls.gets).toEqual([]);
        });

        it('re-reads and re-plans once after a 409 conflict', async () => {
            const aspace = make_aspace([archival_object(), digital_object()], {
                update_statuses: [409],
            });
            const change = change_for(aspace);
            aspace.store.set(AO, archival_object({ lock_version: 15, title: 'Edited by staff' }));

            const outcome = await sync.write_change(change, make_deps(aspace));
            expect(outcome).toEqual({ ok: true });
            expect(aspace.calls.gets).toEqual([AO]);
            expect(aspace.calls.posts).toHaveLength(2);
            expect(aspace.calls.posts[1].record).toMatchObject({
                lock_version: 15,
                title: 'Edited by staff',
            });
            expect(aspace.calls.posts[1].record.external_documents[0].location).toBe(handle(PID));
        });

        it('stops after a 409 when the fresh record already carries the link', async () => {
            const aspace = make_aspace([archival_object(), digital_object()], {
                update_statuses: [409],
            });
            const change = change_for(aspace);
            aspace.store.set(
                AO,
                archival_object({ lock_version: 15, external_documents: [link_doc(handle(PID))] })
            );

            const outcome = await sync.write_change(change, make_deps(aspace));
            expect(outcome).toEqual({ ok: true });
            expect(aspace.calls.posts).toHaveLength(1);
        });

        it('reports the answer when the record is gone after a 409', async () => {
            const aspace = make_aspace([archival_object(), digital_object()], {
                update_statuses: [409],
            });
            const change = change_for(aspace);
            aspace.store.delete(AO);

            const outcome = await sync.write_change(change, make_deps(aspace));
            expect(outcome).toEqual({ ok: false, error: 'HTTP 404: ArchivalObject not found' });
        });

        it('reports a refused update with the reason ArchivesSpace gave', async () => {
            const aspace = make_aspace([archival_object(), digital_object()], {
                update_statuses: [400],
            });
            const outcome = await sync.write_change(change_for(aspace), make_deps(aspace));
            expect(outcome).toEqual({ ok: false, error: 'HTTP 400: refused 400' });
        });

        it('reports a refusal for lack of permission, with a hint, without throwing', async () => {
            const aspace = make_aspace([archival_object(), digital_object()], {
                update_statuses: [403],
            });
            const outcome = await sync.write_change(change_for(aspace), make_deps(aspace));
            expect(outcome).toEqual({
                ok: false,
                error:
                    'HTTP 403: refused 403 (the ArchivesSpace account may not be allowed ' +
                    'to update this kind of record)',
            });
        });

        it('never sends the position of the record', async () => {
            const aspace = make_aspace([archival_object({ position: 4 }), digital_object()]);
            await sync.write_change(change_for(aspace), make_deps(aspace));
            expect(aspace.calls.posts[0].uri).toBe(AO);
            expect(aspace.calls.posts[0].record).not.toHaveProperty('position');
        });
    });

    describe('sync_targets', () => {
        const rows = () => [
            row(),
            row({
                pid: COLLECTION,
                handle: handle(COLLECTION),
                uri: RESOURCE,
                object_type: 'collection',
            }),
        ];
        const records = () => [
            archival_object(),
            digital_object(),
            {
                uri: RESOURCE,
                lock_version: 8,
                external_documents: [link_doc(old_handle(COLLECTION))],
            },
        ];
        const targets = () => sync.build_targets(rows()).targets;

        it('reads each listing once and reports without writing unless asked', async () => {
            const aspace = make_aspace(records());
            const { outcomes, halted } = await sync.sync_targets(
                targets(),
                OPTIONS,
                make_deps(aspace)
            );

            expect(aspace.calls.sets).toEqual([
                { listing: '/repositories/2/archival_objects', ids: [192976] },
                { listing: '/repositories/2/digital_objects', ids: [48380] },
                { listing: '/repositories/2/resources', ids: [1277] },
            ]);
            expect(aspace.calls.posts).toEqual([]);
            expect(halted).toBeNull();
            expect(outcomes.map((outcome) => outcome.result.state)).toEqual(['pending', 'in_sync']);
            expect(outcomes[0].target.uri).toBe(AO);
        });

        it('writes the identifier, then the link, when asked', async () => {
            const aspace = make_aspace(records());
            const { outcomes } = await sync.sync_targets(
                targets(),
                { ...OPTIONS, execute: true },
                make_deps(aspace)
            );

            expect(aspace.calls.posts.map((post) => post.uri)).toEqual([DO, AO]);
            expect(outcomes[0].result.state).toBe('updated');
            expect(aspace.store.get(RESOURCE).lock_version).toBe(8);
        });

        it('marks the record failed, names what was refused, and still writes its link', async () => {
            const aspace = make_aspace(records(), { update_statuses: [400] });
            const { outcomes, halted } = await sync.sync_targets(
                targets(),
                { ...OPTIONS, execute: true },
                make_deps(aspace)
            );
            expect(outcomes[0].result).toMatchObject({
                state: 'failed',
                error: `${DO}: HTTP 400: refused 400`,
            });
            expect(aspace.calls.posts.map((post) => post.uri)).toEqual([DO, AO]);
            expect(aspace.store.get(AO).external_documents).toEqual([link_doc(handle(PID))]);
            expect(halted).toBeNull();
        });

        it('returns a null result for a deleted-only record with nothing to report', async () => {
            const aspace = make_aspace([archival_object()]);
            const deleted = sync.build_targets([
                row({ pid: GONE, handle: handle(GONE), is_active: 0 }),
            ]).targets;
            const { outcomes } = await sync.sync_targets(deleted, OPTIONS, make_deps(aspace));
            expect(outcomes).toEqual([{ target: deleted[0], result: null }]);
        });

        it('never reads a contested record', async () => {
            const aspace = make_aspace([]);
            const contested = sync.build_targets([
                row(),
                row({ pid: TWIN, handle: handle(TWIN) }),
            ]).targets;
            const { outcomes } = await sync.sync_targets(contested, OPTIONS, make_deps(aspace));
            expect(aspace.calls.sets).toEqual([]);
            expect(outcomes[0].result.state).toBe('contested');
        });

        describe('when updates fail', () => {
            const pid_of = (n) => `00000000-0000-4000-8000-00000000000${n}`;
            const uri_of = (n) => `/repositories/2/archival_objects/${100 + n}`;
            const many = (count) => {
                const numbers = Array.from({ length: count }, (_, i) => i + 1);
                return {
                    targets: sync.build_targets(
                        numbers.map((n) =>
                            row({ pid: pid_of(n), handle: handle(pid_of(n)), uri: uri_of(n) })
                        )
                    ).targets,
                    records: numbers.map((n) => archival_object({ uri: uri_of(n), instances: [] })),
                };
            };
            const execute = { ...OPTIONS, execute: true };

            it('carries on with the next record when one update throws', async () => {
                const { targets: two, records: both } = many(2);
                const aspace = make_aspace(both);
                const update = aspace.update_record;
                aspace.update_record = async (uri, record) => {
                    if (uri === uri_of(1)) {
                        throw new Error('ArchivesSpace update failed: timeout of 15000ms exceeded');
                    }
                    return update(uri, record);
                };

                const { outcomes, halted } = await sync.sync_targets(
                    two,
                    execute,
                    make_deps(aspace)
                );
                expect(outcomes.map((outcome) => outcome.result.state)).toEqual([
                    'failed',
                    'updated',
                ]);
                expect(outcomes[0].result.error).toBe(
                    `${uri_of(1)}: ArchivesSpace update failed: timeout of 15000ms exceeded`
                );
                expect(aspace.store.get(uri_of(2)).external_documents).toHaveLength(1);
                expect(halted).toBeNull();
            });

            it('stops after five failed updates in a row and says why', async () => {
                const { targets: seven, records: all } = many(7);
                const aspace = make_aspace(all, { update_statuses: Array(7).fill(400) });

                const { outcomes, halted } = await sync.sync_targets(
                    seven,
                    execute,
                    make_deps(aspace)
                );
                expect(sync.MAX_FAILURES_IN_A_ROW).toBe(5);
                expect(outcomes).toHaveLength(5);
                expect(outcomes.every((outcome) => outcome.result.state === 'failed')).toBe(true);
                expect(aspace.calls.posts).toHaveLength(5);
                expect(halted).toBe(
                    `5 updates in a row failed. Last: ${uri_of(5)}: HTTP 400: refused 400`
                );
            });

            it('starts counting again after an update that works', async () => {
                const { targets: nine, records: all } = many(9);
                const statuses = [400, 400, 400, 400, 200, 400, 400, 400, 400];
                const aspace = make_aspace(all, { update_statuses: statuses });

                const { outcomes, halted } = await sync.sync_targets(
                    nine,
                    execute,
                    make_deps(aspace)
                );
                expect(outcomes).toHaveLength(9);
                expect(halted).toBeNull();
            });

            it('carries the count from one call to the next', async () => {
                const { targets: three, records: all } = many(3);
                const aspace = make_aspace(all, { update_statuses: Array(3).fill(400) });

                const first = await sync.sync_targets(
                    three.slice(0, 2),
                    execute,
                    make_deps(aspace)
                );
                expect(first).toMatchObject({ failures_in_a_row: 2, halted: null });

                const second = await sync.sync_targets(
                    three.slice(2),
                    { ...execute, failures_in_a_row: 4 },
                    make_deps(aspace)
                );
                expect(second.failures_in_a_row).toBe(5);
                expect(second.halted).toMatch(/^5 updates in a row failed/);
            });

            it('does not count records that needed no update', async () => {
                const { targets: six, records: all } = many(6);
                all[2] = archival_object({
                    uri: uri_of(3),
                    instances: [],
                    external_documents: [link_doc(handle(pid_of(3)))],
                });
                const aspace = make_aspace(all, { update_statuses: Array(5).fill(400) });

                const { outcomes, halted } = await sync.sync_targets(
                    six,
                    execute,
                    make_deps(aspace)
                );
                expect(outcomes.map((outcome) => outcome.result.state)).toEqual([
                    'failed',
                    'failed',
                    'in_sync',
                    'failed',
                    'failed',
                    'failed',
                ]);
                expect(halted).toMatch(/^5 updates in a row failed/);
            });
        });

        it('throws when ArchivesSpace cannot list the records', async () => {
            const aspace = make_aspace(records(), { fail_reads: true });
            await expect(sync.sync_targets(targets(), OPTIONS, make_deps(aspace))).rejects.toThrow(
                /could not list \/repositories\/2\/archival_objects \(HTTP 503/
            );
        });
    });
});
