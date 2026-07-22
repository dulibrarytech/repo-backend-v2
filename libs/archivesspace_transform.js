'use strict';

/*
 * ArchivesSpace → flat-metadata transformer.
 * 
 * Replicates the JSON shape the legacy `archivesspace-repository-sync-plugin`
 * emits from `<host>/repositories/:n/archival_objects/:m/repository` — the
 * shape every downstream consumer in v2 expects (`title`, `uri`,
 * `identifiers`, `dates`, `extents`, `subjects`, `notes`, `names`, `parts`,
 * `is_compound`, `resource_type`).
 * 
 * Source of truth for this implementation:
 *   - dulibrarytech/archivesspace-repository-sync-plugin
 *   - backend/model/repository_model.rb (population)
 *   - backend/model/repository_exporter.rb (serialization)
 * 
 * Input expectation:
 *   The caller must hit AS's native record endpoint with the right
 *   ?resolve[]= params so referenced records are inlined under
 *   `_resolved` keys:
 * 
 *     ?resolve[]=subjects
 *     ?resolve[]=linked_agents
 *     ?resolve[]=instances::digital_object
 *     ?resolve[]=instances::digital_object::tree
 * 
 *   Without those params, this transformer will produce empty subjects /
 *   names / parts because there's nothing to read. The library's HTTP
 *   wrapper (libs/archivesspace.js, Phase B) attaches those params.
 * 
 * The module is pure — no I/O, no module-level state. Every helper is
 */
// exported (with a `_` prefix on internals) so tests can pin each
// transformation rule independently.

/*
 * MIME-type lookup, lifted verbatim from the plugin's
 * `@mime_type_map` (repository_model.rb:56-67).
 */
const MIME_MAP = Object.freeze({
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

/*
 * Top-level transform. Accepts the resolved AS record (archival_object
 * or resource shape) and returns the flat object the validator expects.
 * 
 * Defensive on every field — AS records vary wildly in completeness.
 * Anything missing or null is treated as "not present" rather than
 * producing an exception.
 */
function transform(record) {
    if (!record || typeof record !== 'object') {
        return _empty_shape();
    }

    /*
     * extent_notes is gathered as a side effect of _build_extents
     * (the plugin lifts physical_details/dimensions out of extents
     * into the notes block). We pass an array in so the helper can
     * push into it; we read it out afterwards.
     */
    const extent_notes_collected = [];

    const dates = Array.isArray(record.dates) ? record.dates : [];
    const extents_strings = _build_extents(record.extents, extent_notes_collected);
    const notes_from_record = _build_notes(record.notes);
    const extent_notes_from_record = _build_extent_notes(record.notes);
    const all_notes = [
        ...notes_from_record,
        ...extent_notes_collected,
        ...extent_notes_from_record,
    ];

    /*
     * Walk instances ONCE — _build_parts handles part assembly AND
     * captures `digital_object_type` for the resource_type field.
     */
    const parts_result = _build_parts(record.instances);

    const out = {
        title: _build_title(record.title, dates),
        uri: record.uri || '',
        identifiers: _build_identifiers(record),
    };

    if (parts_result.resource_type) {
        out.resource_type = parts_result.resource_type;
    }

    if (dates.length > 0) {
        out.dates = _build_dates(dates);
    }
    if (extents_strings.length > 0) {
        out.extents = extents_strings;
    }

    out.subjects = _build_subjects(record.subjects, record.linked_agents);
    out.notes = all_notes;
    out.names = _build_names(record.linked_agents);
    out.parts = parts_result.parts;
    out.is_compound = parts_result.parts.length > 1;

    return out;
}

function _empty_shape() {
    return {
        title: '',
        uri: '',
        identifiers: [],
        subjects: [],
        notes: [],
        names: [],
        parts: [],
        is_compound: false,
    };
}

/*
 * Title gets the creation date's `expression` appended (plugin's
 * `handle_title` mutates the title with ", <expression>"). This is
 * where the "Parents Newsletter, 1970 June" shape comes from — the AS
 * title would just be "Parents Newsletter".
 */
function _build_title(title, dates) {
    if (!title || typeof title !== 'string') return '';
    if (!Array.isArray(dates)) return title;
    const creation = dates.find(
        (d) => d && d.label === 'creation' && d.expression && String(d.expression).length > 0
    );
    return creation ? `${title}, ${creation.expression}` : title;
}

/*
 * Identifiers normalization. Plugin always emits at least one entry —
 * `{type: 'local', identifier: <local_id or null>}`. The validator
 * only checks the array is non-empty, so this satisfies it.
 * 
 *   - archival_object → `component_id`
 *   - resource        → `id_0.id_1.id_2.id_3` (joined with `.`, blanks dropped)
 */
function _build_identifiers(record) {
    if (!record || typeof record !== 'object') return [];
    let id;
    if (record.jsonmodel_type === 'archival_object' || 'component_id' in record) {
        id = record.component_id || null;
    } else if (record.jsonmodel_type === 'resource' || 'id_0' in record) {
        const parts = ['id_0', 'id_1', 'id_2', 'id_3']
            .map((k) => record[k])
            .filter((v) => v !== undefined && v !== null && String(v).length > 0);
        id = parts.length > 0 ? parts.join('.') : null;
    } else {
        id = null;
    }
    return [{ type: 'local', identifier: id }];
}

/*
 * Map each AS date through the plugin's serializer rules
 * (handle_date in repository_exporter.rb). Synthesizes `expression`
 * from begin[-end] when AS didn't supply one; carries begin/end as
 * separate keys so the indexer can sort by them later.
 */
function _build_dates(dates) {
    if (!Array.isArray(dates)) return [];
    const out = [];
    for (const d of dates) {
        const mapped = _build_date(d);
        if (mapped) out.push(mapped);
    }
    return out;
}

function _build_date(date) {
    if (!date || typeof date !== 'object') return null;
    const has_expression =
        date.expression !== undefined &&
        date.expression !== null &&
        String(date.expression).length > 0;
    const has_begin =
        date.begin !== undefined && date.begin !== null && String(date.begin).length > 0;
    const has_end = date.end !== undefined && date.end !== null && String(date.end).length > 0;

    const out = {
        encoding: 'w3cdtf',
        label: date.label || null,
        type: date.date_type || null,
    };
    if (date.certainty) out.qualifier = date.certainty;

    if (has_expression) {
        out.expression = date.expression;
    } else if (has_begin) {
        out.expression = String(date.begin) + (has_end ? `-${date.end}` : '');
    } else {
        out.expression = '';
    }

    if (has_begin) out.begin = date.begin;
    if (has_end) out.end = date.end;

    return out;
}

/*
 * Each AS extent becomes a single string `"<number> <extent_type> (<portion>)"`.
 * Side effect: any `physical_details` / `dimensions` keys nested in the
 * extent get pushed into the `extent_notes_collector` argument as
 * pseudo-notes ({type: phystech|dimensions, content}).
 */
function _build_extents(extents, extent_notes_collector) {
    if (!Array.isArray(extents)) return [];
    const out = [];
    for (const ext of extents) {
        if (!ext || typeof ext !== 'object') continue;
        const num = ext.number !== undefined && ext.number !== null ? String(ext.number) : '';
        const type = ext.extent_type ? String(ext.extent_type) : '';
        let s = num.length > 0 ? num : '';
        if (type) s = s ? `${s} ${type}` : type;
        if (ext.portion) s += ` (${ext.portion})`;
        if (s) out.push(s);

        if (Array.isArray(extent_notes_collector)) {
            if (ext.physical_details) {
                extent_notes_collector.push({
                    type: 'phystech',
                    content: String(ext.physical_details),
                });
            }
            if (ext.dimensions) {
                extent_notes_collector.push({
                    type: 'dimensions',
                    content: String(ext.dimensions),
                });
            }
        }
    }
    return out;
}

/*
 * AS notes come in two flavors:
 *   - note_singlepart   — has `content` (usually a string or array of strings)
 *   - note_multipart    — has `subnotes[]`, each with its own `content`
 * 
 * Plugin uses `ASpaceExport::Utils.extract_note_text(note)` to flatten
 * either shape into a single string. We do the same here.
 * 
 * physdesc + dimensions notes are SKIPPED from the main notes array —
 * they get rolled into extent_notes via _build_extent_notes.
 */
function _build_notes(notes) {
    if (!Array.isArray(notes)) return [];
    const out = [];
    for (const note of notes) {
        if (!note || typeof note !== 'object') continue;
        if (note.type === 'physdesc' || note.type === 'dimensions') continue;
        const content = extract_note_text(note);
        if (content) {
            out.push({ type: note.type, content });
        }
    }
    return out;
}

function _build_extent_notes(notes) {
    if (!Array.isArray(notes)) return [];
    const out = [];
    for (const note of notes) {
        if (!note || typeof note !== 'object') continue;
        if (note.type !== 'physdesc' && note.type !== 'dimensions') continue;
        const content = extract_note_text(note);
        if (content) {
            out.push({ type: note.type, content });
        }
    }
    return out;
}

/*
 * Walk an AS note (singlepart or multipart) and yield a single string.
 * Defensive — content may be a string, array of strings, missing, or
 * nested under subnotes[].content / subnotes[].items / etc.
 */
function extract_note_text(note) {
    if (!note || typeof note !== 'object') return '';
    if (typeof note.content === 'string') return note.content;
    if (Array.isArray(note.content)) {
        return note.content.filter((c) => typeof c === 'string' && c.length > 0).join(' ');
    }
    if (Array.isArray(note.subnotes)) {
        const chunks = [];
        for (const sub of note.subnotes) {
            if (!sub) continue;
            if (typeof sub.content === 'string' && sub.content.length > 0) {
                chunks.push(sub.content);
            } else if (Array.isArray(sub.content)) {
                for (const c of sub.content) {
                    if (typeof c === 'string' && c.length > 0) chunks.push(c);
                }
            } else if (Array.isArray(sub.items)) {
                for (const item of sub.items) {
                    if (typeof item === 'string' && item.length > 0) chunks.push(item);
                }
            }
        }
        return chunks.join(' ');
    }
    return '';
}

/*
 * Subjects are sourced from TWO places:
 *   1. record.subjects[] (each with _resolved subject record)
 *   2. record.linked_agents[] with role='subject' (plugin reuses the
 *      subjects bucket for agent-as-subject entries — see
 *      handle_agents in repository_model.rb)
 * 
 * Both end up serialized through the same exporter rule:
 *   - authority — subject.source / agent.display_name.source
 *   - title     — terms.map(term).join(' -- ') for subjects, agent.title
 *                 for agent-subjects
 *   - terms     — only when present (subjects only)
 *   - authority_id — when present
 */
function _build_subjects(subjects, linked_agents) {
    const out = [];

    if (Array.isArray(subjects)) {
        for (const s of subjects) {
            const resolved = s && s._resolved;
            if (!resolved || typeof resolved !== 'object') continue;
            const terms = Array.isArray(resolved.terms)
                ? resolved.terms.map((t) => ({
                      type: t && t.term_type,
                      term: t && t.term,
                  }))
                : [];
            const subj = {
                authority: resolved.source || null,
                title: terms
                    .map((t) => t.term)
                    .filter(Boolean)
                    .join(' -- '),
            };
            if (terms.length > 0) subj.terms = terms;
            if (resolved.authority_id) subj.authority_id = resolved.authority_id;
            out.push(subj);
        }
    }

    if (Array.isArray(linked_agents)) {
        for (const link of linked_agents) {
            if (!link || link.role !== 'subject') continue;
            const agent = link._resolved;
            if (!agent || typeof agent !== 'object') continue;
            const dn = agent.display_name || {};
            const subj = {
                authority: dn.source || null,
                title: agent.title || '',
            };
            if (dn.authority_id) subj.authority_id = dn.authority_id;
            out.push(subj);
        }
    }

    return out;
}

/*
 * Names = linked_agents with role !== 'subject'. Carries role + relator
 * (raw key — the plugin I18n-translates it, we defer that).
 */
function _build_names(linked_agents) {
    if (!Array.isArray(linked_agents)) return [];
    const out = [];
    for (const link of linked_agents) {
        if (!link || link.role === 'subject') continue;
        const agent = link._resolved;
        if (!agent || typeof agent !== 'object') continue;
        const dn = agent.display_name || {};
        const name = {
            title: agent.title || '',
            source: dn.source || null,
        };
        if (dn.authority_id) name.authority_id = dn.authority_id;
        if (link.role) name.role = link.role;
        /*
         * Plugin runs `I18n.t("enumerations.linked_agent_archival_record_relators." + relator)`
         * here. We emit the raw relator key; a follow-up can attach a
         * translation table if the dashboard needs human-readable labels.
         */
        if (link.relator) name.relator = link.relator;
        out.push(name);
    }
    return out;
}

/*
 * Parts come from `instances[]` where:
 *   - instance_type === 'digital_object'
 *   - is_representative === true
 *   - the linked digital_object has a `tree._resolved.children[]` array
 * 
 * We walk children ONE LEVEL deep (matching the plugin's "we should
 * only be going one level deep" comment at repository_model.rb:203).
 * 
 * Side return: `resource_type` — captured from the DO's
 * `digital_object_type` if present (plugin's `self.type_of_resource`
 * — exporter line 13 turns `text` → `text`, `still_image` → `still
 * image`).
 * 
 * `kaltura_id` is DEFERRED — the plugin reads it via a per-child
 * `DigitalObjectComponent.to_jsonmodel(child['id'])` DB call. From
 * outside AS that's an extra HTTP call per child; we'll add it in a
 * follow-up if a Kaltura workflow needs it.
 */
function _build_parts(instances) {
    const result = { parts: [], resource_type: null };
    if (!Array.isArray(instances)) return result;

    for (const instance of instances) {
        if (!instance || typeof instance !== 'object') continue;
        if (instance.instance_type !== 'digital_object') continue;
        if (instance.is_representative !== true) continue;

        const object = instance.digital_object && instance.digital_object._resolved;
        if (!object || typeof object !== 'object') continue;

        if (object.digital_object_type && !result.resource_type) {
            // Exporter line 13: `gsub('_', ' ')`
            result.resource_type = String(object.digital_object_type).replace(/_/g, ' ');
        }

        const tree = object.tree && object.tree._resolved;
        if (!tree || !Array.isArray(tree.children)) continue;

        tree.children.forEach((child, i) => {
            if (!child || typeof child !== 'object') return;
            const part = {
                order: String(i + 1),
                title: child.title || '',
            };

            const file_versions = Array.isArray(child.file_versions) ? child.file_versions : [];
            if (file_versions.length > 0) {
                const file = file_versions[0] || {};
                if (file.file_format_name) {
                    /*
                     * MIME_MAP miss falls back to the raw key so a new
                     * file format doesn't silently emit `undefined`.
                     */
                    part.type = MIME_MAP[file.file_format_name] || file.file_format_name;
                }
                part.caption = file.caption !== undefined ? file.caption : null;
            } else {
                part.caption = null;
            }

            result.parts.push(part);
        });
    }
    return result;
}

module.exports = {
    transform,
    extract_note_text,
    MIME_MAP,
    /*
     * Helpers exported with `_` prefix so tests can pin each rule
     * independently. Not part of the public surface — call `transform`
     * from production code.
     */
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
};
