import type { Metadata } from "next";
import { redirect } from "next/navigation";
import AuthForm from "@/components/AuthForm";
import { safeNextPath } from "@/components/format";
import { getCurrentUser } from "@/lib/auth";
import styles from "@/styles/auth.module.css";

export const metadata: Metadata = { title: "Create an account" };

export default async function SignupPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const next = safeNextPath(sp.next);
  if (await getCurrentUser()) redirect(next);

  return (
    <div className={styles.layout}>
      <div className={styles.head}>
        <h1>Make room for one playlist.</h1>
        <p>An email and a password. Then paste a link and the first episode starts.</p>
      </div>
      <div className={styles.panel}>
        <AuthForm mode="signup" next={next} />
      </div>
    </div>
  );
}
