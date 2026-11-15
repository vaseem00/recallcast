import type { Metadata } from "next";
import Link from "next/link";
import BrandMark from "@/components/BrandMark";
import { getCurrentUser } from "@/lib/auth";
import styles from "@/styles/status.module.css";

export const metadata: Metadata = { title: "Not found" };

/** Root 404: unmatched URLs anywhere, and notFound() outside /app. Renders in the root layout only. */
export default async function NotFound() {
  const user = await getCurrentUser().catch(() => null);
  return (
    <div className={styles.shell}>
      <header className="band">
        <div className={`container ${styles.top}`}>
          <Link className="wordmark" href={user ? "/app" : "/"}>
            <BrandMark />
            RecallCast
          </Link>
        </div>
      </header>
      <main id="main" className={`container ${styles.main}`}>
        <div className={styles.slot}>
          <p className={styles.code} aria-hidden="true">
            404
          </p>
          <div className={styles.body}>
            <h1>Not on the schedule</h1>
            <p>There is no page at this address. It may have moved, or the link was mistyped.</p>
            <div className={styles.actions}>
              {user ? (
                <Link className="btn btn--primary" href="/app">
                  Back to your library
                </Link>
              ) : (
                <Link className="btn btn--primary" href="/">
                  Back to the start
                </Link>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
