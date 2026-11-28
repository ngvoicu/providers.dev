// The products' own sites on subdomains of providers.dev (provimux.providers.dev, pi-cache-keeper.providers.dev),
// served by the same Worker from the same build. Each is static: Astro builds its pages under dist/<folder>/, and on
// its subdomain the Worker serves that folder as the site's root and nothing else. Nothing here reads the dataset.

export interface ProductSite {
  /** The site's address, such as https://provimux.providers.dev. */
  readonly site: string;
  readonly host: string;
  /** Where its files are in the static assets, such as /provimux. */
  readonly assets: string;
  /** Its page for an address it does not have, served with status 404. */
  readonly notFound: string;
  /** Its pages, by address. */
  readonly pages: readonly string[];
  /**
   * Pages whose addresses the build's data gives (a page per run of a benchmark), by the shape of the address. Left
   * out for a site whose pages are all listed. An address of such a shape with no page in the build is a missing one.
   */
  readonly families?: readonly RegExp[];
}

export function productSite(site: string, assets: string, pages: readonly string[], families?: readonly RegExp[]): ProductSite {
  return { site, host: new URL(site).hostname, assets, notFound: `${assets}/not-found/`, pages, ...(families ? { families } : {}) };
}

/** Whether a path is the address of a page of the site: one it lists, or one of a shape its data gives. */
export function isSitePage(site: ProductSite, path: string): boolean {
  return site.pages.includes(path) || (site.families?.some((family) => family.test(path)) ?? false);
}

/**
 * On the subdomain: what to answer for a path. `asset` is the static file to serve (with `status`), `redirect` a path
 * on the subdomain to send the request to. The stylesheets and fonts Astro emits (/_astro/) are shared with
 * providers.dev; every other file is the site's own, under its `assets` folder.
 */
export type SiteRoute = { asset: string; status: 200 | 404 } | { redirect: string };

export function siteRoute(site: ProductSite, path: string): SiteRoute {
  if (isSitePage(site, path)) return { asset: `${site.assets}${path}`, status: 200 };
  if (isSitePage(site, `${path}/`)) return { redirect: `${path}/` };
  if (path.startsWith("/_astro/")) return { asset: path, status: 200 };
  // A file of the site: an image, an icon, robots.txt, the sitemap. Never a folder, never a page of the build itself.
  if (/^\/[\w.-]+(\/[\w.-]+)*\.[a-z0-9]+$/i.test(path) && !path.includes("..") && !/\.html$/i.test(path)) return { asset: `${site.assets}${path}`, status: 200 };
  return { asset: site.notFound, status: 404 };
}

/** The address of `path` and `search` on the site. Both are set on its address, never resolved against it. */
export function onSite(site: ProductSite, path: string, search: string): string {
  const location = new URL(site.site);
  location.pathname = path;
  location.search = search;
  return location.toString();
}

/**
 * On providers.dev (and any host other than the subdomain): anything under the site's build folder is the
 * subdomain's and only served there, so it goes to the same path on the subdomain. Null for any other address.
 */
export function movedFromBuild(site: ProductSite, url: URL): string | null {
  const path = url.pathname;
  if (path !== site.assets && !path.startsWith(`${site.assets}/`)) return null;
  return onSite(site, path.slice(site.assets.length) || "/", url.search);
}
