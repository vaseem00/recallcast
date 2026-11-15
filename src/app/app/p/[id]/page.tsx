import type { Metadata } from "next";
import { notFound } from "next/navigation";
import PlaylistView from "@/components/PlaylistView";
import { getCurrentUser, requireUserPage } from "@/lib/auth";
import { getOwnedPlaylist, getPlaylistDetail } from "@/lib/jobs/views";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  if (!ID_RE.test(id)) return { title: "Not found" };
  const user = await getCurrentUser();
  const p = user ? getOwnedPlaylist(user.id, id) : undefined;
  if (user && !p) return { title: "Not found" };
  return { title: p?.title || "Playlist" };
}

export default async function PlaylistPage({ params }: Props) {
  const { id } = await params;
  const user = await requireUserPage(`/app/p/${encodeURIComponent(id)}`);
  if (!ID_RE.test(id)) notFound();
  const detail = getPlaylistDetail(user.id, id);
  if (!detail) notFound();
  return <PlaylistView initial={detail} />;
}
