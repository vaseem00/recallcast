# Deploying RecallCast to Railway

RecallCast runs as **one long-running Node server** with a **persistent volume**. The SQLite database lives on the volume and the job worker runs inside the server process. Episodes are not media files: each one is a start/end window that the browser plays through YouTube's embedded player, so the volume holds almost nothing besides the database. Do not scale it past one replica, and do not use a serverless target.

What the repo already contains:

| File | What it does |
|---|---|
| `Dockerfile` | Multi-stage build on `node:24-bookworm-slim`. It builds Next's standalone output, copies `.next/static` and `public`, and runs as the unprivileged `node` user |
| `scripts/docker-entrypoint.mjs` | Starts as root only to `chown` the volume (Railway mounts it owned by root), then drops to `node` (uid 1000) and loads `server.js` |
| `.dockerignore` | Keeps `node_modules`, `.next`, `data`, `storage`, every `.env*` file and logs out of the build |
| `railway.json` | Dockerfile builder, 1 replica, required volume at `/data`, health check `/api/health`, restart on failure, 30 s drain time |
| `scripts/backup.mjs` | Online SQLite backup with `VACUUM INTO`, no `sqlite3` binary needed |

The image sets these defaults. You do not need to set them in Railway:

| Variable | Value in the image |
|---|---|
| `NODE_ENV` | `production` |
| `HOSTNAME` | `0.0.0.0` |
| `PORT` | `3000`. Railway injects its own `PORT`, and the server listens on it |
| `DATABASE_PATH` | `/data/recallcast.db` |
| `STORAGE_DIR` | `/data/storage` |
| `NEXT_MANUAL_SIG_HANDLE` | `true`. The app's own SIGTERM handler shuts the server down (see [Restarts and deploys](#restarts-and-deploys)) |

## 1. Create the service

Use either of these:

- **From GitHub.** In Railway, click **New Project**, then **Deploy from GitHub repo**, and pick the repo. If the app is not at the repo root, set **Settings → Source → Root Directory** to the folder that holds `Dockerfile` and `railway.json`. Railway reads `railway.json` and builds with the Dockerfile.
- **From your machine.** Install the CLI (`npm i -g @railway/cli`), then run:

  ```powershell
  railway login
  railway init          # creates the project
  railway up            # uploads this folder and builds the Dockerfile
  ```

  `railway up` honours `.dockerignore`, so `.env.local`, `data/` and `storage/` are never uploaded.

The first deploy fails its health check until the volume exists. That is expected: `railway.json` sets `requiredMountPath: /data`.

## 2. Attach a volume at `/data`

1. Open the service, then **Settings → Volumes** (or right-click the service on the canvas and pick **Attach Volume**).
2. Set the mount path to **`/data`**.
3. Pick a size. Only the database (stored transcripts are most of it) and any legacy MP3s from the removed AI-voiced episodes live here, so 1 GB is plenty to start. You can grow the volume later.

Railway allows one volume per service, and a service with a volume runs one deploy at a time: the old container stops before the new one starts. Expect a few seconds of downtime on each deploy. This is also what makes the single-server job recovery below safe.

## 3. Set the variables

Open **Variables** and add these. Use **Raw Editor** to paste them at once.

**Required**

| Variable | Value |
|---|---|
| `APP_URL` | The public `https://` URL, for example `https://recallcast-production.up.railway.app` or your custom domain. The same-origin check compares the `Origin` header with it. A wrong value makes every sign-up, login and form fail with 403 |
| `TRUST_PROXY_HOPS` | `1`. Railway's edge proxy appends the client address to `X-Forwarded-For`. With `0`, every user shares one rate-limit bucket (the proxy's address) |

Generate the domain first (**Settings → Networking → Generate Domain**) so you know the value of `APP_URL`. Change `APP_URL` again when you add a custom domain.

**Providers** (all default to `mock`, which costs nothing and needs no keys)

| Variable | Real value | Key it needs |
|---|---|---|
| `YOUTUBE_PROVIDER` | `api` | `YOUTUBE_API_KEY` |
| `TRANSCRIPT_PROVIDER` | `youtubei` | none |
| `AI_PROVIDER` | `anthropic` | `ANTHROPIC_API_KEY` (optional: `CLAUDE_MODEL`, default `claude-haiku-5-5`; `CLAUDE_EFFORT`, default `medium`; `CLAUDE_REFUSAL_FALLBACK`) |

With `AI_PROVIDER=mock` a free heuristic picks every clip and every reel, so you can run real YouTube and transcripts without an Anthropic key. With `anthropic`, each video that has captions costs up to two Haiku calls: one for the episode (videos longer than 270 s) and one for its reels (videos longer than 80 s), each with at most one repair call. Mark the API keys as **sealed** variables so they are hidden in the dashboard.

**Captions from a server.** `TRANSCRIPT_PROVIDER=youtubei` reads captions the way YouTube's apps do, with no key. YouTube refuses many requests that come from cloud providers' addresses. If every real video shows *No captions* on the server while the same video works on your own machine, that is the cause: look for `[transcripts] no app client returned captions for <id>: ...` in the log, which lists what each client was told (`LOGIN_REQUIRED`, "Sign in to confirm you're not a bot"). The app keeps working (each such video plays a default window and offers *paste a transcript*), but no clip or reel is picked by reading. The ways out are a host whose address YouTube accepts, or a paid transcript service behind the same `TranscriptProvider` interface (`src/lib/transcripts/provider.ts`). When YouTube lets captions through again, *Check captions again* on the playlist page re-runs those videos.

**Caption rate limits.** Even from an address YouTube accepts, caption downloads are limited per address: after enough of them YouTube answers HTTP 429 for a while (seen on a home connection after a few hundred requests in two days). The log then shows `[transcripts] YouTube answered 429 to a caption download. No caption requests for 60 s.` and `process_video ... retry in 60s`. The app stops asking during the pause (60 s, doubling to 15 minutes), retries each video, and after the last retry lets the video play its default window; *Check captions again* is refused with "YouTube is limiting caption requests right now" until the pause is over. One server address serving many users will reach this limit, so for a public launch put a paid transcript service behind `TranscriptProvider` and keep `youtubei` as the fallback.

**Spending caps.** These bound the API bill. Lower them for a soft launch.

| Variable | Default | What it caps |
|---|---|---|
| `MAX_VIDEOS_PER_PLAYLIST` | `25` | Videos imported per playlist |
| `MAX_VIDEO_SECONDS` | `10800` | Longer videos are skipped |
| `MAX_PLAYLISTS_PER_USER_PER_DAY` | `5` | New playlists per user, rolling 24 h |
| `MAX_SIGNUPS_PER_DAY` | `100` | New accounts site-wide, rolling 24 h |
| `MAX_PLAYLISTS_PER_DAY` | `60` | New playlists across every user, rolling 24 h |
| `REELS_PER_VIDEO_MAX` | `6` | Reels cut from one video (1 to 12). The reels call costs the same whatever the number |
| `MAX_SHARES_PER_USER` | `200` | Public links one account can have at a time |

**Sample feed and search engines** (optional). Shared pages (`/r/...`) may be indexed; their canonical link, `/robots.txt` and `/sitemap.xml` use `APP_URL`, so set it to the address people really use. To let visitors try the feed before signing up, share a playlist's reels on the deployed site, set `SAMPLE_FEED` to the copied link and redeploy: the landing page then leads with *Watch a sample feed* and the sitemap names it. A link from another database (your local one, for example) does not exist on the server and is ignored.

**Worker** (optional): `WORKER_CONCURRENCY` (default `2`, 1 to 8), `WORKER_POLL_MS` (`1000`), `SHUTDOWN_GRACE_MS` (`15000`, see below). Keep `WORKER_ENABLED=1`.

Never set `DATABASE_PATH` or `STORAGE_DIR` to a path outside `/data`, or the data is lost on the next deploy.

## 4. First-run checklist

1. The deploy log shows `[jobs] worker started` and no `[jobs] worker failed to start`.
2. `https://<your-domain>/api/health` returns 200 with `"ok":true`, `"storage":{"writable":true}` and `"worker":{"running":true,...}`. A 503 means the database or `/data/storage` is not usable. Check that the volume is mounted at `/data`.
3. The response headers include `Content-Security-Policy` (with `https://www.youtube.com` in `script-src` and `https://www.youtube-nocookie.com` in `frame-src`) and `Strict-Transport-Security`.
4. Sign up, then log in. A 403 here almost always means `APP_URL` does not match the address in the browser bar.
5. With every provider still on `mock`, paste any playlist link. It should reach *ready* in under a minute and list one clip per video. (The mock video ids are not real, so the player shows YouTube's "unavailable" screen.)
6. Switch the providers to the real values one at a time. Run **one** real video longer than 5 minutes and watch the log for each step (see [Limitations](limitations.md)). Its clip should play from the stored start, stop at the end and advance to the next video. The video must not show *No captions* (see "Captions from a server" above), and a minute later **Reels** should list its moments.
7. Share one reel, open the `/r/...` link in a private window and check that it plays without an account. Then press *Stop sharing* and check that the link answers 404. `https://<your-domain>/robots.txt` should name `https://<your-domain>/sitemap.xml`; if it names no sitemap, `APP_URL` is not set.
8. Redeploy once and check that your account and playlists are still there. This proves the volume works.
9. Take a first backup (next section).

## 5. Backups

The database is the only state that matters: accounts, playlists, transcripts and clips all live in it.

**Railway volume backups.** Open the volume, then **Backups**. Turn on the daily or weekly schedule, and make a manual backup before every risky change. A backup snapshots the whole volume. You restore it from the same screen. It restores into the service's volume, so redeploy afterwards.

**Database-only backup with `scripts/backup.mjs`.** It runs `VACUUM INTO` through Node's built-in `node:sqlite`, so it needs no `sqlite3` binary. It is safe while the server runs (WAL mode; it reads one consistent snapshot). It checks the copy with `PRAGMA integrity_check`, names it `recallcast-YYYYMMDD-HHMMSS.db` (UTC) and keeps the newest 7 (`BACKUP_KEEP`, `0` keeps all).

```powershell
railway ssh                                   # shell inside the running container
node scripts/backup.mjs                       # writes /data/backups/recallcast-<stamp>.db
node scripts/backup.mjs /data/backups/manual  # or choose the folder
```

A copy on the volume protects against bad data and bad migrations, not against losing the volume. To keep a copy off Railway, download it, for example with `railway ssh "cat /data/backups/recallcast-<stamp>.db" > recallcast.db`, or use the volume backups above.

To restore a database-only backup: stop the worker by setting `WORKER_ENABLED=0` and redeploying, then in `railway ssh` move `recallcast.db`, `recallcast.db-wal` and `recallcast.db-shm` aside, copy the backup to `/data/recallcast.db`, set `WORKER_ENABLED=1` and redeploy.

Locally the same script uses `DATABASE_PATH` (default `./data/recallcast.db`): `node scripts/backup.mjs`.

## 6. Logs

- **Dashboard:** open the service, then **Deployments**, then a deployment, then **Deploy Logs** (build output is under **Build Logs**). The search box filters lines, for example `[jobs]`, `[health]` or `[auth]`.
- **CLI:** `railway logs` streams the current deployment's logs. `railway logs --build` shows the build.
- Useful prefixes: `[jobs] ... done in`, `... retry in`, `... failed`, `recovered N orphaned job(s)` (after a crash), `worker stopping: released N running job(s)` (on a deploy). Provider and billing errors are logged here and stored in `jobs.last_error`. Users never see them.

## 7. Restarts and deploys

On SIGTERM (a redeploy, a restart or a stop), the app:

1. stops claiming new jobs;
2. at once and synchronously, puts every job it is running back in the queue (`status = 'queued'`, `run_after = now`, `attempts - 1`, so the interrupted attempt does not count);
3. gives those jobs up to `SHUTDOWN_GRACE_MS` (default 15 s) to finish. A job that finishes in time keeps its real result;
4. exits.

`railway.json` sets `drainingSeconds: 30`, so Railway waits 30 s between SIGTERM and SIGKILL. Keep it above `SHUTDOWN_GRACE_MS`. Even a SIGKILL loses nothing, because step 2 already happened.

On start, the worker re-queues every job still marked `running`. Such a job belongs to a process that crashed or was killed. This attempt **is** counted, so a job that crashes the server cannot loop forever. This relies on the **single-server assumption**: only one process runs the worker against the database. Railway guarantees it here (one replica, one volume, no deploy overlap). If you ever run two servers on one database, remove this startup recovery and rely on the 10-minute stale-lock recovery only.

## 8. Roll back

- **Code:** open **Deployments**, then on an earlier successful deployment open the **⋮** menu and choose **Rollback** (or **Redeploy**). It reuses that build image. The volume is not touched. When you deploy from GitHub, also revert the commit, or the next push deploys the bad code again.
- **Schema:** migrations only add (they are append-only and run on start). An older build ignores newer tables and columns, but it may not know a newer row state. If a rollback crosses a migration, restore the backup taken before that deploy (volume backup, or `scripts/backup.mjs` copy) as well.
- **Bad configuration:** revert the variable and deploy the staged change.

## Building the image elsewhere

```bash
docker build -t recallcast .
docker run -p 3000:3000 -v recallcast-data:/data \
  -e APP_URL=http://localhost:3000 recallcast
```

Over plain `http://` the session cookie is `Secure` in production, so a browser on anything other than `localhost` cannot log in. Use HTTPS (Railway, or a TLS proxy) for real use.
