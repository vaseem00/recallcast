import type { Metadata, Viewport } from "next";
import { Archivo } from "next/font/google";
import "./globals.css";

// One family, two widths: the condensed cut sets headings and the time column, the
// regular cut sets everything that is read. Self-hosted at build time by next/font.
const archivo = Archivo({
  subsets: ["latin"],
  axes: ["wdth"],
  display: "swap",
  variable: "--font-archivo",
});

export const metadata: Metadata = {
  title: {
    default: "RecallCast",
    template: "%s | RecallCast",
  },
  description: "Hear the 3 to 4 minutes of each YouTube video that carry its main idea, played back to back.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "light dark",
  // The browser bar on phones takes the band's pine (tokens.css --color-band, light and dark).
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#07281c" },
    { media: "(prefers-color-scheme: dark)", color: "#020c07" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={archivo.variable}>
      <body>{children}</body>
    </html>
  );
}
