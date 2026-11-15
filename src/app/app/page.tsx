import type { Metadata } from "next";
import PasteBox from "@/components/PasteBox";
import PlaylistLibrary from "@/components/PlaylistLibrary";
import { requireUserPage } from "@/lib/auth";
import { listPlaylistsForUser } from "@/lib/jobs/views";
import appStyles from "@/styles/app.module.css";
import styles from "@/styles/library.module.css";

export const metadata: Metadata = { title: "Library" };
export const dynamic = "force-dynamic";

export default async function LibraryPage() {
  const user = await requireUserPage("/app");
  const playlists = listPlaylistsForUser(user.id);

  return (
    <div className={appStyles.page}>
      <div className={appStyles.pageHead}>
        <h1>Library</h1>
        <p>Paste a link. Each video becomes one episode, and its strongest minutes join your reels.</p>
      </div>
      <div className={styles.pastePanel}>
        <PasteBox autoFocus={playlists.length === 0} />
      </div>
      <PlaylistLibrary initial={playlists} />
    </div>
  );
}
