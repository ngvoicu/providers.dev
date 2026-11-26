// How long a browser or any other cache may keep what the Worker answers. Nothing here is a cache of the Worker's
// own: Cloudflare does not cache a Worker's answers on these custom domains, and the Worker keeps none.

/**
 * Everything made from the publication (pages, their markdown, the API, the sitemaps, llms.txt): five minutes, then
 * served while it is checked again for up to an hour. A new import is seen as soon as that check answers.
 */
export const PUBLICATION_CACHE = "public, max-age=300, stale-while-revalidate=3600";

/** A file whose name carries a hash of its content: it never changes under that name. */
export const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

/**
 * A file Astro writes into /_astro/: its stylesheets, scripts and fonts, named `{name}.{hash}.{ext}` with the
 * 8-character hash of the content Vite gives every file it emits. Nothing else is written there (public/ has no
 * _astro folder). The same files on all three hosts.
 */
const HASHED_ASSET = /^\/_astro\/[\w.-]+\.[\w-]{8}\.[a-z0-9]+$/i;

export function isHashedAsset(path: string): boolean {
  return HASHED_ASSET.test(path) && !path.includes("..");
}

/**
 * The static file's answer with the year-long, immutable lifetime where its name is a hash of its content and the
 * answer is that content (200) or confirms it (304). Anything else (a 404, a redirect, any other file, an icon or a
 * picture, which differ per host and keep their names) is passed through as the asset layer made it.
 */
export function withAssetCache(path: string, response: Response): Response {
  if (!isHashedAsset(path) || (response.status !== 200 && response.status !== 304)) return response;
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", IMMUTABLE_CACHE);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
