import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/site";

// Reads APP_URL when asked, not at build time.
export const dynamic = "force-dynamic";

/**
 * /robots.txt: the landing page and shared pages (/r/...) may be crawled; the signed-in app and
 * the API may not. The sitemap is named only when APP_URL gives the site an absolute address.
 */
export default function robots(): MetadataRoute.Robots {
  const sitemap = siteUrl("/sitemap.xml");
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/app/", "/api/"] },
    ...(sitemap ? { sitemap } : {}),
  };
}
