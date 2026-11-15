<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## RecallCast

- `docs/spec.md` is the reference for module contracts, the database schema and the HTTP API. `docs/design.md` has the design and brand rules.
- Never commit `.env.local` or anything under `data/` or `storage/`. Tests never call real paid APIs; every provider has a mock.
- Database migrations are append-only: add a new entry to `MIGRATIONS` in `src/lib/db.ts`, never edit an old one.
- Before a pull request: `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` must pass.
