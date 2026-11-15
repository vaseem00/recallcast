# RecallCast design: Programme

The interface is a broadcast schedule. A playlist is a running order, an episode is a slot, and the thing that is playing is "on air". This direction was chosen over three alternatives (liner notes, cut sheet, category standard).

## Brand

- **Name:** RecallCast, one word, capital R and C. The wordmark sets it in Archivo condensed, extra bold, uppercase (`.wordmark` in `globals.css`).
- **Tagline:** "Hear the part of every video that matters."
- **The mark:** a video's timeline with the part that matters lit by the highlighter, and a play sign in it. In the app it sits before the wordmark (`src/components/BrandMark.tsx`, hidden on screens 400 px wide or less). The square icon puts it on pine: `src/app/icon.svg`, `src/app/favicon.ico`, `src/app/apple-icon.png`, `public/icon-192.png`, `public/icon-512.png` and `docs/media/logo.svg`.
- **Colours in hex** (for images; the app reads the oklch tokens): pine `#07281c`, highlighter `#c8f23c`, band text `#ecf4ee`, muted band text `#afc4b5`, band rule `#334f42`, paper `#f3f9f5`, ink `#082016`.
- **Banner and GitHub social preview:** `docs/media/banner.png` (1280 x 640).
- Keep the mark's proportions and colours. Do not outline it, add a gradient or a shadow, or put the highlighter block on a light background without the pine square.

## Rules

- **The timetable row is the unit.** Lists are rows with a time column on the left (`--time-col`), the programme in the middle and its state on the right. Rows are separated by hairlines; a section opens with a 3px ink rule. No cards, no shadows, no rounded panels.
- **The highlighter means "now".** `--color-signal` marks only what is on air or selected: the playing row, the current nav item, the elapsed part of the clip. It is never decoration. Text on it is always `--color-signal-ink`.
- **The band is pine.** The top bar, the player and the landing page's sample episode sit on `--color-band`. Add the global `band` class to a region and the shared controls inside it re-read their colours.
- **The YouTube frame stays visible.** The player band holds YouTube's embedded player at 356 x 200 (never under 200 px tall; YouTube's terms require it to stay visible) next to our own transport. Do not cover, shrink or restyle the frame; style only our controls around it.
- **The reels feed is the band, full screen.** `/app/reels` and the shared `/r/...` pages sit on pine from the bar to the bottom edge. One YouTube player is pinned at the top (on wide screens, top left) and never moves; the page of each reel scrolls under or beside it. Nothing is ever placed over the player: no hook, no caption, no tap layer, no gradient. A reel's page is its number and state, the hook as a condensed uppercase heading, the source, then the words spoken in the reading width. The line being spoken takes the highlighter; lines already said turn to ink; lines to come stay muted. On wide screens the reel after this one is a schedule row under the video ("Up next", number in the time column).
- **One family, two widths.** Archivo, self-hosted through `next/font`. Headings, times, labels and buttons use the condensed cut (`--wdth-display` 68%, `--wdth-label` 78%), heavy, often uppercase. Anything that is read uses the regular width. Numerals are tabular everywhere.
- **Status is a word with a square marker** (`.chip`), not a pill. A blinking marker means work in progress or on air.
- **Corners are square** (`--radius` 2px). Buttons are outlined; the primary one is filled ink and turns to the highlighter on hover.
- **Motion is small:** the on-air blink, the player sliding in, the schedule rule drawing once on the landing page. All of it stops under `prefers-reduced-motion`.

## Where things live

- Tokens: `src/styles/tokens.css` (light and dark; dark follows the system setting).
- Base and shared controls: `src/styles/base.css`, `src/app/globals.css` (`.btn`, `.input`, `.chip`, `.notice`, `.meter`, `.band`).
- One CSS module per screen in `src/styles/` (`reels.module.css` for the feed, `shared.module.css` for the bar of a shared page).
- `--bar-h` (tokens) is the height of the top bar; the feed starts right under it.

## Do not add

Eyebrow labels above headings, gradient text, glass or blur, card grids, pill-shaped chips, a second accent colour, monospace for times (use tabular numerals).
