"use client";

import { useState } from "react";
import { formatClock } from "../format";
import { SAMPLE_CLIPS, SAMPLE_PLAYLIST } from "./sample";
import styles from "@/styles/landing.module.css";

/**
 * The hero's instrument: a sample running order. Each slot is the part of a video that
 * RecallCast keeps; the timeline shows that window inside the whole video. There is no
 * video or sound on this page, and the caption above the panel says so.
 */
export default function HeroEpisode() {
  const [i, setI] = useState(0);
  const clip = SAMPLE_CLIPS[i];
  const left = (clip.start / clip.videoLengthS) * 100;
  const width = ((clip.end - clip.start) / clip.videoLengthS) * 100;

  return (
    <div className={`band ${styles.instrument}`}>
      <div className={styles.instHead}>
        <div className={styles.instTitleBlock}>
          <p className={styles.instName}>{SAMPLE_PLAYLIST}</p>
          <p className={styles.instSub}>{SAMPLE_CLIPS.length} videos, {SAMPLE_CLIPS.length} episodes</p>
        </div>
        <span className="chip">Sample</span>
      </div>

      <ol className={styles.chapterPills} aria-label="Episodes">
        {SAMPLE_CLIPS.map((c, n) => (
          <li key={c.title}>
            <button type="button" className={styles.chapterPill} aria-current={n === i ? "true" : undefined} onClick={() => setI(n)}>
              <span className={styles.chapterPillTime}>{formatClock(c.end - c.start)}</span>
              {c.title}
            </button>
          </li>
        ))}
      </ol>

      <div className={styles.turns} aria-live="polite">
        <p className={styles.clipVideo}>From &ldquo;{clip.video}&rdquo;</p>
        <p className={styles.turnText}>{clip.excerpt}</p>
        <p className={styles.clipWhy}>{clip.reason}</p>
      </div>

      <div className={styles.timelineWrap}>
        <div
          className={styles.timeline}
          role="img"
          aria-label={`The episode is ${formatClock(clip.start)} to ${formatClock(clip.end)} of a ${formatClock(clip.videoLengthS)} video.`}
        >
          <span className={styles.timelineWindow} style={{ left: `${left}%`, width: `${width}%` }} />
        </div>
        <div className={styles.timelineLabels} aria-hidden="true">
          <span>0:00</span>
          <span className={styles.timelineKept}>
            Kept: {formatClock(clip.start)} to {formatClock(clip.end)}
          </span>
          <span>{formatClock(clip.videoLengthS)}</span>
        </div>
      </div>
    </div>
  );
}
