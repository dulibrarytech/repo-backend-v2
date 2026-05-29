# Contributing

Thanks for contributing to `repo-backend-v2`. A few quick notes:

## Development setup

```sh
nvm use            # Node 20+
cp .env-example .env
# fill in .env values
npm install
npm test
npm start
```

## Coding style

- CommonJS (`require` / `module.exports`).
- 4-space indent (2 for JSON/YAML/Markdown). See `.editorconfig`.
- Prettier + ESLint run in CI. `npm run lint:fix && npm run format` before pushing.
- `async`/`await` everywhere — no callbacks, no `.then()` chains, no IIFEs around `await`.

## Tests

Three tiers under `tests/`:

- **unit/** — pure functions, no I/O. Fast. Run with `npm run test:unit`.
- **integration/** — talks to a real local MySQL + Elasticsearch. Run with `npm run test:integration`.
- **e2e/** — boots the full Express app via supertest. Run with `npm run test:e2e`.

Every PR should land tests at the appropriate tier. Don't mock the database in integration tests; spin up a real one.

## Commit style

One purpose per commit. Imperative subject. Reference issues with `#nnn`. Don't bundle refactors with feature work.

## License

Apache 2.0. By contributing you agree your contribution is licensed under the same terms.
