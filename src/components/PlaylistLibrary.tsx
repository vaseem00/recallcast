"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import type { PlaylistListItem } from "@/lib/jobs/views";
import { api } from "./api";
import { plural, playlistStatus, progressFraction, shouldPollList } from "./format";
import { usePolling } from "./usePolling";
import styles from "@/styles/library.module.css";

export default function PlaylistLibrary({ initial }: { initial: PlaylistListItem[] }) {
  const [items, setItems] = useState<PlaylistListItem[]>(initial);
  const [stale, setStale] = useState(false);
  const failures = useRef(0);

  // A server refresh (router.refresh) hands a new initial list: adopt it during render.
  const [prevInitial, setPrevInitial] = useState(initial);
  if (initial !== prevInitial) {
    setPrevInitial(initial);
    setItems(initial);
  }

  usePolling(shouldPollList(items), 3000, async (signal) => {
    const res = await api<{ playlists: PlaylistListItem[] }>("/api/playlists", { signal });
    if (signal.aborted) return;
    if (res.ok && Array.isArray(res.data?.playlists)) {
      failures.current = 0;
      setStale(false);
      setItems(res.data.playlists);
    } else {
      failures.current += 1;
      if (failures.current >= 2) setStale(true);
    }
  });

  if (items.length === 0) {
    return (
      <div className={styles.empty}>
        <h2 className={styles.emptyHead}>No playlists yet.</h2>
        <p>Paste a link above. RecallCast finds the 3 to 4 minutes of each video that carry its main idea, and queues them like a podcast.</p>
      </div>
    );
  }

  return (
    <section aria-labelledby="library-head">
      <div className={styles.listHead}>
        <h2 id="library-head" className={styles.listTitle}>
          Your playlists
        </h2>
        {stale ? (
          <p className="chip" data-tone="warn" role="status">
            Lost connection, retrying
          </p>
        ) : null}
      </div>
      <ul className={styles.grid}>
        {items.map((p, i) => (
          <PlaylistItem key={p.id} p={p} eager={i < 3} />
        ))}
      </ul>
    </section>
  );
}

function PlaylistItem({ p, eager }: { p: PlaylistListItem; eager: boolean }) {
  const st = playlistStatus(p.status);
  const c = p.counts;
  const nonSkipped = Math.max(0, c.total - c.skipped);
  const frac = progressFraction({ total: nonSkipped, ready: c.ready, failed: c.failed });
  const working = st.tone === "work";
  const title = p.title || (p.kind === "video" ? "Single video" : "Playlist");

  return (
    <li className={styles.item}>
      <p className={styles.figure} aria-label={nonSkipped > 0 ? `${c.ready} of ${plural(nonSkipped, "episode")} ready` : "No episodes yet"}>
        {nonSkipped > 0 ? (
          <>
            {c.ready}
            <span className={styles.figureOf}>/{nonSkipped}</span>
          </>
        ) : (
          <span className={styles.figureOf}>0</span>
        )}
      </p>
      <Link className={styles.itemLink} href={`/app/p/${encodeURIComponent(p.id)}`}>
        <div className={styles.thumb}>
          {p.thumbnail ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={p.thumbnail}
              alt=""
              loading={eager ? "eager" : "lazy"}
              fetchPriority={eager ? "high" : "auto"}
              decoding="async" referrerPolicy="no-referrer" width={480} height={270} />
          ) : (
            <span className={styles.thumbFallback} aria-hidden="true">
              {title.slice(0, 1).toUpperCase()}
            </span>
          )}
        </div>
        <div className={styles.itemBody}>
          <h3 className={styles.itemTitle}>{title}</h3>
          <p className={styles.itemChannel}>
            {p.channel ? <span>{p.channel}</span> : null}
            <span>{nonSkipped > 0 ? plural(nonSkipped, "episode") : working ? "Counting videos" : "No episodes"}</span>
          </p>
        </div>
      </Link>
      <div className={styles.itemMeta}>
        <span className="chip" data-tone={st.tone} role={working ? "status" : undefined}>
          {st.label}
        </span>
      </div>
      {working || frac < 1 ? (
        <div
          className={`meter ${styles.itemMeter}`}
          role="progressbar"
          aria-label={`${title} progress`}
          aria-valuemin={0}
          aria-valuemax={nonSkipped || 1}
          aria-valuenow={c.ready + c.failed}
        >
          <span className="meter__fill" style={{ ["--meter" as string]: String(frac) }} />
        </div>
      ) : null}
      {p.status === "failed" && p.error ? <p className={styles.itemError}>{p.error}</p> : null}
    </li>
  );
}
