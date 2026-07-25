'use strict';

/*
 * Batch structure-QA flag rendering (feature-batch-packaging-qa).
 *
 * The curation-service /workspace and /workspace/packages endpoints report
 * machine-readable structure problems per batch folder:
 *
 *   { code: 'loose_files', severity: 'error'|'warn'|'info',
 *     items: [...capped at 20...], total: <true count> }
 *
 * This module owns the staff-facing wording for those codes. Staff are
 * non-technical: every message names the problem in plain words and says
 * what to do about it. The server deliberately ships codes only, so all
 * tone/wording lives here in one place.
 *
 * Exports:
 *   format_structure_errors(flags) -> [{ severity, text }]
 *   has_blocking_errors(flags)     -> true when any flag is error severity
 */

/*
 * items lists are capped server-side (total carries the real count), so
 * a listing can honestly say "and N more" without shipping hundreds of
 * names to the browser.
 */
function _items_phrase(flag) {
    const items = Array.isArray(flag.items) ? flag.items : [];
    if (items.length === 0) return '';
    const total = Number.isFinite(flag.total) ? flag.total : items.length;
    const more = total - items.length;
    const list = items.join(', ');
    return more > 0 ? `${list} (and ${more} more)` : list;
}

const MESSAGES = {
    no_packages(flag, folder) {
        return (
            `"${folder}" has no archival object folders inside it. ` +
            'Create a folder for each archival object and move its files into that folder.'
        );
    },
    loose_files(flag) {
        const total = Number.isFinite(flag.total) ? flag.total : flag.items.length;
        const noun = total === 1 ? 'file is' : 'files are';
        return (
            `${total} ${noun} sitting directly inside the collection folder: ` +
            `${_items_phrase(flag)}. Move each file into its archival object folder.`
        );
    },
    empty_package(flag) {
        const total = Number.isFinite(flag.total) ? flag.total : flag.items.length;
        const noun = total === 1 ? 'folder is' : 'folders are';
        return (
            `${total} archival object ${noun} empty: ${_items_phrase(flag)}. ` +
            'Add the files, or remove the folder if it was created by mistake.'
        );
    },
    nested_dirs(flag) {
        return (
            'Archival object folders must contain files only, but these contain ' +
            `folders: ${_items_phrase(flag)}. Move the files up one level and ` +
            'remove the extra folders.'
        );
    },
    bad_folder_name(flag, folder) {
        const parts = [];
        const items = Array.isArray(flag.items) ? flag.items : [];
        if (items.indexOf('missing_new_prefix') !== -1) {
            parts.push('start with "new_"');
        }
        if (items.indexOf('missing_resources_id_tail') !== -1) {
            parts.push(
                'end with "-resources_" followed by the ArchivesSpace resource number'
            );
        }
        const rule = parts.length > 0 ? parts.join(' and ') : 'follow the naming convention';
        return (
            `The collection folder name "${folder}" must ${rule} — ` +
            'for example "new_special_collection-resources_1204". Rename the folder, then refresh.'
        );
    },
    partially_processed(flag) {
        return (
            'Some archival object folders in this collection were already processed. ' +
            `Still waiting: ${_items_phrase(flag)}. Running Make Digital Objects ` +
            'again is safe — already-processed folders are left as they are.'
        );
    },
    name_hygiene(flag) {
        return (
            `These names contain spaces: ${_items_phrase(flag)}. ` +
            'Spaces are removed automatically later in the process; renaming them now avoids surprises.'
        );
    },
    unreadable(flag, folder) {
        return (
            `The system could not read "${folder}" because of a folder permission ` +
            'problem. Contact LDT so a developer can fix the permissions.'
        );
    },
};

/*
 * Unknown codes (a newer curation-service than this dashboard) degrade to
 * a generic-but-honest line instead of being dropped — a structure problem
 * must never be silently hidden by a version skew.
 */
function _fallback_message(flag) {
    const items = _items_phrase(flag);
    return (
        `This folder has a structure problem (${flag.code})` +
        (items ? `: ${items}.` : '.') +
        ' Contact LDT if the cause is not obvious.'
    );
}

function format_structure_errors(flags, folder_name) {
    if (!Array.isArray(flags)) return [];
    return flags.map((flag) => {
        const render = MESSAGES[flag.code];
        return {
            severity: flag.severity === 'error' || flag.severity === 'warn' ? flag.severity : 'info',
            code: flag.code,
            text: render ? render(flag, folder_name) : _fallback_message(flag),
        };
    });
}

function has_blocking_errors(flags) {
    return Array.isArray(flags) && flags.some((f) => f && f.severity === 'error');
}

module.exports = {
    format_structure_errors,
    has_blocking_errors,
};
