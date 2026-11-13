import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { publish } from "../scripts/lib/publish.ts";
import { sync } from "../scripts/lib/sync.ts";
import { handleApi, type ApiDeps } from "../src/core/api.ts";
import { summarize, type Summary } from "../src/core/entries.ts";
import { openapi } from "../src/core/openapi.ts";
import { PARAMS, parseQuery, runQuery } from "../src/core/query.ts";
import type { Catalog } from "../src/core/schema.ts";
import { depsFrom, fetchReturning, fixtureUpstream, ROOT, tempDataDir, writeAuthored } from "./helpers.ts";

let deps: ApiDeps;
let published: string;

beforeAll(async () => {
  const dataDir = tempDataDir();
  await sync({ dataDir, fetch: fetchReturning(JSON.stringify(fixtureUpstream())) });
  writeAuthored(dataDir);
  const report = publish({ dataDir, rootDir: ROOT });
  expect(report.errors).toEqual([]);
  published = join(dataDir, "published");
  deps = depsFrom(published);
});

const get = (path: string, init?: RequestInit): Promise<Response> => handleApi(new Request(`https://providers.dev${path}`, init), deps);
const json = async <T = Record<string, unknown>>(path: string): Promise<T> => (await get(path)).json() as Promise<T>;

interface Page {
  total: number;
  limit: number;
  offset: number;
  next_offset: number | null;
  data: Summary[];
}

describe("GET /api/v1/models", () => {
  it("pages through every entry once, in a fixed order", async () => {
    const seen: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page: Page = await json<Page>(`/api/v1/models?limit=200&offset=${offset}`);
      expect(page.total).toBe(601);
      seen.push(...page.data.map((entry) => entry.ref));
      offset = page.next_offset;
    }
    expect(seen).toHaveLength(601);
    expect(new Set(seen).size).toBe(601);
    expect(seen).toEqual([...seen].sort((a, b) => (a < b ? -1 : 1)));
    const again = await json<Page>("/api/v1/models?limit=200");
    expect(again.data.map((entry) => entry.ref)).toEqual(seen.slice(0, 200));
  });

  it("defaults to 50 and refuses more than 200", async () => {
    expect((await json<Page>("/api/v1/models")).data).toHaveLength(50);
    expect((await get("/api/v1/models?limit=201")).status).toBe(400);
    expect((await get("/api/v1/models?limit=0")).status).toBe(400);
  });

  it("keeps only the models released in the last N months", async () => {
    const { monthsBefore } = await import("../src/core/query.ts");
    expect(monthsBefore("2026-11-13", 6)).toBe("2026-05-13");
    expect(monthsBefore("2026-01-13", 3)).toBe("2025-10-13");
    expect(monthsBefore("2026-05-31", 3)).toBe("2026-02-28");
    expect(monthsBefore("2026-11-13", 24)).toBe("2024-11-13");

    const entry = (ref: string, release_date?: string) => ({ ref, provider: "p", model: ref, release_date }) as unknown as Summary;
    const entries = [entry("old", "2026-05-12"), entry("edge", "2026-05-13"), entry("new", "2026-10-01"), entry("month", "2026-05"), entry("old-month", "2026-04"), entry("undated")];
    const run = (months: string) => {
      const parsed = parseQuery(new URLSearchParams(`max_age_months=${months}`));
      if (!parsed.ok) throw new Error("not a valid query");
      return runQuery(entries, parsed.query, "2026-11-13").data.map((item) => item.ref);
    };
    // Six months back from 13 November is 13 May. A date known only to the month counts when the month is in range. No date, no match.
    expect(run("6")).toEqual(["edge", "month", "new"]);
    expect(run("1")).toEqual([]);
    expect(run("600")).toEqual(["edge", "month", "new", "old", "old-month"]);

    expect((await get("/api/v1/models?max_age_months=0")).status).toBe(400);
    expect((await get("/api/v1/models?max_age_months=601")).status).toBe(400);
    // Every entry of the fixture has a date except the added one, which takes its date from the entry it names.
    const all = await get("/api/v1/models?max_age_months=600&limit=1");
    expect(((await all.json()) as Page).total).toBe(601);
    // The answer depends on the day, so the day is in its ETag; without the filter it is the dataset version alone.
    const today = new Date().toISOString().slice(0, 10);
    expect(all.headers.get("ETag")).toMatch(new RegExp(`^"[0-9a-f]+-${today}"$`));
    expect((await get("/api/v1/models?limit=1")).headers.get("ETag")).toMatch(/^"[0-9a-f]+"$/);
    expect((await get("/api/v1/models?max_age_months=600&limit=1", { headers: { "If-None-Match": all.headers.get("ETag") ?? "" } })).status).toBe(304);
  });

  it("filters by provider, access, origin and type", async () => {
    const byProvider = await json<Page>("/api/v1/models?provider=provider-03,provider-04&limit=200");
    expect(byProvider.total).toBe(40);
    expect(new Set(byProvider.data.map((entry) => entry.provider))).toEqual(new Set(["provider-03", "provider-04"]));
    const subscription = await json<Page>("/api/v1/models?access=subscription");
    expect(subscription.data.map((entry) => entry.ref)).toEqual(["added-login/lab/model-2"]);
    expect((await json<Page>("/api/v1/models?origin=added")).total).toBe(1);
    expect((await json<Page>("/api/v1/models?origin=modified")).data.map((entry) => entry.ref)).toEqual(["provider-01/model-1"]);
    expect((await json<Page>("/api/v1/models?type=embedding")).total).toBe(30);
  });

  it("treats min_context and min_output as lower bounds and leaves out unknown values", async () => {
    const context = await json<Page>("/api/v1/models?min_context=1900000&limit=200");
    expect(context.data.every((entry) => (entry.context ?? 0) >= 1900000)).toBe(true);
    // 30 x model-18 and model-19 (1.9M and 2M), plus the overridden provider-01/model-1 (5M).
    expect(context.total).toBe(61);
    const zero = await json<Page>("/api/v1/models?min_context=0&limit=1");
    // model-7 has no limit at all: unknown is not zero.
    expect(zero.total).toBe(601 - 30);
    const output = await json<Page>("/api/v1/models?min_output=0&provider=provider-00&limit=200");
    expect(output.data.some((entry) => entry.max_output === 0)).toBe(true);
    expect(output.total).toBe(19);
  });

  it("tells unsupported caching from unknown caching", async () => {
    const page = (cache: string) => json<Page>(`/api/v1/models?provider=provider-00&cache=${cache}`);
    expect((await page("yes")).total).toBe(10);
    expect((await page("no")).total).toBe(5);
    expect((await page("unknown")).total).toBe(5);
    const explicit = await json<Page>("/api/v1/models?provider=provider-00&cache_mode=explicit");
    expect(explicit.total).toBe(5);
    expect(explicit.data[0]?.cache_ttl_s).toEqual([300, 3600]);
  });

  it("searches across ids and names, every word required", async () => {
    expect((await json<Page>("/api/v1/models?q=provider-05%20model-18")).data.map((entry) => entry.ref)).toEqual(["provider-05/lab/model-18"]);
    expect((await json<Page>("/api/v1/models?q=nothing-like-this")).total).toBe(0);
    expect((await json<Page>("/api/v1/models?canonical_id=lab/model-3")).total).toBe(30);
  });

  it("sorts numbers numerically, with unknown last in both directions", async () => {
    const descending = await json<Page>("/api/v1/models?provider=provider-00&sort=context&order=desc&limit=200");
    const values = descending.data.map((entry) => entry.context);
    expect(values[0]).toBe(2000000);
    expect(values.at(-1)).toBeUndefined();
    const ascending = await json<Page>("/api/v1/models?provider=provider-00&sort=context&order=asc&limit=200");
    expect(ascending.data[0]?.context).toBe(100000);
    expect(ascending.data.at(-1)?.context).toBeUndefined();
  });

  it("rejects unknown and malformed parameters with details", async () => {
    const response = await get("/api/v1/models?acess=api&min_context=big&cache=maybe&provider=a&provider=b");
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; details: { param: string }[] } };
    expect(body.error.code).toBe("invalid_parameters");
    expect(body.error.details.map((detail) => detail.param).sort()).toEqual(["acess", "cache", "min_context", "provider"]);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("lookups", () => {
  it("finds an entry whose model id has a slash, by ref or by provider and model", async () => {
    const byRef = await json<{ data: { model: { id: string }; summary: Summary } }>(`/api/v1/entry?ref=${encodeURIComponent("provider-02/lab/model-4")}`);
    expect(byRef.data.model.id).toBe("lab/model-4");
    expect(byRef.data.summary.ref).toBe("provider-02/lab/model-4");
    const byParts = await json<{ data: { model: { id: string } } }>("/api/v1/entry?provider=provider-02&model=lab%2Fmodel-4");
    expect(byParts.data.model).toEqual(byRef.data.model);
  });

  it("answers 404 and 400 with one error shape", async () => {
    for (const [path, status, code] of [
      ["/api/v1/entry?ref=provider-02/nope", 404, "entry_not_found"],
      ["/api/v1/entry", 400, "invalid_parameters"],
      ["/api/v1/entry?ref=a/b&provider=a", 400, "invalid_parameters"],
      ["/api/v1/providers/nope", 404, "provider_not_found"],
      ["/api/v1/nope", 404, "not_found"],
      ["/api/v1/meta?x=1", 400, "invalid_parameters"],
    ] as const) {
      const response = await get(path);
      expect(response.status, path).toBe(status);
      const body = (await response.json()) as { error: { code: string; message: string } };
      expect(body.error.code, path).toBe(code);
      expect(body.error.message.length).toBeGreaterThan(10);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    }
  });

  it("serves the provider, the directory, the catalog and the metadata", async () => {
    const provider = await json<{ data: { id: string; models: Record<string, unknown> } }>("/api/v1/providers/provider-01");
    expect(provider.data.id).toBe("provider-01");
    expect(Object.keys(provider.data.models)).toHaveLength(20);
    const directory = await json<{ data: { id: string; models: number }[] }>("/api/v1/providers");
    expect(directory.data).toHaveLength(31);
    const catalog = await json<{ meta: { dataset_version: string }; providers: Catalog }>("/api/v1/catalog");
    expect(Object.keys(catalog.providers)).toHaveLength(31);
    const meta = await json<{ dataset_version: string; counts: { models: number }; upstream: { commit: string } }>("/api/v1/meta");
    expect(meta.dataset_version).toBe(catalog.meta.dataset_version);
    expect(meta.counts.models).toBe(601);
    expect(meta.upstream.commit).toBe("abc123");
  });
});

describe("HTTP behaviour", () => {
  it("answers 304 to a matching If-None-Match and sends freshness headers", async () => {
    const first = await get("/api/v1/models");
    const etag = first.headers.get("ETag")!;
    expect(etag).toBe(`"${deps.meta.dataset_version}"`);
    expect(first.headers.get("X-Dataset-Version")).toBe(deps.meta.dataset_version);
    expect(first.headers.get("Cache-Control")).toContain("max-age=300");
    for (const path of ["/api/v1/models", "/api/v1/catalog", "/api/v1/entry?ref=provider-02/lab/model-4"]) {
      const second = await get(path, { headers: { "If-None-Match": `W/${etag}, "other"` } });
      expect(second.status, path).toBe(304);
      expect(await second.text()).toBe("");
    }
    expect((await get("/api/v1/models", { headers: { "If-None-Match": '"stale"' } })).status).toBe(200);
  });

  it("is read-only and open to any origin", async () => {
    const post = await get("/api/v1/models", { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
    const preflight = await get("/api/v1/models", { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const head = await get("/api/v1/meta", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("describes every endpoint and parameter in the OpenAPI document", async () => {
    const document = await json<{ paths: Record<string, { get: { parameters?: { name: string }[] } }> }>("/api/v1/openapi.json");
    expect(document).toEqual(JSON.parse(JSON.stringify(openapi())));
    expect(Object.keys(document.paths).sort()).toEqual(
      ["/api.json", "/api/v1/catalog", "/api/v1/entry", "/api/v1/meta", "/api/v1/models", "/api/v1/openapi.json", "/api/v1/providers", "/api/v1/providers/{providerId}"].sort(),
    );
    expect(document.paths["/api/v1/models"]!.get.parameters!.map((parameter) => parameter.name)).toEqual(PARAMS.map((param) => param.name));
    for (const path of Object.keys(document.paths).filter((item) => item.startsWith("/api/v1/") && !item.includes("{"))) {
      const response = await get(path === "/api/v1/entry" ? `${path}?ref=provider-02/model-1` : path);
      expect(response.status, path).toBe(200);
    }
  });
});

describe("one dataset for the website and the API", () => {
  const check = (dir: string): void => {
    const local = depsFrom(dir);
    const exported = JSON.parse(readFileSync(join(dir, "site", "api.json"), "utf8")) as Catalog;
    const browserIndex = JSON.parse(readFileSync(join(dir, "site", "data", "index.json"), "utf8"));
    // The index the website downloads is the index the Worker answers from.
    expect(browserIndex).toEqual(local.index);
    // Every summary is exactly what the compatibility export says about that entry.
    const refs = new Set<string>();
    for (const entry of local.index.entries) {
      refs.add(entry.ref);
      const model = exported[entry.provider]!.models[entry.model]!;
      expect(summarize(entry.provider, model, entry.shard)).toEqual(entry);
    }
    const total = Object.values(exported).reduce((sum, provider) => sum + Object.keys(provider.models).length, 0);
    expect(refs.size).toBe(total);
  };

  it("holds for the fixture", async () => {
    check(published);
    // What the website computes in the browser is what the API returns for the same URL parameters.
    const params = new URLSearchParams("min_context=500000&cache=yes&sort=context&order=desc&limit=7&offset=3");
    const parsed = parseQuery(params, false);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const browser = runQuery(deps.index.entries, parsed.query);
    const api = await json<Page>(`/api/v1/models?${params}`);
    expect(api.data).toEqual(browser.data);
    expect(api.total).toBe(browser.total);
    // The full entry from the API is the entry in the export.
    const exported = JSON.parse(readFileSync(join(published, "site", "api.json"), "utf8")) as Catalog;
    const entry = await json<{ data: { model: unknown } }>("/api/v1/entry?ref=provider-01/model-1");
    expect(entry.data.model).toEqual(exported["provider-01"]!.models["model-1"]);
    expect((entry.data.model as { limit: { context: number } }).limit.context).toBe(5000000);
  });

  const real = join(ROOT, "data", "published");
  it.skipIf(!existsSync(join(real, "site", "api.json")))("holds for the real published snapshot", () => {
    check(real);
  });
});
