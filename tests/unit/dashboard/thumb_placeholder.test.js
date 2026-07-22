'use strict';

/*
 * Render thumb_placeholder.ejs for each media category and assert the icon
 * + accessible label differ — so audio, video, and PDF default thumbnails
 * are visually distinct from images. Each category's SVG is identified by a
 * path/shape token unique to it.
 */

const path = require('node:path');
const ejs = require('ejs');

const PARTIAL = path.resolve(__dirname, '../../../views/dashboard/partials/thumb_placeholder.ejs');
const render = (media) => ejs.renderFile(PARTIAL, { media });

const AUDIO_TOKEN = '<circle cx="6" cy="18" r="3"/>'; // music-note bass note
const VIDEO_TOKEN = '<polygon points="23 7 16 12 23 17 23 7"/>'; // film play
const PDF_TOKEN = '<polyline points="14 2 14 8 20 8"/>'; // doc fold
const IMAGE_TOKEN = '<circle cx="8.5" cy="8.5" r="1.5"/>'; // image "sun"
const FILE_TOKEN = '<polyline points="13 2 13 9 20 9"/>'; // generic file fold

describe('thumb_placeholder partial', () => {
    it('audio → music-note icon + "Audio file"', async () => {
        const html = await render('audio');
        expect(html).toContain('data-media="audio"');
        expect(html).toContain('Audio file');
        expect(html).toContain(AUDIO_TOKEN);
    });

    it('video → film icon + "Video file"', async () => {
        const html = await render('video');
        expect(html).toContain('data-media="video"');
        expect(html).toContain('Video file');
        expect(html).toContain(VIDEO_TOKEN);
    });

    it('pdf → document icon + "PDF document"', async () => {
        const html = await render('pdf');
        expect(html).toContain('data-media="pdf"');
        expect(html).toContain('PDF document');
        expect(html).toContain(PDF_TOKEN);
    });

    it('image → image icon', async () => {
        const html = await render('image');
        expect(html).toContain('data-media="image"');
        expect(html).toContain(IMAGE_TOKEN);
    });

    it('unknown or absent media → generic file icon', async () => {
        const html = await render('file');
        expect(html).toContain('data-media="file"');
        expect(html).toContain(FILE_TOKEN);
        const fallback = await render(undefined);
        expect(fallback).toContain('data-media="file"');
        expect(fallback).toContain(FILE_TOKEN);
    });

    it('audio, video, pdf icons are each distinct from the image icon', async () => {
        for (const m of ['audio', 'video', 'pdf']) {
            const html = await render(m);
            expect(html).not.toContain(IMAGE_TOKEN);
        }
        expect(await render('image')).not.toContain(AUDIO_TOKEN);
    });
});
