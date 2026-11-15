# Security model

How RecallCast protects accounts, keys and the API bill. To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## Secrets

- API keys are read from the environment on the server only (`src/lib/env.ts`). They are never sent to the browser, logged or stored in the database.
- `.env.local`, every other `.env*` file except `.env.example`, the database (`data/`) and `storage/` are in `.gitignore` and `.dockerignore`.
- Provider, billing and configuration errors stay in `jobs.last_error` and the server log. Users see messages about their own content or link only.

## Accounts and sessions

- **Passwords:** hashed with scrypt (timing-safe comparison), at least 8 characters.
- **Sessions:** the `rc_session` cookie is httpOnly and SameSite=Lax, and Secure in production. The database stores only the sha256 of the token.
- **Rate limits:** login allows 100 attempts per 15 min per IP, 10 per IP+email and 50 per email across all IPs. The per-email limit does not apply to a browser that signed in to that account before (`rc_device` cookie), so strangers cannot lock the owner out. Sign-up allows 10 attempts per hour per IP. Password change and account deletion allow 10 per account per 15 min. The limits are stored in SQLite, so a restart does not reset them. The client IP is the TCP peer address, or the `TRUST_PROXY_HOPS`-th `X-Forwarded-For` entry from the right. IPv6 clients are grouped by /64.
- **Ownership:** every lookup is filtered by the signed-in user. Another user's id gets a 404, not a 403.
- **Cross-origin requests:** every route that changes data checks the Origin header.
- **Request bodies:** JSON bodies are read as a stream and cut off at the route's size limit, so a huge upload is refused without being buffered.

## Paid work per user

Without email verification, these bound what one person (or many throwaway accounts) can spend:

- 5 new playlists per user per day (deleting does not reset it), at most 3 retries per failed video, at most 3 caption re-checks per no-caption video, and a pasted transcript only for a video that has no captions or has failed.
- Reels add at most one Claude call (plus one repair) per stored transcript; nothing a user can press re-runs it.
- Site-wide caps over a rolling 24 hours: `MAX_SIGNUPS_PER_DAY` (default 100) and `MAX_PLAYLISTS_PER_DAY` (default 60), counted in append-only ledgers so deleting accounts or playlists frees nothing.
- The worker shares its job slots fairly between users.

## Share links

- The slug is 128 random bits from `crypto.randomBytes`, checked against a fixed pattern before any query.
- A public page is read-only and carries no account data (no owner id, email, saved or seen state, or internal playlist id); a test asserts this on the serialized page.
- It may be indexed by search engines, which the share buttons say when they copy the link. The sitemap names only the landing page and the `SAMPLE_FEED` link.
- It is gone on revoke (404, `noindex`) and deleted with its reel, playlist or account.

## Browser

- Every response carries a Content-Security-Policy and the other security headers from `next.config.ts` (HSTS in production builds). The CSP allows only the YouTube player from outside: `script-src https://www.youtube.com https://s.ytimg.com` and `frame-src https://www.youtube-nocookie.com https://www.youtube.com`.
- `script-src` includes `'unsafe-inline'` because Next's bootstrap scripts are inline and there is no nonce setup.

## Prompt injection

Third-party transcript text is treated as data in the prompt (wrapped in tags, angle brackets stripped), and the system prompt tells Claude to ignore instructions inside it. Claude's answers are validated against a schema and clamped to the video before anything is stored.
