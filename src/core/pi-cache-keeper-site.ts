// pi-cache-keeper's own site, pi-cache-keeper.providers.dev, served by the same Worker from the same build. One static
// page: Astro builds it under dist/pi-cache-keeper/, and on the subdomain the Worker serves that folder as the site's
// root (src/core/product-site.ts). Nothing here reads the dataset.
import { movedFromBuild, productSite } from "./product-site.ts";

/** The subdomain's pages, by address. */
export const PI_CACHE_KEEPER_PAGES = ["/"] as const;

export const PI_CACHE_KEEPER = productSite("https://pi-cache-keeper.providers.dev", "/pi-cache-keeper", PI_CACHE_KEEPER_PAGES);
export const PI_CACHE_KEEPER_SITE = PI_CACHE_KEEPER.site;

/**
 * On providers.dev (and any host other than the subdomain): anything under /pi-cache-keeper/ is the subdomain's build
 * and is only served there, so it goes to the same path on the subdomain; null for any other address.
 */
export function movedToPiCacheKeeper(url: URL): string | null {
  return movedFromBuild(PI_CACHE_KEEPER, url);
}
