import type { TranscriptSegment } from "@/lib/types";

/**
 * ~2-minute sample transcript used by the mock transcript provider. It has a clear thesis,
 * a story (Ebbinghaus' self-experiment), an analogy (a path through a field) and concrete
 * takeaways, so the mock and real AI providers both have something meaningful to extract.
 */
const LINES: Array<[start: number, text: string]> = [
  [0.0, "Hey everyone, welcome back to the lab."],
  [3.2, "Today we're talking about why you forget almost everything you learn, and what to do about it."],
  [8.9, "Back in the 1880s, a German psychologist named Hermann Ebbinghaus ran a strange experiment on himself."],
  [14.6, "He memorised long lists of nonsense syllables, things like DAX, BUP and ZOL,"],
  [19.1, "so that nothing he already knew could help him remember them."],
  [23.4, "Then he tested himself again after twenty minutes, after an hour, after a day, and so on."],
  [29.8, "What he found is now called the forgetting curve."],
  [33.0, "Memory drops off steeply at first, and then the decline slows down."],
  [37.5, "A big chunk of what he learned was gone within the first day."],
  [41.7, "Now here's the hopeful part."],
  [43.9, "Every time he relearned a list, it took less effort, and the curve got flatter."],
  [49.6, "Think of memory like a path through a tall field of grass."],
  [53.8, "Walk it once and the grass springs back by tomorrow."],
  [57.4, "Walk it again a few days later and the path stays visible a little longer."],
  [62.0, "Keep walking it at growing intervals and it turns into a trail that lasts."],
  [67.3, "That is the core idea behind spaced repetition."],
  [70.6, "Instead of cramming everything the night before, you review just as you're about to forget."],
  [76.2, "The second idea is retrieval practice."],
  [79.0, "Pulling an answer out of your head strengthens the memory more than re-reading the page."],
  [84.8, "Re-reading feels productive because the material looks familiar,"],
  [89.1, "but familiarity is not the same as being able to recall it."],
  [93.4, "So here's a simple routine you can try this week."],
  [96.5, "After you learn something, write three questions about it."],
  [100.3, "Answer them tomorrow, then in three days, then in a week."],
  [105.1, "If you get one wrong, bring it back sooner."],
  [108.6, "That's it. Small, spaced, effortful reviews beat one long session."],
  [113.4, "In the next video we'll look at why sleep matters so much for all of this."],
  [118.2, "Thanks for watching, and I'll see you there."],
];

const END_S = 121.5;

export const MOCK_TRANSCRIPT_SEGMENTS: readonly TranscriptSegment[] = Object.freeze(
  LINES.map(([start, text], i) => {
    const next = i + 1 < LINES.length ? LINES[i + 1][0] : END_S;
    return Object.freeze({ start, dur: Math.round((next - start) * 100) / 100, text });
  }),
);
