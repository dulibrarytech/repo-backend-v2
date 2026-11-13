'use strict';

const link = require('../../../libs/aspace_link');

const PID = '8fd73006-4c1c-478a-989f-153cb8afdf13';
const OTHER = 'fd9a67c7-b58c-42bf-a2d1-97175acaa96e';
const HANDLE = `https://hdl.handle.net/10176/${PID}`;
const HTTP_HANDLE = `http://hdl.handle.net/10176/${PID}`;
const OTHER_HANDLE = `http://hdl.handle.net/10176/${OTHER}`;

function doc(overrides = {}) {
    return {
        jsonmodel_type: 'external_document',
        title: 'Special Collections @ DU',
        location: HTTP_HANDLE,
        publish: true,
        ...overrides,
    };
}

function record(external_documents) {
    return { uri: '/repositories/2/archival_objects/1', lock_version: 3, external_documents };
}

describe('libs/aspace_link', () => {
    describe('handle_id', () => {
        it('reads the prefix and suffix from a handle URL', () => {
            expect(link.handle_id(HANDLE)).toBe(`10176/${PID}`);
        });

        it('gives http and https forms of one handle the same id', () => {
            expect(link.handle_id(HTTP_HANDLE)).toBe(link.handle_id(HANDLE));
        });

        it('ignores case and surrounding whitespace', () => {
            expect(link.handle_id(` ${HANDLE.toUpperCase()}\n`)).toBe(`10176/${PID}`);
        });

        it('keeps a legacy suffix', () => {
            expect(link.handle_id('http://hdl.handle.net/10136/codu:50106')).toBe(
                '10136/codu:50106'
            );
        });

        it.each([
            [
                'an error message',
                'Error: [/libs/handles lib (create_handle)] Unable to create new handle',
            ],
            ['a bare uuid', PID],
            ['another host', `https://digitalarchives.du.edu/object/${PID}`],
            ['an empty string', ''],
            ['null', null],
            ['undefined', undefined],
        ])('returns null for %s', (_label, value) => {
            expect(link.handle_id(value)).toBeNull();
        });
    });

    describe('is_link_title', () => {
        it.each([
            'Special Collections @ DU',
            'Special Collections@DU',
            'Special Collections @DU',
            'Special Collection @ DU',
            'special collections @ du ',
        ])('accepts "%s"', (title) => {
            expect(link.is_link_title(title)).toBe(true);
        });

        it.each([
            'James B. Radetsky Digital Papers',
            'View in Special Collections @ DU',
            'Digitized version (Metropolitan Museum of Art)',
            '',
            null,
        ])('rejects "%s"', (title) => {
            expect(link.is_link_title(title)).toBe(false);
        });
    });

    describe('plan_link', () => {
        it('adds a published link when the record has none', () => {
            const plan = link.plan_link(record([]), HANDLE);
            expect(plan.action).toBe('add');
            expect(plan.record.external_documents).toEqual([
                {
                    jsonmodel_type: 'external_document',
                    title: 'Special Collections @ DU',
                    location: HANDLE,
                    publish: true,
                },
            ]);
            expect(plan.record.lock_version).toBe(3);
        });

        it('adds a link when the record has no external_documents field', () => {
            const plan = link.plan_link({ uri: '/repositories/2/resources/9' }, HANDLE);
            expect(plan.action).toBe('add');
            expect(plan.record.external_documents).toHaveLength(1);
        });

        it('keeps unrelated documents when adding', () => {
            const unrelated = doc({
                title: 'Digitized version (Metropolitan Museum of Art)',
                location: 'https://www.metmuseum.org/art/collection/search/1',
            });
            const plan = link.plan_link(record([unrelated]), HANDLE);
            expect(plan.action).toBe('add');
            expect(plan.record.external_documents[0]).toBe(unrelated);
            expect(plan.record.external_documents[1].location).toBe(HANDLE);
        });

        it('never overwrites a document that lacks the repository title', () => {
            const reference = doc({
                title: 'James B. Radetsky Digital Papers',
                location: OTHER_HANDLE,
            });
            const plan = link.plan_link(record([reference]), HANDLE);
            expect(plan.action).toBe('add');
            expect(plan.record.external_documents[0]).toBe(reference);
        });

        it('needs no change when the link holds the handle under either scheme', () => {
            expect(link.plan_link(record([doc()]), HANDLE)).toEqual({ action: 'none' });
            expect(link.plan_link(record([doc({ location: HANDLE })]), HANDLE)).toEqual({
                action: 'none',
            });
        });

        it('treats a differently titled document that holds the handle as the link', () => {
            const plan = link.plan_link(
                record([doc({ title: 'View in Special Collections @ DU' })]),
                HANDLE
            );
            expect(plan).toEqual({ action: 'none' });
        });

        it('repoints a link that holds another handle, and publishes it', () => {
            const stale = doc({ location: OTHER_HANDLE, publish: false, lock_version: 7 });
            const plan = link.plan_link(record([stale]), HANDLE);
            expect(plan.action).toBe('update');
            expect(plan.previous).toBe(OTHER_HANDLE);
            expect(plan.record.external_documents).toEqual([
                { ...stale, location: HANDLE, publish: true },
            ]);
        });

        it('replaces a location that is not a handle', () => {
            const broken = doc({ location: 'Error: Unable to create new handle' });
            const plan = link.plan_link(record([broken]), HANDLE);
            expect(plan.action).toBe('update');
            expect(plan.record.external_documents[0].location).toBe(HANDLE);
        });

        it('recognises the link by a title variant and keeps that title', () => {
            const variant = doc({ title: 'Special Collections@DU', location: OTHER_HANDLE });
            const plan = link.plan_link(record([variant]), HANDLE);
            expect(plan.action).toBe('update');
            expect(plan.record.external_documents[0].title).toBe('Special Collections@DU');
        });

        it('changes only the link when the record has several documents', () => {
            const unrelated = doc({ title: 'WorldCat', location: 'https://worldcat.org/1' });
            const stale = doc({ location: OTHER_HANDLE });
            const plan = link.plan_link(record([unrelated, stale]), HANDLE);
            expect(plan.record.external_documents[0]).toBe(unrelated);
            expect(plan.record.external_documents[1].location).toBe(HANDLE);
        });

        it('reports ambiguous when two documents carry the repository title', () => {
            const plan = link.plan_link(record([doc(), doc({ location: OTHER_HANDLE })]), HANDLE);
            expect(plan).toEqual({ action: 'ambiguous' });
        });

        it('reports a correct link that is not published', () => {
            const plan = link.plan_link(record([doc({ publish: false })]), HANDLE);
            expect(plan).toEqual({ action: 'unpublished' });
        });

        it('publishes a correct link only when asked, leaving its location alone', () => {
            const plan = link.plan_link(record([doc({ publish: false })]), HANDLE, {
                publish: true,
            });
            expect(plan.action).toBe('publish');
            expect(plan.record.external_documents).toEqual([doc({ publish: true })]);
        });

        it('leaves the position of the record out of what is sent back', () => {
            const placed = (documents) => ({ ...record(documents), position: 4 });
            const added = link.plan_link(placed([]), HANDLE);
            const repointed = link.plan_link(placed([doc({ location: OTHER_HANDLE })]), HANDLE);
            const published = link.plan_link(placed([doc({ publish: false })]), HANDLE, {
                publish: true,
            });

            for (const plan of [added, repointed, published]) {
                expect(plan.record).not.toHaveProperty('position');
                expect(plan.record.lock_version).toBe(3);
            }
        });

        it('does not modify the record it was given', () => {
            const original = { ...record([doc({ location: OTHER_HANDLE })]), position: 4 };
            const before = JSON.parse(JSON.stringify(original));
            link.plan_link(original, HANDLE);
            expect(original).toEqual(before);
        });
    });

    describe('linked_handle_ids', () => {
        it('lists the handle ids found in document locations', () => {
            const found = link.linked_handle_ids(
                record([doc(), doc({ title: 'WorldCat', location: 'https://worldcat.org/1' })])
            );
            expect(found).toEqual([`10176/${PID}`]);
        });
    });

    describe('digital_object_refs', () => {
        it('lists the digital objects attached to a record', () => {
            const refs = link.digital_object_refs({
                instances: [
                    { instance_type: 'mixed_materials', sub_container: {} },
                    {
                        instance_type: 'digital_object',
                        digital_object: { ref: '/repositories/2/digital_objects/48380' },
                    },
                ],
            });
            expect(refs).toEqual(['/repositories/2/digital_objects/48380']);
        });

        it('returns an empty list when there are no instances', () => {
            expect(link.digital_object_refs({})).toEqual([]);
        });
    });

    describe('plan_digital_object', () => {
        it('needs no change when the identifier is the handle under either scheme', () => {
            const plan = link.plan_digital_object({ digital_object_id: HTTP_HANDLE }, HANDLE);
            expect(plan).toEqual({ action: 'none' });
        });

        it('replaces a component id with the handle', () => {
            const digital_object = { digital_object_id: 'B133.01.0003.00001', lock_version: 1 };
            const plan = link.plan_digital_object(digital_object, HANDLE);
            expect(plan.action).toBe('update');
            expect(plan.previous).toBe('B133.01.0003.00001');
            expect(plan.record).toEqual({ digital_object_id: HANDLE, lock_version: 1 });
            expect(digital_object.digital_object_id).toBe('B133.01.0003.00001');
        });

        it('replaces the handle of another object', () => {
            const plan = link.plan_digital_object({ digital_object_id: OTHER_HANDLE }, HANDLE);
            expect(plan.action).toBe('update');
            expect(plan.record.digital_object_id).toBe(HANDLE);
        });
    });
});
