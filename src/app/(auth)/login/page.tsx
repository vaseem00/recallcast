import type { Metadata } from "next";
import { redirect } from "next/navigation";
import AuthForm from "@/components/AuthForm";
import { safeNextPath } from "@/components/format";
import { getCurrentUser } from "@/lib/auth";
import styles from "@/styles/auth.module.css";

export const metadata: Metadata = { title: "Log in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const next = safeNextPath(sp.next);
  if (await getCurrentUser()) redirect(next);

  return (
    <div className={styles.layout}>
      <div className={styles.head}>
        <h1>Welcome back.</h1>
        <p>Your playlists and episodes are where you left them.</p>
      </div>
      <div className={styles.panel}>
        <AuthForm mode="login" next={next} />
      </div>
    </div>
  );
}
