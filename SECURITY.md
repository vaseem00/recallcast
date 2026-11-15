# Security policy

## Reporting a vulnerability

Please report security problems privately. Use **Report a vulnerability** on this repository's **Security** tab (GitHub private vulnerability reporting). Do not open a public issue.

Include what you found, the steps to reproduce it, and what an attacker could do with it. You will get an answer as soon as the maintainers can look at it. Please give them reasonable time to fix the problem before you disclose it.

## Supported versions

Only the latest commit on `main` gets security fixes.

## Your own instance

- Keep API keys in `.env.local` (locally) or in your host's secret variables. Never commit them.
- If a key leaks, revoke it in the Google Cloud console or the Anthropic Console and create a new one.
- Behind a reverse proxy, set `TRUST_PROXY_HOPS` to the real number of proxies and keep the app port private.
- Set `APP_URL` to your public `https://` address. Lower the `MAX_*` caps for a soft launch.

How the app protects accounts, keys and the API bill is described in [docs/security.md](docs/security.md).
