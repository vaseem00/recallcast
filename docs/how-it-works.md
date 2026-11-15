# How RecallCast works

RecallCast turns a YouTube playlist into two things:

- **Episodes:** for each video, one continuous window of 150 to 255 seconds (aiming for 210) that carries the video's main idea, with a short title, a one or two sentence summary and the reason it was chosen. The episodes play back to back, like a podcast queue. Videos of 270 seconds or less play in full.
- **Reels:** self-contained moments of about a minute (30 to 80 seconds), up to one per five minutes of video, in a feed you swipe through at `/app/reels`.

Nothing is downloaded or re-hosted. The browser plays each window through YouTube's official IFrame Player API (privacy-enhanced `youtube-nocookie.com` host). The video stays visible (at least 200 px tall) next to RecallCast's own controls.

## How the episode is picked

| Case | What happens | `clip.picked` |
|---|---|---|
| Video up to 270 s | Plays in full. No AI call | `whole` |
| Longer video, `AI_PROVIDER=anthropic` | One Claude structured-output call on the timed transcript, plus at most one repair call if the window needed fixing | `ai` |
| Claude's answer is unusable (refusal, invalid output, transcript over 400k characters) | A free heuristic picks the densest stretch, avoiding intros, sponsor reads and outros | `heuristic` |
| `AI_PROVIDER=mock` | The heuristic always picks | `heuristic` |
| No captions | A default window just after the intro is stored, and the user can paste a transcript to get a proper pick | `nocaptions` |

Every proposed window is clamped to the video and snapped to caption boundaries, so playback never starts or stops mid-sentence. Rate limits and other transient errors go back to the job queue instead of the heuristic.

## Reels

Once a video's episode is stored, a second job (`pick_moments`) cuts its reels. Every ready video gets at least one, captions or not.

| Case | What happens | `picked` / `basis` |
|---|---|---|
| Video up to 80 s | The whole video is one reel. No AI call | `whole` |
| Longer video, `AI_PROVIDER=anthropic` | One Claude structured-output call returns up to `REELS_PER_VIDEO_MAX` moments (one per five minutes of video), best first, each with a hook (the headline) and a takeaway. Moments outside the video or overlapping are dropped; a too-short or too-long one is brought to 60 s. One repair call only when nothing in the answer was usable | `ai` / `transcript` |
| Claude's answer is unusable, the job fails for good, or `AI_PROVIDER=mock` | A free heuristic takes the densest non-overlapping minutes, starting each on a sentence when the captions are punctuated | `heuristic` / `transcript` |
| No captions, but the description has chapter marks ("0:00 Intro", "4:10 Wiring") | Free: each reel starts at a chapter and is titled with it, long chapters first; intros, sponsor reads and outros only when nothing else is left. Up to one per five minutes | `heuristic` / `chapters` |
| No captions and no chapters | Free: one minute from just after the intro (10% in), titled with the video | `heuristic` / `position` |

Chapter marks come from the description in the same YouTube Data API call that reads the playlist, so they cost nothing extra. Reels cut without captions say so in the feed. When captions turn up later (*Check captions again*, or a pasted transcript), the video is re-cut from what is said.

A failed reels job never fails the video: the episode stays playable and the heuristic's reels are stored. Videos processed before reels existed get theirs the first time their owner opens the feed.

## The feed

`/app/reels` (`?playlist=<id>` for one playlist, `?saved=1` for saved reels) shows one reel per screen. Swipe, scroll, or use the keys: Up and Down (or K and J) move between reels, Space plays or pauses, Left and Right seek 5 s, M mutes, S saves.

**Feed order** (`src/lib/feed-rank.ts`, pure and deterministic). The All feed weaves every playlist together:

- Reels not seen yet come first. Seen ones come back at the end, the one seen longest ago first; reels swiped away without being finished come last.
- Each playlist plays as a series: video by video, each video's reels in the order they occur. When most titles carry a number ("Week 10", "Part 4", "Ep. 3", "#12", "2 of 5") and the playlist lists them backwards (newest first, as many channels do), it plays from part 1.
- Playlists take turns (smooth weighted round-robin), so every playlist shows up near the top. A playlist's weight rises when its reels are played to the end, saved or shared, falls when they are swiped away within the first 3 seconds, gets a boost for a new playlist (halving every 3 days), and is lower for reels cut without captions (chapters 0.7, position 0.4, transcript 1). No playlist drops out.
- A video the viewer swiped away from without finishing any of its reels moves to the end of its playlist.
- Variety: at most two reels of one video and three of one playlist in a row while another playlist still has reels.

The feed reports what happens to each reel (seconds played, played to the end, swiped away early) with `PATCH /api/reels/[id]`. Those numbers stay in the owner's own rows and order only the owner's own feed. One playlist's feed (`?playlist=`) is its series order alone, unseen first.

## How it plays

The whole feed has one YouTube player. It stays pinned at the top of the screen (beside the text on wide screens), never smaller than 200 px, and nothing is ever drawn over it: the hook, the captions and every control sit below or beside it. When a new reel's page settles, the same player loads that reel's window. The captions under it are the video's own words, with the line being spoken marked.

If the browser refuses to start a video with sound before the viewer has tapped anything, the reel starts muted and the *Tap for sound* button (*Unmute* on a phone) is highlighted. If YouTube's player has still not started a video 9 seconds after loading it, or reports a player error, the feed replaces the player with a new one, once per reel.

## Sharing

*Share* on a reel makes a public page at `/r/<slug>` that plays that one reel; *Share reels* on a playlist page makes a public feed of the playlist's reels at another `/r/<slug>`. A slug is 128 random bits; nobody can guess one.

The page is public: it needs no account, shows nothing about the owner, and search engines may index it (it carries a canonical link when `APP_URL` is set, and the share buttons tell the owner so). The site lists no shared page anywhere except the sample feed below, so a crawler finds one only where its owner posted the link. A link stops working the moment the owner presses *Stop sharing* or deletes the playlist or the account; the address then answers 404. An account can hold `MAX_SHARES_PER_USER` links.

**The sample feed on the landing page.** To let visitors try the feed before making an account, share a playlist's reels (*Share reels* on its page), paste the copied link into `.env.local` as `SAMPLE_FEED=...` and restart. The landing page then leads with *Watch a sample feed*, lists the feed's first three hooks, and `/sitemap.xml` names the feed. If the link is later revoked, the landing page goes back to showing no sample. `/robots.txt` allows the landing page and `/r/...`, and closes `/app/` and `/api/`.

## Pipeline

The jobs live in the `jobs` table of the SQLite database, so they survive restarts. The worker runs inside the Next.js server process (started from `src/instrumentation.ts`).

1. `POST /api/playlists` adds an `ingest_playlist` job.
2. `ingest_playlist` fetches the metadata, saves the videos (applying the length and count limits) and adds one `process_video` job per video.
3. `process_video` gets the transcript (a stored or pasted one is reused), picks the clip and stores it as one episode: a JSON `ClipPlan` `{start, end, title, summary, reason, picked}` in `episodes.script_json`. The video is then `ready`, and a `pick_moments` job is queued in the same transaction.
4. `pick_moments` cuts the video's reels and stores them as rows of `moments`. It is its own job so that a rate limit on the second Claude call never re-runs, and re-bills, the clip pick. It leaves a video whose reels are ready alone, so rows a user saved or shared keep their ids.
5. The playlist status rolls up to `ready`, `partial` or `failed` from the videos; reels do not hold it back.

**Retries.** A job is retried only when its error is transient (`retryable === true`, for example a rate limit or a 5xx). The waits are about 30 s, then 60 s, and there are at most 3 attempts. Other errors fail the job at once, and their message is shown on that video. A lock older than 10 minutes counts as stale and the job is recovered. On SIGTERM the worker stops claiming, puts its running jobs back in the queue at once and gives them `SHUTDOWN_GRACE_MS` to finish. On start it re-queues every job a previous process left *running*.

## Architecture

```
src/
  app/                    Next.js App Router (pages + /api route handlers, runtime = nodejs)
    page.tsx              landing page (offers the SAMPLE_FEED link when one is set)
    robots.ts, sitemap.ts /robots.txt and /sitemap.xml
    manifest.ts, icon.svg web app manifest and icons
    (auth)/login, signup  auth forms
    app/                  signed-in area: library, /app/p/[id] playlist, /app/reels feed, /app/account
    r/[slug]/             public page of a shared reel or a shared playlist feed (no account)
    api/                  JSON API (see spec.md for the full list)
  proxy.ts                Next 16 "proxy" (formerly middleware): /app/* without a cookie redirects to /login
  instrumentation.ts      starts the job worker once per Node server process and installs its SIGTERM/SIGINT handlers
  components/             client components (Player and ReelsFeed on youtube-player.ts, the IFrame API loader; PlaylistView, ...)
  styles/                 tokens.css (design tokens, light + dark) and CSS modules
  lib/
    db.ts                 node:sqlite connection, WAL, foreign keys, versioned append-only migrations
    env.ts                zod-parsed env; requireEnv() raises ConfigError at job time
    http.ts               json/error helpers, HttpError, handleError
    auth/                 scrypt passwords, sha256-hashed session tokens, rate limits, same-origin check
    youtube/              URL parser, chapter marks, Data API v3 provider, mock
    transcripts/          youtubei.js provider (+ caption-file fallback), manual transcript parser, mock
    ai/                   clip.ts and moments.ts (window rules + heuristics), Claude provider (structured outputs), mock
    reels.ts              the feed query, save/seen/viewing reports, share links and the public page's data
    feed-rank.ts          the feed order: playlists woven together, series order, viewing signals (pure)
    jobs/                 DB-backed queue + worker + pipeline steps
```

The module contracts, database schema and HTTP API are in [spec.md](spec.md).

`GET /api/health` returns `{ ok, db, schemaVersion, worker: { running, active }, storage: { writable } }` and answers 503 when the database query fails or the storage folder is not writable.

## Accounts

Signed-in users manage their account at `/app/account`:

- **Change password:** current password and a new one of at least 8 characters. Every other device is signed out and this browser gets a fresh session.
- **Sign out everywhere:** ends every session of the account.
- **Delete account:** asks for the password and an explicit confirmation, cancels the account's queued jobs and deletes the user and everything it owns. It cannot be undone.

There is no email (no verification, no reset link). An operator resets a password on the server with `node scripts/reset-password.mjs <email>`, which sets a random password, signs the account out everywhere and prints the password once.
