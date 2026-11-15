/**
 * The RecallCast mark: a video's timeline with the part that matters lit by the highlighter,
 * and a play sign in it. Decorative (the wordmark text next to it is the accessible name).
 * Colours come from globals.css (.brand-mark), so it follows the band and the dark theme.
 * The square app icon with its pine background is src/app/icon.svg.
 */
export default function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 48 32" aria-hidden="true" focusable="false">
      <rect className="brand-mark__track" x="0" y="14" width="48" height="4" />
      <rect className="brand-mark__on" x="14" y="4" width="20" height="24" />
      <path className="brand-mark__play" d="M21 10.5v11l9-5.5z" />
    </svg>
  );
}
