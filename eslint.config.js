'use strict';

const js = require('@eslint/js');
const globals = require('globals');
const prettier = require('eslint-config-prettier');
const vitest = require('eslint-plugin-vitest');

module.exports = [
    {
        ignores: [
            'node_modules/**',
            'coverage/**',
            'logs/**',
            'tmp/**',
            'uploads/**',
            /*
             * Vendored minified bundles (htmx/bootstrap) — never lint or --fix
             * these. (Was 'public/vendor/**', which matched nothing — the
             * bundles live under public/assets/vendor/.)
             */
            'public/assets/vendor/**',
        ],
    },
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'commonjs',
            globals: {
                ...globals.node,
            },
        },
        rules: {
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
            'no-console': 'off',
            'no-process-exit': 'off',
            eqeqeq: ['error', 'always'],
            'prefer-const': 'error',
            'no-var': 'error',
        },
    },
    {
        files: ['tests/**/*.{js,test.js}'],
        plugins: { vitest },
        languageOptions: {
            globals: {
                ...vitest.environments.env.globals,
            },
        },
        rules: {
            ...vitest.configs.recommended.rules,
            /*
             * expect(value, message) is a valid vitest form — the second arg
             * is a custom failure message (the a11y contrast tests use it to
             * print the failing ratio + hexes). The rule defaults to
             * maxArgs: 1, which flags it; allow the documented 2-arg form.
             */
            'vitest/valid-expect': ['error', { maxArgs: 2 }],
        },
    },
    {
        // Browser-side assets — served as static files to the dashboard.
        files: ['public/**/*.js'],
        languageOptions: {
            ecmaVersion: 2020,
            sourceType: 'script',
            globals: {
                ...globals.browser,
            },
        },
    },
    prettier,
    {
        // Comment style: narrative blocks use /* … */ with aligned stars, not
        // runs of // lines. Placed AFTER eslint-config-prettier so nothing can
        // switch it off. Auto-fixable — `npm run lint:fix` converts the whole
        // tree, which is also how the style is applied to other checkouts.
        rules: {
            'multiline-comment-style': ['error', 'starred-block'],
        },
    },
];
