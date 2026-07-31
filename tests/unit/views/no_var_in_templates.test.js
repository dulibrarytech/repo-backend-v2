'use strict';

/*
 * `var` is banned application-wide (see CLAUDE.md). ESLint's no-var rule
 * enforces that for .js, but it does not parse .ejs — and templates carry a
 * lot of scriptlet JS, which is where all 182 remaining occurrences lived
 * before the 2026-07-31 sweep. This closes that gap.
 *
 * Only JS regions are scanned. That deliberately skips CSS custom properties
 * like `style="color: var(--text-muted)"`, which are not JS and are common in
 * these templates.
 */

const fs = require('node:fs');
const path = require('node:path');

const VIEWS = path.join(__dirname, '..', '..', '..', 'views');

/* <% ... %>, <%= ... %>, <%- ... %> — but not <%/* comment *\/%> */
const JS_REGION = /<%(?!\/\*)[=\-_]?([\s\S]*?)[-_]?%>/g;
/* `var` followed by whitespace and an identifier: a declaration, not var(--x) */
const VAR_DECL = /\bvar\s+[A-Za-z_$]/;

function templates(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) templates(full, out);
        else if (entry.name.endsWith('.ejs')) out.push(full);
    }
    return out;
}

function offenders() {
    const found = [];
    for (const file of templates(VIEWS)) {
        const src = fs.readFileSync(file, 'utf8');
        for (const region of src.matchAll(JS_REGION)) {
            if (!VAR_DECL.test(region[1])) continue;
            const line = src.slice(0, region.index).split('\n').length;
            found.push(`${path.relative(VIEWS, file)}:${line}`);
        }
    }
    return found;
}

describe('EJS templates', () => {
    it('scans a non-trivial number of templates (guard is actually wired up)', () => {
        expect(templates(VIEWS).length).toBeGreaterThan(50);
    });

    it('declare no variables with var — use let or const', () => {
        expect(offenders()).toEqual([]);
    });

    /*
     * The scanner must not trip on CSS custom properties, which appear all
     * over these templates in inline styles.
     */
    it('does not mistake a CSS var() call for a declaration', () => {
        expect(VAR_DECL.test('style="color: var(--text-muted, #6c757d)"')).toBe(false);
        expect(VAR_DECL.test('border-top: 1px solid var(--border)')).toBe(false);
        expect(VAR_DECL.test('let x = 1')).toBe(false);
        expect(VAR_DECL.test('var x = 1')).toBe(true);
        expect(VAR_DECL.test('for (var i = 0;')).toBe(true);
    });
});
