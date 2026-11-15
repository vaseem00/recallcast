// Vitest global setup: every test file runs in its own process (pool: forks),
// so an in-memory DB + mock providers here give each file a clean, offline world.
// Tests must never hit paid APIs.
process.env.DATABASE_PATH = ":memory:";
process.env.YOUTUBE_PROVIDER = "mock";
process.env.TRANSCRIPT_PROVIDER = "mock";
process.env.AI_PROVIDER = "mock";
process.env.WORKER_ENABLED = "0";
