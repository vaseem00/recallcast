// Container entrypoint (see Dockerfile). Starts as root only to make the mounted volume
// writable, then drops to the unprivileged `node` user (uid/gid 1000) and starts the Next.js
// standalone server in this same process.
//
// Why: Railway (and plain `docker run -v`) mounts volumes owned by root, so a process that is
// non-root from the start cannot create /data/recallcast.db. Doing the chown here keeps the
// app itself running as non-root without needing RAILWAY_RUN_UID=0.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const APP_UID = 1000;
const APP_GID = 1000;
const dataDirs = [
  path.dirname(path.resolve(process.env.DATABASE_PATH || "/data/recallcast.db")),
  path.resolve(process.env.STORAGE_DIR || "/data/storage"),
];

function chownTree(p) {
  const st = fs.lstatSync(p);
  if (st.uid !== APP_UID || st.gid !== APP_GID) fs.lchownSync(p, APP_UID, APP_GID);
  if (st.isDirectory()) for (const entry of fs.readdirSync(p)) chownTree(path.join(p, entry));
}

if (typeof process.getuid === "function" && process.getuid() === 0) {
  for (const dir of dataDirs) {
    fs.mkdirSync(dir, { recursive: true });
    const st = fs.statSync(dir);
    // Fast path on every boot after the first: only walk the tree when the root is not ours.
    if (st.uid !== APP_UID || st.gid !== APP_GID) chownTree(dir);
  }
  process.setgroups?.([]);
  process.setgid(APP_GID);
  process.setuid(APP_UID);
}

// Node runs as PID 1 here and PID 1 ignores SIGTERM without a handler. The app installs its own
// handlers (src/instrumentation.ts); this fallback only exits when no other handler is present
// (for example WORKER failed to load), so `docker stop` / a Railway redeploy never hangs.
for (const [signal, code] of [["SIGTERM", 143], ["SIGINT", 130]]) {
  process.on(signal, () => {
    if (process.listenerCount(signal) <= 1) process.exit(code);
  });
}

await import(pathToFileURL(path.join(import.meta.dirname, "..", "server.js")).href);
