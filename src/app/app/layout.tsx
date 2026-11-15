import Link from "next/link";
import { AccountLink, AppNavLinks, SignOutButton } from "@/components/AppNav";
import BrandMark from "@/components/BrandMark";
import { requireUserPage } from "@/lib/auth";
import styles from "@/styles/app.module.css";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUserPage("/app");

  return (
    <div className={styles.shell}>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className={`band ${styles.bar}`}>
        <nav className={styles.barInner} aria-label="Main">
          <Link className="wordmark" href="/app">
            <BrandMark />
            RecallCast
          </Link>
          <AppNavLinks />
          <div className={styles.account}>
            <AccountLink email={user.email} />
            <span className={styles.barSignOut}>
              <SignOutButton />
            </span>
          </div>
        </nav>
      </header>
      <main id="main" className={styles.main}>
        {children}
      </main>
    </div>
  );
}
