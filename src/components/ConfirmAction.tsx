"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A destructive or costly action that asks first, inline: the button turns into a question
 * with Confirm and Cancel. Escape or Cancel backs out; focus moves to Confirm and back.
 */
export default function ConfirmAction({
  label,
  question,
  confirmLabel,
  busyLabel,
  danger = false,
  disabled = false,
  onConfirm,
}: {
  label: string;
  question: string;
  confirmLabel: string;
  busyLabel: string;
  danger?: boolean;
  disabled?: boolean;
  /** Return an error message to show, or null on success. */
  onConfirm: () => Promise<string | null>;
}) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const wasAsking = useRef(false);

  useEffect(() => {
    if (asking) confirmRef.current?.focus();
    else if (wasAsking.current) triggerRef.current?.focus();
    wasAsking.current = asking;
  }, [asking]);

  const cls = `btn btn--small${danger ? " btn--danger" : ""}`;

  if (!asking) {
    return (
      <span style={{ display: "inline-grid", gap: "var(--space-2xs)" }}>
        <button ref={triggerRef} type="button" className={cls} disabled={disabled} onClick={() => { setError(null); setAsking(true); }}>
          {label}
        </button>
        {error ? (
          <span className="field__hint" data-tone="error" role="alert">
            {error}
          </span>
        ) : null}
      </span>
    );
  }

  return (
    <span
      role="group"
      aria-label={question}
      style={{ display: "inline-flex", flexWrap: "wrap", alignItems: "center", gap: "var(--space-xs)" }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !busy) {
          e.stopPropagation();
          setAsking(false);
        }
      }}
    >
      <span style={{ fontSize: "var(--text-sm)", color: "var(--color-ink-2)" }}>{question}</span>
      <button
        ref={confirmRef}
        type="button"
        className={`btn btn--small${danger ? " btn--danger" : " btn--primary"}`}
        disabled={busy}
        aria-busy={busy || undefined}
        onClick={async () => {
          setBusy(true);
          const err = await onConfirm();
          setBusy(false);
          if (err) setError(err);
          setAsking(false);
        }}
      >
        {busy ? busyLabel : confirmLabel}
      </button>
      <button type="button" className="btn btn--small btn--quiet" disabled={busy} onClick={() => setAsking(false)}>
        Cancel
      </button>
    </span>
  );
}
