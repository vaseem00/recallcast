import Link from "next/link";
import BrandMark from "@/components/BrandMark";
import styles from "@/styles/auth.module.css";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.shell}>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="band">
        <div className={`container ${styles.top}`}>
          <Link className="wordmark" href="/">
            <BrandMark />
            RecallCast
          </Link>
        </div>
      </header>
      <main id="main" className={`container ${styles.main}`}>
        {children}
      </main>
      <footer className={`container ${styles.foot}`}>
        <p>RecallCast is not affiliated with YouTube.</p>
      </footer>
    </div>
  );
}
