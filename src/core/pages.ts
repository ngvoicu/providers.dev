// Entry pages, rendered on request from the same objects the API returns. An entry page is
// GET /entries/{provider}/{model}: its own address, title and description, and no script needed to read it.
// The page around the entry (header, footer, styles) is a file built ahead of time, with marks where the entry goes.
import { etagMatches, loadEntry, refFromPath, type ApiDeps } from "./api.ts";
import { entryHref, escapeHtml } from "./format.ts";
import type { JsonObject } from "./merge.ts";
import { entryHtml } from "./render.ts";

export const ENTRY_SHELL = "/entry/";
/** The marks in the shell. They are replaced everywhere they appear. */
export const MARK = { title: "%%ENTRY_TITLE%%", description: "%%ENTRY_DESCRIPTION%%", canonical: "%%ENTRY_CANONICAL%%", html: "%%ENTRY_HTML%%" } as const;

const fill = (shell: string, values: Record<keyof typeof MARK, string>): string =>
  (Object.keys(MARK) as (keyof typeof MARK)[]).reduce((page, key) => page.split(MARK[key]).join(values[key]), shell);

const htmlHeaders = (extra: Record<string, string> = {}): Headers =>
  new Headers({ "Content-Type": "text/html; charset=utf-8", "X-Content-Type-Options": "nosniff", ...extra });

export interface PageDeps extends ApiDeps {
  /** The address the site is published at, for canonical links. */
  site: string;
  now(): Date;
}

/** True for the paths this file answers. */
export function isEntryPage(pathname: string): boolean {
  return pathname.startsWith("/entries/") || pathname === "/entry" || pathname === "/entry/";
}

export async function handleEntryPage(request: Request, deps: PageDeps): Promise<Response> {
  const url = new URL(request.url);
  const notFound = async (): Promise<Response> => {
    const page = await deps.asset("/404.html");
    return new Response(page ? await page.text() : "Not found", { status: 404, headers: htmlHeaders({ "Cache-Control": "no-store" }) });
  };
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });

  // The address entries had before they got pages of their own.
  if (!url.pathname.startsWith("/entries/")) {
    const old = url.searchParams.get("ref");
    return old && old.includes("/") ? Response.redirect(new URL(entryHref(old), url.origin).toString(), 301) : notFound();
  }

  const ref = refFromPath(url.pathname.slice("/entries/".length).replace(/\/+$/, ""));
  const summary = ref ? deps.index.entries.find((entry) => entry.ref === ref) : undefined;
  const provider = summary ? deps.index.providers.find((item) => item.id === summary.provider) : undefined;
  if (!summary || !provider) return notFound();

  // A date turns stale with time, so the day is part of what the page is.
  const now = deps.now();
  const etag = `"${deps.meta.dataset_version}-${now.toISOString().slice(0, 10)}"`;
  const headers = htmlHeaders({ ETag: etag, "Cache-Control": "public, max-age=300, stale-while-revalidate=3600", "X-Dataset-Version": deps.meta.dataset_version });
  if (etagMatches(request, etag)) return new Response(null, { status: 304, headers });

  const [shell, entry] = await Promise.all([deps.asset(ENTRY_SHELL), loadEntry(deps, summary)]);
  if (!shell || !entry) return new Response("The published snapshot is incomplete. Try again after the next publication.", { status: 503, headers: htmlHeaders({ "Cache-Control": "no-store" }) });

  const limit = (value: number | undefined, word: string): string => (value === undefined ? "" : `${word} ${value.toLocaleString("en-US")} tokens`);
  const facts = [limit(summary.context, "context window"), limit(summary.max_output, "maximum output")].filter(Boolean);
  const page = fill(await shell.text(), {
    title: escapeHtml(`${summary.name} at ${provider.name}`),
    description: escapeHtml(
      `${summary.name} at ${provider.name} (${summary.ref})${facts.length > 0 ? `: ${facts.join(", ")}` : ""}. Limits, prices and prompt caching as documented and as evaluated, with sources.`,
    ),
    canonical: escapeHtml(new URL(entryHref(summary.ref), deps.site).toString()),
    html: entryHtml({ summary, provider, model: entry as JsonObject, now, imported: deps.meta.upstream.fetched_at.slice(0, 10) }),
  });
  return new Response(request.method === "HEAD" ? null : page, { status: 200, headers });
}
