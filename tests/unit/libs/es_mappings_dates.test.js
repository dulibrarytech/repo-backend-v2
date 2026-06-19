'use strict';

// Guards the dirty-date fix: display_record.dates.{begin,date,end} must
// tolerate malformed / non-strict dates so one bad value (e.g. "02-05-12"
// or non-zero-padded "1974-11-1") can't reject the whole document and
// poison the indexer (which requeues failures and would retry forever).

const mappings = require('../../../libs/es_mappings.json');

function dates_props() {
    const root = mappings.mappings ? mappings.mappings.properties : mappings.properties;
    return root.display_record.properties.dates.properties;
}

describe('es_mappings display_record.dates', () => {
    const dp = dates_props();
    for (const field of ['begin', 'date', 'end']) {
        it(`${field}: date field with ignore_malformed + a lenient format`, () => {
            expect(dp[field].type).toBe('date');
            // A genuinely-bad value is skipped, not fatal to the document.
            expect(dp[field].ignore_malformed).toBe(true);
            // Accept non-zero-padded dates (yyyy-M-d) so legitimate values
            // like "1974-11-1" index as real dates instead of being dropped.
            expect(dp[field].format).toMatch(/yyyy-M-d/);
            // Raw string stays searchable regardless of date parsing.
            expect(dp[field].fields.keyword.type).toBe('keyword');
        });
    }
});
