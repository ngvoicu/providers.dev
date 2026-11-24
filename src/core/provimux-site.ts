// Provimux's own site, provimux.providers.dev, served by the same Worker from the same build. Its pages are static:
// Astro builds them under dist/provimux/, and on the subdomain the Worker serves that folder as the site's root
// (src/core/product-site.ts). Nothing here reads the dataset.
import { movedFromBuild, onSite, productSite, siteRoute, type SiteRoute } from "./product-site.ts";

/** The subdomain's pages, by address. */
export const PROVIMUX_PAGES = ["/", "/support/"] as const;

export const PROVIMUX = productSite("https://provimux.providers.dev", "/provimux", PROVIMUX_PAGES);
export const PROVIMUX_SITE = PROVIMUX.site;
export const PROVIMUX_HOST = PROVIMUX.host;
/** Where the subdomain's files are in the static assets. */
export const PROVIMUX_ASSETS = PROVIMUX.assets;
/** Its page for an address it does not have, served with status 404. */
export const PROVIMUX_NOT_FOUND = PROVIMUX.notFound;

/**
 * On providers.dev (and any host other than the subdomain): where an address that moved to provimux.providers.dev
 * now is, or null. The support page moved with its old address /docs/support/; anything under /provimux/ is the
 * subdomain's build and is only served there. Path and query are set on PROVIMUX_SITE, never resolved against it.
 */
export function movedToProvimux(url: URL): string | null {
  if (/^\/(docs\/)?support\/?$/.test(url.pathname)) return onSite(PROVIMUX, "/support/", url.search);
  return movedFromBuild(PROVIMUX, url);
}

/** On the subdomain: what to answer for a path (src/core/product-site.ts). */
export type ProvimuxRoute = SiteRoute;

export function provimuxRoute(path: string): ProvimuxRoute {
  return siteRoute(PROVIMUX, path);
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
