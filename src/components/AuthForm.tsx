"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, type FormEvent } from "react";
import { api } from "./api";
import styles from "@/styles/auth.module.css";

type Mode = "signup" | "login";

const PASSWORD_MIN = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface FieldErrors {
  email?: string;
  password?: string;
}

export default function AuthForm({ mode, next }: { mode: Mode; next: string }) {
  const router = useRouter();
  const id = useId();
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<{ text: string; emailTaken?: boolean } | null>(null);

  const isSignup = mode === "signup";
  const emailId = `${id}-email`;
  const passwordId = `${id}-password`;
  const emailHelp = `${id}-email-help`;
  const passwordHelp = `${id}-password-help`;
  const formErrorId = `${id}-form-error`;

  function validate(): FieldErrors {
    const errs: FieldErrors = {};
    const e = email.trim();
    if (!e) errs.email = "Enter your email address.";
    else if (!EMAIL_RE.test(e)) errs.email = "That address looks incomplete. Write it as name@example.com.";
    if (!password) errs.password = "Enter a password.";
    else if (isSignup && password.length < PASSWORD_MIN) errs.password = `Use at least ${PASSWORD_MIN} characters.`;
    return errs;
  }

  async function onSubmit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    if (busy) return;
    setFormError(null);
    const errs = validate();
    setFieldErrors(errs);
    if (errs.email) {
      emailRef.current?.focus();
      return;
    }
    if (errs.password) {
      passwordRef.current?.focus();
      return;
    }
    setBusy(true);
    const res = await api<{ user: { id: string; email: string } }>(isSignup ? "/api/auth/signup" : "/api/auth/login", {
      method: "POST",
      body: { email: email.trim(), password },
    });
    if (res.ok) {
      router.replace(next);
      router.refresh();
      return;
    }
    setBusy(false);
    if (res.status === 409 && isSignup) {
      setFormError({ text: "An account with this email already exists.", emailTaken: true });
      emailRef.current?.focus();
    } else if (res.status === 401 && !isSignup) {
      setFormError({ text: "That email and password do not match an account." });
      passwordRef.current?.focus();
    } else {
      setFormError({ text: res.error });
    }
  }

  const otherHref = isSignup ? "/login" : "/signup";
  const otherQuery = next !== "/app" ? `?next=${encodeURIComponent(next)}` : "";

  return (
    <form className={styles.form} onSubmit={onSubmit} noValidate aria-describedby={formError ? formErrorId : undefined}>
      <div className="field">
        <label className="field__label" htmlFor={emailId}>
          Email
        </label>
        <input
          ref={emailRef}
          id={emailId}
          className="input"
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          spellCheck={false}
          required
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (fieldErrors.email) setFieldErrors((f) => ({ ...f, email: undefined }));
          }}
          aria-invalid={fieldErrors.email ? true : undefined}
          aria-describedby={emailHelp}
          disabled={busy}
        />
        <p className="field__hint" id={emailHelp} data-tone={fieldErrors.email ? "error" : undefined}>
          {fieldErrors.email ?? ""}
        </p>
      </div>

      <div className="field">
        <div className={styles.labelRow}>
          <label className="field__label" htmlFor={passwordId}>
            Password
          </label>
          <button
            type="button"
            className={styles.reveal}
            onClick={() => setShow((s) => !s)}
            aria-pressed={show}
            aria-controls={passwordId}
          >
            {show ? "Hide" : "Show"}
          </button>
        </div>
        <input
          ref={passwordRef}
          id={passwordId}
          className="input"
          type={show ? "text" : "password"}
          name="password"
          autoComplete={isSignup ? "new-password" : "current-password"}
          required
          minLength={isSignup ? PASSWORD_MIN : undefined}
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            if (fieldErrors.password) setFieldErrors((f) => ({ ...f, password: undefined }));
          }}
          aria-invalid={fieldErrors.password ? true : undefined}
          aria-describedby={passwordHelp}
          disabled={busy}
        />
        <p className="field__hint" id={passwordHelp} data-tone={fieldErrors.password ? "error" : undefined}>
          {fieldErrors.password ?? (isSignup ? `At least ${PASSWORD_MIN} characters.` : "")}
        </p>
      </div>

      <div className={styles.errorSlot} id={formErrorId} role="alert">
        {formError ? (
          <p className="notice" data-tone="error">
            {formError.text}{" "}
            {formError.emailTaken ? (
              <Link className="link" href={`/login${otherQuery}`}>
                Log in instead
              </Link>
            ) : null}
          </p>
        ) : null}
      </div>

      <button className={`btn btn--primary ${styles.submit}`} type="submit" disabled={busy} aria-busy={busy || undefined}>
        {busy ? (isSignup ? "Creating your account" : "Logging in") : isSignup ? "Create account" : "Log in"}
      </button>

      <p className={styles.switch}>
        {isSignup ? "Have an account? " : "New here? "}
        <Link className="link" href={`${otherHref}${otherQuery}`}>
          {isSignup ? "Log in" : "Create an account"}
        </Link>
      </p>
    </form>
  );
}
