'use strict';

/*
 * Canonical display_record envelope builder — the single source of truth
 * for the v1-contract shape stored in tbl_objects.display_record and
 * mirrored by the Elasticsearch document projection:
 *
 *   { pid, is_member_of_collection, handle, thumbnail, mime_type,
 *     object_type, is_published, is_compound, title, creator, f_subjects,
 *     abstract, type, display_record: { ...raw ASpace record, parts },
 *     object, entry_id? }
 *
 * where display_record.parts is the ONE merged parts manifest:
 *
 *   { order, title, type: <MIME>, caption, kaltura_id?, object?, thumbnail? }
 *
 * Merged from the two partial copies the ingest pipeline produces:
 *   - the ASpace record's parts (order/title/type=MIME/caption/kaltura_id —
 *     MIME here is MDO-stamped and authoritative; the METS-derived mime is
 *     positional and has shipped wrong)
 *   - the METS/DIP file list (uuid/file/mime_type/type/object/thumbnail —
 *     the only source of DuraCloud object + thumbnail paths)
 *
 * Consumers: ingester/lib/repository_build (ingest-time write),
 * metadata/worker (refresh-time rewrite), libs/elasticsearch (index-time
 * projection fallbacks), scripts/backfill_display_records (prod repair).
 *
 * History: post-cutover ingests (2026-07-30..08-04) stored a thin 5-key
 * envelope with the two parts copies un-merged, which dropped kaltura_id
 * from everything the frontend reads and mis-assigned MIMEs. See
 * repo/REPOV2_DISPLAY_RECORD_FINDINGS.md.
 */

// The first useful string from a string / array-of-strings / null value.
function first_string(v) {
    if (typeof v === 'string') return v;
    if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
    return null;
}

/*
 * abstract: the `abstract`-type note's content from the raw ASpace record,
 * falling back to a plain field on either the inner record or a legacy
 * envelope (`dr`). Mirrors v1's create_display_record.
 */
function extract_abstract(inner, dr) {
    if (inner && Array.isArray(inner.notes)) {
        const note = inner.notes.find((n) => n && n.type === 'abstract');
        if (note && note.content !== null && note.content !== undefined) {
            return first_string(note.content);
        }
    }
    return first_string((inner && inner.abstract) || (dr && dr.abstract));
}

// creator: the title of the first name whose role is 'creator'.
function derive_creator(inner, dr) {
    if (inner && Array.isArray(inner.names)) {
        const c = inner.names.find((n) => n && n.role === 'creator');
        if (c && c.title) return c.title;
    }
    return (dr && dr.creator) || null;
}

// f_subjects: flat list of subject titles (the facet/search surface).
function derive_f_subjects(inner, dr) {
    if (inner && Array.isArray(inner.subjects)) {
        const arr = inner.subjects.map((s) => s && s.title).filter((s) => typeof s === 'string');
        if (arr.length > 0) return arr;
    }
    return Array.isArray(dr && dr.f_subjects)
        ? dr.f_subjects.filter((s) => typeof s === 'string')
        : [];
}

/*
 * Kaltura entry id for A/V objects — a top-level convenience field; the
 * per-part ids stay inside display_record.parts. Single-file legacy A/V
 * objects carry it on the envelope or inner record rather than in a part.
 */
function derive_entry_id(parts, dr, inner) {
    if (Array.isArray(parts)) {
        const p = parts.find((x) => x && (x.entry_id || x.kaltura_id));
        if (p) return p.entry_id || p.kaltura_id;
    }
    if (dr && (dr.entry_id || dr.kaltura_id)) return dr.entry_id || dr.kaltura_id;
    if (inner && (inner.entry_id || inner.kaltura_id)) return inner.entry_id || inner.kaltura_id;
    return null;
}

/*
 * Coarse resource type from the mime type — a last-resort fallback so an
 * object whose metadata never carried resource_type still lands in a
 * Format facet bucket. Values match the frontend's facet normalization.
 */
function type_from_mime(mime) {
    if (typeof mime !== 'string' || !mime) return null;
    if (mime.startsWith('image/')) return 'still image';
    if (mime === 'application/pdf') return 'text';
    if (mime.startsWith('video/')) return 'moving image';
    if (mime.startsWith('audio/')) return 'sound recording';
    return null;
}

/*
 * Is a parts array the METS/DIP shape ({uuid, file, mime_type, type:
 * 'object'|'txt', object, thumbnail}) rather than the canonical merged /
 * ASpace shape ({order, title, type: MIME, ...})? DIP entries carry `file`
 * and never `title`; ASpace/merged entries are the reverse.
 */
function is_dip_parts(parts) {
    return (
        Array.isArray(parts) &&
        parts.length > 0 &&
        parts.some((p) => p && p.file !== undefined && p.title === undefined)
    );
}

// Case-insensitive key for file-name matching.
function file_key(name) {
    return typeof name === 'string' ? name.trim().toLowerCase() : '';
}

// "thing-001.tif" → "thing-001", for matching against DIP file_id.
function strip_ext(name) {
    const k = file_key(name);
    const dot = k.lastIndexOf('.');
    return dot > 0 ? k.slice(0, dot) : k;
}

/*
 * The DuraCloud DIP stores access copies as `objects/<fileUUID>-<original
 * name>` (the same fileUUID names the `thumbnails/<uuid>.jpg` derivative),
 * but the METS FLocat href carries only the original name — so paths built
 * from it 404 against the dip-store. When the DIP entry's uuid is known,
 * normalize the object path to the real on-store name; already-prefixed
 * paths pass through untouched.
 */
function dip_object_path(p) {
    if (!p || !p.object || !p.uuid) return (p && p.object) || null;
    const cut = p.object.lastIndexOf('/');
    const dir = cut >= 0 ? p.object.slice(0, cut + 1) : '';
    const base = p.object.slice(cut + 1);
    if (base.startsWith(`${p.uuid}-`)) return p.object;
    return `${dir}${p.uuid}-${base}`;
}

/*
 * Merge the ASpace parts with the METS/DIP file list into the one
 * canonical manifest. Matching is by file name (ASpace part `title` ↔ DIP
 * `file`, then title-minus-extension ↔ DIP `file_id`).
 *
 *   - ASpace parts drive order/title/caption/kaltura_id, and their `type`
 *     (MDO-stamped MIME) beats the METS-derived mime.
 *   - Matched DIP entries contribute the DuraCloud `object` + `thumbnail`
 *     paths.
 *   - DIP txt sidecars (uri.txt, transcripts) are never parts.
 *   - Unmatched DIP object files are appended so every real file stays
 *     renderable even when the ASpace record's parts are incomplete; an
 *     ASpace part with no DIP match is kept without paths.
 */
function merge_parts(inner_parts, dip_parts) {
    const inner = Array.isArray(inner_parts) ? inner_parts.filter(Boolean) : [];
    const dip = Array.isArray(dip_parts) ? dip_parts.filter(Boolean) : [];
    const dip_objects = dip.filter((p) => p.type !== 'txt');

    const by_file = new Map();
    const by_file_id = new Map();
    for (const p of dip_objects) {
        if (p.file !== undefined && !by_file.has(file_key(p.file))) {
            by_file.set(file_key(p.file), p);
        }
        if (p.file_id !== undefined && !by_file_id.has(file_key(p.file_id))) {
            by_file_id.set(file_key(p.file_id), p);
        }
    }

    const claimed = new Set();
    const out = [];

    for (const p of inner) {
        let match = by_file.get(file_key(p.title)) || by_file_id.get(strip_ext(p.title)) || null;
        /*
         * An ASpace part without a title (sparse legacy metadata) can't
         * match by name — pair it with the next unclaimed DIP file
         * positionally, as v1 effectively did.
         */
        if (!match && !p.title) {
            match = dip_objects.find((d) => !claimed.has(d)) || null;
        }
        if (match) claimed.add(match);
        const entry = {
            order: p.order !== undefined && p.order !== null ? p.order : String(out.length + 1),
            title: p.title || (match ? match.file : null),
            // MIME: ASpace's copy is authoritative, METS-derived is fallback.
            type: p.type || (match && match.mime_type) || null,
            caption: p.caption !== undefined ? p.caption : null,
        };
        const kaltura_id = p.kaltura_id || p.entry_id || (match && match.kaltura_id) || null;
        if (kaltura_id) entry.kaltura_id = kaltura_id;
        if (match) {
            const object_path = dip_object_path(match);
            if (object_path) entry.object = object_path;
            if (match.thumbnail) entry.thumbnail = match.thumbnail;
        }
        out.push(entry);
    }

    for (const p of dip_objects) {
        if (claimed.has(p)) continue;
        const entry = {
            order: String(out.length + 1),
            title: p.file || null,
            type: p.mime_type || null,
            caption: null,
        };
        if (p.kaltura_id || p.entry_id) entry.kaltura_id = p.kaltura_id || p.entry_id;
        const object_path = dip_object_path(p);
        if (object_path) entry.object = object_path;
        if (p.thumbnail) entry.thumbnail = p.thumbnail;
        out.push(entry);
    }

    return out;
}

/*
 * The "master" merged part — the one whose object/thumbnail/MIME become
 * the row's top-level columns. Same semantics as v1 and the ingester's
 * pick_master: entries with a real object path, stable-sorted by file
 * name, first wins. txt sidecars never reach the merged manifest, so no
 * filter for them here.
 */
function pick_master_part(merged) {
    if (!Array.isArray(merged) || merged.length === 0) return null;
    const candidates = merged.filter((p) => p && p.object);
    if (candidates.length === 0) return null;
    const sorted = [...candidates].sort((a, b) =>
        String(a.title || '').localeCompare(String(b.title || ''))
    );
    return sorted[0];
}

/*
 * Build the full v1-contract envelope. Callers supply the row identity
 * fields, the raw ASpace record, and the METS/DIP parts (empty array when
 * unavailable — e.g. a metadata refresh reuses the paths already stored).
 *
 * Returns the envelope plus the derived column values so every writer
 * (ingest, refresh, backfill) keeps tbl_objects columns and the JSON in
 * lockstep:
 *
 *   { envelope, master, mime_type, thumbnail, file_name, object,
 *     compound_parts }
 */
function build_envelope({
    pid,
    is_member_of_collection,
    handle,
    is_published,
    is_compound,
    metadata,
    dip_parts,
}) {
    if (!metadata || typeof metadata !== 'object') {
        throw new Error('build_envelope requires the ASpace metadata record');
    }
    const merged = merge_parts(metadata.parts, dip_parts);
    const master = pick_master_part(merged);

    const mime_type = (master && master.type) || null;
    const thumbnail = (master && master.thumbnail) || null;
    const object = (master && master.object) || null;
    const entry_id = derive_entry_id(merged, null, metadata);

    const envelope = {
        pid,
        is_member_of_collection: is_member_of_collection || '',
        handle: handle || '',
        thumbnail,
        mime_type,
        // v1 and the frontend know only 'object' + is_compound, never 'compound'.
        object_type: 'object',
        is_published: is_published ? 1 : 0,
        is_compound: is_compound ? 1 : 0,
        title: metadata.title || '',
        creator: derive_creator(metadata, null),
        f_subjects: derive_f_subjects(metadata, null),
        abstract: extract_abstract(metadata, null) || '',
        type: metadata.resource_type || type_from_mime(mime_type),
        // The raw ASpace record, carrying the single merged parts copy.
        display_record: { ...metadata, parts: merged },
        object,
    };
    if (entry_id) envelope.entry_id = entry_id;

    return {
        envelope,
        master,
        mime_type,
        thumbnail,
        /*
         * v1 convention: tbl_objects.file_name is the master's FULL
         * dip-store path (21,753/21,779 legacy rows), not the bare file
         * name — the convert (TIFF→JPG) service posts it verbatim as
         * full_path, and the index projection's master_object fallback
         * expects a resolvable path.
         */
        file_name: object,
        object,
        compound_parts: is_compound ? JSON.stringify(merged) : '[]',
    };
}

module.exports = {
    first_string,
    extract_abstract,
    derive_creator,
    derive_f_subjects,
    derive_entry_id,
    type_from_mime,
    is_dip_parts,
    dip_object_path,
    merge_parts,
    pick_master_part,
    build_envelope,
};
