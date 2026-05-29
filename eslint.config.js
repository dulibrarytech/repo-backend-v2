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
            'public/vendor/**',
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
        rules: vitest.configs.recommended.rules,
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
];
