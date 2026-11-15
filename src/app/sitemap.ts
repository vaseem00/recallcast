import type { MetadataRoute } from "next";
import { getSampleFeed } from "@/lib/reels";
import { siteUrl } from "@/lib/site";

// Reads APP_URL and the sample feed when asked, not at build time.
export const dynamic = "force-dynamic";

/**
 * /sitemap.xml: the landing page and the sample feed it links to. Other shared pages are left
 * out on purpose: they may be indexed, but the site does not publish a list of its users' links.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const home = siteUrl("/");
  if (!home) return [];
  const sample = getSampleFeed();
  const sampleUrl = sample ? siteUrl(`/r/${sample.slug}`) : null;
  return [{ url: home, changeFrequency: "weekly", priority: 1 }, ...(sampleUrl ? [{ url: sampleUrl, changeFrequency: "weekly" as const, priority: 0.8 }] : [])];
}
