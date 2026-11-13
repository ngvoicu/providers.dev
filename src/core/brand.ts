// The providers.dev mark: a "p" and a "d" that share one bowl. The ring is a provider, the dot is the model inside
// it, and the two stems are the two ways in (API key and subscription). It reads the same turned upside down.
//
// Drawn on a 32-unit grid: the stems are 4 units wide and start on even coordinates, so their edges fall on whole
// pixels at 16 and 32 px.

/** The box of the bare mark inside the 32-unit grid: 16 wide, 24 high. */
export const MARK_BOX = "8 4 16 24";

export const BRAND = { from: "#6366f1", to: "#3730a3", ink: "#ffffff", dot: "#c7d2fe" } as const;

/** The mark without a background. `ink` draws the ring and stems, `dot` the model. */
export function markSvg(ink: string, dot: string): string {
  return (
    `<g fill="none" stroke="${ink}" stroke-width="4"><circle cx="16" cy="16" r="6"/><path d="M10 16v12M22 16V4"/></g>` +
    `<circle cx="16" cy="16" r="1.9" fill="${dot}"/>`
  );
}

/** The mark on its indigo tile, as a complete SVG document. `radius` 0 gives a full square (iOS rounds it itself). */
export function tileSvg(radius = 7): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${BRAND.from}"/><stop offset="1" stop-color="${BRAND.to}"/></linearGradient></defs>` +
    `<rect width="32" height="32" rx="${radius}" fill="url(#g)"/>` +
    markSvg(BRAND.ink, BRAND.dot) +
    `</svg>`
  );
}
