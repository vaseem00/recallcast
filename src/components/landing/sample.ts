/**
 * A sample written for the landing page, about a well-established idea (retrieval practice and
 * spacing). It stands for no real video or creator, and the page says so beside it.
 */
export interface SampleClip {
  video: string;
  videoLengthS: number;
  start: number;
  end: number;
  title: string;
  reason: string;
  excerpt: string;
}

export const SAMPLE_PLAYLIST = "How memory works";

export const SAMPLE_CLIPS: SampleClip[] = [
  {
    video: "Why rereading feels like learning",
    videoLengthS: 1694,
    start: 724,
    end: 940,
    title: "Familiar is not the same as known",
    reason: "This is where the video makes its main claim and backs it with the classroom study.",
    excerpt:
      "Here's the trap. When you reread a page, it gets familiar, and familiar feels like you know it. But recognising something on the page and pulling it out of memory are different skills, and only the second one shows up in the exam...",
  },
  {
    video: "Test yourself before you check",
    videoLengthS: 1122,
    start: 301,
    end: 512,
    title: "Recall first, then look",
    reason: "The step-by-step method the rest of the video builds on.",
    excerpt:
      "Close the notes. Ask yourself the question out loud, and give an answer, even a bad one. Then check. The effort of reaching for it is the part that does the work...",
  },
  {
    video: "Spacing, explained",
    videoLengthS: 2291,
    start: 1480,
    end: 1702,
    title: "Short tries over several days",
    reason: "The worked example that shows why spacing beats one long session.",
    excerpt:
      "Same total time, two schedules. One long evening, or four short tries spread over a week. A month later the spread-out group remembers far more, and here's why...",
  },
];
