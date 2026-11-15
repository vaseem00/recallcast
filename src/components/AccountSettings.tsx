"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState, type FormEvent, type RefObject } from "react";
import { api } from "./api";
import { SignOutButton } from "./AppNav";
import ConfirmAction from "./ConfirmAction";
import styles from "@/styles/account.module.css";

const PASSWORD_MIN = 8;

/** A password input with its label and a Show/Hide toggle, as on the sign-up form. */
function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
  hint,
  error,
  disabled,
  inputRef,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: "current-password" | "new-password";
  hint?: string;
  error?: string;
  disabled?: boolean;
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  const id = useId();
  const [show, setShow] = useState(false);
  const inputId = `${id}-input`;
  const hintId = `${id}-hint`;
  return (
    <div className="field">
      <div className={styles.labelRow}>
        <label className="field__label" htmlFor={inputId}>
          {label}
        </label>
        <button type="button" className={styles.reveal} onClick={() => setShow((s) => !s)} aria-pressed={show} aria-controls={inputId}>
          {show ? "Hide" : "Show"}
        </button>
      </div>
      <input
        ref={inputRef}
        id={inputId}
        className="input"
        type={show ? "text" : "password"}
        autoComplete={autoComplete}
        required
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={hintId}
        disabled={disabled}
      />
      <p className="field__hint" id={hintId} data-tone={error ? "error" : undefined}>
        {error ?? hint ?? ""}
      </p>
    </div>
  );
}

function ChangePassword() {
  const currentRef = useRef<HTMLInputElement>(null);
  const nextRef = useRef<HTMLInputElement>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<{ current?: string; next?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function onSubmit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    if (busy) return;
    setDone(false);
    setFormError(null);
    const errs: { current?: string; next?: string } = {};
    if (!current) errs.current = "Enter your current password.";
    if (!next) errs.next = "Enter a new password.";
    else if (next.length < PASSWORD_MIN) errs.next = `Use at least ${PASSWORD_MIN} characters.`;
    setErrors(errs);
    if (errs.current) return currentRef.current?.focus();
    if (errs.next) return nextRef.current?.focus();

    setBusy(true);
    const res = await api<{ ok: true }>("/api/account/password", {
      method: "POST",
      body: { currentPassword: current, newPassword: next },
    });
    setBusy(false);
    if (res.ok) {
      setCurrent("");
      setNext("");
      setDone(true);
      return;
    }
    if (res.status === 400 && /current password/i.test(res.error)) {
      setErrors({ current: res.error });
      currentRef.current?.focus();
    } else {
      setFormError(res.error);
    }
  }

  return (
    <form className={styles.form} onSubmit={onSubmit} noValidate>
      <PasswordField
        label="Current password"
        value={current}
        onChange={(v) => {
          setCurrent(v);
          if (errors.current) setErrors((e) => ({ ...e, current: undefined }));
        }}
        autoComplete="current-password"
        error={errors.current}
        disabled={busy}
        inputRef={currentRef}
      />
      <PasswordField
        label="New password"
        value={next}
        onChange={(v) => {
          setNext(v);
          if (errors.next) setErrors((e) => ({ ...e, next: undefined }));
        }}
        autoComplete="new-password"
        hint={`At least ${PASSWORD_MIN} characters.`}
        error={errors.next}
        disabled={busy}
        inputRef={nextRef}
      />
      <div className={styles.slot} role="status">
        {done ? <p className="notice">Password changed. Every other device is signed out.</p> : null}
      </div>
      <div className={styles.slot} role="alert">
        {formError ? (
          <p className="notice" data-tone="error">
            {formError}
          </p>
        ) : null}
      </div>
      <div className={styles.actions}>
        <button className="btn btn--primary" type="submit" disabled={busy} aria-busy={busy || undefined}>
          {busy ? "Changing password" : "Change password"}
        </button>
      </div>
    </form>
  );
}

function SignOutEverywhere() {
  const router = useRouter();
  return (
    <ConfirmAction
      label="Sign out everywhere"
      question="Sign out on every device, this one too?"
      confirmLabel="Sign out everywhere"
      busyLabel="Signing out"
      onConfirm={async () => {
        const res = await api("/api/account/logout-all", { method: "POST", body: {} });
        if (res.ok || res.status === 401) {
          router.replace("/login");
          router.refresh();
          return null;
        }
        return res.error;
      }}
    />
  );
}

function DeleteAccount() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>();

  return (
    <form className={styles.form} onSubmit={(e) => e.preventDefault()} noValidate>
      <PasswordField
        label="Your password"
        value={password}
        onChange={(v) => {
          setPassword(v);
          setError(undefined);
        }}
        autoComplete="current-password"
        hint="Type it to unlock the button."
        error={error}
      />
      <div className={styles.actions}>
        <ConfirmAction
          danger
          label="Delete account"
          question="Delete the account and everything in it for good?"
          confirmLabel="Delete for good"
          busyLabel="Deleting"
          disabled={password.length === 0}
          onConfirm={async () => {
            const res = await api("/api/account", { method: "DELETE", body: { password } });
            if (res.ok) {
              router.replace("/");
              router.refresh();
              return null;
            }
            if (res.status === 400) {
              setError(res.error);
              return null;
            }
            return res.error;
          }}
        />
      </div>
    </form>
  );
}

export default function AccountSettings() {
  return (
    <>
      <section className={styles.section} aria-labelledby="account-password">
        <h2 id="account-password" className={styles.sectionTitle}>
          Password
        </h2>
        <div className={styles.row}>
          <p className={styles.label}>Change</p>
          <div className={styles.body}>
            <p className={styles.text}>
              There is no reset by email, so keep the new one somewhere safe. Changing it signs out every other device.
            </p>
            <ChangePassword />
          </div>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="account-signins">
        <h2 id="account-signins" className={styles.sectionTitle}>
          Sign-ins
        </h2>
        <div className={styles.row}>
          <p className={styles.label}>This device</p>
          <div className={styles.body}>
            <div className={styles.actions}>
              <SignOutButton className="btn btn--small" />
            </div>
          </div>
        </div>
        <div className={styles.row}>
          <p className={styles.label}>Everywhere</p>
          <div className={styles.body}>
            <p className={styles.text}>Ends every session: phones, other browsers, and this one. Use it if you signed in on a computer that is not yours.</p>
            <div className={styles.actions}>
              <SignOutEverywhere />
            </div>
          </div>
        </div>
      </section>

      <section className={styles.section} data-tone="danger" aria-labelledby="account-delete">
        <h2 id="account-delete" className={styles.sectionTitle}>
          Delete account
        </h2>
        <div className={styles.row}>
          <p className={styles.label}>For good</p>
          <div className={styles.body}>
            <p className={styles.text}>
              Removes your playlists, episodes and audio, and stops anything still being made. It cannot be undone.
            </p>
            <DeleteAccount />
          </div>
        </div>
      </section>
    </>
  );
}
