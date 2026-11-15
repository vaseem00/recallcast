import type { MetadataRoute } from "next";

/** Web app manifest: name, colours and icons for "Add to Home screen" on phones. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "RecallCast",
    short_name: "RecallCast",
    description: "Hear the 3 to 4 minutes of each YouTube video that carry its main idea, and swipe its best one-minute moments.",
    start_url: "/app",
    display: "standalone",
    background_color: "#07281c",
    theme_color: "#07281c",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
