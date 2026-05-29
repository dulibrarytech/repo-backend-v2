'use strict';

// WCAG 2.1 AA contrast regression guard.
//
// Reads the CSS tokens straight out of public/assets/styles.css and
// computes the contrast ratio of each foreground / background pair
// the dashboard actually renders. If any token drift drops a pair
// below the AA threshold (4.5:1 for normal text), the test fails —
// catching the next person who darkens an accent or lightens a
// background without checking the math.
//
// Why parse the stylesheet rather than hard-code the hexes here? So
// the test fails when *someone changes the CSS*, not when someone
// changes the test. Single source of truth.

const fs = require('node:fs');
const path = require('node:path');

const STYLES_PATH = path.join(__dirname, '..', '..', '..', 'public', 'assets', 'styles.css');

function _read_tokens() {
    const text = fs.readFileSync(STYLES_PATH, 'utf8');
    const out = {};
    // Match `--name: #xxxxxx;` inside any selector. We only care
    // about top-level CSS variables (:root) but a global regex is
    // fine — the dashboard doesn't redefine these tokens in nested
    // scopes.
    const re = /(--[a-z][a-z0-9-]*)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        // Keep the FIRST hit only — :root declarations come before
        // any later override.
        if (!(m[1] in out)) out[m[1]] = m[2];
    }
    return out;
}

// Convert "#rrggbb" / "#rgb" → [r, g, b] in 0..255.
function _hex_to_rgb(hex) {
    const h = hex.replace('#', '');
    if (h.length === 3) {
        return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
    }
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// sRGB → relative luminance per WCAG 2.x:
//   https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
function _relative_luminance(rgb) {
    const [r, g, b] = rgb.map((c) => {
        const cs = c / 255;
        return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function _contrast_ratio(fg_hex, bg_hex) {
    const l1 = _relative_luminance(_hex_to_rgb(fg_hex));
    const l2 = _relative_luminance(_hex_to_rgb(bg_hex));
    const [lighter, darker] = l1 > l2 ? [l1, l2] : [l2, l1];
    return (lighter + 0.05) / (darker + 0.05);
}

describe('a11y — color contrast (WCAG 2.1 AA)', () => {
    const tokens = _read_tokens();

    // AA threshold for normal text (small UI labels we render at
    // 11–14px count as "normal" — AA's "large text" exemption only
    // applies at ≥18px or ≥14px bold).
    const AA_NORMAL = 4.5;

    it('parses the expected tokens from styles.css', () => {
        // Sanity — the regex actually found the variables we care
        // about. If someone restructures :root, the test fails loud
        // here rather than silently passing every pair.
        for (const name of [
            '--text',
            '--text-muted',
            '--text-strong',
            '--sev-info',
            '--sev-warn',
            '--sev-error',
            '--sev-success',
            '--sev-fatal',
            '--surface',
            '--surface-alt',
            '--hairline-soft',
            '--sev-info-bg',
            '--sev-warn-bg',
            '--sev-error-bg',
            '--sev-success-bg',
            '--sev-fatal-bg',
        ]) {
            expect(tokens[name]).toMatch(/^#[0-9a-f]{6}$/i);
        }
    });

    // Pairs the dashboard actually renders. Each row: foreground,
    // background, label-for-failures. Extending this list as we add
    // new surfaces is how we keep coverage honest.
    const PAIRS = [
        ['--text', '--surface', 'body text on white'],
        ['--text', '--surface-alt', 'body text on surface-alt'],
        ['--text-strong', '--surface', 'strong text on white'],
        ['--text-muted', '--surface', 'muted text on white'],
        ['--text-muted', '--surface-alt', 'muted text on surface-alt'],
        ['--text-muted', '--hairline-soft', 'muted text on hairline-soft'],
        ['--text-muted', '--sev-warn-bg', 'muted text on warn-bg'],
        ['--sev-info', '--sev-info-bg', 'info badge text on info-bg'],
        ['--sev-warn', '--sev-warn-bg', 'warn badge text on warn-bg (DRAFT chip)'],
        ['--sev-error', '--sev-error-bg', 'error badge text on error-bg'],
        ['--sev-success', '--sev-success-bg', 'success badge text on success-bg (PUB chip)'],
        ['--sev-fatal', '--sev-fatal-bg', 'fatal badge text on fatal-bg'],
    ];

    for (const [fg, bg, label] of PAIRS) {
        it(`${label} — ${fg} on ${bg} meets AA (≥${AA_NORMAL}:1)`, () => {
            const ratio = _contrast_ratio(tokens[fg], tokens[bg]);
            // Helpful failure message — print the actual ratio + the
            // hexes so the maintainer can see what the change did.
            expect(
                ratio,
                `${fg}=${tokens[fg]} on ${bg}=${tokens[bg]} → ${ratio.toFixed(2)}:1 (need ≥${AA_NORMAL}:1)`
            ).toBeGreaterThanOrEqual(AA_NORMAL);
        });
    }
});
