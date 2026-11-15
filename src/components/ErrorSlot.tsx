"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import styles from "@/styles/status.module.css";

/** The body of an error boundary: what happened, Try again, and a way back. */
export default function ErrorSlot({ error, retry, backHref, backLabel }: {
  error: unknown;
  retry: () => void;
  backHref: string;
  backLabel: string;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const digest = error && typeof error === "object" && "digest" in error && typeof error.digest === "string" ? error.digest : null;

  useEffect(() => {
    console.error(error);
    headingRef.current?.focus();
  }, [error]);

  return (
    <div className={styles.slot} role="alert">
      <p className={styles.code} aria-hidden="true">
        Error
      </p>
      <div className={styles.body}>
        <h1 ref={headingRef} tabIndex={-1}>
          Off air for a moment
        </h1>
        <p>Something broke while loading this page. Trying again usually fixes it.</p>
        <div className={styles.actions}>
          <button type="button" className="btn btn--primary" onClick={() => retry()}>
            Try again
          </button>
          <Link className="btn btn--quiet" href={backHref}>
            {backLabel}
          </Link>
        </div>
        {digest ? <p className={styles.ref}>Reference {digest}</p> : null}
      </div>
    </div>
  );
}
