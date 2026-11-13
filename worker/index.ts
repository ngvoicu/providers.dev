// The Cloudflare Worker. It runs only for /api/v1/* (see wrangler.jsonc); everything else is a static asset.
// The index and the metadata are bundled at build time; full entries are read from the static snapshot.
import { handleApi } from "../src/core/api.ts";
import type { Index } from "../src/core/entries.ts";
import type { Meta } from "../src/core/schema.ts";
import index from "./generated/index.json";
import meta from "./generated/meta.json";

interface Env {
  ASSETS: { fetch(request: Request | string): Promise<Response> };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/v1/")) return env.ASSETS.fetch(request);
    return handleApi(request, {
      index: index as unknown as Index,
      meta: meta as unknown as Meta,
      async asset(path) {
        const response = await env.ASSETS.fetch(new Request(new URL(path, url.origin)));
        return response.ok ? response : null;
      },
    });
  },
};
