'use strict';

const { parse_mets } = require('../../../ingester/libs/mets');
const { ValidationError } = require('../../../libs/errors');

/*
 * Minimal METS doc — one amdSec (RDF-flavor PREMIS) + one fileSec
 * with two files. Covers the happy path used by the worker.
 */
function rdf_amdsec(mime, id) {
    return `
    <mets:amdSec${id ? ` ID="${id}"` : ''}>
      <mets:techMD>
        <mets:mdWrap>
          <mets:xmlData>
            <premis:object>
              <premis:objectCharacteristics>
                <premis:objectCharacteristicsExtension>
                  <rdf:RDF>
                    <rdf:Description>
                      <File:MIMEType>${mime}</File:MIMEType>
                    </rdf:Description>
                  </rdf:RDF>
                </premis:objectCharacteristicsExtension>
              </premis:objectCharacteristics>
            </premis:object>
          </mets:xmlData>
        </mets:mdWrap>
      </mets:techMD>
    </mets:amdSec>`;
}

function fits_amdsec_pdf() {
    return `
    <mets:amdSec>
      <mets:techMD>
        <mets:mdWrap>
          <mets:xmlData>
            <premis:object>
              <premis:objectCharacteristics>
                <premis:objectCharacteristicsExtension>
                  <fits>
                    <toolOutput>
                      <tool>
                        <fileUtilityOutput>
                          <mimetype>application/pdf</mimetype>
                        </fileUtilityOutput>
                      </tool>
                    </toolOutput>
                  </fits>
                </premis:objectCharacteristicsExtension>
              </premis:objectCharacteristics>
            </premis:object>
          </mets:xmlData>
        </mets:mdWrap>
      </mets:techMD>
    </mets:amdSec>`;
}

function file_entry(id, href, admid) {
    return `
      <mets:file ID="${id}"${admid ? ` ADMID="${admid}"` : ''}>
        <mets:FLocat xlink:href="${href}" />
      </mets:file>`;
}

function wrap(inner) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<mets:mets xmlns:mets="http://www.loc.gov/METS/"
           xmlns:premis="info:lc/xmlns/premis-v2"
           xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
           xmlns:File="https://example.com/file-ns"
           xmlns:xlink="http://www.w3.org/1999/xlink">
  ${inner}
</mets:mets>`;
}

describe('ingester/libs/mets — parse_mets', () => {
    it('returns an array of file descriptors for a happy-path METS', async () => {
        const xml = wrap(`
            ${rdf_amdsec('image/tiff')}
            ${rdf_amdsec('image/tiff')}
            <mets:fileSec>
              <mets:fileGrp>
                ${file_entry('file-aaaa-1111', 'objects/thing-001.tif')}
                ${file_entry('file-aaaa-2222', 'objects/thing-002.tif')}
              </mets:fileGrp>
            </mets:fileSec>
        `);
        const out = await parse_mets(xml, { sip_uuid: 'sip-1', dip_path: '0000/1111/folder' });
        expect(out).toHaveLength(2);
        expect(out[0]).toEqual({
            uuid: 'aaaa-1111',
            sip_uuid: 'sip-1',
            dip_path: '0000/1111/folder',
            file: 'thing-001.tif',
            file_id: 'thing-001',
            mime_type: 'image/tiff',
            type: 'object',
        });
        expect(out[1].uuid).toBe('aaaa-2222');
        expect(out[1].file_id).toBe('thing-002');
    });

    it('detects FITS-flavor PDF mime type', async () => {
        const xml = wrap(`
            ${fits_amdsec_pdf()}
            <mets:fileSec>
              <mets:fileGrp>
                ${file_entry('file-pdf-1', 'objects/doc.pdf')}
              </mets:fileGrp>
            </mets:fileSec>
        `);
        const out = await parse_mets(xml, { sip_uuid: 'sip-1', dip_path: 'x/y' });
        expect(out[0].mime_type).toBe('application/pdf');
    });

    it('marks .txt files as type "txt"', async () => {
        const xml = wrap(`
            ${rdf_amdsec('text/plain')}
            <mets:fileSec>
              <mets:fileGrp>
                ${file_entry('file-txt-1', 'objects/transcript.txt')}
              </mets:fileGrp>
            </mets:fileSec>
        `);
        const out = await parse_mets(xml, { sip_uuid: 'sip-1', dip_path: 'x/y' });
        expect(out[0].type).toBe('txt');
    });

    it('strips the "file-" prefix from the ID attribute', async () => {
        const xml = wrap(`
            ${rdf_amdsec('image/tiff')}
            <mets:fileSec>
              <mets:fileGrp>
                ${file_entry('file-abc-def', 'objects/x.tif')}
              </mets:fileGrp>
            </mets:fileSec>
        `);
        const out = await parse_mets(xml, { sip_uuid: 'sip-1', dip_path: 'x/y' });
        expect(out[0].uuid).toBe('abc-def');
    });

    it('returns an empty array when there is no fileSec', async () => {
        const xml = wrap(rdf_amdsec('image/tiff'));
        const out = await parse_mets(xml, { sip_uuid: 'sip-1', dip_path: 'x/y' });
        expect(out).toEqual([]);
    });

    it('returns an empty array when fileSec has no fileGrp', async () => {
        const xml = wrap(`<mets:fileSec></mets:fileSec>`);
        const out = await parse_mets(xml, { sip_uuid: 'sip-1', dip_path: 'x/y' });
        expect(out).toEqual([]);
    });

    it('throws ValidationError on non-string input', async () => {
        await expect(parse_mets(null, { sip_uuid: 'x', dip_path: 'y' })).rejects.toBeInstanceOf(
            ValidationError
        );
        await expect(parse_mets('', { sip_uuid: 'x', dip_path: 'y' })).rejects.toBeInstanceOf(
            ValidationError
        );
    });

    it('throws ValidationError on malformed XML', async () => {
        await expect(
            parse_mets('<not closed', { sip_uuid: 'x', dip_path: 'y' })
        ).rejects.toBeInstanceOf(ValidationError);
    });

    it('associates mimes by ADMID, not position (uri.txt-first regression)', async () => {
        /*
         * The 2026-07/08 prod ingests shipped swapped mimes because the
         * fileSec listed uri.txt BEFORE the media file while the amdSecs
         * were in the opposite order — positional zip gave uri.txt the
         * video mime and the .mov null. ADMID is authoritative.
         */
        const xml = wrap(`
            ${rdf_amdsec('video/quicktime', 'amdSec-1')}
            ${rdf_amdsec('text/plain', 'amdSec-2')}
            <mets:fileSec>
              <mets:fileGrp>
                ${file_entry('file-txt-1', 'objects/uri.txt', 'amdSec-2')}
                ${file_entry('file-mov-1', 'objects/interview.mov', 'amdSec-1')}
              </mets:fileGrp>
            </mets:fileSec>
        `);
        const out = await parse_mets(xml, { sip_uuid: 'sip-1', dip_path: 'x/y' });
        expect(out[0].file).toBe('uri.txt');
        expect(out[0].mime_type).toBe('text/plain');
        expect(out[1].file).toBe('interview.mov');
        expect(out[1].mime_type).toBe('video/quicktime');
    });

    it('takes the first token of a multi-valued ADMID', async () => {
        const xml = wrap(`
            ${rdf_amdsec('image/tiff', 'amdSec-9')}
            <mets:fileSec>
              <mets:fileGrp>
                ${file_entry('file-a', 'objects/a.tif', 'amdSec-9 amdSec-extra')}
              </mets:fileGrp>
            </mets:fileSec>
        `);
        const out = await parse_mets(xml, { sip_uuid: 'sip-1', dip_path: 'x/y' });
        expect(out[0].mime_type).toBe('image/tiff');
    });

    it('falls back to positional association when files carry no ADMID', async () => {
        const xml = wrap(`
            ${rdf_amdsec('image/tiff', 'amdSec-1')}
            ${rdf_amdsec('image/png', 'amdSec-2')}
            <mets:fileSec>
              <mets:fileGrp>
                ${file_entry('file-a', 'objects/a.tif')}
                ${file_entry('file-b', 'objects/b.png')}
              </mets:fileGrp>
            </mets:fileSec>
        `);
        const out = await parse_mets(xml, { sip_uuid: 'sip-1', dip_path: 'x/y' });
        expect(out[0].mime_type).toBe('image/tiff');
        expect(out[1].mime_type).toBe('image/png');
    });

    it('falls back positionally when ADMID references an unknown amdSec', async () => {
        const xml = wrap(`
            ${rdf_amdsec('image/tiff', 'amdSec-1')}
            <mets:fileSec>
              <mets:fileGrp>
                ${file_entry('file-a', 'objects/a.tif', 'amdSec-nope')}
              </mets:fileGrp>
            </mets:fileSec>
        `);
        const out = await parse_mets(xml, { sip_uuid: 'sip-1', dip_path: 'x/y' });
        expect(out[0].mime_type).toBe('image/tiff');
    });

    it('falls back to the last mime type when fewer amdSecs than files', async () => {
        /*
         * One amdSec, two files — second file inherits the same mime
         * (per v1's positional fallback behavior).
         */
        const xml = wrap(`
            ${rdf_amdsec('image/tiff')}
            <mets:fileSec>
              <mets:fileGrp>
                ${file_entry('file-a', 'objects/a.tif')}
                ${file_entry('file-b', 'objects/b.tif')}
              </mets:fileGrp>
            </mets:fileSec>
        `);
        const out = await parse_mets(xml, { sip_uuid: 'sip-1', dip_path: 'x/y' });
        expect(out[0].mime_type).toBe('image/tiff');
        expect(out[1].mime_type).toBe('image/tiff');
    });
});
