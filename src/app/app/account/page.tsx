import type { Metadata } from "next";
import AccountSettings from "@/components/AccountSettings";
import { requireUserPage } from "@/lib/auth";
import appStyles from "@/styles/app.module.css";
import styles from "@/styles/account.module.css";

export const metadata: Metadata = { title: "Account" };
export const dynamic = "force-dynamic";

const OPENED = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

export default async function AccountPage() {
  const user = await requireUserPage("/app/account");
  const opened = new Date(user.createdAt);

  return (
    <div className={appStyles.page}>
      <div className={appStyles.pageHead}>
        <h1>Account</h1>
        <p>Change your password, sign out on other devices, or close the account.</p>
      </div>

      <section className={styles.section} aria-labelledby="account-details">
        <h2 id="account-details" className={styles.sectionTitle}>
          Details
        </h2>
        <dl className={styles.details}>
          <div className={styles.row}>
            <dt className={styles.label}>Email</dt>
            <dd className={styles.value}>
              {user.email}
            </dd>
          </div>
          <div className={styles.row}>
            <dt className={styles.label}>Opened</dt>
            <dd className={styles.value}>
              <time dateTime={opened.toISOString()}>{OPENED.format(opened)}</time>
            </dd>
          </div>
        </dl>
      </section>

      <AccountSettings />
    </div>
  );
}
