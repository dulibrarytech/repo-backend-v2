'use strict';

/*
 * Pure helpers for Stage 5 (post-AM repository build).
 * 
 * Splitting these out from stages/repository.js keeps the orchestrator
 * thin (it sequences fetch → parse → build → insert) and makes the
 * data-shape work unit-testable without spinning up sqlite or stubbing
 * HTTP. Two big concerns live here:
 * 
 *   1. `enrich_parts(files, { dip_path })` — given the METS-parsed
 *      file list, build the per-part records the dashboard renders
 *      (object path + thumbnail path inside DuraCloud).
 * 
 *   2. `build_object_row({ queue_row, metadata, parts, handle })`
 *      — assemble the tbl_objects-shaped record ready for
 *      repository/model._insert. Encapsulates the field selection,
 *      JSON serialization, and the "is this compound?" decision.
 * 
 * The shape produced here mirrors what v1's ingest pipeline wrote so
 * existing rows + the legacy indexer + the staff dashboard line up
 * column-for-column. New columns introduced by v2 (e.g. is_indexed
 * trigger flags) ride on top.
 */

const { ValidationError } = require('../../libs/errors');
const display_envelope = require('../../libs/display_envelope');

/*
 * Given the METS-parsed file list (from ingester/libs/mets.parse_mets)
 * and the DIP path, produce the "parts" array we store inside
 * display_record. Each entry carries:
 * 
 *   { uuid, file_id, file, mime_type, type, object, thumbnail }
 * 
 * where `object` is the DuraCloud path to the master file and
 * `thumbnail` is the DC path to the conventional thumbnail derivative
 * AM produced during ingest. The thumbnail path is `<dip_path>/
 * thumbnails/<file_uuid>.jpg`, matching v1's convention so the
 * existing dashboard thumbnail proxy resolves cleanly.
 */
function enrich_parts(files, { dip_path }) {
    if (!Array.isArray(files)) {
        throw new ValidationError('enrich_parts requires an array of METS files');
    }
    if (!dip_path) {
        throw new ValidationError('enrich_parts requires dip_path');
    }
    /*
     * Only emit one entry per file UUID. Compound files commonly
     * appear in both an object position and a `.txt` sidecar; we
     * keep the object record and ignore the sidecar's duplicate.
     */
    const seen = new Set();
    const out = [];
    for (const f of files) {
        if (!f || !f.uuid) continue;
        if (seen.has(f.uuid)) continue;
        seen.add(f.uuid);
        out.push({
            uuid: f.uuid,
            file_id: f.file_id,
            file: f.file,
            mime_type: f.mime_type || null,
            type: f.type || 'object',
            /*
             * Master file path inside the DIP. AM names the stored
             * access copy `<fileUUID>-<original name>` — the METS
             * FLocat href carries only the original name, so the
             * bare `objects/<file>` path 404s against the dip-store
             * (that broke every published v2 image until 2026-08-04;
             * see repo/REPOV2_DISPLAY_RECORD_FINDINGS.md). The
             * dashboard's thumbnail proxy resolves these via
             * libs/duracloud.
             */
            object: `${dip_path}/objects/${f.uuid}-${f.file}`,
            /*
             * Thumbnail derivative AM auto-generated. Note .jpg —
             * AM normalizes all preview thumbnails to JPEG regardless
             * of source.
             */
            thumbnail: `${dip_path}/thumbnails/${f.uuid}.jpg`,
        });
    }
    return out;
}

/*
 * Stamp kaltura_id onto each part by looking up (package, file) in
 * tbl_kaltura_ids. Called from Stage 5 AFTER enrich_parts and BEFORE
 * build_object_row so the display_record's parts[] carry the entry IDs
 * when the dashboard renders them.
 * 
 * Why we read from tbl_kaltura_ids here (instead of trusting whatever
 * kaltura_id MDO stamped onto the AS record):
 *   1. MDO writes kaltura_id to the AS digital object COMPONENT level
 *      — different path from our snapshot's metadata.parts[].
 *      Re-deriving from tbl_kaltura_ids gives us the same source of
 *      truth that the standalone kaltura subsystem uses.
 *   2. If staff re-ran the kaltura/metadata batch after MDO (common
 *      when Kaltura entries were corrected post-MDO), the most
 *      recent resolution wins via tbl_kaltura_ids' insertion order.
 *   3. Backfill scenarios (kaltura items ingested before kaltura/*
 *      existed) can re-attach IDs via a future admin action without
 *      re-running MDO.
 * 
 * kaltura_model is the kaltura/model module. Tests inject a fake.
 * Always best-effort: a lookup miss leaves kaltura_id absent on the
 * part (NOT set to '0_0'). The dashboard renders a "no Kaltura match"
 * hint only when the part is known to be Kaltura-hosted (mime starts
 * with video/ or audio/) AND no kaltura_id is present.
 */
async function attach_kaltura_ids(parts, package_name, kaltura_model) {
    if (!Array.isArray(parts) || parts.length === 0) return parts;
    if (!kaltura_model || typeof kaltura_model.get_entry_id_for_file !== 'function') {
        return parts;
    }
    const out = [];
    for (const p of parts) {
        if (!p || !p.file) {
            out.push(p);
            continue;
        }
        try {
            const entry_id = await kaltura_model.get_entry_id_for_file(package_name, p.file);
            if (entry_id) {
                out.push({ ...p, kaltura_id: entry_id });
                continue;
            }
        } catch {
            /*
             * Lookup failed — leave the part untouched. We don't
             * halt the ingest on a kaltura-table read failure; the
             * entry_id can be backfilled later.
             */
        }
        out.push(p);
    }
    return out;
}

/*
 * Pick the "master" part — the row in tbl_objects gets one
 * authoritative file_name + thumbnail + mime_type even for compound
 * objects (the dashboard list view uses these for the row preview).
 * 
 * Strategy:
 *   - If only one part of type='object', use it.
 *   - If multiple, prefer the first object-type part. (v1 used
 *     filename lexical order; we match that with a stable sort.)
 *   - txt-only parts are never selected as master.
 * 
 * Returns the chosen part, or null if there are no object parts.
 */
function pick_master(parts) {
    if (!Array.isArray(parts) || parts.length === 0) return null;
    const objects = parts.filter((p) => p && p.type === 'object');
    if (objects.length === 0) return null;
    /*
     * Stable sort by file name so the choice is deterministic across
     * runs even when AM returns the file list in a different order.
     */
    const sorted = [...objects].sort((a, b) =>
        String(a.file || '').localeCompare(String(b.file || ''))
    );
    return sorted[0];
}

/*
 * Build the tbl_objects row. `queue_row` is the ingest_queue row,
 * `metadata` is the AS snapshot (already validated), `parts` is the
 * output of enrich_parts (post attach_kaltura_ids), `handle` is the
 * URL minted by libs/handles (may be null in dev). The master part is
 * chosen inside libs/display_envelope from the merged manifest — same
 * selection semantics as pick_master.
 * 
 * `collection_pid` (optional) is the local collection mirror's PID
 * resolved by Stage 5 before this call. It populates
 * is_member_of_collection so the dashboard's collection-detail page
 * finds this object as a member. Pre-flight gate ensures it's set
 * in normal operation; we fall back to queue_row.collection_uuid for
 * legacy queue rows that pre-date the gate (those carry the folder
 * name in collection_uuid, which is wrong for the column's semantics
 * but matches the historical bug — better than dropping the link).
 * 
 * Returns an object ready for repository/model._insert.
 */
function build_object_row({ queue_row, metadata, parts, handle, collection_pid }) {
    if (!queue_row || !queue_row.sip_uuid || queue_row.sip_uuid === 'PENDING') {
        throw new ValidationError('queue_row.sip_uuid is required');
    }
    if (!metadata) {
        throw new ValidationError('metadata is required');
    }

    const is_compound = compute_is_compound(metadata, parts);

    /*
     * display_record envelope: the full v1 contract — denormalized
     * top-level fields + the raw AS record under display_record with
     * the ONE merged parts manifest (ASpace order/title/MIME/caption/
     * kaltura_id + METS DuraCloud object/thumbnail paths). Built by
     * libs/display_envelope so ingest, metadata refresh, the indexer
     * projection, and the backfill script all emit the same shape.
     *
     * The derived column values come back from the same call so the
     * columns and the JSON cannot diverge. mime prefers the ASpace
     * parts' MDO-stamped value over the METS-derived one (the METS
     * association has shipped wrong — see mets.js).
     */
    const built = display_envelope.build_envelope({
        pid: queue_row.sip_uuid,
        is_member_of_collection: collection_pid || queue_row.collection_uuid || '',
        handle,
        is_published: 0, // staff publishes via the dashboard
        is_compound,
        metadata,
        dip_parts: parts,
    });

    return {
        pid: queue_row.sip_uuid,
        is_member_of_collection: collection_pid || queue_row.collection_uuid || '',
        handle: handle || '',
        uri: queue_row.metadata_uri || '',
        object_type: is_compound ? 'compound' : 'object',
        /*
         * mods is the bare AS metadata as JSON. The metadata_worker
         * writes the same shape on refresh, so re-using that column
         * keeps both writers consistent.
         */
        mods: JSON.stringify(metadata),
        /*
         * mime_type / file_name / thumbnail come from the master
         * merged part. For pure-txt or empty METS we'd land here with
         * master=null — that's fine, tbl_objects.thumbnail is
         * nullable and the dashboard renders a placeholder.
         */
        mime_type: built.mime_type,
        file_name: built.file_name,
        thumbnail: built.thumbnail,
        display_record: JSON.stringify(built.envelope),
        compound_parts: built.compound_parts,
        sip_uuid: queue_row.sip_uuid,
        is_compound: is_compound ? 1 : 0,
        is_published: 0, // staff publishes via the dashboard
        is_restricted: 0,
        is_active: 1,
        is_complete: 1,
        is_indexed: 0,
        /*
         * is_updated=1 signals the indexer worker to push this row
         * into Elasticsearch. The indexer flips it back to 0 once
         * the ES write lands.
         */
        is_updated: 1,
    };
}

/*
 * Compound detection: trust the metadata's is_compound flag when it's
 * explicit; otherwise infer from the parts count (more than one
 * object-type part → compound).
 */
function compute_is_compound(metadata, parts) {
    if (metadata && metadata.is_compound === true) return true;
    if (metadata && metadata.is_compound === false) return false;
    if (!Array.isArray(parts)) return false;
    const obj_parts = parts.filter((p) => p && p.type === 'object');
    return obj_parts.length > 1;
}

/*
 * Pull a specific note out of the AS metadata. AS records carry an
 * array of `{ type, content }` notes; the dashboard surfaces the
 * 'abstract' note prominently. Returns '' when missing so the
 * envelope's downstream consumers don't need null guards.
 */
function extract_note(metadata, note_type) {
    if (!metadata || !Array.isArray(metadata.notes)) return '';
    const note = metadata.notes.find((n) => n && n.type === note_type);
    return note && note.content ? String(note.content) : '';
}

module.exports = {
    enrich_parts,
    attach_kaltura_ids,
    pick_master,
    build_object_row,
    _compute_is_compound: compute_is_compound,
    _extract_note: extract_note,
};
