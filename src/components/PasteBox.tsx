"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState, type FormEvent } from "react";
import { api } from "./api";
import { describeUrl } from "./format";
import styles from "@/styles/library.module.css";

/**
 * The paste box: a YouTube playlist or video link, checked as you type with the same parser
 * the server uses, posted to /api/playlists, then on to the new playlist's page.
 */
export default function PasteBox({ autoFocus = false }: { autoFocus?: boolean }) {
  const router = useRouter();
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const feedback = describeUrl(value);
  const showInvalid = feedback.state === "invalid" && touched;
  const helpId = `${id}-help`;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setTouched(true);
    setServerError(null);
    const fb = describeUrl(value);
    if (fb.state !== "ok") {
      if (fb.state === "empty") setServerError("Paste a link first.");
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    const res = await api<{ id: string }>("/api/playlists", { method: "POST", body: { url: value.trim() } });
    if (res.ok && res.data && typeof res.data.id === "string") {
      setValue("");
      router.push(`/app/p/${encodeURIComponent(res.data.id)}`);
      router.refresh();
      return;
    }
    setBusy(false);
    if (res.ok) {
      setServerError("Added, but the response was unexpected. Refresh the page.");
      router.refresh();
      return;
    }
    if (res.status === 401) {
      router.replace("/login?next=/app");
      return;
    }
    setServerError(res.error);
    inputRef.current?.focus();
  }

  let hint = feedback.message;
  let tone: "error" | "ok" | undefined;
  if (serverError) {
    hint = serverError;
    tone = "error";
  } else if (showInvalid) {
    tone = "error";
  } else if (feedback.state === "ok") {
    tone = "ok";
  } else if (feedback.state === "invalid") {
    // Not touched yet: keep the neutral hint until they leave the field or submit.
    hint = describeUrl("").message;
  }

  return (
    <form className={styles.paste} onSubmit={onSubmit} noValidate>
      <label className={styles.pasteLabel} htmlFor={`${id}-url`}>
        Paste a YouTube playlist or video link
      </label>
      <div className={styles.pasteRow}>
        <input
          ref={inputRef}
          id={`${id}-url`}
          className="input"
          type="text"
          inputMode="url"
          name="url"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="https://www.youtube.com/playlist?list=..."
          autoFocus={autoFocus}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setServerError(null);
            if (touched && describeUrl(e.target.value).state === "ok") setTouched(false);
          }}
          onBlur={() => {
            if (value.trim()) setTouched(true);
          }}
          onPaste={() => setTouched(true)}
          aria-invalid={showInvalid || !!serverError ? true : undefined}
          aria-describedby={helpId}
          disabled={busy}
          maxLength={2048}
        />
        <button className="btn btn--primary" type="submit" disabled={busy} aria-busy={busy || undefined}>
          {busy ? "Adding" : "Make episodes"}
        </button>
      </div>
      <p className="field__hint" id={helpId} data-tone={tone} aria-live="polite">
        {hint}
      </p>
    </form>
  );
}
