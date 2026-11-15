"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { api } from "./api";
import styles from "@/styles/playlist.module.css";

/** Same rule as the server (MIN_MANUAL_TRANSCRIPT_WORDS in src/lib/jobs/commands.ts). */
const MIN_WORDS = 20;

function countWords(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

/**
 * For a video whose captions could not be fetched: paste the transcript (from YouTube's
 * "Show transcript" panel or anywhere else) and the video goes back into the pipeline.
 */
export default function ManualTranscript({
  videoId,
  youtubeUrl,
  onSubmitted,
}: {
  videoId: string;
  youtubeUrl: string;
  onSubmitted: () => void;
}) {
  const id = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const value = text.trim();
    if (countWords(value) < MIN_WORDS) {
      setError(`That is too short to make an episode from. Paste the whole transcript (at least ${MIN_WORDS} words).`);
      ref.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    const res = await api(`/api/videos/${encodeURIComponent(videoId)}/transcript`, { method: "POST", body: { text: value } });
    setBusy(false);
    if (res.ok) {
      setDone(true);
      setText("");
      onSubmitted();
      return;
    }
    setError(res.error);
    ref.current?.focus();
  }

  if (done) {
    return (
      <p className={styles.manualDone} role="status">
        Transcript received. This episode is back in the queue.
      </p>
    );
  }

  return (
    <form className={styles.manual} onSubmit={onSubmit} noValidate>
      <label className={styles.manualLabel} htmlFor={`${id}-t`}>
        Paste this video&apos;s transcript
      </label>
      <p className={styles.manualHelp} id={`${id}-h`}>
        Captions for this video could not be fetched. On{" "}
        <a className="link" href={youtubeUrl} target="_blank" rel="noopener noreferrer">
          the video&apos;s page
        </a>{" "}
        open the description, choose Show transcript, then copy it here. Lines that start with a time such as 1:23 keep
        their timestamps.
      </p>
      <textarea
        ref={ref}
        id={`${id}-t`}
        className="textarea"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (error) setError(null);
        }}
        aria-describedby={`${id}-h ${id}-e`}
        aria-invalid={error ? true : undefined}
        disabled={busy}
        rows={8}
        spellCheck={false}
      />
      <div className={styles.manualRow}>
        <p className="field__hint" id={`${id}-e`} data-tone={error ? "error" : undefined} aria-live="polite">
          {error ?? `${countWords(text).toLocaleString()} words`}
        </p>
        <button className="btn btn--small" type="submit" disabled={busy} aria-busy={busy || undefined}>
          {busy ? "Sending" : "Use this transcript"}
        </button>
      </div>
    </form>
  );
}
