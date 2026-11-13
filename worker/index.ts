// The Cloudflare Worker. It answers the API (/api/v1/*) and the entry pages (/entries/*); everything else is a
// static asset (see wrangler.jsonc). The index and the metadata are bundled at build time; full entries are read
// from the static snapshot.
import { handleApi } from "../src/core/api.ts";
import type { Index } from "../src/core/entries.ts";
import { handleEntryPage, isEntryPage } from "../src/core/pages.ts";
import type { Meta } from "../src/core/schema.ts";
import index from "./generated/index.json";
import meta from "./generated/meta.json";

interface Env {
  ASSETS: { fetch(request: Request | string): Promise<Response> };
}

const SITE = "https://providers.dev";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const deps = {
      index: index as unknown as Index,
      meta: meta as unknown as Meta,
      async asset(path: string) {
        const response = await env.ASSETS.fetch(new Request(new URL(path, url.origin)));
        return response.ok ? response : null;
      },
    };
    if (url.pathname.startsWith("/api/v1/")) return handleApi(request, deps);
    if (isEntryPage(url.pathname)) return handleEntryPage(request, { ...deps, site: SITE, now: () => new Date() });
    return env.ASSETS.fetch(request);
  },
};
