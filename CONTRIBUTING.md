# Contributing to RecallCast

Thanks for helping. Bug reports, fixes, docs and ideas are all welcome.

## Set up

You need Node.js 24 or newer.

```bash
npm install
cp .env.example .env.local     # Windows PowerShell: Copy-Item .env.example .env.local
npm run dev                    # http://localhost:3000
```

Every provider defaults to `mock`, so you can work on almost everything without any API key. See [docs/configuration.md](docs/configuration.md) for the real providers.

## Before you open a pull request

These must pass. CI runs the same checks on Node 24 and 26, and builds the Docker image.

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

If you changed a user flow (sign-up, playlists, the player, reels, sharing), also run `npm run smoke` after the build. It is a Windows PowerShell script; on macOS or Linux use `pwsh -File scripts/smoke.ps1` if you have PowerShell 7.

For a UI change, add screenshots at phone and desktop width to the pull request.

## House rules

- **No secrets in the repo.** Never commit `.env.local`, API keys, or anything under `data/` or `storage/`. If a key ever lands in a commit, rotate it at once; deleting the commit is not enough.
- **Tests never call paid APIs.** Every provider (YouTube, captions, AI) has a mock behind the same interface. Tests live next to the code as `*.test.ts`.
- **Migrations are append-only.** Add a new entry to `MIGRATIONS` in `src/lib/db.ts`; never edit or reorder an old one.
- **Dependencies:** open an issue before adding one. The app deliberately has very few.
- **Next.js 16 differs from older versions.** Read the relevant guide in `node_modules/next/dist/docs/` before using a Next API (see [AGENTS.md](AGENTS.md)).
- **YouTube's player rules:** nothing may be drawn over the embedded player, and it stays at least 200 px tall. See [docs/limitations.md](docs/limitations.md).
- **Design:** use the tokens in `src/styles/tokens.css` and follow [docs/design.md](docs/design.md). No new accent colour.

Module contracts, the database schema and the HTTP API are in [docs/spec.md](docs/spec.md).

## Reporting security problems

Please do not open a public issue. Follow [SECURITY.md](SECURITY.md).
