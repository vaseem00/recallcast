"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useRef, useState } from "react";
import type { EpisodeView, PlaylistDetail, VideoView } from "@/lib/jobs/views";
import { api } from "./api";
import ConfirmAction from "./ConfirmAction";
import { clipRangeLabel, formatClock, formatMinutes, plural, playlistStatus, progressFraction, shouldPollDetail, videoStatus, youtubeAt } from "./format";
import ManualTranscript from "./ManualTranscript";
import Player, { type PlayerTrack } from "./Player";
import { usePolling } from "./usePolling";
import appStyles from "@/styles/app.module.css";
import styles from "@/styles/playlist.module.css";

function toTrack(e: EpisodeView, channel: string): PlayerTrack {
  return { id: e.id, youtubeVideoId: e.youtubeVideoId, start: e.clip.start, end: e.clip.end, title: e.title, channel };
}

const PICK_NOTE: Record<EpisodeView["clip"]["picked"], string> = {
  ai: "Picked by reading the whole transcript.",
  heuristic: "Picked automatically from the transcript.",
  whole: "The video is short, so it plays in full.",
  nocaptions: "No captions were found, so this part starts just after the intro.",
};

export default function PlaylistView({ initial }: { initial: PlaylistDetail }) {
  const router = useRouter();
  const [detail, setDetail] = useState<PlaylistDetail>(initial);
  const [gone, setGone] = useState(false);
  const [stale, setStale] = useState(false);
  // The episode on air (by id, so a poll that reorders or adds episodes keeps it).
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const failures = useRef(0);

  const { playlist, videos, episodes, progress } = detail;
  const id = playlist.id;

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const res = await api<PlaylistDetail>(`/api/playlists/${encodeURIComponent(id)}`, { signal });
      if (signal?.aborted) return;
      if (res.ok && res.data?.playlist) {
        failures.current = 0;
        setStale(false);
        setDetail(res.data);
      } else if (res.status === 404) {
        setGone(true);
      } else if (res.status === 401) {
        router.replace(`/login?next=${encodeURIComponent(`/app/p/${id}`)}`);
      } else {
        failures.current += 1;
        if (failures.current >= 2) setStale(true);
      }
    },
    [id, router],
  );

  // Keep polling while videos are processing, and after that while their reels are being cut.
  usePolling(!gone && (shouldPollDetail(detail) || detail.reels.pending > 0), 3000, (signal) => refresh(signal));

  const episodeById = useMemo(() => new Map(episodes.map((e) => [e.id, e])), [episodes]);
  const channelByVideo = useMemo(() => new Map(videos.map((v) => [v.id, v.channel || playlist.channel])), [videos, playlist.channel]);
  const tracks = useMemo(
    () => episodes.map((e) => toTrack(e, channelByVideo.get(e.videoId) ?? playlist.channel)),
    [episodes, channelByVideo, playlist.channel],
  );
  const currentIndex = currentId ? tracks.findIndex((t) => t.id === currentId) : -1;

  const st = playlistStatus(playlist.status);
  const frac = progressFraction(progress);
  const working = st.tone === "work";
  const totalListen = episodes.reduce((n, e) => n + e.durationS, 0);
  const progressText =
    progress.total > 0
      ? `${progress.ready} of ${plural(progress.total, "episode")} ready${progress.failed ? `, ${progress.failed} failed` : ""}`
      : working
        ? "Reading the playlist"
        : "No episodes";

  // Videos playing a default window because no captions were found (nothing pasted either).
  const noCaptions = videos.filter((v) => v.status === "ready" && v.transcriptStatus === "needs_manual").length;
  const reelsHref = `/app/reels?playlist=${encodeURIComponent(id)}`;

  async function copyFeedLink(slug: string): Promise<void> {
    const url = new URL(`/r/${slug}`, window.location.origin).toString();
    try {
      await navigator.clipboard.writeText(url);
      setNotice("Link copied. The page is public: anyone can swipe through this playlist's reels without an account, and search engines may list it.");
    } catch {
      setNotice(`Copy this link: ${url}`);
    }
  }

  async function shareFeed(): Promise<void> {
    if (detail.shareSlug) return copyFeedLink(detail.shareSlug);
    const res = await api<{ slug: string }>(`/api/playlists/${encodeURIComponent(id)}/share`, { method: "POST", body: {} });
    if (!res.ok || !res.data?.slug) {
      setNotice(res.ok ? "The link could not be made. Try again." : res.error);
      return;
    }
    const slug = res.data.slug;
    setDetail((d) => ({ ...d, shareSlug: slug }));
    await copyFeedLink(slug);
  }

  if (gone) {
    return (
      <div className={appStyles.page}>
        <div className={appStyles.pageHead}>
          <h1>This playlist is gone.</h1>
          <p>It was deleted, or it belongs to another account.</p>
        </div>
        <Link className="btn" href="/app">
          Back to the library
        </Link>
      </div>
    );
  }

  const canRetry = progress.failed > 0 || playlist.status === "failed";

  return (
    <>
      <div className={appStyles.page}>
        <nav aria-label="Breadcrumb" className={styles.crumbs}>
          <Link className="link" href="/app">
            Library
          </Link>
        </nav>

        <header className={styles.header}>
          <div className={styles.headerThumb}>
            {playlist.thumbnail ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={playlist.thumbnail} alt="" referrerPolicy="no-referrer" width={480} height={270} />
            ) : null}
          </div>
          <div className={styles.headerText}>
            <h1 className={styles.title}>{playlist.title || (playlist.kind === "video" ? "Single video" : "Playlist")}</h1>
            {playlist.channel ? <p className={styles.channel}>{playlist.channel}</p> : null}
            <div className={styles.statusRow}>
              <span className="chip" data-tone={st.tone}>
                {st.label}
              </span>
              <span className={styles.progressText}>{progressText}</span>
              {stale ? (
                <span className="chip" data-tone="warn">
                  Lost connection, retrying
                </span>
              ) : null}
            </div>
            {progress.total > 0 && (working || frac < 1) ? (
              <div
                className={`meter ${styles.meter}`}
                role="progressbar"
                aria-label="Episodes finished"
                aria-valuemin={0}
                aria-valuemax={progress.total}
                aria-valuenow={progress.ready + progress.failed}
              >
                <span className="meter__fill" style={{ ["--meter" as string]: String(frac) }} />
              </div>
            ) : null}
            <p className="visually-hidden" role="status" aria-live="polite">
              {`${st.label}. ${progressText}.`}
            </p>
          </div>
          <div className={styles.actions}>
            {tracks.length > 0 ? (
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => setCurrentId(tracks[0].id)}
                aria-pressed={currentIndex >= 0}
              >
                {currentIndex >= 0 ? "On air" : tracks.length > 1 ? `Play all, ${formatMinutes(totalListen)}` : "Play"}
              </button>
            ) : null}
            {detail.reels.ready > 0 ? (
              <Link className="btn" href={reelsHref}>
                {plural(detail.reels.ready, "reel")}
              </Link>
            ) : detail.reels.pending > 0 ? (
              <span className="chip" data-tone="work" role="status">
                Cutting reels
              </span>
            ) : null}
            {detail.reels.ready > 0 ? (
              <button type="button" className="btn btn--small" onClick={() => void shareFeed()}>
                {detail.shareSlug ? "Copy reels link" : "Share reels"}
              </button>
            ) : null}
            {detail.shareSlug ? (
              <ConfirmAction
                label="Stop sharing"
                question="Turn the public link off?"
                confirmLabel="Turn it off"
                busyLabel="Turning off"
                onConfirm={async () => {
                  const res = await api(`/api/playlists/${encodeURIComponent(id)}/share`, { method: "DELETE" });
                  if (!res.ok && res.status !== 404) return res.error;
                  setDetail((d) => ({ ...d, shareSlug: null }));
                  setNotice("The public link no longer works.");
                  return null;
                }}
              />
            ) : null}
            {noCaptions > 0 ? (
              <ConfirmAction
                label="Check captions again"
                question={`Look for captions on ${plural(noCaptions, "video")} again?`}
                confirmLabel="Check"
                busyLabel="Checking"
                onConfirm={async () => {
                  const res = await api<{ rechecked: number }>(`/api/playlists/${encodeURIComponent(id)}/recheck`, { method: "POST", body: {} });
                  if (!res.ok) return res.error;
                  setNotice(
                    res.data?.rechecked
                      ? `Looking for captions on ${plural(res.data.rechecked, "video")}. Each one that has them gets a proper pick and its reels.`
                      : "No video is waiting for captions.",
                  );
                  await refresh();
                  return null;
                }}
              />
            ) : null}
            {canRetry ? (
              <ConfirmAction
                label="Retry failed"
                question={`Try the ${progress.failed > 0 ? plural(progress.failed, "failed video") : "playlist"} again?`}
                confirmLabel="Retry"
                busyLabel="Retrying"
                onConfirm={async () => {
                  const res = await api(`/api/playlists/${encodeURIComponent(id)}/retry`, { method: "POST", body: {} });
                  if (!res.ok) return res.error;
                  setNotice("Failed videos are back in the queue.");
                  await refresh();
                  return null;
                }}
              />
            ) : null}
            <ConfirmAction
              label="Delete"
              question="Delete this playlist and its episodes?"
              confirmLabel="Delete for good"
              busyLabel="Deleting"
              danger
              onConfirm={async () => {
                const res = await api(`/api/playlists/${encodeURIComponent(id)}`, { method: "DELETE" });
                if (!res.ok && res.status !== 404) return res.error;
                router.push("/app");
                router.refresh();
                return null;
              }}
            />
          </div>
        </header>

        {notice ? (
          <p className="notice" role="status">
            {notice}
          </p>
        ) : null}
        {playlist.status === "failed" && playlist.error ? (
          <p className="notice" data-tone="error" role="alert">
            {playlist.error}
          </p>
        ) : null}

        <section aria-labelledby="episodes-head" className={styles.episodes}>
          <h2 id="episodes-head" className={styles.sectionTitle}>
            Episodes
          </h2>
          {videos.length === 0 ? (
            <EpisodesSkeleton working={working} />
          ) : (
            <ol className={styles.list}>
              {videos.map((v) => (
                <VideoRow
                  key={v.id}
                  video={v}
                  episode={v.episodeId ? episodeById.get(v.episodeId) ?? null : null}
                  current={currentId}
                  onPlay={(e) => setCurrentId(e.id)}
                  onTranscriptSent={() => void refresh()}
                />
              ))}
            </ol>
          )}
        </section>
      </div>
      {currentIndex >= 0 ? (
        <Player tracks={tracks} index={currentIndex} onIndexChange={(i) => setCurrentId(tracks[i]?.id ?? null)} onClose={() => setCurrentId(null)} />
      ) : null}
    </>
  );
}

function EpisodesSkeleton({ working }: { working: boolean }) {
  if (!working) return <p className={styles.recapNote}>No videos were found in this link.</p>;
  return (
    <div aria-hidden="true" className={styles.skeletonList}>
      {[0, 1, 2].map((i) => (
        <div key={i} className={styles.skeletonRow}>
          <span className="skeleton" style={{ width: "2ch", height: "1.2em" }} />
          <span className="skeleton" style={{ height: "1.2em" }} />
          <span className="skeleton" style={{ width: "8ch", height: "1.2em" }} />
        </div>
      ))}
    </div>
  );
}

function VideoRow({
  video,
  episode,
  current,
  onPlay,
  onTranscriptSent,
}: {
  video: VideoView;
  episode: EpisodeView | null;
  current: string | null;
  onPlay: (e: EpisodeView) => void;
  onTranscriptSent: () => void;
}) {
  const vs = videoStatus(video.status, video.transcriptStatus);
  const playing = !!episode && current === episode.id;
  const noCaptions = video.transcriptStatus === "needs_manual" && video.status !== "skipped";

  return (
    <li className={styles.row} data-state={video.status} data-playing={playing || undefined}>
      <div className={styles.rowMain}>
        <span className={styles.num}>
          <span className="visually-hidden">Episode {video.position + 1}, </span>
          {episode ? formatClock(episode.durationS) : <span className={styles.numEmpty}>{String(video.position + 1).padStart(2, "0")}</span>}
        </span>
        <div className={styles.rowText}>
          <h3 className={styles.rowTitle}>{episode?.title || video.title}</h3>
          <p className={styles.rowMeta}>
            {episode && episode.title !== video.title ? <span>{video.title}</span> : null}
            {episode ? <span>{clipRangeLabel(episode.clip)}</span> : video.durationS > 0 ? <span>Video {formatClock(video.durationS)}</span> : null}
          </p>
        </div>
        <div className={styles.rowSide}>
          <span className="chip" data-tone={playing ? "live" : episode && noCaptions ? "warn" : vs.tone}>
            {playing ? "On air" : episode && noCaptions ? "No captions" : vs.label}
          </span>
          {episode ? (
            <button
              type="button"
              className={`btn btn--small ${styles.playSmall}`}
              onClick={() => onPlay(episode)}
              aria-pressed={playing}
              aria-label={`${playing ? "Playing" : "Play"} ${episode.title}`}
            >
              {playing ? "Playing" : "Play"}
            </button>
          ) : null}
        </div>
      </div>

      {video.status === "failed" && video.error ? <p className={styles.rowError}>{video.error}</p> : null}
      {video.status === "skipped" ? <p className={styles.rowNote}>{video.error || "Skipped: this video is longer than the limit."}</p> : null}

      {episode ? (
        <details className={styles.details}>
          <summary className={styles.summary}>About this part</summary>
          <div className={styles.detailsBody}>
            <p className={styles.clipSummary}>{episode.clip.summary}</p>
            {episode.clip.reason ? <p className={styles.clipReason}>{episode.clip.reason}</p> : null}
            <p className={styles.clipMeta}>
              {PICK_NOTE[episode.clip.picked]}{" "}
              <a className="link" href={youtubeAt(video.youtubeVideoId, episode.clip.start)} target="_blank" rel="noopener noreferrer">
                Watch on YouTube from {formatClock(episode.clip.start)}
              </a>
            </p>
            {episode.excerpt ? (
              <div className={styles.scriptBlock}>
                <h4 className={styles.scriptHead}>What is said</h4>
                <p className={styles.excerpt}>{episode.excerpt}</p>
              </div>
            ) : null}
            {noCaptions ? <ManualTranscript videoId={video.id} youtubeUrl={video.youtubeUrl} onSubmitted={onTranscriptSent} /> : null}
          </div>
        </details>
      ) : noCaptions && video.status === "failed" ? (
        <ManualTranscript videoId={video.id} youtubeUrl={video.youtubeUrl} onSubmitted={onTranscriptSent} />
      ) : null}
    </li>
  );
}
