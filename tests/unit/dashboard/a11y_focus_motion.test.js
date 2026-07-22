'use strict';

/*
 * Static guard for the Phase-4 WCAG additions: keyboard focus ring +
 * reduced-motion preference. The rules live in CSS, so we just read
 * the file and assert the expected selectors/queries are present.
 * 
 * A static check catches the most common regression (someone replaces
 * the rule wholesale during a refactor and forgets to bring it back)
 * without needing a browser. Visual correctness still requires manual
 * keyboard testing, but that's true of every focus-ring style.
 */

const fs = require('node:fs');
const path = require('node:path');

const STYLES_PATH = path.join(__dirname, '..', '..', '..', 'public', 'assets', 'styles.css');

describe('a11y — focus + motion (Phase 4)', () => {
    const css = fs.readFileSync(STYLES_PATH, 'utf8');

    describe('keyboard focus ring (WCAG 2.4.7)', () => {
        it('declares a universal :focus-visible ring', () => {
            /*
             * Match the bare `:focus-visible {` selector (not a chained
             * form like `.foo:focus-visible {`) — that's the
             * universal baseline we rely on for keyboard nav.
             */
            expect(css).toMatch(/^\s*:focus-visible\s*\{/m);
        });

        it('uses the DU crimson token for the focus outline', () => {
            /*
             * Whichever selector applies the universal ring, the
             * outline must use the brand color so it reads as an
             * intentional indicator and not a stray browser default.
             * Anchor on the line-leading :focus-visible to avoid
             * catching the .skip-link's own focus-visible block.
             */
            const block = css.match(/^\s*:focus-visible\s*\{[^}]*\}/m);
            expect(block).toBeTruthy();
            expect(block[0]).toMatch(/outline:\s*\d+px\s+solid\s+var\(--du-crimson\)/);
            expect(block[0]).toMatch(/outline-offset:/);
        });

        it('kebab-btn suppresses outline only on mouse focus (preserves keyboard ring)', () => {
            /*
             * The fix is to gate the outline-removal on
             * :not(:focus-visible) — that's mouse focus only. Bare
             * `.kebab-btn:focus { outline: 0 }` is the old broken
             * shape; assert it's gone.
             */
            expect(css).toMatch(/\.kebab-btn:focus:not\(:focus-visible\)\s*\{[^}]*outline:\s*0/);
            /*
             * Negative: there must NOT be an unconditional outline:0
             * applied to plain :focus on the kebab button.
             */
            expect(css).not.toMatch(
                /\.kebab-btn:focus\s*,[^{]*\{\s*[^}]*outline:\s*0/
            );
        });
    });

    describe('reduced-motion preference (WCAG 2.3.3)', () => {
        it('declares a prefers-reduced-motion media query', () => {
            expect(css).toMatch(/@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)/);
        });

        it('collapses animation + transition durations under reduce', () => {
            /*
             * Match the global reset block (* selector inside the
             * media query). Don't be too strict on whitespace.
             */
            const block = css.match(
                /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)\s*\{[\s\S]*?\*\s*,[\s\S]*?\}/
            );
            expect(block).toBeTruthy();
            expect(block[0]).toMatch(/animation-duration:\s*0?\.?\d+m?s\s*!important/);
            expect(block[0]).toMatch(/transition-duration:\s*0?\.?\d+m?s\s*!important/);
        });
    });
});
