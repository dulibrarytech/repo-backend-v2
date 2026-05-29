'use strict';

// METS XML parser. Archivematica produces a METS document per AIP
// describing every file in the package (UUIDs, MIME types, paths into
// the DIP store). The ingest worker fetches the METS file via the
// DuraCloud proxy, runs it through parse_mets(...), and uses the
// resulting array of file descriptors to build tbl_objects rows for
// the master files + derivatives.
//
// Output shape — one entry per `mets:file` element:
//   {
//     uuid,        // file UUID (the `ID="file-…"` attribute, minus prefix)
//     sip_uuid,    // SIP UUID (passed in by the caller, not derived)
//     dip_path,    // DIP-store path prefix (passed in by the caller)
//     file,        // relative path under objects/ (e.g. "thing.tif")
//     file_id,     // file basename minus extension (e.g. "thing")
//     mime_type,   // detected mime type for the techMD that precedes
//                  // this file group; v1 derived this from PREMIS
//                  // object characteristics (RDF or FITS toolOutput)
//     type,        // 'object' for binary objects; 'txt' for text
//                  // sidecars (transcript / OCR / etc.)
//   }
//
// v1 used `xmldoc` (DOM walker). v2 uses `xml2js` for consistency with
// the SSO / ASpace XML handling. The shape this module emits is
// identical to v1's so downstream code (worker, dashboard) needs no
// changes.

const xml2js = require('xml2js');
const { ValidationError } = require('../../libs/errors');

// xml2js parser configured to:
//   - keep namespace prefixes intact (`mets:fileSec`, `premis:object`)
//   - keep attributes addressable as `node.$`
//   - never collapse single-child arrays — METS' shape varies enough
//     that consistent arrays simplify the walker
const PARSER_OPTS = {
    explicitArray: true,
    explicitRoot: false,
    mergeAttrs: false,
    preserveChildrenOrder: false,
    charkey: '_',
    attrkey: '$',
};

async function parse_mets(xml, { sip_uuid, dip_path }) {
    if (!xml || typeof xml !== 'string') {
        throw new ValidationError('METS xml must be a non-empty string');
    }
    const parser = new xml2js.Parser(PARSER_OPTS);
    let parsed;
    try {
        parsed = await parser.parseStringPromise(xml);
    } catch (err) {
        throw new ValidationError(`METS XML parse error: ${err.message}`);
    }

    // Walk amdSec children sequentially. The METS produced by AM
    // alternates `mets:amdSec` blocks (one per file, carrying the mime
    // type) with a single trailing `mets:fileSec` block (the file
    // manifest). The mime-type-for-this-file association is positional
    // in v1's xmldoc walker, so we preserve that semantic by walking
    // the amdSec list in order and zipping mime types against fileSec
    // entries by index.
    const amd_secs = parsed['mets:amdSec'] || [];
    const file_sec = parsed['mets:fileSec'] && parsed['mets:fileSec'][0];

    const mime_types = amd_secs.map(extract_mime_type);

    if (!file_sec) {
        return [];
    }
    const file_grp = (file_sec['mets:fileGrp'] && file_sec['mets:fileGrp'][0]) || null;
    if (!file_grp) {
        return [];
    }
    const files = file_grp['mets:file'] || [];

    const out = [];
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const flocat = (file['mets:FLocat'] && file['mets:FLocat'][0]) || null;
        if (!flocat || !flocat.$) continue;
        const href = flocat.$['xlink:href'] || '';
        const cleaned = href.replace(/^objects\//, '');
        const ext_parts = cleaned.split('.');
        const ext = ext_parts.length > 1 ? ext_parts.pop() : '';
        const file_id = ext_parts.join('.');
        const id_attr = (file.$ && file.$.ID) || '';
        out.push({
            uuid: id_attr.replace(/^file-/, ''),
            sip_uuid,
            dip_path,
            file: cleaned,
            file_id,
            // The xmldoc walker associated each file with the mime type
            // from the matching amdSec (by index). Fall back to the last
            // captured mime type if we ran out of amdSecs (AM emits one
            // amdSec per file in modern versions; we tolerate older
            // METS).
            mime_type:
                mime_types[i] !== undefined ? mime_types[i] : mime_types[mime_types.length - 1],
            type: ext === 'txt' ? 'txt' : 'object',
        });
    }
    return out;
}

// Extract the file's MIME type from a `mets:amdSec/mets:techMD/.../
// premis:objectCharacteristicsExtension` block. Two flavors exist in
// practice:
//
//   - RDF format: <rdf:Description><File:MIMEType>…</File:MIMEType></...>
//     Used for media files (wav, mp4, tiff) where the FITS tool ran
//     against a metadata-rich source.
//
//   - FITS toolOutput format: <fits><toolOutput><tool>
//     <fileUtilityOutput><mimetype>…</mimetype></...>
//     Used primarily for PDFs in v1's deployment.
//
// Returns null if neither flavor matches — caller decides whether to
// fall back to a sibling block or surface as INGEST_HALTED.
function extract_mime_type(amd_sec) {
    try {
        const tech_md = first_child(amd_sec, 'mets:techMD');
        const md_wrap = first_child(tech_md, 'mets:mdWrap');
        const xml_data = first_child(md_wrap, 'mets:xmlData');
        const premis_obj = first_child(xml_data, 'premis:object');
        const obj_chars = first_child(premis_obj, 'premis:objectCharacteristics');
        const obj_chars_ext = first_child(obj_chars, 'premis:objectCharacteristicsExtension');
        if (!obj_chars_ext) return null;

        // RDF flavor (media files).
        const rdf = first_child(obj_chars_ext, 'rdf:RDF');
        if (rdf) {
            const rdf_desc = first_child(rdf, 'rdf:Description');
            const mime = first_child_value(rdf_desc, 'File:MIMEType');
            if (mime) return mime;
        }

        // FITS flavor (PDFs and others).
        const fits = first_child(obj_chars_ext, 'fits');
        if (fits) {
            const tool_output = first_child(fits, 'toolOutput');
            const tool = first_child(tool_output, 'tool');
            const file_util = first_child(tool, 'fileUtilityOutput');
            const mime = first_child_value(file_util, 'mimetype');
            // v1 only honored mime === 'application/pdf' from this path;
            // we preserve that filter so we don't accidentally pick up
            // FITS noise from non-PDF files.
            if (mime === 'application/pdf') return mime;
        }

        return null;
    } catch {
        // Defensive: malformed METS shouldn't blow up the whole parse.
        // The worker decides whether to halt based on whether ANY
        // mime types came out non-null.
        return null;
    }
}

function first_child(node, name) {
    if (!node || typeof node !== 'object') return null;
    const arr = node[name];
    if (!Array.isArray(arr) || arr.length === 0) return null;
    return arr[0];
}

function first_child_value(node, name) {
    const child = first_child(node, name);
    if (!child) return null;
    // xml2js with charkey='_' stores text content as `_` when the
    // element also has attributes; bare text is the string itself.
    if (typeof child === 'string') return child;
    if (child && typeof child === 'object' && child._) return child._;
    return null;
}

module.exports = { parse_mets };
