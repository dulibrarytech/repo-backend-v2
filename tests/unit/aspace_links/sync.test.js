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
    UNREACHABLE,
} = require('../../helpers/aspace_links');

const OPTIONS = { prefix: '10176' };

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

    describe('load_targets', () => {
        it('reads only the rows of the records asked for', async () => {
            const loaders = {
                load_rows_for: vi.fn(async () => [
                    row(),
                    row({ pid: GONE, handle: handle(GONE), is_active: 0 }),
                ]),
                load_rows: vi.fn(async () => []),
            };
            const found = await sync.load_targets([AO], loaders);
            expect([...found.keys()]).toEqual([AO]);
            expect(found.get(AO).live.map((r) => r.pid)).toEqual([PID]);
            expect(found.get(AO).deleted.map((r) => r.pid)).toEqual([GONE]);
            expect(loaders.load_rows_for).toHaveBeenCalledWith([AO]);
            expect(loaders.load_rows).not.toHaveBeenCalled();
        });

        it('reads every row when a record cannot be found by the start of its uri', async () => {
            const padded = row({ uri: ` ${AO}` });
            const loaders = {
                load_rows_for: vi.fn(async () => []),
                load_rows: vi.fn(async () => [padded, row({ pid: TWIN, uri: RESOURCE })]),
            };
            const found = await sync.load_targets([AO], loaders);
            expect(found.get(AO).live).toEqual([padded]);
            expect(loaders.load_rows).toHaveBeenCalledTimes(1);
        });

        it('notes the handle each record is remembered to have been linked with', async () => {
            const loaders = {
                load_rows_for: async () => [row(), row({ pid: TWIN, uri: RESOURCE })],
                load_rows: async () => [],
                linked_handles: vi.fn(
                    async () =>
                        new Map([
                            [AO, handle(PID)],
                            ['/repositories/2/archival_objects/9', handle(GONE)],
                        ])
                ),
            };
            const found = await sync.load_targets([AO, RESOURCE], loaders);
            expect(loaders.linked_handles).toHaveBeenCalledWith([AO, RESOURCE]);
            expect(found.get(AO).linked).toBe(handle(PID));
            expect(found.get(RESOURCE)).not.toHaveProperty('linked');
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

        it.each([true, false])(
            'reports a link left behind by a deleted object, published %s, and changes nothing',
            (shown) => {
                const target = target_of(row({ pid: GONE, handle: handle(GONE), is_active: 0 }));
                const record = archival_object({
                    external_documents: [link_doc(old_handle(GONE), { publish: shown })],
                });
                const assessed = sync.assess(target, record, no_digital_objects, OPTIONS);
                expect(assessed).toEqual({
                    result: { uri: AO, pids: [GONE], state: 'orphan_link' },
                    changes: [],
                });
            }
        );

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

        it('finds a record in sync when its link holds the handle, whatever its digital object says', () => {
            const record = archival_object({ external_documents: [link_doc(old_handle(PID))] });
            const digital_objects = new Map([[DO, digital_object()]]);
            const assessed = sync.assess(target_of(row()), record, digital_objects, OPTIONS);
            expect(assessed).toEqual({
                result: {
                    uri: AO,
                    pids: [PID],
                    state: 'in_sync',
                    handle: handle(PID),
                    link: 'none',
                },
                changes: [],
            });
        });

        it.each([
            ['published', 1],
            ['not published', 0],
        ])(
            'plans the identifier first and the link second for a new object, %s',
            (_label, is_published) => {
                const digital_objects = new Map([[DO, digital_object()]]);
                const assessed = sync.assess(
                    target_of(row({ is_published })),
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
            }
        );

        it('leaves a link that a deleted object left on the record, and asks for a review', () => {
            const target = target_of(row(), row({ pid: GONE, handle: handle(GONE), is_active: 0 }));
            const record = archival_object({ external_documents: [link_doc(old_handle(GONE))] });
            const digital_objects = new Map([
                [DO, digital_object({ digital_object_id: old_handle(GONE) })],
            ]);
            const assessed = sync.assess(target, record, digital_objects, OPTIONS);
            expect(assessed).toEqual({
                result: {
                    uri: AO,
                    pids: [PID],
                    state: 'needs_review',
                    handle: handle(PID),
                    link: 'other_link',
                    link_previous: old_handle(GONE),
                    note:
                        `The record already links to ${old_handle(GONE)}. To replace it, ` +
                        'remove that link in ArchivesSpace, then use Check these again.',
                },
                changes: [],
            });
        });

        it('writes identifier and link once staff have removed the link a deleted object left', () => {
            const target = target_of(row(), row({ pid: GONE, handle: handle(GONE), is_active: 0 }));
            const digital_objects = new Map([
                [DO, digital_object({ digital_object_id: old_handle(GONE) })],
            ]);
            const assessed = sync.assess(target, archival_object(), digital_objects, OPTIONS);
            expect(assessed.result).toMatchObject({
                state: 'pending',
                link: 'add',
                digital_object: 'update',
                digital_object_previous: old_handle(GONE),
            });
            expect(assessed.changes.map((change) => change.uri)).toEqual([DO, AO]);
        });

        it('plans only the link when the identifier already holds the handle', () => {
            const digital_objects = new Map([
                [DO, digital_object({ digital_object_id: old_handle(PID) })],
            ]);
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
                digital_object: 'none',
                digital_object_uri: DO,
            });
            expect(assessed.changes.map((change) => change.field)).toEqual(['link']);
        });

        it('adds the link of a collection record but leaves its digital objects alone', () => {
            const target = target_of(row({ object_type: 'collection' }));
            const assessed = sync.assess(
                target,
                archival_object(),
                new Map([[DO, digital_object()]]),
                OPTIONS
            );
            expect(assessed.result).toMatchObject({
                state: 'pending',
                link: 'add',
                digital_object: 'absent',
            });
            expect(assessed.changes.map((change) => change.uri)).toEqual([AO]);
        });

        it('holds the link back, and asks for a review, when the digital object could not be read', () => {
            const assessed = sync.assess(
                target_of(row()),
                archival_object(),
                no_digital_objects,
                OPTIONS
            );
            expect(assessed).toEqual({
                result: {
                    uri: AO,
                    pids: [PID],
                    state: 'needs_review',
                    handle: handle(PID),
                    link: 'add',
                    digital_object: 'not_found',
                    digital_object_uri: DO,
                    note: 'The digital object attached to the record could not be read.',
                },
                changes: [],
            });
        });

        it('holds the link back, and asks for a review, when the digital object is shared with another record', () => {
            const shared = digital_object({
                linked_instances: [{ ref: AO }, { ref: '/repositories/2/archival_objects/9' }],
            });
            const assessed = sync.assess(
                target_of(row()),
                archival_object(),
                new Map([[DO, shared]]),
                OPTIONS
            );
            expect(assessed).toEqual({
                result: {
                    uri: AO,
                    pids: [PID],
                    state: 'needs_review',
                    handle: handle(PID),
                    link: 'add',
                    digital_object: 'shared',
                    digital_object_uri: DO,
                    note: 'The digital object is also attached to another record.',
                },
                changes: [],
            });
        });

        it('writes the identifier when the digital object is attached to this record only', () => {
            const own = digital_object({ linked_instances: [{ ref: AO }] });
            const assessed = sync.assess(
                target_of(row()),
                archival_object(),
                new Map([[DO, own]]),
                OPTIONS
            );
            expect(assessed.changes.map((change) => change.uri)).toEqual([DO, AO]);
        });

        it('holds the link back, and asks for a review, when the record has two digital objects', () => {
            const second = { instance_type: 'digital_object', digital_object: { ref: `${DO}9` } };
            const record = archival_object();
            record.instances.push(second);
            const assessed = sync.assess(target_of(row()), record, no_digital_objects, OPTIONS);
            expect(assessed).toEqual({
                result: {
                    uri: AO,
                    pids: [PID],
                    state: 'needs_review',
                    handle: handle(PID),
                    link: 'add',
                    digital_object: 'multiple',
                    note: 'More than one digital object is attached to the record.',
                },
                changes: [],
            });
        });

        describe('a record remembered to have had its link', () => {
            const remembered = (...rows) => ({ ...target_of(...rows), linked: old_handle(PID) });
            const digital_objects = new Map([[DO, digital_object()]]);

            it('is not linked a second time once the link is gone', () => {
                const assessed = sync.assess(
                    remembered(row()),
                    archival_object(),
                    digital_objects,
                    OPTIONS
                );
                expect(assessed).toEqual({
                    result: {
                        uri: AO,
                        pids: [PID],
                        linked: old_handle(PID),
                        state: 'link_removed',
                        handle: handle(PID),
                        link: 'add',
                    },
                    changes: [],
                });
            });

            it('reads as up to date again once staff put the link back', () => {
                const record = archival_object({ external_documents: [link_doc(handle(PID))] });
                const assessed = sync.assess(remembered(row()), record, digital_objects, OPTIONS);
                expect(assessed.result).toMatchObject({
                    state: 'in_sync',
                    linked: old_handle(PID),
                });
            });

            it.each([
                ['two objects share the record', [row(), row({ pid: TWIN, handle: handle(TWIN) })]],
                ['the record is gone from ArchivesSpace', [row()], undefined],
                [
                    'the link points somewhere else',
                    [row()],
                    archival_object({ external_documents: [link_doc(handle(GONE))] }),
                ],
                [
                    'the record has two repository links',
                    [row()],
                    archival_object({
                        external_documents: [link_doc(handle(GONE)), link_doc(handle(TWIN))],
                    }),
                ],
            ])('is still remembered when %s', (_label, rows, record) => {
                const assessed = sync.assess(remembered(...rows), record, digital_objects, OPTIONS);
                expect(assessed.result.linked).toBe(old_handle(PID));
                expect(assessed.changes).toEqual([]);
            });

            it.each([
                ['another object now holds the record', { linked: handle(GONE) }],
                ['what was remembered is not a handle', { linked: 'Error: Unable to create' }],
                ['nothing was remembered', {}],
            ])('is linked as usual when %s', (_label, memory) => {
                const assessed = sync.assess(
                    { ...target_of(row()), ...memory },
                    archival_object(),
                    digital_objects,
                    OPTIONS
                );
                expect(assessed.result).not.toHaveProperty('linked');
                expect(assessed.result.state).toBe('pending');
                expect(assessed.changes.map((change) => change.uri)).toEqual([DO, AO]);
            });

            it('forgets the link of an object that has since been deleted', () => {
                const target = remembered(row({ is_active: 0 }));
                const record = archival_object({ external_documents: [link_doc(handle(PID))] });
                const assessed = sync.assess(target, record, digital_objects, OPTIONS);
                expect(assessed.result).toEqual({ uri: AO, pids: [PID], state: 'orphan_link' });
            });
        });

        it('leaves the link of an object that is not published where it is', () => {
            const record = archival_object({ external_documents: [link_doc(old_handle(PID))] });
            const assessed = sync.assess(
                target_of(row({ is_published: 0 })),
                record,
                no_digital_objects,
                OPTIONS
            );
            expect(assessed).toEqual({
                result: {
                    uri: AO,
                    pids: [PID],
                    state: 'in_sync',
                    handle: handle(PID),
                    link: 'none',
                },
                changes: [],
            });
        });

        it('reports a link staff unpublished, and leaves it unpublished', () => {
            const record = archival_object({
                instances: [],
                external_documents: [link_doc(old_handle(PID), { publish: false })],
            });
            const assessed = sync.assess(target_of(row()), record, no_digital_objects, OPTIONS);
            expect(assessed).toEqual({
                result: {
                    uri: AO,
                    pids: [PID],
                    state: 'unpublished_link',
                    handle: handle(PID),
                    link: 'unpublished',
                },
                changes: [],
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
            expect(outcome).toEqual({ ok: true, written: { action: 'add', previous: null } });
            expect(aspace.calls.posts).toHaveLength(1);
            expect(aspace.calls.gets).toEqual([]);
        });

        it('reports what it wrote and the value it replaced', async () => {
            const aspace = make_aspace([archival_object(), digital_object()]);
            const digital_objects = new Map([[DO, aspace.store.get(DO)]]);
            const assessed = sync.assess(
                target_of(row()),
                aspace.store.get(AO),
                digital_objects,
                OPTIONS
            );
            expect(assessed.changes[0]).toMatchObject({ uri: DO, field: 'digital_object_id' });

            const outcome = await sync.write_change(assessed.changes[0], make_deps(aspace));
            expect(outcome).toEqual({
                ok: true,
                written: { action: 'update', previous: 'B133.01.0003.00001' },
            });
        });

        it('re-reads and re-plans once after a 409 conflict', async () => {
            const aspace = make_aspace([archival_object(), digital_object()], {
                update_statuses: [409],
            });
            const change = change_for(aspace);
            aspace.store.set(AO, archival_object({ lock_version: 15, title: 'Edited by staff' }));

            const outcome = await sync.write_change(change, make_deps(aspace));
            expect(outcome).toEqual({ ok: true, written: { action: 'add', previous: null } });
            expect(aspace.calls.gets).toEqual([AO]);
            expect(aspace.calls.posts).toHaveLength(2);
            expect(aspace.calls.posts[1].record).toMatchObject({
                lock_version: 15,
                title: 'Edited by staff',
            });
            expect(aspace.calls.posts[1].record.external_documents[0].location).toBe(handle(PID));
        });

        it('counts the write as made when the fresh record carries the link after a 409', async () => {
            const aspace = make_aspace([archival_object(), digital_object()], {
                update_statuses: [409],
            });
            const change = change_for(aspace);
            aspace.store.set(
                AO,
                archival_object({ lock_version: 15, external_documents: [link_doc(handle(PID))] })
            );

            const outcome = await sync.write_change(change, make_deps(aspace));
            expect(outcome).toEqual({ ok: true, written: { action: 'add', previous: null } });
            expect(aspace.calls.posts).toHaveLength(1);
        });

        it('writes nothing over a link to another object that appeared meanwhile', async () => {
            const aspace = make_aspace([archival_object(), digital_object()], {
                update_statuses: [409],
            });
            const change = change_for(aspace);
            aspace.store.set(
                AO,
                archival_object({ lock_version: 15, external_documents: [link_doc(handle(TWIN))] })
            );

            const outcome = await sync.write_change(change, make_deps(aspace));
            expect(outcome).toEqual({
                ok: false,
                error: 'the record changed while it was being updated; run again',
            });
            expect(aspace.calls.posts).toHaveLength(1);
        });

        it('writes nothing, and claims nothing, when staff unpublished the link meanwhile', async () => {
            const aspace = make_aspace([archival_object(), digital_object()], {
                update_statuses: [409],
            });
            const change = change_for(aspace);
            aspace.store.set(
                AO,
                archival_object({
                    lock_version: 15,
                    external_documents: [link_doc(handle(PID), { publish: false })],
                })
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

        it('re-plans again while ArchivesSpace keeps answering 409, up to three times', async () => {
            const aspace = make_aspace([archival_object(), digital_object()], {
                update_statuses: [409, 409, 409],
            });
            const outcome = await sync.write_change(change_for(aspace), make_deps(aspace));
            expect(outcome.ok).toBe(true);
            expect(aspace.calls.gets).toHaveLength(3);
            expect(aspace.calls.posts).toHaveLength(4);
        });

        it('reports the conflict after the third re-plan is refused too', async () => {
            const aspace = make_aspace([archival_object(), digital_object()], {
                update_statuses: [409, 409, 409, 409],
            });
            const outcome = await sync.write_change(change_for(aspace), make_deps(aspace));
            expect(outcome).toEqual({ ok: false, error: 'HTTP 409: refused 409' });
            expect(aspace.calls.posts).toHaveLength(4);
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

        it('marks the record failed, names what was refused, and holds its link back', async () => {
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
            expect(aspace.calls.posts.map((post) => post.uri)).toEqual([DO]);
            expect(aspace.store.get(AO).external_documents).toEqual([]);
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

        it('hands over each write and each outcome as soon as it is made', async () => {
            const aspace = make_aspace(records());
            const seen = [];
            const deps = {
                ...make_deps(aspace),
                on_written: async (entry) => seen.push(entry),
                on_outcome: async ({ target, result }) =>
                    seen.push(`${target.uri} ${result.state}`),
            };
            await sync.sync_targets(targets(), { ...OPTIONS, execute: true }, deps);

            expect(seen).toEqual([
                {
                    record_uri: AO,
                    uri: DO,
                    field: 'digital_object_id',
                    action: 'update',
                    previous: 'B133.01.0003.00001',
                    value: handle(PID),
                    pids: [PID],
                },
                {
                    record_uri: AO,
                    uri: AO,
                    field: 'link',
                    action: 'add',
                    previous: null,
                    value: handle(PID),
                    pids: [PID],
                },
                `${AO} updated`,
                `${RESOURCE} in_sync`,
            ]);
        });

        it('stops between records when asked to, before reading the next listing', async () => {
            const aspace = make_aspace(records());
            let stop = false;
            const deps = {
                ...make_deps(aspace),
                on_outcome: async () => {
                    stop = true;
                },
                should_stop: () => stop,
            };
            const { outcomes, halted } = await sync.sync_targets(targets(), OPTIONS, deps);

            expect(outcomes.map((outcome) => outcome.target.uri)).toEqual([AO]);
            expect(halted).toBeNull();
            expect(aspace.calls.sets.map((set) => set.listing)).toEqual([
                '/repositories/2/archival_objects',
                '/repositories/2/digital_objects',
            ]);
        });

        it('writes the identifier and the link of an object that is not published yet', async () => {
            const aspace = make_aspace([archival_object(), digital_object()]);
            const { outcomes } = await sync.sync_targets(
                sync.build_targets([row({ is_published: 0 })]).targets,
                { ...OPTIONS, execute: true },
                make_deps(aspace)
            );
            expect(aspace.calls.posts.map((post) => post.uri)).toEqual([DO, AO]);
            expect(outcomes[0].result.state).toBe('updated');
        });

        it('reads no digital object for a record that already has its link', async () => {
            const linked = archival_object({ external_documents: [link_doc(handle(PID))] });
            const aspace = make_aspace([linked, digital_object()]);
            const { outcomes } = await sync.sync_targets(
                sync.build_targets([row()]).targets,
                { ...OPTIONS, execute: true },
                make_deps(aspace)
            );
            expect(aspace.calls.sets.map((set) => set.listing)).toEqual([
                '/repositories/2/archival_objects',
            ]);
            expect(aspace.calls.posts).toEqual([]);
            expect(outcomes[0].result.state).toBe('in_sync');
        });

        it.each([
            ['points at another object', [link_doc(handle(TWIN))], {}],
            ['is not published', [link_doc(handle(PID), { publish: false })], {}],
            ['was removed after the record had it', [], { linked: handle(PID) }],
        ])(
            'reads no digital object for a record whose link %s',
            async (_label, documents, memory) => {
                const record = archival_object({ external_documents: documents });
                const aspace = make_aspace([record, digital_object()]);
                const [target] = sync.build_targets([row()]).targets;
                await sync.sync_targets(
                    [{ ...target, ...memory }],
                    { ...OPTIONS, execute: true },
                    make_deps(aspace)
                );
                expect(aspace.calls.sets.map((set) => set.listing)).toEqual([
                    '/repositories/2/archival_objects',
                ]);
                expect(aspace.calls.posts).toEqual([]);
            }
        );

        it('reads nothing for an object without a usable handle', async () => {
            const aspace = make_aspace([archival_object(), digital_object()]);
            const { outcomes } = await sync.sync_targets(
                sync.build_targets([row({ handle: 'Error: Unable to create new handle' })]).targets,
                { ...OPTIONS, execute: true },
                make_deps(aspace)
            );
            expect(aspace.calls.sets).toEqual([]);
            expect(outcomes[0].result.state).toBe('invalid_handle');
        });

        it('writes nothing for a record with two digital objects, and asks for a review', async () => {
            const record = archival_object();
            record.instances.push({
                instance_type: 'digital_object',
                digital_object: { ref: `${DO}9` },
            });
            const aspace = make_aspace([record, digital_object()]);
            const { outcomes } = await sync.sync_targets(
                sync.build_targets([row()]).targets,
                { ...OPTIONS, execute: true },
                make_deps(aspace)
            );
            expect(outcomes[0].result).toMatchObject({
                state: 'needs_review',
                link: 'add',
                digital_object: 'multiple',
                note: 'More than one digital object is attached to the record.',
            });
            expect(aspace.calls.posts).toEqual([]);
        });

        describe('just before a write', () => {
            const run_with = (aspace, loaders) =>
                sync.sync_targets(
                    sync.build_targets([row()]).targets,
                    { ...OPTIONS, execute: true },
                    { ...make_deps(aspace), loaders: { load_rows: async () => [], ...loaders } }
                );

            it('reads the object again and writes when nothing has changed', async () => {
                const aspace = make_aspace([archival_object(), digital_object()]);
                const load_rows_for = vi.fn(async () => [row()]);
                const { outcomes } = await run_with(aspace, { load_rows_for });
                expect(load_rows_for).toHaveBeenCalledWith([AO]);
                expect(aspace.calls.posts.map((post) => post.uri)).toEqual([DO, AO]);
                expect(outcomes[0].result.state).toBe('updated');
            });

            it('writes nothing for an object deleted since the batch was read', async () => {
                const aspace = make_aspace([archival_object(), digital_object()]);
                const { outcomes } = await run_with(aspace, {
                    load_rows_for: async () => [row({ is_active: 0 })],
                });
                expect(aspace.calls.posts).toEqual([]);
                expect(outcomes[0].result).toBeNull();
            });

            it('writes nothing once a second object shares the record', async () => {
                const aspace = make_aspace([archival_object(), digital_object()]);
                const { outcomes } = await run_with(aspace, {
                    load_rows_for: async () => [row(), row({ pid: TWIN, handle: handle(TWIN) })],
                });
                expect(aspace.calls.posts).toEqual([]);
                expect(outcomes[0].result).toMatchObject({
                    state: 'contested',
                    pids: [PID, TWIN],
                });
            });

            it('writes nothing when the object is gone altogether', async () => {
                const aspace = make_aspace([archival_object(), digital_object()]);
                const { outcomes } = await run_with(aspace, { load_rows_for: async () => [] });
                expect(aspace.calls.posts).toEqual([]);
                expect(outcomes[0].result).toBeNull();
            });

            it('does not read again a record that needs no write', async () => {
                const linked = archival_object({ external_documents: [link_doc(handle(PID))] });
                const load_rows_for = vi.fn(async () => [row()]);
                await run_with(make_aspace([linked, digital_object()]), { load_rows_for });
                expect(load_rows_for).not.toHaveBeenCalled();
            });
        });

        it('gives up the whole call at once when ArchivesSpace refuses the login', async () => {
            const refused = Object.assign(new Error('ArchivesSpace login rejected: HTTP 403'), {
                status: 401,
            });
            let requests = 0;
            const deps = {
                ...make_deps(make_aspace(records())),
                request: async () => {
                    requests += 1;
                    throw refused;
                },
            };
            await expect(sync.sync_targets(targets(), OPTIONS, deps)).rejects.toBe(refused);
            expect(requests).toBe(1);
        });

        it('gives up the whole call when the login is refused for a write', async () => {
            const refused = Object.assign(new Error('ArchivesSpace login rejected: HTTP 403'), {
                status: 401,
            });
            const aspace = make_aspace(records());
            aspace.update_record = async () => {
                throw refused;
            };
            await expect(
                sync.sync_targets(targets(), { ...OPTIONS, execute: true }, make_deps(aspace))
            ).rejects.toBe(refused);
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
                const aspace = make_aspace(all, { update_statuses: Array(7).fill(503) });

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
                    `5 updates in a row failed. Last: ${uri_of(5)}: ` +
                        `ArchivesSpace ${uri_of(5)} returned HTTP 503: refused 503`
                );
            });

            it.each([500, 429])(
                'counts an update answered with %i toward the stop',
                async (status) => {
                    const { targets: five, records: all } = many(5);
                    const aspace = make_aspace(all, { update_statuses: Array(5).fill(status) });
                    const { halted } = await sync.sync_targets(five, execute, make_deps(aspace));
                    expect(halted).toMatch(/^5 updates in a row failed/);
                }
            );

            it('does not stop for updates ArchivesSpace refuses for a reason of the record', async () => {
                const { targets: seven, records: all } = many(7);
                const statuses = [400, 403, 409, 409, 409, 409, 422, 404, 400, 400];
                const aspace = make_aspace(all, { update_statuses: statuses });

                const { outcomes, halted, failures_in_a_row } = await sync.sync_targets(
                    seven,
                    execute,
                    make_deps(aspace)
                );
                expect(outcomes).toHaveLength(7);
                expect(outcomes.every((outcome) => outcome.result.state === 'failed')).toBe(true);
                expect(halted).toBeNull();
                expect(failures_in_a_row).toBe(0);
            });

            it('starts counting again after an update that works', async () => {
                const { targets: nine, records: all } = many(9);
                const statuses = [503, 503, 503, 503, 200, 503, 503, 503, 503];
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
                const aspace = make_aspace(all, { update_statuses: Array(3).fill(503) });

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

            it('starts a call at most one failure short of stopping', async () => {
                const { targets: one, records: all } = many(1);
                all[0] = archival_object({
                    uri: uri_of(1),
                    instances: [],
                    external_documents: [link_doc(handle(pid_of(1)))],
                });
                const result = await sync.sync_targets(
                    one,
                    { ...execute, failures_in_a_row: 9 },
                    make_deps(make_aspace(all))
                );
                expect(result).toMatchObject({ failures_in_a_row: 4, halted: null });
            });

            it('does not count records that needed no update', async () => {
                const { targets: six, records: all } = many(6);
                all[2] = archival_object({
                    uri: uri_of(3),
                    instances: [],
                    external_documents: [link_doc(handle(pid_of(3)))],
                });
                const aspace = make_aspace(all, { update_statuses: Array(5).fill(503) });

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

        it('throws, after one look at the repository, when ArchivesSpace cannot be reached', async () => {
            const aspace = make_aspace(records(), { down: true });
            await expect(sync.sync_targets(targets(), OPTIONS, make_deps(aspace))).rejects.toThrow(
                UNREACHABLE
            );
            expect(aspace.calls.sets).toHaveLength(1);
            expect(aspace.calls.gets).toEqual(['/repositories/2']);
        });

        describe('when a listing cannot be read', () => {
            const uri_of = (n) => `/repositories/2/archival_objects/${100 + n}`;
            const pid_of = (n) => `00000000-0000-4000-8000-00000000000${n}`;
            const several = (count) => {
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
            const refusing = (aspace, refuse, status = 500) => {
                const list = aspace.get_native_set;
                aspace.get_native_set = async (listing, ids) => {
                    if (!refuse(listing, ids)) return list(listing, ids);
                    aspace.calls.sets.push({ listing, ids });
                    return { status, data: { error: 'could not serialize' } };
                };
                return aspace;
            };

            it('still remembers that a record had its link when the record cannot be read', async () => {
                const { targets: all, records } = several(1);
                const aspace = refusing(make_aspace(records), () => true, 400);
                const [target] = all;
                const { outcomes } = await sync.sync_targets(
                    [{ ...target, linked: handle(pid_of(1)) }],
                    OPTIONS,
                    make_deps(aspace)
                );
                expect(outcomes[0].result).toMatchObject({
                    state: 'needs_review',
                    linked: handle(pid_of(1)),
                });
            });

            it('narrows the read down to the record it cannot read, and reports only that one', async () => {
                const { targets: all, records } = several(3);
                const aspace = refusing(make_aspace(records), (listing, ids) => ids.includes(102));
                const { outcomes } = await sync.sync_targets(all, OPTIONS, make_deps(aspace));

                expect(aspace.calls.sets.map((set) => set.ids)).toEqual([
                    [101, 102, 103],
                    [101, 102],
                    [101],
                    [102],
                    [103],
                ]);
                expect(aspace.calls.gets).toEqual(Array(3).fill('/repositories/2'));
                expect(outcomes.map((outcome) => outcome.result.state)).toEqual([
                    'pending',
                    'needs_review',
                    'pending',
                ]);
                expect(outcomes[1].result).toEqual({
                    uri: uri_of(2),
                    pids: [pid_of(2)],
                    state: 'needs_review',
                    error:
                        'ArchivesSpace /repositories/2/archival_objects returned HTTP 500: ' +
                        'could not serialize',
                });
            });

            it('needs a few reads, not one per record, to find one bad record in a hundred', async () => {
                const { targets: all, records } = several(100);
                const aspace = refusing(make_aspace(records), (listing, ids) => ids.includes(137));
                const { outcomes } = await sync.sync_targets(all, OPTIONS, make_deps(aspace));

                expect(aspace.calls.sets.length).toBeLessThanOrEqual(15);
                expect(aspace.calls.gets.length).toBeLessThanOrEqual(8);
                expect(
                    outcomes.filter((outcome) => outcome.result.state === 'pending')
                ).toHaveLength(99);
                expect(
                    outcomes.find((outcome) => outcome.result.state === 'needs_review').target.uri
                ).toBe(uri_of(37));
            });

            it('reports every record of a listing ArchivesSpace refuses, without reading it again', async () => {
                const { targets: all, records } = several(3);
                const aspace = refusing(make_aspace(records), () => true, 403);
                const { outcomes, halted } = await sync.sync_targets(
                    all,
                    OPTIONS,
                    make_deps(aspace)
                );

                expect(aspace.calls.sets).toHaveLength(1);
                expect(aspace.calls.gets).toEqual([]);
                expect(outcomes.map((outcome) => outcome.result.state)).toEqual(
                    Array(3).fill('needs_review')
                );
                expect(halted).toBeNull();
            });

            it('holds back the link of a record whose digital object cannot be read', async () => {
                const aspace = refusing(
                    make_aspace([archival_object(), digital_object()]),
                    (listing) => listing.endsWith('/digital_objects')
                );
                const { outcomes } = await sync.sync_targets(
                    sync.build_targets([row()]).targets,
                    { ...OPTIONS, execute: true },
                    make_deps(aspace)
                );
                expect(aspace.calls.posts).toEqual([]);
                expect(outcomes[0].result).toMatchObject({
                    state: 'needs_review',
                    link: 'add',
                    digital_object: 'not_found',
                    note: 'The digital object attached to the record could not be read.',
                });
            });

            it('does not let one listing that fails hold up another', async () => {
                const aspace = refusing(make_aspace(records()), (listing) =>
                    listing.endsWith('/resources')
                );
                const { outcomes } = await sync.sync_targets(targets(), OPTIONS, make_deps(aspace));
                expect(outcomes.map((outcome) => outcome.result.state)).toEqual([
                    'pending',
                    'needs_review',
                ]);
                expect(outcomes[1].target.uri).toBe(RESOURCE);
            });

            it('syncs every record when the smaller reads work', async () => {
                const { targets: all, records } = several(3);
                let refusals = 2;
                const aspace = refusing(make_aspace(records), (listing, ids) => {
                    if (!ids.includes(102) || refusals === 0) return false;
                    refusals -= 1;
                    return true;
                });
                const { outcomes } = await sync.sync_targets(all, OPTIONS, make_deps(aspace));
                expect(outcomes.map((outcome) => outcome.result.state)).toEqual(
                    Array(3).fill('pending')
                );
            });

            it('puts everything off when ArchivesSpace goes down partway through', async () => {
                const { targets: all, records } = several(3);
                const aspace = make_aspace(records);
                refusing(aspace, () => {
                    aspace.go_down();
                    return true;
                });
                const outcomes = [];
                const deps = {
                    ...make_deps(aspace),
                    on_outcome: async (outcome) => outcomes.push(outcome),
                };

                await expect(sync.sync_targets(all, OPTIONS, deps)).rejects.toThrow(
                    'ArchivesSpace /repositories/2/archival_objects returned HTTP 500'
                );
                expect(aspace.calls.sets).toHaveLength(1);
                expect(outcomes).toEqual([]);
            });

            it('puts everything off when five records in a row cannot be read', async () => {
                const { targets: six } = several(6);
                const aspace = make_aspace([], { fail_reads: true });
                const outcomes = [];
                const deps = {
                    ...make_deps(aspace),
                    on_outcome: async (outcome) => outcomes.push(outcome),
                };

                await expect(sync.sync_targets(six, OPTIONS, deps)).rejects.toThrow(
                    'ArchivesSpace /repositories/2/archival_objects returned HTTP 503'
                );
                expect(aspace.calls.sets.filter((set) => set.ids.length === 1)).toHaveLength(5);
                expect(aspace.calls.sets.length).toBeLessThanOrEqual(10);
                expect(outcomes).toEqual([]);
            });
        });
    });
});
