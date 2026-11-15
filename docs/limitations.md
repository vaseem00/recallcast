# Limitations and known gaps

## Limits

- Up to 25 videos per playlist (`MAX_VIDEOS_PER_PLAYLIST`), and videos up to 3 hours long. Longer videos show as *skipped*.
- 5 new playlists per user in any rolling 24-hour window.
- Live and upcoming streams, private videos and deleted videos are left out at import.
- Transcripts over 400k characters are not sent to Claude; the heuristic picks instead.
- Videos whose owner disabled embedding cannot play in the player. The page links to the video on YouTube at the clip's start.

## Captions

- **The caption route is unofficial.** `TRANSCRIPT_PROVIDER=youtubei` asks for captions as YouTube's app clients (`ANDROID`, `IOS`, `ANDROID_VR`, `VISIONOS`), because YouTube refuses its web client without an attestation token. YouTube can change this without notice. The YouTube API terms do not provide for reading captions this way; the only official route (`captions.download`) works for the video's owner alone. If you run a public instance, read YouTube's API Terms of Service and Developer Policies first.
- **Caption downloads are rate-limited per address.** After a few hundred caption requests in two days, a home connection got HTTP 429 on every caption download for a while. The app treats a 429 as a retry: it stops asking for 60 s (doubling up to 15 minutes while refused), retries the video, and after the last retry plays the default window and waits for *Check captions again*. Caption fetches are paced to one video per second. A site with real traffic will hit this limit; plan for a paid transcript service behind the `TranscriptProvider` interface (`src/lib/transcripts/provider.ts`).
- **Many cloud addresses are refused outright.** See "Captions from a server" in [deploy.md](deploy.md).
- **Videos without captions still get reels**, cut at the description's chapter marks or by position. They are re-cut from the transcript when captions turn up.

## What has been run against the real services

- **Transcripts:** checked live in November 2026. From a home connection, 23 of 23 videos of a real playlist got their captions (before the rate limit above).
- **YouTube Data API:** playlists, videos and chapter marks read with a real key.
- **Reels feed and share page:** checked in headless Chrome with real videos at desktop and phone sizes (the player stays at least 200 px tall with nothing in front of it, playback starts and stops at the stored window, the captions follow), and on an Android phone in Brave. Not checked: iOS Safari, where starting the next reel with sound depends on Apple's autoplay rules. The muted start with *Tap for sound* is the fallback there.
- **Claude: not run live yet.** The clip pick and the reels pick go through the same request code, tested against a fake client. Before you rely on it, run one video with a real key and check that both requests are accepted (the log prints `[ai] clip pick on ...` and `[ai] moment pick on ...` with token counts), then read the reels it returns.
- **Player start-up:** in freshly started headless Chrome, a few bare YouTube embeds never started (error 5). The feed replaces a player that has not started after 9 seconds, once per reel.

## YouTube's embed rules

YouTube's Required Minimum Functionality says an app must not display overlays in front of any part of an embedded player, and must not use touch events on a player to initiate an action. The reels feed follows that: nothing is drawn over the player. The episode player (`src/components/Player.tsx`) keeps a transparent layer over the frame to read taps (one tap play or pause, two taps skip, three taps full screen). It draws nothing, but it is a layer in front of the player. Remove `tapLayer` and rely on the buttons to be strictly inside the rule.

The same document says an app must not "mimic or replicate YouTube's core user experiences" without adding independent value. The feed's case for that is the selection (moments chosen from long videos by reading them), the hooks and the read-along captions.

RecallCast is not affiliated with YouTube or Google.

## Hosting

- **One persistent server.** The app uses SQLite and runs the worker inside the server, so it needs one long-running Node server with a persistent disk. Run exactly one replica. Serverless platforms such as Vercel are not suitable unless you move to Postgres and a separate worker. The repo ships a `Dockerfile` and `railway.json` (see [deploy.md](deploy.md)); a VM, Fly.io with a volume or Render with a disk also work with the same image.
- **Docker:** the CI workflow builds the image on every push and pull request. Running the image on a real host has not been tried yet.
- **Behind a reverse proxy, set `TRUST_PROXY_HOPS`** (1 on Railway) and make sure clients cannot reach the app port directly, or every client shares one rate-limit bucket.
- **Crash recovery assumes one server.** A clean shutdown releases running jobs at once; after a crash, the next start re-queues every job left *running*. With two servers on one database, remove the startup recovery and rely on the 10-minute stale-lock recovery.
- **Moving to Postgres.** The SQL is mostly portable. The `db.ts` helpers (`?` params, `BEGIN IMMEDIATE`) and the job claim (it should use `FOR UPDATE SKIP LOCKED`) must change.

## Product gaps

- **No email:** no verification, no reset link, no CAPTCHA. The site-wide caps bound the cost. Sign-up answers 409 for an email that already has an account; every attempt counts against the per-IP limit and pays for a full password hash, which makes probing for registered emails slow but not impossible.
- **Password reset is operator-only:** `node scripts/reset-password.mjs <email>` on the server that holds the database.
- **Re-processing replaces the episode.** Pasting a transcript for a no-captions or failed video replaces its episode and its reels. A video that already has a transcript does not accept a new one.
- **Reels are cut once.** There is no "pick again"; if Claude was unavailable, the heuristic's picks stay.
- **The feed is one user's own videos.** There is no shared catalogue or following. A shared link shows exactly what its owner shared.
- **Job fairness is per user, not per job size.** One long video holds its slot until it is done.
- **Leftover tables.** Earlier versions had AI-voiced episodes, a season recap and memory cards. The `knowledge`, `cards` and `reviews` tables and a few columns stay in the schema because migrations are append-only. Nothing writes them.
