# Configuration

RecallCast reads its settings from environment variables. Locally, put them in `.env.local` (copy [`.env.example`](../.env.example)); `.env.local` is in `.gitignore` and must never be committed. On a server, set them as the platform's variables. Variables set in the process environment win over the `.env` files. Empty values count as unset.

## Providers and API keys

Each provider has a real and a mock implementation. All three default to `mock`, so the app runs with no keys at all.

| Variable | Real value | What it does | Key it needs |
|---|---|---|---|
| `YOUTUBE_PROVIDER` | `api` | Reads playlist and video titles, lengths, thumbnails and chapter marks through the YouTube Data API v3 | `YOUTUBE_API_KEY` |
| `TRANSCRIPT_PROVIDER` | `youtubei` | Fetches caption transcripts with the `youtubei.js` package, asking as YouTube's app clients | none |
| `AI_PROVIDER` | `anthropic` | Lets Claude pick the episode and the reels from the transcript | `ANTHROPIC_API_KEY` |
| `CLAUDE_MODEL` | `claude-haiku-5-5` | The model for both picks (the default) | |
| `CLAUDE_EFFORT` | `medium` | One of `low`, `medium`, `high`, `xhigh` or `max` | |
| `CLAUDE_REFUSAL_FALLBACK` | `1` | Server-side refusal fallbacks (beta), only on models that support them (not Haiku). `0` turns them off | |

You can switch each provider on its own. A real provider without its key does not stop the server: the job that needs it fails with "Server configuration problem: Missing environment variable ...", and the log says which.

With `AI_PROVIDER=anthropic`, a video with captions costs up to two Claude requests: one for the episode (videos longer than 270 s) and one for its reels (videos longer than 80 s), each with at most one repair request.

## Other settings

| Variable | Default | |
|---|---|---|
| `APP_URL` | (none) | The public URL. Used for the same-origin check behind a proxy, and for the canonical link of shared pages, `robots.txt` and the sitemap (left out without it) |
| `SAMPLE_FEED` | (none) | The shared feed the landing page offers without an account: the link *Share reels* copied, or its 22-character id. Anything else stops the server with a clear message |
| `TRUST_PROXY_HOPS` | `0` | Reverse proxies in front of the app that append to `X-Forwarded-For`. `0`: the rate limits use the TCP peer address and ignore `X-Forwarded-For`. `N`: the client is the Nth entry from the right. Never set it higher than the real number of proxies |
| `DATABASE_PATH` | `./data/recallcast.db` | SQLite file, or `:memory:` |
| `STORAGE_DIR` | `./storage` | Holds only legacy MP3s from removed AI-voiced episodes; they are deleted with their playlist or account |
| `MAX_VIDEOS_PER_PLAYLIST` | `25` | |
| `MAX_VIDEO_SECONDS` | `10800` | Longer videos (3 hours) are skipped |
| `MAX_PLAYLISTS_PER_USER_PER_DAY` | `5` | A rolling 24-hour window. Deleting a playlist does not give the slot back |
| `MAX_SIGNUPS_PER_DAY` | `100` | New accounts across the whole site in any rolling 24 hours |
| `MAX_PLAYLISTS_PER_DAY` | `60` | New playlists across every user in any rolling 24 hours |
| `REELS_PER_VIDEO_MAX` | `6` | Most reels cut from one video (1 to 12). A video gets one per five minutes, up to this number |
| `MAX_SHARES_PER_USER` | `200` | Public links (shared reels and shared feeds) one account may have at a time |
| `WORKER_ENABLED` | `1` | `0` runs the web server without processing jobs |
| `WORKER_POLL_MS` | `1000` | How often an idle worker checks for jobs |
| `WORKER_CONCURRENCY` | `2` | 1 to 8 |
| `SHUTDOWN_GRACE_MS` | `15000` | On SIGTERM/SIGINT, how long running jobs get to finish (0 to 120000). Their locks are released at once, so a job that does not finish runs again on the next start |

## Mock mode

With `*_PROVIDER=mock` nothing costs money and the server calls no paid API:

- **YouTube mock:** any playlist link returns a fixed playlist of 3 videos (12 to 18 minutes long) called "How Memory Works". Any video link returns one of them. The mock ids are not real videos, so the embedded player shows YouTube's "unavailable" screen; the rest of the app works.
- **Transcript mock:** returns a transcript of about 2 minutes on the forgetting curve. Video ids that contain `NOCAP` (for example `https://youtu.be/NOCAPvid001`) return no captions, which lets you test the default window and the "paste a transcript" flow.
- **AI mock:** always uses the free heuristic pickers.
- **Error hooks:** ids that contain `NOTFOUND`, `PRIVATE` or `QUOTA` make the YouTube mock throw the matching error.

You can mix modes. A common setup is real YouTube and transcripts with `AI_PROVIDER=mock`: real videos, free heuristic picks, and only the free YouTube key.
