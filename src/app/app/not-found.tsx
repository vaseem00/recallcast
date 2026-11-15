import Link from "next/link";
import styles from "@/styles/status.module.css";

/**
 * notFound() inside /app (an unknown playlist id, or one that belongs to someone else): shown
 * inside the signed-in shell, so the nav stays. Missing and not-owned look the same on purpose.
 */
export default function AppNotFound() {
  return (
    <div className={styles.slot}>
      <p className={styles.code} aria-hidden="true">
        404
      </p>
      <div className={styles.body}>
        <h1>Not in your library</h1>
        <p>This playlist does not exist, or it was removed.</p>
        <div className={styles.actions}>
          <Link className="btn btn--primary" href="/app">
            Back to your library
          </Link>
        </div>
      </div>
    </div>
  );
}
