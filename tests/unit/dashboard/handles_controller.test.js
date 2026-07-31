'use strict';

/*
 * The mint form posts a fixed five rows so "up to 5" needs no add-row
 * scripting. That puts the burden on the server to work out which rows the
 * operator actually filled in — and to not silently discard a row that was
 * half-filled, which would mint fewer handles than the operator believes.
 */

const controller = require('../../../dashboard/handles_controller');
const handles_model = require('../../../handles/model');
const app_config = require('../../../config/app');

/*
 * Minimal res double: enough for render_partial + the HX-Trigger toast
 * header, which is the only thing these assertions care about.
 */
function make_res() {
    const headers = {};
    const rendered = [];
    return {
        headers,
        rendered,
        get: (name) => headers[name],
        set: (name, value) => { headers[name] = value; },
        render: (view, locals) => { rendered.push({ view, locals }); },
        locals: {},
        toast() {
            return headers['HX-Trigger'] ? JSON.parse(headers['HX-Trigger']).toast : null;
        },
    };
}

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

/*
 * Regression, 2026-07-31. A rejected target used to bubble a ValidationError
 * to the central handler, which answers 400 with a JSON envelope. htmx does
 * not swap on a 4xx — the dashboard's only htmx:responseError handler covers
 * 401 — so the operator clicked Mint and absolutely nothing happened. Expected
 * failures have to come back as a toast on a 200.
 */
describe('dashboard/handles_controller error surfacing', () => {
    let original_env;
    beforeEach(() => {
        original_env = { ...process.env };
        /*
         * A fully configured system — mint() refuses outright otherwise, and
         * these assertions are about what happens AFTER that gate.
         */
        process.env.HANDLE_ADMIN_URL = 'http://handle.example.edu:8000';
        process.env.HANDLE_ADMIN_ID = '300:0.NA/10176';
        process.env.HANDLE_ADMIN_KEY_PATH = '/etc/repov2/admpriv.bin';
        process.env.HANDLE_CLIENT_LIB = '/opt/handle-client/lib';
        process.env.HANDLE_SERVER = 'https://hdl.handle.net/';
        process.env.HANDLE_TARGET = 'https://digitalarchives.du.edu/object/';
        process.env.HANDLE_ALLOWED_TARGET_HOSTS = 'du.edu';
        process.env.HANDLE_PREFIX = '10176';
        app_config._reset();
        vi.spyOn(handles_model, 'list').mockResolvedValue([]);
    });
    afterEach(() => {
        process.env = original_env;
        app_config._reset();
        vi.restoreAllMocks();
    });

    it('toasts a disallowed target host instead of throwing', async () => {
        const res = make_res();
        await controller.handles_mint(
            { body: { target_url: ['https://evil.com/x'], note: [''] }, query: {} },
            res
        );

        const toast = res.toast();
        expect(toast.level).toBe('error');
        expect(toast.message).toMatch(/not allowed/);
        /* and the list is still re-rendered, so the panel refreshes */
        expect(res.rendered[0].view).toBe('dashboard/partials/handles_list');
    });

    it('toasts an empty submission rather than failing silently', async () => {
        const res = make_res();
        await controller.handles_mint(
            { body: { target_url: ['', ''], note: ['', ''] }, query: {} },
            res
        );
        expect(res.toast().message).toMatch(/at least one target URL/i);
    });

    it('toasts a delete conflict', async () => {
        vi.spyOn(handles_model, 'remove').mockRejectedValue(
            new (require('../../../libs/errors').ConflictError)('10176/x is in use by object p1')
        );
        const res = make_res();
        await controller.handles_delete({ params: { id: '1' }, query: {} }, res);

        expect(res.toast().level).toBe('error');
        expect(res.toast().message).toMatch(/in use by object/);
    });

    /* An unexpected fault must still reach the central error handler. */
    it('rethrows anything that is not an expected failure', async () => {
        vi.spyOn(handles_model, 'remove').mockRejectedValue(new Error('socket hang up'));
        await expect(
            controller.handles_delete({ params: { id: '1' }, query: {} }, make_res())
        ).rejects.toThrow('socket hang up');
    });
});
