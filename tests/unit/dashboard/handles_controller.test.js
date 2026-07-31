'use strict';

/*
 * The mint form posts a fixed five rows so "up to 5" needs no add-row
 * scripting. That puts the burden on the server to work out which rows the
 * operator actually filled in — and to not silently discard a row that was
 * half-filled, which would mint fewer handles than the operator believes.
 */

const controller = require('../../../dashboard/handles_controller');

describe('dashboard/handles_controller.entries_from_body', () => {
    it('drops entirely blank rows', () => {
        const entries = controller.entries_from_body({
            target_url: ['https://du.edu/a', '', '', '', ''],
            note: ['first', '', '', '', ''],
        });
        expect(entries).toEqual([{ target_url: 'https://du.edu/a', note: 'first' }]);
    });

    it('keeps filled rows in order, ignoring blanks between them', () => {
        const entries = controller.entries_from_body({
            target_url: ['https://du.edu/a', '', 'https://du.edu/b', '', ''],
            note: ['', '', 'third', '', ''],
        });
        expect(entries).toEqual([
            { target_url: 'https://du.edu/a', note: '' },
            { target_url: 'https://du.edu/b', note: 'third' },
        ]);
    });

    /*
     * A note with no URL is kept, not dropped: the model then rejects it with
     * "Target URL is required". Dropping it would silently mint nothing for a
     * row the operator clearly meant to fill.
     */
    it('keeps a note-only row so it fails loudly rather than vanishing', () => {
        const entries = controller.entries_from_body({
            target_url: ['', '', '', '', ''],
            note: ['I forgot the URL', '', '', '', ''],
        });
        expect(entries).toEqual([{ target_url: '', note: 'I forgot the URL' }]);
    });

    it('handles a single-row body where Express gives strings, not arrays', () => {
        const entries = controller.entries_from_body({
            target_url: 'https://du.edu/a',
            note: 'solo',
        });
        expect(entries).toEqual([{ target_url: 'https://du.edu/a', note: 'solo' }]);
    });

    it('trims surrounding whitespace', () => {
        const entries = controller.entries_from_body({
            target_url: ['  https://du.edu/a  '],
            note: ['  padded  '],
        });
        expect(entries).toEqual([{ target_url: 'https://du.edu/a', note: 'padded' }]);
    });

    it('returns nothing for a completely empty form', () => {
        expect(controller.entries_from_body({
            target_url: ['', '', '', '', ''],
            note: ['', '', '', '', ''],
        })).toEqual([]);
    });
});
