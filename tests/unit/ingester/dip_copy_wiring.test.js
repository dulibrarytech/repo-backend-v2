'use strict';

/*
 * The default clients Stage 4 and Stage 5 use with DIP_COPY_ENABLED carry
 * the DIP-copy calls: every stage test injects fakes, so nothing else
 * checks the wiring.
 */

const curation = require('../../../ingester/libs/aip_store_client');
const archivematica = require('../../../libs/archivematica');
const dip_store = require('../../../libs/dip_store');

describe('DIP copy wiring', () => {
    it('the default curation client has copy_dip and is_configured', () => {
        expect(typeof curation.copy_dip).toBe('function');
        expect(typeof curation.is_configured).toBe('function');
    });

    it('the default Archivematica client has get_dip_path and get_dip_package', () => {
        expect(typeof archivematica.get_dip_path).toBe('function');
        expect(typeof archivematica.get_dip_package).toBe('function');
    });

    it('the DIP store has what Stage 5 reads the METS with', () => {
        for (const name of ['is_configured', 'mets_path', 'fetch_text']) {
            expect(typeof dip_store[name]).toBe('function');
        }
    });
});
