// Team vs Solo's own site, teamvssolo.providers.dev, served by the same Worker from the same build. Its pages are
// static: Astro builds them under dist/teamvssolo/ from the results file (data/teamvssolo/results.json), and on the
// subdomain the Worker serves that folder as the site's root (src/core/product-site.ts). Nothing here reads the
// dataset of providers.dev, and the Worker never reads the results file.
import { movedFromBuild, productSite } from "./product-site.ts";

/** The pages every build has, by address. */
export const TEAMVSSOLO_PAGES = ["/", "/results/", "/tests/", "/method/"] as const;

/**
 * The pages the results file gives, by the shape of their address: a test's results (/results/tally/) and a run
 * (/runs/tally/full/solo-fable-high/solo/1/, the run's id with the "+" of a team's setup written "--"). An address of
 * these shapes that the build has no page for gets the site's own page for a missing address.
 */
export const TEAMVSSOLO_PAGE_FAMILIES = [
  /^\/results\/[a-z0-9][a-z0-9._-]*\/$/,
  /^\/runs\/[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*\/(solo|delegation|active)\/[1-9][0-9]*\/$/,
] as const;

export const TEAMVSSOLO = productSite("https://teamvssolo.providers.dev", "/teamvssolo", TEAMVSSOLO_PAGES, TEAMVSSOLO_PAGE_FAMILIES);
export const TEAMVSSOLO_SITE = TEAMVSSOLO.site;

/**
 * On providers.dev (and any host other than the subdomain): anything under /teamvssolo/ is the subdomain's build and
 * is only served there, so it goes to the same path on the subdomain; null for any other address.
 */
export function movedToTeamVsSolo(url: URL): string | null {
  return movedFromBuild(TEAMVSSOLO, url);
}
