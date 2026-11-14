// Static assets contain templates and versioned data. Pages consume the public API response contract.
import { apiHeaders, handleApi } from "../src/core/api.ts";
import { handlePage, isPage, PAGE_SHELL } from "../src/core/pages.ts";
import { readSnapshot, type AssetBinding } from "../src/core/snapshot.ts";

interface Env { ASSETS: AssetBinding }
const SITE = "https://providers.dev";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const api = url.pathname.startsWith("/api/v1/") || url.pathname === "/api.json" || url.pathname === "/data/catalog.json";
    const data = url.pathname.startsWith("/data/");
    const page = isPage(url.pathname);
    // Implementation assets are internal. CSS, scripts, icons and other public files remain static.
    if (url.pathname.startsWith("/site-shell") || url.pathname.startsWith("/reference-content") || url.pathname.startsWith("/snapshots/") || url.pathname === "/current.json") return new Response("Not found", { status: 404 });
    if (!api && !data && !page && /\.[a-z0-9]+$/i.test(url.pathname)) return env.ASSETS.fetch(request);
    try {
      const snapshot = await readSnapshot(env.ASSETS, url.origin);
      if (api) return handleApi(request, snapshot);
      if (data) {
        if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
        const asset = await snapshot.asset(url.pathname);
        if (!asset) return new Response("Not found", { status: 404 });
        return new Response(request.method === "HEAD" ? null : asset.body, { headers: apiHeaders(snapshot.meta, { "Content-Type": asset.headers.get("Content-Type") ?? "application/json" }) });
      }
      return handlePage(request, {
        api: (path) => handleApi(new Request(new URL(path, url.origin)), snapshot),
        shell: () => snapshot.asset(PAGE_SHELL), site: SITE, now: () => new Date(),
      });
    } catch {
      const headers = { "Cache-Control": "no-store", "Content-Type": api ? "application/json" : "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" };
      return new Response(request.method === "HEAD" ? null : api ? JSON.stringify({ error: { code: "snapshot_incomplete", message: "The published snapshot is unavailable. Try again shortly." } }) : "The published snapshot is unavailable. Try again shortly.", { status: 503, headers });
    }
  },
};
