"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "./api";
import styles from "@/styles/app.module.css";

const LINKS = [
  { href: "/app", label: "Library", match: (p: string) => p === "/app" || p.startsWith("/app/p/") },
  { href: "/app/reels", label: "Reels", match: (p: string) => p.startsWith("/app/reels") },
];

export function AppNavLinks() {
  const pathname = usePathname() ?? "";
  return (
    <ul className={styles.navLinks}>
      {LINKS.map((l) => (
        <li key={l.href}>
          <Link className={styles.navLink} href={l.href} aria-current={l.match(pathname) ? "page" : undefined}>
            {l.label}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * The account entry in the top bar: the email on wide screens, the word "Account" on narrow
 * ones (where the bar has no room for an address, and Sign out moves to the account page).
 */
export function AccountLink({ email }: { email: string }) {
  const pathname = usePathname() ?? "";
  return (
    <Link
      className={styles.accountLink}
      href="/app/account"
      title={email}
      aria-current={pathname.startsWith("/app/account") ? "page" : undefined}
    >
      <span className={styles.email}>
        <span className="visually-hidden">Account: </span>
        {email}
      </span>
      <span className={styles.accountShort}>Account</span>
    </Link>
  );
}

export function SignOutButton({ className = "btn btn--quiet btn--small" }: { className?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <button
      type="button"
      className={className}
      disabled={busy}
      aria-busy={busy || undefined}
      onClick={async () => {
        setBusy(true);
        setFailed(false);
        const res = await api("/api/auth/logout", { method: "POST", body: {} });
        if (res.ok || res.status === 401) {
          router.replace("/");
          router.refresh();
          return;
        }
        setBusy(false);
        setFailed(true);
      }}
      title={failed ? "Sign out did not go through. Try again." : undefined}
    >
      {busy ? "Signing out" : failed ? "Try again" : "Sign out"}
    </button>
  );
}
