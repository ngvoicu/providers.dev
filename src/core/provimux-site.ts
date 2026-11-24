// Provimux's own site, provimux.providers.dev, served by the same Worker from the same build. Its pages are static:
// Astro builds them under dist/provimux/, and on the subdomain the Worker serves that folder as the site's root.
// Nothing here reads the dataset.

export const PROVIMUX_SITE = "https://provimux.providers.dev";
export const PROVIMUX_HOST = new URL(PROVIMUX_SITE).hostname;
/** Where the subdomain's files are in the static assets. */
export const PROVIMUX_ASSETS = "/provimux";
/** Its page for an address it does not have, served with status 404. */
export const PROVIMUX_NOT_FOUND = `${PROVIMUX_ASSETS}/not-found/`;

/** The subdomain's pages, by address. */
export const PROVIMUX_PAGES = ["/", "/support/"] as const;

/**
 * On providers.dev (and any host other than the subdomain): where an address that moved to provimux.providers.dev
 * now is, or null. The support page moved with its old address /docs/support/; anything under /provimux/ is the
 * subdomain's build and is only served there. Path and query are set on PROVIMUX_SITE, never resolved against it.
 */
export function movedToProvimux(url: URL): string | null {
  const path = url.pathname;
  let target: string | null = null;
  if (/^\/(docs\/)?support\/?$/.test(path)) target = "/support/";
  else if (path === PROVIMUX_ASSETS || path.startsWith(`${PROVIMUX_ASSETS}/`)) target = path.slice(PROVIMUX_ASSETS.length) || "/";
  if (target === null) return null;
  const location = new URL(PROVIMUX_SITE);
  location.pathname = target;
  location.search = url.search;
  return location.toString();
}

/**
 * On the subdomain: what to answer for a path. `asset` is the static file to serve (with `status`), `redirect` a path
 * on the subdomain to send the request to. The stylesheets and fonts Astro emits (/_astro/) are shared with
 * providers.dev; every other file is the subdomain's own, under PROVIMUX_ASSETS.
 */
export type ProvimuxRoute = { asset: string; status: 200 | 404 } | { redirect: string };

export function provimuxRoute(path: string): ProvimuxRoute {
  if ((PROVIMUX_PAGES as readonly string[]).includes(path)) return { asset: `${PROVIMUX_ASSETS}${path}`, status: 200 };
  if ((PROVIMUX_PAGES as readonly string[]).includes(`${path}/`)) return { redirect: `${path}/` };
  if (path.startsWith("/_astro/")) return { asset: path, status: 200 };
  // A file of the site: an image, an icon, robots.txt, the sitemap. Never a folder, never a page of the build itself.
  if (/^\/[\w.-]+(\/[\w.-]+)*\.[a-z0-9]+$/i.test(path) && !path.includes("..") && !/\.html$/i.test(path)) return { asset: `${PROVIMUX_ASSETS}${path}`, status: 200 };
  return { asset: PROVIMUX_NOT_FOUND, status: 404 };
}

/** The support text's title, description, lead and contents: the same on the page and in /api/v1/docs/support. */
export const SUPPORT = {
  title: "Support",
  description: "Support plans for companies that run Provimux, by providers.dev: prices, reply times, what is covered and how to buy.",
  lead: "Provimux is free and stays open source (MIT). For companies that run it, providers.dev offers support plans: a private channel to the maintainer and a first reply within a stated number of business days.",
  toc: [
    { id: "plans", label: "Plans" },
    { id: "promises", label: "What a plan promises" },
    { id: "covered", label: "What support covers" },
    { id: "buy", label: "How to buy" },
    { id: "faq", label: "Questions" },
  ],
};
