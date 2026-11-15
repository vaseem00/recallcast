RECALLCAST - PRODUCT SPEC (source of truth)

What: a public web app. A user signs up (email+password), pastes a YouTube playlist URL (or a single video URL), and gets one episode per video: the most important continuous 3-4 minute part of that video, played in a podcast-style queue.
 - Episode = ClipPlan {start, end, title, summary, reason, picked} (whole seconds). Window length CLIP_MIN_S=150 to CLIP_MAX_S=255, target CLIP_TARGET_S=210. Videos up to WHOLE_VIDEO_MAX_S=270 play in full (picked 'whole', no AI call).
 - Picking (src/lib/ai/clip.ts + provider): Claude reads the timed transcript and picks the window (picked 'ai'). If Claude's answer is unusable (refusal, invalid output after the repair call, transcript > 400k chars) a free deterministic heuristic picks instead (picked 'heuristic'); AI_PROVIDER=mock always uses the heuristic. No captions -> defaultClip: a window starting ~10% in, just after the intro (picked 'nocaptions'), video ready with transcript_status 'needs_manual'; pasting a transcript re-runs the pick. normalizeClip() clamps every proposal to the video, enforces the length bounds and snaps start/end to caption boundaries.
 - Playback: nothing is downloaded or re-hosted. The browser plays the window through YouTube's official IFrame Player API on the privacy-enhanced host www.youtube-nocookie.com. The YouTube frame stays visible (356x200, min 200px tall). Our own transport: play/pause, seek within the clip, -15/+15 s, speed 1/1.25/1.5/2x, previous/next, keyboard (space, arrows), auto-advance to the next video's clip. Each episode links to the clip start on youtube.com.
 - Titles/summaries describe only what the transcript says; credit the creator by channel name; never invent facts.
 - Reels (added 2026-11-13): besides its one episode, a video with a transcript is cut into reels: self-contained moments of REEL_MIN_S=30 to REEL_MAX_S=80 seconds (target REEL_TARGET_S=60), one per SECONDS_PER_REEL=300 seconds of video, at least 1, at most REELS_PER_VIDEO_MAX (default 6, hard cap 12), best first. Reel = MomentPlan {start, end, hook, takeaway, picked} (whole seconds). Videos up to 80 s are one reel (picked 'whole', no AI call). Picking (src/lib/ai/moments.ts + provider.pickMoments): one Claude call per video returns the list (picked 'ai'); normalizeMoments() drops what is outside the video, non-numeric or overlapping an earlier one by more than MAX_OVERLAP_S=8, brings a too-short or too-long window to the target and snaps start/end to caption boundaries; a partly usable answer is kept as is, and only an answer with nothing usable gets the one repair call. Unusable answer, permanent job failure or AI_PROVIDER=mock -> heuristicMoments (densest non-overlapping minutes, each started on a sentence when captions are punctuated; picked 'heuristic'). No transcript -> no reels.
 - Reels feed (/app/reels): one reel per screen, snap-scrolled. ONE YouTube player for the whole feed, pinned at the top of the scroller (position: sticky), never under 200 px tall, nothing drawn over it (YouTube Required Minimum Functionality: no overlays, one auto-playing player, player in view). The hook, the read-along captions (the line being spoken is highlighted) and all controls sit below or beside it. When a page settles the same player loads that reel's window (loadVideoById start/end). Order: unseen first by (ord, newest playlist, video position), then seen ones oldest-seen first. If the browser blocks autoplay with sound (onAutoplayBlocked, or still unstarted after 4 s) the reel starts muted and 'Tap for sound' is highlighted. At the end of a reel: next reel (default) or repeat. Keys: Up/Down or K/J, Space, Left/Right 5 s, M, S.
 - Share links: a reel, or a playlist's reels, can be made public at /r/<slug> (slug = 16 random bytes, base64url, 22 chars; the only credential). Public pages need no account, show no owner data, may be indexed by search engines (robots index,follow + canonical link when APP_URL is set; the share buttons say so), and die on revoke or when the reel/playlist/account is deleted (404, noindex). MAX_SHARES_PER_USER (default 200) per account.
 - Sample feed: SAMPLE_FEED (env; a share link or its 22-char id, parsed to the id, anything else is a ConfigError) names one shared feed. The landing page then offers it to visitors without an account ("Watch a sample feed" in the hero for signed-out visitors, the first 3 hooks and a button in the reels slot). A revoked/deleted link reads as no sample. /robots.txt allows / and /r/, disallows /app/ and /api/. /sitemap.xml lists the landing page and the sample feed only, never other users' links; both need APP_URL for absolute addresses.
 - Captions again: POST /api/playlists/[id]/recheck re-runs ready videos that have transcript_status 'needs_manual' and no stored transcript, at most MAX_USER_RETRIES times per video.
 - Caption rate limits: when YouTube answers a caption download with HTTP 429, the youtubei provider throws a RetryableError (the only thing a TranscriptProvider may throw), asks YouTube for nothing more until a pause has passed (60 s, doubling to 15 min while refused; one state per process on globalThis) and the worker retries process_video. On the job's last attempt the video gets the default window ('needs_manual') instead of failing. During a pause the recheck route answers 429 "YouTube is limiting caption requests right now..." without spending a re-check. The app paces caption fetches to one video per second.
 (REMOVED 2026-11: Claude-written two-host scripts, ElevenLabs voicing, MP3 episodes and the audio route, memory cards/knowledge extraction, the season recap, and recall cards with spaced-repetition review. Their tables/columns (knowledge, cards, reviews, episodes.audio_path, kind 'recap', video statuses 'scripting'/'voicing') remain only because migrations are append-only; nothing writes them.)

STACK
- Next.js latest stable, App Router, TypeScript strict, src/ dir, import alias @/*. Plain CSS (global tokens.css + CSS modules) - NO Tailwind (Hallmark design skill wants token CSS).
- Database: SQLite via Node built-in node:sqlite (DatabaseSync). File at ./data/recallcast.db (gitignored). All DB access goes through src/lib/db.ts (getDb(), migrations run once on first getDb()). Keep SQL portable-ish so we can move to Postgres for deploy.
- Server-only modules import 'server-only'. All route handlers use runtime = 'nodejs'.
- Tests: vitest (node environment). Test files live next to code as *.test.ts.
- Validation: zod everywhere at API boundaries.
- Claude: @anthropic-ai/sdk. Model from env CLAUDE_MODEL default 'claude-haiku-5-5'. Two tasks, each with its own frozen system prompt (SYSTEM_PROMPT, MOMENTS_SYSTEM_PROMPT) and wire schema, sharing all request code: "moment pick" is one call per video longer than 80 s (transcript formatted in 10-second blocks so a reel can start on its first sentence), plus at most one repair call. "clip pick" is one call per video longer than 270 s, plus at most one repair call when the answer is invalid or normalizeClip had to change it; roughly well under one US cent per video. Structured outputs via client.beta.messages.parse with output_config.format (betaZodOutputFormat, wrapped so parse never throws). Do NOT send thinking or budget_tokens. Set output_config.effort explicitly ('medium' default, env CLAUDE_EFFORT). Non-streaming, max_tokens 16000. One stable system block with cache_control ephemeral; transcript and titles go in the user message, wrapped in tags. Check stop_reason (refusal, max_tokens, model_context_window_exceeded) before reading output. Server-side refusal fallbacks (fallbacks: "default" + beta server-side-fallback-2026-07-01) only on models documented to accept them (not Haiku), env CLAUDE_REFUSAL_FALLBACK; dropped once if the API rejects them.

PROVIDER MODES (env), each with a real and a mock implementation behind one interface, selected in a factory:
- YOUTUBE_PROVIDER=api|mock  (api uses YOUTUBE_API_KEY, YouTube Data API v3 playlistItems.list paginated + videos.list for duration/thumbnail/channel)
- TRANSCRIPT_PROVIDER=youtubei|mock (youtubei uses the youtubei.js npm package to fetch caption transcripts with segment start times: getBasicInfo(id, {client}) as the app clients ANDROID, IOS, ANDROID_VR, VISIONOS in that order, then the caption track's timedtext URL (json3, then XML); a client that answers OK with no tracks means the video has no captions; the WEB path (getInfo + transcript panel) is only the last resort, because since 2025 YouTube answers WEB/MWEB/TV with UNPLAYABLE and get_transcript with 400 unless the request carries an attestation token; on failure the video gets the default 'nocaptions' window, transcript_status='needs_manual', and the user can paste a transcript)
- AI_PROVIDER=anthropic|mock (ANTHROPIC_API_KEY; mock = heuristic picker)
- If a key is missing for a real provider, the factory throws a clear config error at job time (not at import time).
Real run needs only: YOUTUBE_API_KEY (YOUTUBE_PROVIDER=api), TRANSCRIPT_PROVIDER=youtubei, ANTHROPIC_API_KEY (AI_PROVIDER=anthropic).
Limits (env with defaults): MAX_VIDEOS_PER_PLAYLIST=25, MAX_VIDEO_SECONDS=10800, MAX_PLAYLISTS_PER_USER_PER_DAY=5, MAX_SIGNUPS_PER_DAY=100, MAX_PLAYLISTS_PER_DAY=60, REELS_PER_VIDEO_MAX=6 (1-12), MAX_SHARES_PER_USER=200.
Storage: STORAGE_DIR (./storage) holds only legacy MP3s of the removed voiced episodes; they are still deleted with their playlist/account.
CSP (next.config.ts) adds script-src https://www.youtube.com https://s.ytimg.com and frame-src https://www.youtube-nocookie.com https://www.youtube.com for the player; Referrer-Policy strict-origin-when-cross-origin (the embed needs a referrer).

DATABASE SCHEMA (src/lib/db.ts, ids are text UUIDs via crypto.randomUUID, timestamps are integer ms):
- users(id PK, email UNIQUE COLLATE NOCASE, password_hash, created_at)
- sessions(id PK = sha256 hex of token, user_id FK, created_at, expires_at)
- playlists(id PK, user_id FK, source_url, youtube_playlist_id NULL, kind 'playlist'|'video', title, channel, thumbnail, status 'queued'|'ingesting'|'processing'|'ready'|'partial'|'failed', error NULL, created_at, updated_at)
- videos(id PK, playlist_id FK ON DELETE CASCADE, youtube_video_id, position, title, channel, duration_s, thumbnail, transcript_status 'pending'|'ok'|'needs_manual'|'failed', status 'pending'|'transcribing'|'analyzing'|'ready'|'failed'|'skipped' (legacy 'scripting'|'voicing' unused), error NULL)
- transcripts(video_id PK FK CASCADE, source 'youtubei'|'manual'|'mock', lang, segments_json)  segments: [{start:number(sec), dur:number, text:string}]
- episodes(id PK, playlist_id FK CASCADE, video_id FK CASCADE, kind 'video', title, script_json = JSON ClipPlan, audio_path NULL, duration_s = end - start, status 'voiced' (= ready to play), error NULL, created_at). One per ready video, replaced on re-processing.
- legacy, unused (append-only migrations; cascade-deleted with their playlist/user): knowledge, cards, reviews, episodes.audio_path, episodes kind 'recap', episode statuses 'pending'|'scripted'|'failed'
- moments(id PK, playlist_id FK CASCADE, video_id FK CASCADE, ord INT (0 = strongest of its video), start_s, end_s, hook, takeaway, picked 'ai'|'heuristic'|'whole', basis 'transcript'|'chapters'|'position' (migration 6, default 'transcript'), saved_at NULL, seen_at NULL, watch_s INT, completions INT, skips INT (migration 6, default 0), created_at). The reels. saved_at/seen_at/watch_s/completions/skips are the owner's feed state and viewing; only the owner's feed ranking reads them. Rows are replaced only by storeClip (new transcript, or a re-run without one); pick_moments never touches a video whose moments_status is 'ready'. Every ready video gets reels: without a transcript they are cut free from videos.chapters_json (the description's chapter marks, migration 6; NULL = never read, read once through YouTubeProvider.fetchChapters) or one minute by position.
- videos.moments_status 'none'|'pending'|'ready' (migration 5; 'none' = not picked yet or no transcript, 'pending' = pick_moments queued or running)
- shares(slug PK, user_id FK CASCADE, kind 'moment'|'playlist', moment_id NULL FK CASCADE, playlist_id FK CASCADE, created_at); unique per moment (kind 'moment') and per playlist (kind 'playlist')
- jobs(id PK, type, payload_json, status 'queued'|'running'|'done'|'failed', attempts INT, max_attempts INT, run_after, locked_at NULL, last_error NULL, created_at, updated_at)
Foreign keys ON (PRAGMA foreign_keys = ON), WAL mode.

SHARED TYPES (src/lib/types.ts) - the contract every module codes against:
- TranscriptSegment {start:number; dur:number; text:string}
- VideoMeta {youtubeVideoId; title; channel; durationS; thumbnail; position}
- PlaylistMeta {youtubePlaylistId:string|null; kind:'playlist'|'video'; title; channel; thumbnail; videos: VideoMeta[]}
- ClipPick 'ai'|'heuristic'|'whole'|'nocaptions'
- ClipPlan {start:number; end:number; title; summary; reason; picked:ClipPick}  (whole seconds, end > start)
- MomentPick 'ai'|'heuristic'|'whole'; MomentPlan {start:number; end:number; hook; takeaway; picked:MomentPick}  (whole seconds, end > start)
- JobType 'ingest_playlist'|'process_video'|'pick_moments'

MODULE INTERFACES (exact exports):
- src/lib/youtube/parse.ts: parseYouTubeUrl(input:string): {kind:'playlist', playlistId} | {kind:'video', videoId} | null  (handles youtube.com/playlist?list=, watch?v=..&list=.. -> playlist, youtu.be/ID, /shorts/ID, /embed/ID, m.youtube.com, music.youtube.com, bare IDs rejected, trims whitespace)
- src/lib/youtube/index.ts: getYouTubeProvider(): {fetchPlaylist(id):Promise<PlaylistMeta>; fetchVideo(id):Promise<PlaylistMeta>}
- src/lib/transcripts/index.ts: getTranscriptProvider(): {fetch(videoId):Promise<{segments:TranscriptSegment[]; lang:string; source:string}|null>} ; plus parseManualTranscript(text):TranscriptSegment[] (accepts plain text or lines with timestamps like 1:23 / 01:02:03)
- src/lib/ai/index.ts: getAiProvider(): {pickClip(input:{video:VideoMeta; segments:TranscriptSegment[]}):Promise<ClipPlan>; pickMoments(input:{video; segments; count:number}):Promise<MomentPlan[]> (never empty: throws AiPermanentError when nothing usable comes back)}. moments.ts (pure): momentCount, normalizeMoments, heuristicMoments, wholeMoment, sentenceStart, hookFromExcerpt. Also exports normalizeClip, heuristicClip, wholeVideoClip, defaultClip, isShortVideo (clip.ts, pure). The prompt transcript has [mm:ss] markers so start/end are real. Transcripts > MAX_TRANSCRIPT_CHARS (400k formatted) raise AiInputError -> heuristic.
- src/lib/jobs/*: enqueue(type, payload, opts?), a DB-backed worker (claim with UPDATE ... WHERE status='queued' AND run_after<=now, exponential backoff, max_attempts 3, stale lock recovery after 10 min), startWorker() called once from src/instrumentation.ts register() when NEXT_RUNTIME==='nodejs' (guard against double start with a globalThis flag). Job types: 'ingest_playlist' {playlistId} -> fetch meta, insert videos (cap MAX_VIDEOS_PER_PLAYLIST, skip > MAX_VIDEO_SECONDS as 'skipped'), enqueue 'process_video' per video; 'process_video' {videoId} -> transcript (stored/pasted one reused; none -> defaultClip) -> pickClip (non-retryable error -> heuristicClip; retryable -> back to the queue) -> store the ClipPlan episode, video 'ready'; status roll-up of playlist (ready / partial / failed); storing the clip of a video that has a transcript also deletes its old reels, sets moments_status 'pending' and enqueues 'pick_moments' {videoId} in the same transaction. 'pick_moments' {videoId} -> skip when moments_status is 'ready' -> pickMoments(count = momentCount(length, REELS_PER_VIDEO_MAX)) (AiPermanentError -> heuristicMoments; retryable -> back to the queue) -> replace the moments rows, moments_status 'ready'. Its failure handler stores the heuristic's reels instead of failing anything. queueMissingMoments(userId, playlistId?) enqueues it for ready videos with a transcript and no reels (called when the owner loads the feed). src/lib/jobs/pipeline.ts holds the step functions so they are unit-testable with mock providers.
- src/lib/auth/*: hashPassword/verifyPassword (node:crypto scrypt, timing-safe), createSession(userId) -> sets httpOnly Secure(in prod) SameSite=Lax cookie 'rc_session' (random 32-byte token, DB stores sha256), getCurrentUser(), requireUser() (throws/redirects), destroySession(). Login rate-limit (in-memory per IP+email, 10/15min). Password min 8 chars. Same-origin check (Origin header) on mutating API routes - export assertSameOrigin(req).
- src/lib/reels.ts: loadReelFeed(userId, {playlistId?, saved?, limit?}) -> ReelFeed {reels: ReelView[], total, pending, videos, noCaptions}; setReelState(userId, momentId, {saved?, seen?}); shareMoment/unshareMoment, sharePlaylist/unsharePlaylist/getPlaylistShare; getSharedPage(slug) -> {kind, title, channel, thumbnail, reels} | null (public, no owner data); captionsFor(segments, start, end). ReelView {id, playlistId|null, playlistTitle, youtubeVideoId, videoTitle, channel, thumbnail, start, end, hook, takeaway, picked, saved, seen, shareSlug|null, captions:[{t (seconds into the video), d, text}]}.
- src/components/reel-feed.ts (client-safe, pure): activeLineIndex, mergeReels, slideIndexAt, feed preferences (muted, autoNext, speed) as a useSyncExternalStore store over localStorage. src/components/ReelsFeed.tsx is the feed (mode 'owner' | 'public').
- src/lib/youtube/links.ts: youtubeTimestampUrl(videoId, seconds) -> https://www.youtube.com/watch?v=ID&t=SECONDSs (client-safe).
- src/components/youtube-player.ts: loadYouTubeApi() loads the IFrame API script once; src/components/Player.tsx is the sticky clip player (one YT player instance, loadVideoById with startSeconds/endSeconds per clip).

HTTP API (all JSON, all under src/app/api, all require auth except signup/login, all check ownership; errors as {error:string} with proper status):
- POST /api/auth/signup {email,password} -> 201 {user}; POST /api/auth/login -> 200 {user}; POST /api/auth/logout -> 204; GET /api/me -> {user}|401
- POST /api/playlists {url} -> 201 {id} (validates URL, daily cap, enqueues ingest_playlist)
- GET /api/playlists -> {playlists:[...with counts]}
- GET /api/playlists/[id] -> {playlist, videos:[{id, youtubeVideoId, youtubeUrl, durationS, transcriptStatus, status, error, episodeId, ...}], episodes:[{id, playlistId, videoId, youtubeVideoId, title, clip:ClipPlan, excerpt (<= 700 words), durationS = clip.end - clip.start, createdAt}], progress:{total, ready, failed, skipped, processing}}
- DELETE /api/playlists/[id] -> 204 (also deletes any legacy audio files)
- POST /api/playlists/[id]/retry -> 202 (re-enqueues failed videos)
- POST /api/videos/[id]/transcript {text} -> 202 (manual transcript for a needs_manual or failed video; re-enqueues process_video)
- POST /api/playlists/[id]/recheck -> 202 {rechecked} (looks for captions again on no-caption videos; 429 when each is out of retries, or while YouTube is rate-limiting caption downloads)
- GET /api/reels[?playlist=ID][&saved=1] -> ReelFeed (30 per request in the order of src/lib/feed-rank.ts rankFeed: all playlists woven together, each as a series, unseen first; one playlist: its series order; also queues reels for videos that have none yet)
- PATCH /api/reels/[id] {saved?: boolean, seen?: true, watched?: 0..600 seconds, completed?: true, skipped?: true} -> {saved, seen}. A viewing report adds to watch_s/completions/skips and marks the reel seen; completed wins over skipped.
- POST /api/reels/[id]/share -> {slug, path: '/r/<slug>'} (same link until revoked); DELETE -> 204
- POST /api/playlists/[id]/share -> {slug, path} (public feed of the playlist's reels); DELETE -> 204
- GET /api/playlists/[id] also returns reels: {ready, pending} and shareSlug
(The audio route GET /api/episodes/[id]/audio was removed with the voiced episodes.)

PAGES (src/app):
- / landing page (designed with Hallmark; offers the SAMPLE_FEED link when set), /signup, /login, /robots.txt, /sitemap.xml
- /app library: paste box + list of playlists with live status
- /app/p/[id] playlist: running order of clips (title, clip range, summary, why it was picked, link to the moment on YouTube), sticky clip player (visible YouTube frame + our transport, auto-advance), manual-transcript paste UI for needs_manual videos, polling every 3s while processing
- /app/reels the reels feed (?playlist=ID one playlist, ?saved=1 saved reels); empty states for no playlists, reels still being cut (polls every 4 s), no captions, nothing saved
- /r/[slug] PUBLIC (not under /app, so the proxy lets it through): a shared reel or a shared playlist feed; generateMetadata sets title, description, Open Graph image (the video thumbnail), robots index,follow and a canonical link (when APP_URL is set); unknown or revoked slug -> 404 with noindex
- /app/account account settings
Middleware (src/middleware.ts) redirects unauthenticated /app/* to /login (cookie presence check only; real check in server components/routes).

---

FOUNDATION NOTES (added by the foundation engineer; these refine, not replace, the spec above)

Versions: Next.js 16.4.5 (Turbopack is the default bundler for dev and build), React 19.3.0,
@anthropic-ai/sdk ^1.6.0, zod ^4.6.7 (zod v4 API: z.url(), z.email(), error.issues), youtubei.js ^18.3.0,
vitest ^5.1.0, @types/node ^26. Node >= 24 required (node:sqlite, including the DatabaseSync `timeout` option and
`isTransaction`). Keep to these dependencies; propose a new one in an issue before adding it.

Next.js 16 differences that matter:
- middleware.ts is deprecated and renamed to proxy.ts (export function proxy). The /app/* cookie check
  lives in src/proxy.ts (already implemented). Do not create src/middleware.ts.
- cookies(), headers(), draftMode() are async: `const c = await cookies()`.
- Dynamic route params are a Promise: `export async function GET(req: Request, ctx: RouteContext<'/api/playlists/[id]'>) { const { id } = await ctx.params }`.
  Pages: `export default async function Page(props: PageProps<'/app/p/[id]'>) { const { id } = await props.params }`.
  RouteContext / PageProps / LayoutProps are global types generated by Next (no import).
- cacheComponents is OFF in next.config.ts (it forbids `export const runtime`). Routes are dynamic when they read cookies.
- Read node_modules/next/dist/docs/ before using any Next API you are unsure of.

node:sqlite: src/lib/db.ts loads it via `process.getBuiltinModule("node:sqlite")` (no static import), so
Turbopack never resolves it. Never `import ... from "node:sqlite"` anywhere else; use the db helpers.

DB helpers (src/lib/db.ts): getDb(), run(sql, ...params) -> {changes, lastInsertRowid}, get<T>(sql, ...params),
all<T>(sql, ...params), exec(sql), transaction(fn) (fn MUST be synchronous; nests via SAVEPOINT), now(),
openDatabase(file), closeDb(), MIGRATIONS. Params are positional `?` values or ONE object for `:name` params.
Values must be string | number | bigint | null | Uint8Array (no booleans, no undefined - use null).
Store JSON columns with JSON.stringify and parse on read. Schema changes = append a new MIGRATIONS entry.

Other shared helpers:
- src/lib/env.ts: getEnv() (lazy, cached, zod-parsed), requireEnv(key, neededBy) -> throws ConfigError,
  resetEnvCache() for tests, isProd(). Extra vars beyond the spec: APP_URL, DATABASE_PATH, STORAGE_DIR,
  WORKER_ENABLED, WORKER_POLL_MS. All provider modes default to "mock".
- src/lib/http.ts: json(data, status?), error(status, msg), noContent(), parseJson(req, schema),
  HttpError(status, msg), handleError(err) (HttpError -> its status; other -> 500; rethrows Next redirect).
- src/lib/ids.ts: newId().
- src/lib/storage.ts, src/lib/storage/audio.ts: storageRoot(), safe path resolution and deleteAudio(rel) for the legacy
  MP3s. Use these for every filesystem path (they carry the turbopackIgnore hint).
- src/lib/types.ts: the shared types above plus DB row types (UserRow, PlaylistRow, VideoRow, EpisodeRow,
  JobRow, ...), status unions, JobType and JobPayloads, PublicUser {id, email, createdAt}.
- src/lib/jobs/index.ts re-exports enqueue (queue.ts) and startWorker (worker.ts).
  enqueue<T extends JobType>(type, payload: JobPayloads[T], opts?: {runAfter?, maxAttempts?}): string (sync).
- GET /api/health -> {ok, db, schemaVersion, worker, storage:{writable}} (extra; deploy health check).

Testing: `npm test` (vitest, node env). src/test/setup.ts forces DATABASE_PATH=:memory:, all providers mock,
WORKER_ENABLED=0. Each test file runs in its own process (pool: forks), so the DB singleton is fresh per file.
'server-only' is aliased to a no-op stub in vitest.config.mts. Never call real paid APIs in tests.
Verification gate: `npm run typecheck`, `npm test`, `npm run build` must all pass.
