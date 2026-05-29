'use strict';

// Unit tests for libs/archivesspace_transform — the pure transformer
// that turns a resolve-references-expanded ArchivesSpace JSON record
// into the flat shape the QA validator + indexer + dashboard expect.
//
// Each helper is exercised in isolation (via the underscore-prefixed
// export) so a regression in, say, MIME-map lookup doesn't cascade and
// hide a separate regression in date synthesis. The end-to-end
// `transform()` cases pin the assembly contract (which keys end up
// where) on representative records.

const {
    transform,
    extract_note_text,
    MIME_MAP,
    _build_title,
    _build_identifiers,
    _build_dates,
    _build_date,
    _build_extents,
    _build_notes,
    _build_extent_notes,
    _build_subjects,
    _build_names,
    _build_parts,
} = require('../../../libs/archivesspace_transform');

describe('libs/archivesspace_transform', () => {
    describe('MIME_MAP', () => {
        it('is frozen so callers cannot mutate the shared map', () => {
            expect(Object.isFrozen(MIME_MAP)).toBe(true);
        });

        it('carries the verbatim file_format_name → MIME entries from the plugin', () => {
            // Lifted from repository_model.rb:56-67 — values must match
            // exactly so downstream consumers see the same MIME strings
            // they got from the legacy /repository endpoint.
            expect(MIME_MAP).toEqual({
                aiff: 'audio/x-aiff',
                avi: 'video/x-msvideo',
                gif: 'image/gif',
                jpeg: 'image/jpeg',
                mov: 'video/quicktime',
                mp3: 'audio/mp3',
                pdf: 'application/pdf',
                tiff: 'image/tiff',
                txt: 'text/plain',
                wav: 'audio/x-wav',
            });
        });
    });

    describe('_build_title', () => {
        it('returns "" for missing/non-string titles', () => {
            expect(_build_title(undefined, [])).toBe('');
            expect(_build_title(null, [])).toBe('');
            expect(_build_title(42, [])).toBe('');
        });

        it('returns the title unchanged when there is no creation date', () => {
            expect(_build_title('Parents Newsletter', [])).toBe('Parents Newsletter');
        });

        it('returns the title unchanged when dates is not an array', () => {
            expect(_build_title('Parents Newsletter', null)).toBe('Parents Newsletter');
        });

        it('appends ", <expression>" when a creation date is present', () => {
            const dates = [{ label: 'creation', expression: '1970 June' }];
            expect(_build_title('Parents Newsletter', dates)).toBe('Parents Newsletter, 1970 June');
        });

        it('ignores non-creation date labels', () => {
            const dates = [{ label: 'publication', expression: '1980' }];
            expect(_build_title('Newsletter', dates)).toBe('Newsletter');
        });

        it('ignores a creation date with an empty expression', () => {
            const dates = [{ label: 'creation', expression: '' }];
            expect(_build_title('Newsletter', dates)).toBe('Newsletter');
        });

        it('picks the first creation date when there are multiple', () => {
            const dates = [
                { label: 'creation', expression: '1970' },
                { label: 'creation', expression: '1971' },
            ];
            expect(_build_title('NL', dates)).toBe('NL, 1970');
        });
    });

    describe('_build_identifiers', () => {
        it('returns [] for null/non-object input', () => {
            expect(_build_identifiers(null)).toEqual([]);
            expect(_build_identifiers('x')).toEqual([]);
        });

        it('uses component_id for archival_object records', () => {
            const rec = { jsonmodel_type: 'archival_object', component_id: 'ABC-123' };
            expect(_build_identifiers(rec)).toEqual([{ type: 'local', identifier: 'ABC-123' }]);
        });

        it('joins id_0..id_3 with `.` for resource records', () => {
            const rec = {
                jsonmodel_type: 'resource',
                id_0: 'M',
                id_1: '042',
                id_2: 'a',
                id_3: '1',
            };
            expect(_build_identifiers(rec)).toEqual([{ type: 'local', identifier: 'M.042.a.1' }]);
        });

        it('drops empty/blank id parts when joining resource ids', () => {
            const rec = { jsonmodel_type: 'resource', id_0: 'M', id_1: '', id_2: null, id_3: '7' };
            expect(_build_identifiers(rec)).toEqual([{ type: 'local', identifier: 'M.7' }]);
        });

        it('infers archival_object shape when component_id is present without jsonmodel_type', () => {
            const rec = { component_id: 'ABC-123' };
            expect(_build_identifiers(rec)).toEqual([{ type: 'local', identifier: 'ABC-123' }]);
        });

        it('infers resource shape when id_0 is present without jsonmodel_type', () => {
            const rec = { id_0: 'M', id_1: '042' };
            expect(_build_identifiers(rec)).toEqual([{ type: 'local', identifier: 'M.042' }]);
        });

        it('emits a null identifier when neither shape supplies one (validator only checks non-empty array)', () => {
            const rec = { jsonmodel_type: 'archival_object' };
            expect(_build_identifiers(rec)).toEqual([{ type: 'local', identifier: null }]);
        });

        it('emits a null identifier when the record carries neither shape', () => {
            const rec = { title: 'orphan' };
            expect(_build_identifiers(rec)).toEqual([{ type: 'local', identifier: null }]);
        });
    });

    describe('_build_date', () => {
        it('returns null for non-object input', () => {
            expect(_build_date(null)).toBe(null);
            expect(_build_date('1970')).toBe(null);
        });

        it('emits the canonical shape with encoding/label/type plus expression', () => {
            const out = _build_date({
                label: 'creation',
                date_type: 'single',
                expression: '1970 June',
            });
            expect(out).toEqual({
                encoding: 'w3cdtf',
                label: 'creation',
                type: 'single',
                expression: '1970 June',
            });
        });

        it('synthesizes expression from begin alone when no expression provided', () => {
            const out = _build_date({ label: 'creation', date_type: 'single', begin: '1970' });
            expect(out.expression).toBe('1970');
            expect(out.begin).toBe('1970');
            expect(out.end).toBeUndefined();
        });

        it('synthesizes expression from begin-end when both are provided', () => {
            const out = _build_date({
                label: 'creation',
                date_type: 'inclusive',
                begin: '1970',
                end: '1979',
            });
            expect(out.expression).toBe('1970-1979');
            expect(out.begin).toBe('1970');
            expect(out.end).toBe('1979');
        });

        it('prefers the AS-supplied expression over synthesizing from begin/end', () => {
            const out = _build_date({
                label: 'creation',
                date_type: 'inclusive',
                begin: '1970',
                end: '1979',
                expression: 'circa 1970s',
            });
            expect(out.expression).toBe('circa 1970s');
        });

        it('carries certainty through as `qualifier`', () => {
            const out = _build_date({
                label: 'creation',
                date_type: 'single',
                begin: '1970',
                certainty: 'approximate',
            });
            expect(out.qualifier).toBe('approximate');
        });

        it('omits qualifier when certainty is absent', () => {
            const out = _build_date({ label: 'creation', date_type: 'single', begin: '1970' });
            expect('qualifier' in out).toBe(false);
        });

        it('defaults missing label/type to null', () => {
            const out = _build_date({ begin: '1970' });
            expect(out.label).toBe(null);
            expect(out.type).toBe(null);
        });

        it('emits an empty expression when nothing usable is provided', () => {
            const out = _build_date({ label: 'creation', date_type: 'single' });
            expect(out.expression).toBe('');
        });
    });

    describe('_build_dates', () => {
        it('returns [] for non-array input', () => {
            expect(_build_dates(undefined)).toEqual([]);
            expect(_build_dates(null)).toEqual([]);
        });

        it('maps each date through _build_date and drops nulls', () => {
            const out = _build_dates([
                { label: 'creation', date_type: 'single', begin: '1970' },
                null,
                { label: 'publication', date_type: 'single', expression: '1971' },
            ]);
            expect(out).toHaveLength(2);
            expect(out[0].expression).toBe('1970');
            expect(out[1].expression).toBe('1971');
        });
    });

    describe('_build_extents', () => {
        it('returns [] for non-array input', () => {
            expect(_build_extents(undefined, [])).toEqual([]);
        });

        it('formats "<number> <extent_type> (<portion>)"', () => {
            const out = _build_extents(
                [{ number: '3', extent_type: 'folders', portion: 'whole' }],
                []
            );
            expect(out).toEqual(['3 folders (whole)']);
        });

        it('omits the portion suffix when no portion is set', () => {
            const out = _build_extents([{ number: '3', extent_type: 'folders' }], []);
            expect(out).toEqual(['3 folders']);
        });

        it('still emits a string when only the extent_type is present', () => {
            const out = _build_extents([{ extent_type: 'folders' }], []);
            expect(out).toEqual(['folders']);
        });

        it('side-effects physical_details into the extent_notes collector as `phystech`', () => {
            const collector = [];
            _build_extents(
                [{ number: '1', extent_type: 'reel', physical_details: 'color' }],
                collector
            );
            expect(collector).toEqual([{ type: 'phystech', content: 'color' }]);
        });

        it('side-effects dimensions into the collector as `dimensions`', () => {
            const collector = [];
            _build_extents([{ number: '1', extent_type: 'reel', dimensions: '16mm' }], collector);
            expect(collector).toEqual([{ type: 'dimensions', content: '16mm' }]);
        });

        it('tolerates a missing collector (transform default)', () => {
            // The collector is optional — when absent, side effects are skipped
            // but the main extent strings still produce.
            expect(() =>
                _build_extents([{ number: '1', extent_type: 'reel', dimensions: '16mm' }])
            ).not.toThrow();
        });
    });

    describe('extract_note_text', () => {
        it('returns "" for null / non-object input', () => {
            expect(extract_note_text(null)).toBe('');
            expect(extract_note_text('x')).toBe('');
        });

        it('returns content directly when it is a string (singlepart)', () => {
            expect(extract_note_text({ type: 'abstract', content: 'hello' })).toBe('hello');
        });

        it('joins content with spaces when it is an array of strings (singlepart)', () => {
            expect(
                extract_note_text({ type: 'scopecontent', content: ['part one', 'part two'] })
            ).toBe('part one part two');
        });

        it('extracts subnotes[].content strings (multipart)', () => {
            const note = {
                type: 'scopecontent',
                subnotes: [
                    { jsonmodel_type: 'note_text', content: 'first' },
                    { jsonmodel_type: 'note_text', content: 'second' },
                ],
            };
            expect(extract_note_text(note)).toBe('first second');
        });

        it('handles subnote.content as an array of strings', () => {
            const note = {
                subnotes: [{ content: ['a', 'b'] }],
            };
            expect(extract_note_text(note)).toBe('a b');
        });

        it('handles subnote.items as an array of strings', () => {
            const note = {
                subnotes: [{ items: ['one', 'two'] }],
            };
            expect(extract_note_text(note)).toBe('one two');
        });

        it('returns "" when nothing extractable is present', () => {
            expect(extract_note_text({ type: 'abstract' })).toBe('');
        });
    });

    describe('_build_notes', () => {
        it('returns [] for non-array input', () => {
            expect(_build_notes(undefined)).toEqual([]);
        });

        it('flattens both singlepart and multipart notes through extract_note_text', () => {
            const out = _build_notes([
                { type: 'abstract', content: 'short' },
                { type: 'scopecontent', subnotes: [{ content: 'long' }] },
            ]);
            expect(out).toEqual([
                { type: 'abstract', content: 'short' },
                { type: 'scopecontent', content: 'long' },
            ]);
        });

        it('skips physdesc and dimensions notes (handled by _build_extent_notes)', () => {
            const out = _build_notes([
                { type: 'abstract', content: 'keep' },
                { type: 'physdesc', content: 'skip' },
                { type: 'dimensions', content: 'skip' },
            ]);
            expect(out).toEqual([{ type: 'abstract', content: 'keep' }]);
        });

        it('drops notes that flatten to an empty string', () => {
            const out = _build_notes([{ type: 'abstract' }, { type: 'abstract', content: 'x' }]);
            expect(out).toEqual([{ type: 'abstract', content: 'x' }]);
        });
    });

    describe('_build_extent_notes', () => {
        it('returns [] for non-array input', () => {
            expect(_build_extent_notes(undefined)).toEqual([]);
        });

        it('keeps ONLY physdesc / dimensions notes (the inverse of _build_notes)', () => {
            const out = _build_extent_notes([
                { type: 'abstract', content: 'skip' },
                { type: 'physdesc', content: 'one reel' },
                { type: 'dimensions', content: '16mm' },
            ]);
            expect(out).toEqual([
                { type: 'physdesc', content: 'one reel' },
                { type: 'dimensions', content: '16mm' },
            ]);
        });
    });

    describe('_build_subjects', () => {
        it('returns [] when neither subjects nor linked_agents supply input', () => {
            expect(_build_subjects(undefined, undefined)).toEqual([]);
        });

        it('joins subject terms with " -- " for the title field', () => {
            const subjects = [
                {
                    _resolved: {
                        source: 'lcsh',
                        terms: [
                            { term_type: 'topical', term: 'Music' },
                            { term_type: 'geographic', term: 'Denver' },
                        ],
                    },
                },
            ];
            const out = _build_subjects(subjects, undefined);
            expect(out).toHaveLength(1);
            expect(out[0].title).toBe('Music -- Denver');
            expect(out[0].authority).toBe('lcsh');
            expect(out[0].terms).toEqual([
                { type: 'topical', term: 'Music' },
                { type: 'geographic', term: 'Denver' },
            ]);
        });

        it('carries authority_id when present on the resolved subject', () => {
            const subjects = [
                {
                    _resolved: {
                        source: 'lcsh',
                        authority_id: 'sh1234',
                        terms: [{ term_type: 'topical', term: 'Music' }],
                    },
                },
            ];
            expect(_build_subjects(subjects, undefined)[0].authority_id).toBe('sh1234');
        });

        it('omits terms[] when the resolved subject has no terms', () => {
            const subjects = [{ _resolved: { source: 'lcsh' } }];
            const out = _build_subjects(subjects, undefined);
            expect('terms' in out[0]).toBe(false);
        });

        it('skips subjects with no _resolved block (un-resolved reference)', () => {
            const subjects = [{ ref: '/subjects/1' }];
            expect(_build_subjects(subjects, undefined)).toEqual([]);
        });

        it('merges linked_agents with role="subject" into the subjects bucket', () => {
            const agents = [
                {
                    role: 'subject',
                    _resolved: {
                        title: 'Doe, Jane',
                        display_name: { source: 'naf', authority_id: 'n12345' },
                    },
                },
            ];
            const out = _build_subjects(undefined, agents);
            expect(out).toEqual([{ authority: 'naf', title: 'Doe, Jane', authority_id: 'n12345' }]);
        });

        it('ignores linked_agents with role !== "subject"', () => {
            const agents = [
                { role: 'creator', _resolved: { title: 'Doe, Jane', display_name: {} } },
            ];
            expect(_build_subjects(undefined, agents)).toEqual([]);
        });
    });

    describe('_build_names', () => {
        it('returns [] for non-array input', () => {
            expect(_build_names(undefined)).toEqual([]);
        });

        it('emits a name entry for each non-subject linked_agent', () => {
            const agents = [
                {
                    role: 'creator',
                    relator: 'aut',
                    _resolved: {
                        title: 'Doe, Jane',
                        display_name: { source: 'naf', authority_id: 'n12345' },
                    },
                },
            ];
            expect(_build_names(agents)).toEqual([
                {
                    title: 'Doe, Jane',
                    source: 'naf',
                    authority_id: 'n12345',
                    role: 'creator',
                    relator: 'aut',
                },
            ]);
        });

        it('excludes role="subject" entries (those belong to _build_subjects)', () => {
            const agents = [
                { role: 'subject', _resolved: { title: 'Doe, Jane', display_name: {} } },
                { role: 'creator', _resolved: { title: 'Smith, John', display_name: {} } },
            ];
            const out = _build_names(agents);
            expect(out).toHaveLength(1);
            expect(out[0].title).toBe('Smith, John');
        });

        it('omits optional keys when their source values are missing', () => {
            const agents = [{ role: 'creator', _resolved: { title: 'Doe', display_name: {} } }];
            const out = _build_names(agents);
            expect('authority_id' in out[0]).toBe(false);
            expect('relator' in out[0]).toBe(false);
        });
    });

    describe('_build_parts', () => {
        it('returns { parts: [], resource_type: null } for non-array input', () => {
            expect(_build_parts(undefined)).toEqual({ parts: [], resource_type: null });
        });

        it('walks ONLY representative digital_object instances', () => {
            const instances = [
                {
                    instance_type: 'mixed_materials',
                    is_representative: true,
                    digital_object: { _resolved: { tree: { _resolved: { children: [{}] } } } },
                },
                {
                    instance_type: 'digital_object',
                    is_representative: false,
                    digital_object: { _resolved: { tree: { _resolved: { children: [{}] } } } },
                },
            ];
            expect(_build_parts(instances).parts).toEqual([]);
        });

        it('captures digital_object_type as resource_type, replacing `_` with " "', () => {
            const instances = [
                {
                    instance_type: 'digital_object',
                    is_representative: true,
                    digital_object: {
                        _resolved: {
                            digital_object_type: 'still_image',
                            tree: { _resolved: { children: [] } },
                        },
                    },
                },
            ];
            expect(_build_parts(instances).resource_type).toBe('still image');
        });

        it('emits one part per child with order starting at "1"', () => {
            const instances = [
                {
                    instance_type: 'digital_object',
                    is_representative: true,
                    digital_object: {
                        _resolved: {
                            tree: {
                                _resolved: {
                                    children: [
                                        { title: 'page 1', file_versions: [] },
                                        { title: 'page 2', file_versions: [] },
                                    ],
                                },
                            },
                        },
                    },
                },
            ];
            const parts = _build_parts(instances).parts;
            expect(parts[0].order).toBe('1');
            expect(parts[1].order).toBe('2');
            expect(parts[0].title).toBe('page 1');
        });

        it('resolves type via MIME_MAP on file_format_name', () => {
            const instances = [
                {
                    instance_type: 'digital_object',
                    is_representative: true,
                    digital_object: {
                        _resolved: {
                            tree: {
                                _resolved: {
                                    children: [
                                        {
                                            title: 'p1',
                                            file_versions: [{ file_format_name: 'tiff' }],
                                        },
                                    ],
                                },
                            },
                        },
                    },
                },
            ];
            expect(_build_parts(instances).parts[0].type).toBe('image/tiff');
        });

        it('falls back to the raw file_format_name on MIME_MAP miss', () => {
            const instances = [
                {
                    instance_type: 'digital_object',
                    is_representative: true,
                    digital_object: {
                        _resolved: {
                            tree: {
                                _resolved: {
                                    children: [
                                        {
                                            title: 'p1',
                                            file_versions: [{ file_format_name: 'webp' }],
                                        },
                                    ],
                                },
                            },
                        },
                    },
                },
            ];
            // Unknown format passes through verbatim — better than emitting
            // undefined on a new file type the plugin didn't know about.
            expect(_build_parts(instances).parts[0].type).toBe('webp');
        });

        it('passes file_versions[0].caption through (null when absent)', () => {
            const instances = [
                {
                    instance_type: 'digital_object',
                    is_representative: true,
                    digital_object: {
                        _resolved: {
                            tree: {
                                _resolved: {
                                    children: [
                                        {
                                            title: 'p1',
                                            file_versions: [
                                                { file_format_name: 'tiff', caption: 'cover' },
                                            ],
                                        },
                                        { title: 'p2', file_versions: [] },
                                    ],
                                },
                            },
                        },
                    },
                },
            ];
            const parts = _build_parts(instances).parts;
            expect(parts[0].caption).toBe('cover');
            expect(parts[1].caption).toBe(null);
        });

        it('skips instances whose digital_object is unresolved', () => {
            const instances = [
                {
                    instance_type: 'digital_object',
                    is_representative: true,
                    digital_object: { ref: '/digital_objects/1' },
                },
            ];
            expect(_build_parts(instances).parts).toEqual([]);
        });
    });

    describe('transform (end-to-end)', () => {
        it('returns the canonical empty shape for null / non-object input', () => {
            const empty = {
                title: '',
                uri: '',
                identifiers: [],
                subjects: [],
                notes: [],
                names: [],
                parts: [],
                is_compound: false,
            };
            expect(transform(null)).toEqual(empty);
            expect(transform(undefined)).toEqual(empty);
            expect(transform('x')).toEqual(empty);
        });

        it('is_compound is false for 0 or 1 parts', () => {
            const single = {
                uri: '/x/1',
                instances: [
                    {
                        instance_type: 'digital_object',
                        is_representative: true,
                        digital_object: {
                            _resolved: {
                                tree: { _resolved: { children: [{ title: 'only' }] } },
                            },
                        },
                    },
                ],
            };
            expect(transform(single).is_compound).toBe(false);
            expect(transform({ uri: '/x/2' }).is_compound).toBe(false);
        });

        it('is_compound is true for 2+ parts', () => {
            const compound = {
                uri: '/x/3',
                instances: [
                    {
                        instance_type: 'digital_object',
                        is_representative: true,
                        digital_object: {
                            _resolved: {
                                tree: {
                                    _resolved: { children: [{ title: 'a' }, { title: 'b' }] },
                                },
                            },
                        },
                    },
                ],
            };
            expect(transform(compound).is_compound).toBe(true);
        });

        it('assembles a full archival_object record into the flat shape', () => {
            const record = {
                jsonmodel_type: 'archival_object',
                uri: '/repositories/2/archival_objects/12345',
                title: 'Parents Newsletter',
                component_id: 'PN-001',
                dates: [
                    {
                        label: 'creation',
                        date_type: 'single',
                        begin: '1970-06',
                        expression: '1970 June',
                    },
                ],
                extents: [
                    {
                        number: '1',
                        extent_type: 'folder',
                        portion: 'whole',
                        physical_details: 'paper',
                    },
                ],
                notes: [
                    { type: 'abstract', content: 'A newsletter.' },
                    { type: 'physdesc', content: 'one folder' },
                ],
                subjects: [
                    {
                        _resolved: {
                            source: 'lcsh',
                            terms: [{ term_type: 'topical', term: 'Education' }],
                        },
                    },
                ],
                linked_agents: [
                    {
                        role: 'creator',
                        relator: 'aut',
                        _resolved: { title: 'University of Denver', display_name: {} },
                    },
                ],
                instances: [
                    {
                        instance_type: 'digital_object',
                        is_representative: true,
                        digital_object: {
                            _resolved: {
                                digital_object_type: 'text',
                                tree: {
                                    _resolved: {
                                        children: [
                                            {
                                                title: 'page 1',
                                                file_versions: [{ file_format_name: 'tiff' }],
                                            },
                                        ],
                                    },
                                },
                            },
                        },
                    },
                ],
            };

            const out = transform(record);

            // Title is decorated with the creation expression.
            expect(out.title).toBe('Parents Newsletter, 1970 June');
            expect(out.uri).toBe('/repositories/2/archival_objects/12345');
            expect(out.identifiers).toEqual([{ type: 'local', identifier: 'PN-001' }]);
            expect(out.resource_type).toBe('text');
            expect(out.dates).toHaveLength(1);
            expect(out.dates[0].expression).toBe('1970 June');
            expect(out.extents).toEqual(['1 folder (whole)']);
            // physdesc came in via the notes block; physical_details came in
            // via the extent. Both end up in the notes array via the
            // extent_notes pathway.
            const note_types = out.notes.map((n) => n.type).sort();
            expect(note_types).toEqual(['abstract', 'physdesc', 'phystech']);
            expect(out.subjects).toEqual([
                {
                    authority: 'lcsh',
                    title: 'Education',
                    terms: [{ type: 'topical', term: 'Education' }],
                },
            ]);
            expect(out.names).toEqual([
                {
                    title: 'University of Denver',
                    source: null,
                    role: 'creator',
                    relator: 'aut',
                },
            ]);
            expect(out.parts).toHaveLength(1);
            expect(out.parts[0]).toEqual({
                order: '1',
                title: 'page 1',
                type: 'image/tiff',
                caption: null,
            });
            expect(out.is_compound).toBe(false);
        });

        it('assembles a resource record (id_0..id_3 identifier path)', () => {
            const record = {
                jsonmodel_type: 'resource',
                uri: '/repositories/2/resources/42',
                title: 'Manuscript Collection',
                id_0: 'M',
                id_1: '042',
            };
            const out = transform(record);
            expect(out.identifiers).toEqual([{ type: 'local', identifier: 'M.042' }]);
            // No instances → no resource_type key (the helper only sets it
            // when a representative DO supplies digital_object_type).
            expect('resource_type' in out).toBe(false);
            // No dates/extents → neither key present.
            expect('dates' in out).toBe(false);
            expect('extents' in out).toBe(false);
        });

        it('omits `dates` and `extents` keys when the source arrays are empty', () => {
            const out = transform({ uri: '/x/9', title: 't', dates: [], extents: [] });
            expect('dates' in out).toBe(false);
            expect('extents' in out).toBe(false);
        });

        it('treats an unresolved subject as missing rather than raising', () => {
            const record = {
                uri: '/x/10',
                title: 't',
                subjects: [{ ref: '/subjects/1' }], // no _resolved
                linked_agents: [],
            };
            expect(transform(record).subjects).toEqual([]);
        });
    });

    // ---- Resource (collection) records ----
    //
    // The legacy plugin deliberately under-populates resource records:
    // its from_resource() map only runs handle_notes / handle_subjects /
    // handle_agents — skipping handle_dates, handle_extents, and
    // handle_instances. The result is a resource shape with empty
    // dates/extents/parts even when AS has those fields populated.
    //
    // We intentionally DIVERGE from that — the unified transformer
    // applies every helper uniformly so ES sees the same field set
    // across both object and collection records. These tests pin that
    // policy so a future "match plugin exactly" reflex can't quietly
    // revert it.
    describe('transform (resource / collection records)', () => {
        it('produces dates/extents on resources too (richer than the legacy plugin)', () => {
            // A resource record with dates + extents populated in AS.
            // The plugin would suppress these; we pass them through.
            const record = {
                jsonmodel_type: 'resource',
                uri: '/repositories/2/resources/42',
                title: 'Glenn Miller Collection',
                id_0: 'M',
                id_1: '042',
                dates: [
                    {
                        label: 'creation',
                        date_type: 'inclusive',
                        begin: '1900',
                        end: '1980',
                        expression: '1900-1980',
                    },
                ],
                extents: [{ number: '20', extent_type: 'linear feet', portion: 'whole' }],
                linked_agents: [
                    {
                        role: 'creator',
                        relator: 'aut',
                        _resolved: { title: 'Miller, Glenn', display_name: {} },
                    },
                ],
            };
            const out = transform(record);
            expect(out.identifiers).toEqual([{ type: 'local', identifier: 'M.042' }]);
            expect(out.dates).toHaveLength(1);
            expect(out.dates[0].expression).toBe('1900-1980');
            expect(out.extents).toEqual(['20 linear feet (whole)']);
            expect(out.names).toHaveLength(1);
            expect(out.names[0].title).toBe('Miller, Glenn');
            // No instances → still no resource_type, no parts, not compound.
            expect('resource_type' in out).toBe(false);
            expect(out.parts).toEqual([]);
            expect(out.is_compound).toBe(false);
        });

        it('emits the same top-level keys on a resource as on an archival_object (for ES consistency)', () => {
            const resource = transform({
                jsonmodel_type: 'resource',
                uri: '/r/1',
                title: 'Coll',
                id_0: 'M',
            });
            const ao = transform({
                jsonmodel_type: 'archival_object',
                uri: '/ao/1',
                title: 'Item',
                component_id: 'X-1',
            });
            // Sorted-key parity check — both records must surface the
            // same baseline shape so the ES mapping doesn't have to
            // branch on object_type.
            const baseline = [
                'identifiers',
                'is_compound',
                'names',
                'notes',
                'parts',
                'subjects',
                'title',
                'uri',
            ];
            expect(Object.keys(resource).sort()).toEqual(baseline);
            expect(Object.keys(ao).sort()).toEqual(baseline);
        });
    });
});
