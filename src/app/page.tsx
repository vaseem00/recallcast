import Link from "next/link";
import BrandMark from "@/components/BrandMark";
import HeroEpisode from "@/components/landing/HeroEpisode";
import { getCurrentUser } from "@/lib/auth";
import { getSampleFeed } from "@/lib/reels";
import styles from "@/styles/landing.module.css";

export const dynamic = "force-dynamic";

const LATER = [
  { time: "Then", name: "The next video", line: "When one part ends, the next video's part starts, like a podcast queue.", state: "Up next" },
  {
    time: "1 min",
    name: "Or swipe the reels",
    line: "The strongest one-minute moments of every video, in a feed you swipe through. Send one to a friend with a link; they need no account.",
    state: "Reels",
    sample: true,
  },
];

const STEPS = [
  { n: "01", title: "Read the transcript", body: "The whole timed transcript of the video, from its captions." },
  { n: "02", title: "Find the main idea", body: "The stretch that carries the central argument or lesson, not the intro, the sponsor or the outro." },
  { n: "03", title: "Cut on a thought", body: "It starts where a thought begins and ends after the point lands, 3 to 4 minutes later." },
];

export default async function Home() {
  const user = await getCurrentUser();
  // The feed named by SAMPLE_FEED: real reels a visitor can play before making an account.
  const sample = getSampleFeed();
  const sampleHref = sample ? `/r/${sample.slug}` : null;

  const actions = user ? (
    <Link className="btn btn--primary" href="/app">
      Open your library
    </Link>
  ) : (
    <>
      <Link className="btn btn--primary" href="/signup">
        Create an account
      </Link>
      <Link className="btn" href="/login">
        Log in
      </Link>
    </>
  );
  // A visitor without an account gets the thing itself first, then the sign-up.
  const heroActions =
    user || !sampleHref ? (
      actions
    ) : (
      <>
        <Link className="btn btn--primary" href={sampleHref}>
          Watch a sample feed
        </Link>
        <Link className="btn" href="/signup">
          Create an account
        </Link>
      </>
    );

  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="band">
        <div className={`container ${styles.nav}`}>
          <Link className="wordmark" href="/">
            <BrandMark />
            RecallCast
          </Link>
          <nav aria-label="Account" className={styles.navLinks}>
            {user ? (
              <Link className={styles.navLink} href="/app">
                Open your library
              </Link>
            ) : (
              <>
                <Link className={styles.navLink} href="/login">
                  Log in
                </Link>
                <Link className={styles.navLink} href="/signup">
                  Create an account
                </Link>
              </>
            )}
          </nav>
        </div>
      </header>

      <main id="main">
        <section className={`container ${styles.hero}`} aria-labelledby="hero-head">
          <h1 id="hero-head" className={styles.heroHead}>
            Hear the part of every video that matters.
          </h1>
          <div className={styles.heroSide}>
            <p className="lead">Paste a YouTube playlist. RecallCast finds the 3 to 4 minutes of each video that carry its main idea, and plays them back to back.</p>
            <div className={styles.actions}>{heroActions}</div>
          </div>
        </section>

        <section className={`container ${styles.schedule}`} aria-labelledby="schedule-head">
          <div className={styles.scheduleHead}>
            <h2 id="schedule-head" className={styles.scheduleTitle}>
              What one playlist becomes
            </h2>
            <p className={styles.scheduleNote}>
              {sample ? "The episode is a sample made up for this page. The reels under it are real." : "A sample made up for this page. Nothing plays here."}
            </p>
          </div>

          <ol className={styles.slots}>
            <li className={`${styles.slot} ${styles.slotOnAir}`}>
              <p className={styles.slotTime}>3 to 4 min</p>
              <div className={styles.slotBody}>
                <h3 className={styles.slotName}>One part per video</h3>
                <p className={styles.slotLine}>The creator&apos;s own words, played from the original video. It starts where a thought starts and ends after the point lands.</p>
              </div>
              <p className={`chip ${styles.slotState}`} data-tone="live">
                On air
              </p>
              <div className={styles.slotStage}>
                <HeroEpisode />
              </div>
            </li>
            {LATER.map((r) => (
              <li key={r.name} className={styles.slot}>
                <p className={styles.slotTime}>{r.time}</p>
                <div className={styles.slotBody}>
                  <h3 className={styles.slotName}>{r.name}</h3>
                  <p className={styles.slotLine}>{r.line}</p>
                  {r.sample && sample && sampleHref ? (
                    <div className={styles.sample}>
                      <p className={styles.sampleNote}>
                        Cut from <strong>{sample.title}</strong>
                        {sample.channel ? ` by ${sample.channel}` : ""}. It plays right here, without an account.
                      </p>
                      <ol className={styles.sampleReels}>
                        {sample.hooks.map((hook, i) => (
                          <li key={i} className={styles.sampleReel}>
                            <span className={styles.sampleNo}>{String(i + 1).padStart(2, "0")}</span>
                            <span>{hook}</span>
                          </li>
                        ))}
                      </ol>
                      <Link className="btn btn--primary" href={sampleHref}>
                        {sample.count === 1 ? "Watch the reel" : `Watch all ${sample.count} reels`}
                      </Link>
                    </div>
                  ) : null}
                </div>
                <p className={`chip ${styles.slotState}`} data-tone="quiet">
                  {r.state}
                </p>
              </li>
            ))}
          </ol>
        </section>

        <section className={`container ${styles.moments}`} aria-labelledby="moments-head">
          <div className={styles.momentsText}>
            <h2 id="moments-head">Nothing rewritten. Only chosen.</h2>
            <p className="lead">Every episode is the creator speaking, in their own video. RecallCast decides where to start and where to stop.</p>
          </div>
          <figure className={styles.memory}>
            <p className={styles.memoryLine}>How a part is chosen</p>
            <ol className={styles.memoryIdeas}>
              {STEPS.map((s) => (
                <li key={s.title} className={styles.memoryIdea}>
                  <span className={styles.memoryTime}>{s.n}</span>
                  <div>
                    <p className={styles.memoryIdeaTitle}>{s.title}</p>
                    <p className={styles.memoryIdeaBody}>{s.body}</p>
                  </div>
                </li>
              ))}
            </ol>
            <figcaption className={styles.caption}>Videos play in YouTube&apos;s own player, so the creator keeps the view.</figcaption>
          </figure>
        </section>
      </main>

      <footer className={`container ${styles.footer}`}>
        <p className={styles.footerStatement}>Start with the playlist you saved last.</p>
        <div className={styles.actions}>{actions}</div>
        <p className={styles.legal}>RecallCast is not affiliated with YouTube. Videos belong to their creators and play in YouTube&apos;s embedded player; nothing is downloaded or re-hosted.</p>
      </footer>
    </>
  );
}
