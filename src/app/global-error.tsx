"use client"; // Error boundaries must be Client Components

import { useEffect } from "react";

/**
 * Last-resort boundary for errors in the root layout itself. It replaces the root layout, so
 * globals.css and the Archivo font may not be there: everything it needs is inline, in the
 * Programme colours (pine band, paper, ink), with a system condensed fallback.
 */

const css = `
:root { color-scheme: light dark; --paper: #f2f7f3; --ink: #10221b; --ink2: #273a32; --band: #13281f; --band-ink: #eef4ef; --signal: #d4f04a; }
@media (prefers-color-scheme: dark) { :root { --paper: #0d1713; --ink: #eef4ef; --ink2: #d0dbd3; --band: #07100c; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100dvh; background: var(--paper); color: var(--ink); font-family: Archivo, ui-sans-serif, system-ui, sans-serif; line-height: 1.5; }
.ge-top { background: var(--band); color: var(--band-ink); min-height: 56px; display: flex; align-items: center; padding: 0 clamp(16px, 4vw, 40px); }
.ge-mark { font-weight: 800; font-stretch: 68%; font-size: 1.375rem; letter-spacing: 0.02em; text-transform: uppercase; color: inherit; text-decoration: none; }
.ge-main { max-width: 1200px; margin: 0 auto; padding: clamp(40px, 9vh, 96px) clamp(16px, 4vw, 40px); }
.ge-slot { border-top: 3px solid var(--ink); padding-top: 24px; display: grid; gap: 16px; }
.ge-slot h1 { margin: 0; font-weight: 800; font-stretch: 68%; font-size: clamp(2rem, 3.2vw, 3rem); line-height: 1; text-transform: uppercase; }
.ge-slot p { margin: 0; color: var(--ink2); max-width: 56ch; }
.ge-btn { justify-self: start; min-height: 44px; padding: 0 24px; border: 1px solid var(--ink); border-radius: 2px; background: var(--ink); color: var(--paper); font: inherit; font-weight: 700; font-stretch: 78%; font-size: 0.875rem; letter-spacing: 0.06em; text-transform: uppercase; cursor: pointer; }
.ge-btn:hover { background: var(--signal); border-color: #10221b; color: #10221b; }
.ge-btn:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
`;

export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <html lang="en">
      <head>
        <title>Something went wrong | RecallCast</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style>{css}</style>
      </head>
      <body>
        <header className="ge-top">
          {/* A plain <a>: a full reload is the point when the root layout failed. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a className="ge-mark" href="/">
            RecallCast
          </a>
        </header>
        <main className="ge-main">
          <div className="ge-slot" role="alert">
            <h1>Off air</h1>
            <p>RecallCast could not load. Try again, or come back in a minute.</p>
            <button type="button" className="ge-btn" onClick={() => retry()}>
              Try again
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
