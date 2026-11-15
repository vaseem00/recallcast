import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import BrandMark from "@/components/BrandMark";
import ReelsFeed from "@/components/ReelsFeed";
import { getCurrentUser } from "@/lib/auth";
import { getSharedPage } from "@/lib/reels";
import { siteUrl } from "@/lib/site";
import styles from "@/styles/shared.module.css";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

/**
 * /r/<slug>: a shared reel, or a shared playlist's reels. A public page: no account is needed,
 * nothing about the owner is shown, and search engines may index it (the share buttons say so).
 * The site does not list these pages anywhere itself, except the one sample feed the landing
 * page links to; a crawler finds the rest only where their owners posted them. A revoked or
 * unknown link is a 404, which drops it from an index.
 */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const page = getSharedPage(slug);
  if (!page) return { title: "Not found", robots: { index: false, follow: false } };
  const canonical = siteUrl(`/r/${slug}`);
  const first = page.reels[0];
  const title = page.kind === "moment" ? page.title : `${page.title}: the best minutes`;
  const description =
    page.kind === "moment"
      ? [first.takeaway, page.channel ? `From ${page.channel} on YouTube.` : ""].filter(Boolean).join(" ") || "A one-minute moment from a YouTube video."
      : `${page.reels.length} one-minute moments${page.channel ? ` from ${page.channel}` : ""}, played from the original YouTube videos.`;
  return {
    title,
    description,
    robots: { index: true, follow: true },
    alternates: canonical ? { canonical } : undefined,
    openGraph: {
      title,
      description,
      url: canonical ?? undefined,
      type: "website",
      siteName: "RecallCast",
      images: page.thumbnail ? [{ url: page.thumbnail }] : undefined,
    },
    twitter: { card: page.thumbnail ? "summary_large_image" : "summary", title, description, images: page.thumbnail ? [page.thumbnail] : undefined },
  };
}

export default async function SharedPage({ params }: Props) {
  const { slug } = await params;
  const page = getSharedPage(slug);
  if (!page) notFound();
  const user = await getCurrentUser();

  return (
    <div className={styles.shell}>
      <header className={`band ${styles.bar}`}>
        <div className={styles.barInner}>
          <Link className="wordmark" href="/">
            <BrandMark />
            RecallCast
          </Link>
          <p className={styles.note}>Videos play in YouTube&apos;s own player. Nothing is downloaded or re-hosted.</p>
        </div>
      </header>
      <main>
        <ReelsFeed
          initial={{ reels: page.reels, total: page.reels.length, pending: 0, videos: 0, noCaptions: 0 }}
          mode="public"
          title={page.kind === "moment" ? page.channel || "A shared reel" : page.title}
          signedIn={!!user}
        />
      </main>
    </div>
  );
}
