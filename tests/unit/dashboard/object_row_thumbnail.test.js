'use strict';

/*
 * object_row.ejs thumbnail cell: a no-thumbnail object renders the
 * media-specific placeholder; a thumbnailed object tags the <img> with
 * data-media so the client broken-image fallback can pick the right icon.
 */

const path = require('node:path');
const ejs = require('ejs');

const PARTIAL = path.resolve(__dirname, '../../../views/dashboard/partials/object_row.ejs');

function item(over) {
    return {
        pid: 'p1',
        title: 'Julia Wilkinson Manley Oral History, 2023',
        is_active: 1,
        is_published: 0,
        object_type: 'object',
        handle: null,
        uri: null,
        thumbnail: null,
        media_category: 'file',
        ...over,
    };
}
const render = (over) => ejs.renderFile(PARTIAL, { item: item(over), dashboard_base: '/repo/dashboard' });

describe('object_row thumbnail cell', () => {
    it('audio object with no thumbnail → audio placeholder', async () => {
        const html = await render({ thumbnail: null, media_category: 'audio' });
        expect(html).toContain('data-media="audio"');
        expect(html).toContain('Audio file');
    });

    it('thumbnailed object tags the img with data-media (for the broken-image fallback)', async () => {
        const html = await render({
            thumbnail: '/repo/dashboard/objects/p1/thumbnail/raw',
            media_category: 'video',
        });
        expect(html).toMatch(/<img[^>]*class="thumb-img"[^>]*data-media="video"/);
    });

    it('no-mime object falls back to the generic file placeholder', async () => {
        const html = await render({ thumbnail: null, media_category: 'file' });
        expect(html).toContain('data-media="file"');
    });
});
