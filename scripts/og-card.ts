// Writes dist/og-card.html, the 1200 x 630 card that public/og.png is a screenshot of. It needs a built site,
// because it uses the site's stylesheet for the fonts:
//   npm run build && npm run og-card && npm run preview
// then save a 1200 x 630 screenshot of http://localhost:8787/og-card as public/og.png and rebuild.
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MARK_BOX, markSvg, tileSvg } from "../src/core/brand.ts";

const DIST = join(import.meta.dirname, "..", "dist");
const stylesheets = readdirSync(join(DIST, "_astro")).filter((name) => name.endsWith(".css"));
if (stylesheets.length === 0) throw new Error("no stylesheet in dist/_astro: run `npm run build` first");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="robots" content="noindex" />
<title>providers.dev card</title>
${stylesheets.map((name) => `<link rel="stylesheet" href="/_astro/${name}" />`).join("\n")}
<style>
  html, body { margin: 0; width: 1200px; height: 630px; overflow: hidden; }
  body {
    display: block; position: relative; box-sizing: border-box; padding: 64px 72px; color: #fafafa;
    background:
      radial-gradient(900px 620px at 92% 8%, rgba(99, 102, 241, 0.34), transparent 62%),
      radial-gradient(700px 500px at 0% 110%, rgba(55, 48, 163, 0.28), transparent 60%),
      #09090b;
  }
  .og-brand { display: flex; align-items: center; gap: 18px; font-size: 34px; font-weight: 620; letter-spacing: -0.02em; }
  .og-brand svg { width: 60px; height: 60px; }
  .og-brand span span { color: #8f8f9a; }
  h1 { margin: 92px 0 0; max-width: 760px; font-size: 70px; line-height: 1.04; font-weight: 650; letter-spacing: -0.04em; }
  p { margin: 30px 0 0; max-width: 720px; font-size: 29px; line-height: 1.38; color: #a1a1aa; letter-spacing: -0.01em; }
  .mark { position: absolute; right: 104px; top: 120px; height: 390px; width: 260px; color: #fafafa; }
</style>
</head>
<body>
  <div class="og-brand">${tileSvg()}<span>providers<span>.dev</span></span></div>
  <h1>AI models as each provider actually exposes them</h1>
  <p>Context window, maximum output and prompt cache, for every provider and access method.</p>
  <svg class="mark" viewBox="${MARK_BOX}" aria-hidden="true">${markSvg("currentColor", "#818cf8")}</svg>
</body>
</html>
`;
writeFileSync(join(DIST, "og-card.html"), html);
console.log("wrote dist/og-card.html");
