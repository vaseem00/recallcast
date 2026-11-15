"use client"; // Error boundaries must be Client Components

import Link from "next/link";
import BrandMark from "@/components/BrandMark";
import ErrorSlot from "@/components/ErrorSlot";
import styles from "@/styles/status.module.css";

/** Root error boundary: errors in any page outside /app (the /app shell has its own). */
export default function RootError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <div className={styles.shell}>
      <header className="band">
        <div className={`container ${styles.top}`}>
          <Link className="wordmark" href="/">
            <BrandMark />
            RecallCast
          </Link>
        </div>
      </header>
      <main id="main" className={`container ${styles.main}`}>
        <ErrorSlot error={error} retry={retry} backHref="/" backLabel="Back to the start" />
      </main>
    </div>
  );
}
