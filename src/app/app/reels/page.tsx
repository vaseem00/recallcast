import type { Metadata } from "next";
import ReelsFeed from "@/components/ReelsFeed";
import { requireUserPage } from "@/lib/auth";
import { loadReelFeed } from "@/lib/reels";

export const metadata: Metadata = { title: "Reels" };
export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

/**
 * /app/reels: the one-minute moments of every playlist as a swipe feed.
 * ?playlist=ID shows one playlist's reels, ?saved=1 the saved ones.
 */
export default async function ReelsPage({ searchParams }: Props) {
  const params = await searchParams;
  const rawPlaylist = Array.isArray(params.playlist) ? params.playlist[0] : params.playlist;
  const playlistId = rawPlaylist && ID_RE.test(rawPlaylist) ? rawPlaylist : null;
  const saved = !playlistId && params.saved === "1";
  const next = playlistId ? `/app/reels?playlist=${playlistId}` : saved ? "/app/reels?saved=1" : "/app/reels";
  const user = await requireUserPage(next);
  const feed = loadReelFeed(user.id, { playlistId, saved });
  // The key remounts the feed (and its player) when the slice changes.
  return <ReelsFeed key={next} initial={feed} mode="owner" playlistId={playlistId} saved={saved} />;
}
