'use strict';

const { defineConfig } = require('vitest/config');

module.exports = defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['tests/**/*.test.js'],
        exclude: ['node_modules/**', 'coverage/**'],
        testTimeout: 10_000,
        coverage: {
            provider: 'v8',
            reporter: ['text', 'lcov', 'html'],
            reportsDirectory: './coverage',
            include: [
                'api/**',
                'auth/**',
                'config/**',
                'dashboard/**',
                'indexer/**',
                'ingester/**',
                'libs/**',
                'repository/**',
                'search/**',
                'stats/**',
                'users/**',
            ],
            exclude: ['**/*.test.js', '**/views/**', '**/public/**'],
        },
        setupFiles: ['./tests/helpers/setup.js'],
    },
});
