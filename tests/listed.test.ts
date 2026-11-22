// groundtruth's discovery file, listed.json (Provimux's model-lists.md, sections 4.3 and 10, D3): fetched by the sync
// beside observed.json, checked, kept as it came; read by the build into the listings.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { publish } from "../scripts/lib/publish.ts";
import { LISTED_URL, OBSERVED_URL, sync } from "../scripts/lib/sync.ts";
import { ListingSchema } from "../src/core/contract.ts";
import type { Listing } from "../src/core/listings.ts";
import { ListedFile, MeasurementLabels, type Meta } from "../src/core/schema.ts";
import { parse } from "yaml";
import { fixtureUpstream, ROOT, tempDataDir, writeAuthored } from "./helpers.ts";

const UPSTREAM = JSON.stringify(fixtureUpstream());

/** The discovery file of the fixture: provider-02 read by Provimux, with one model the catalog has and one it lacks. */
function listedFile(more: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 1,
    repository: "https://github.com/ngvoicu/groundtruth",
    providers: {
      "provider-02": {
        date: "2026-11-22",
        client: "provimux",
        models: [
          { id: "gemini-4-neon", name: "Gemini 4 Neon", context_window: 1048576, max_output: 65536, input_modalities: ["text", "image"], reasoning: { levels: ["low", "medium", "high"] }, variants: ["gemini-4-neon-low", "gemini-4-neon-medium", "gemini-4-neon-high"] },
          { id: "model-1", plans: ["plus", "pro"], hidden: false },
        ],
      },
    },
    ...more,
  };
}

/**
 * A fetch that answers models.dev with the fixture, the measurements with 404 (that part fails, and with it `ok`, as
 * everywhere in the fixture), and the discovery file with `listed`.
 */
function answering(listed: () => Response, seen: { headers?: Record<string, string> } = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === LISTED_URL) {
      seen.headers = { ...((init?.headers as Record<string, string> | undefined) ?? {}) };
      return listed();
    }
    if (url === OBSERVED_URL) return new Response("not found", { status: 404 });
    if (url.includes("api.github.com")) return new Response("{}");
    if (url.startsWith("https://models.dev/")) return new Response(UPSTREAM, { headers: { etag: '"u1"' } });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}
const json = (body: unknown, etag = '"l1"') => () => new Response(typeof body === "string" ? body : JSON.stringify(body), { headers: { etag } });
const at = (day: number) => () => new Date(`2026-11-${day}T04:17:00Z`);
const statusOf = (dataDir: string) => JSON.parse(readFileSync(join(dataDir, "sync-status.json"), "utf8")) as Record<string, unknown>;
const stored = (dataDir: string) => join(dataDir, "sources", "listed.json");

describe("the sync of listed.json", () => {
  it("asks groundtruth's repository root, beside observed.json", () => {
    expect(LISTED_URL).toBe("https://raw.githubusercontent.com/ngvoicu/groundtruth/main/listed.json");
    expect(LISTED_URL.replace("listed.json", "observed.json")).toBe(OBSERVED_URL);
  });

  it("a missing file changes nothing: no file is written, the run is ok, the record says absent", async () => {
    const dataDir = tempDataDir();
    const report = await sync({ dataDir, fetch: answering(() => new Response("404: Not Found", { status: 404 })), now: at(22) });
    // The discovery part never fails the run: `ok` speaks of models.dev and the measurements only.
    expect(statusOf(dataDir).last_error).toBe("the measurements file answered HTTP 404");
    expect(report.listed.status).toBe("unchanged");
    expect(existsSync(stored(dataDir))).toBe(false);
    expect(existsSync(join(dataDir, "sources", "listed.meta.json"))).toBe(false);
    expect(statusOf(dataDir).listed).toEqual({ last_attempt_at: "2026-11-22T04:17:00.000Z", status: "absent" });
  });

  it("a good file is kept as it came, with its meta; the next run sends its ETag and a 304 changes nothing but checked_at", async () => {
    const dataDir = tempDataDir();
    const body = JSON.stringify(listedFile());
    const first = await sync({ dataDir, fetch: answering(json(body)), now: at(22) });
    expect(first.listed).toEqual({ status: "updated", summary: ["1 providers, 2 models"] });
    expect(readFileSync(stored(dataDir), "utf8")).toBe(`${body}\n`);
    expect(JSON.parse(readFileSync(join(dataDir, "sources", "listed.meta.json"), "utf8"))).toMatchObject({ source: LISTED_URL, fetched_at: "2026-11-22T04:17:00.000Z", etag: '"l1"' });
    const seen: { headers?: Record<string, string> } = {};
    const second = await sync({ dataDir, fetch: answering(() => new Response(null, { status: 304 }), seen), now: at(23) });
    expect(seen.headers?.["If-None-Match"]).toBe('"l1"');
    expect(second.listed.status).toBe("unchanged");
    expect(readFileSync(stored(dataDir), "utf8")).toBe(`${body}\n`);
    expect(JSON.parse(readFileSync(join(dataDir, "sources", "listed.meta.json"), "utf8"))).toMatchObject({ fetched_at: "2026-11-22T04:17:00.000Z", checked_at: "2026-11-23T04:17:00.000Z" });
    // A file that went missing later is still "no discovery": the last copy stays.
    await sync({ dataDir, fetch: answering(() => new Response("gone", { status: 404 })), now: at(24) });
    expect(readFileSync(stored(dataDir), "utf8")).toBe(`${body}\n`);
  });

  it.each<[string, () => Response, RegExp]>([
    ["not JSON", json("<html>"), /^the discovery file is not JSON$/],
    ["an account in a model", json(listedFile({ providers: { "provider-02": { date: "2026-11-22", client: "provimux", models: [{ id: "m", email: "ada@example.com" }] } } })), /does not match the expected structure .*email/],
    ["an auth file name beside a provider", json(listedFile({ providers: { "provider-02": { date: "2026-11-22", client: "provimux", auth_file: "devin-ada.json", models: [{ id: "m" }] } } })), /does not match the expected structure .*auth_file/],
    ["a count of logins at the top", json({ ...listedFile(), logins: 2 }), /does not match the expected structure .*logins/],
    ["a provider with no model", json(listedFile({ providers: { "provider-02": { date: "2026-11-22", client: "provimux", models: [] } } })), /does not match the expected structure/],
    ["a model twice", json(listedFile({ providers: { "provider-02": { date: "2026-11-22", client: "provimux", models: [{ id: "m" }, { id: "m" }] } } })), /listed twice/],
    ["schema 2", json({ ...listedFile(), schema: 2 }), /does not match the expected structure/],
    ["HTTP 500", () => new Response("down", { status: 500 }), /^the discovery file answered HTTP 500$/],
  ])("a malformed file (%s) keeps the last good copy, fails only its part, and is recorded", async (_name, answer, words) => {
    const dataDir = tempDataDir();
    await sync({ dataDir, fetch: answering(json(listedFile())), now: at(22) });
    const before = readFileSync(stored(dataDir), "utf8");
    const report = await sync({ dataDir, fetch: answering(answer), now: at(23) });
    expect(report.upstream.status).not.toBe("failed");
    expect(report.listed.status).toBe("failed");
    expect(report.listed.error).toMatch(words);
    expect(readFileSync(stored(dataDir), "utf8")).toBe(before);
    expect(statusOf(dataDir).listed).toEqual({ last_attempt_at: "2026-11-23T04:17:00.000Z", status: "failed", error: report.listed.error });
    // The five fields of models.dev and the measurements say nothing of it.
    expect(statusOf(dataDir).last_error).toBe("the measurements file answered HTTP 404");
  });

  it("--only=pi leaves the discovery file and its record as they were", async () => {
    const dataDir = tempDataDir();
    await sync({ dataDir, fetch: answering(json(listedFile())), now: at(22) });
    const record = statusOf(dataDir).listed;
    let asked = false;
    await sync({ dataDir, fetch: answering(() => ((asked = true), new Response("x"))), now: at(23), only: "pi" });
    expect(asked).toBe(false);
    expect(statusOf(dataDir).listed).toEqual(record);
  });
});

describe("the build reads it", () => {
  async function built(listed: (() => Response) | null, then?: () => Response): Promise<{ dataDir: string; meta: Meta; listing: (id: string) => Listing | null }> {
    const dataDir = tempDataDir();
    await sync({ dataDir, fetch: answering(listed ?? (() => new Response("", { status: 404 }))), now: at(22) });
    if (then) await sync({ dataDir, fetch: answering(then), now: at(23) });
    writeAuthored(dataDir);
    writeFileSync(join(dataDir, "authored", "measurement-labels.yaml"), readFileSync(join(ROOT, "data", "authored", "measurement-labels.yaml")));
    const report = publish({ dataDir, rootDir: ROOT, now: at(23) });
    expect(report.errors).toEqual([]);
    const file = (id: string) => join(dataDir, "published", "site", "data", "listings", `${id}.json`);
    return { dataDir, meta: report.meta!, listing: (id) => (existsSync(file(id)) ? (JSON.parse(readFileSync(file(id), "utf8")) as { data: Listing }).data : null) };
  }

  it("a missing file changes nothing: the listings are models.dev's, meta.listings has no file", async () => {
    const { meta, listing } = await built(null);
    expect(listing("provider-02")!.basis).toBe("models.dev");
    expect(meta.listings).toMatchObject({ fetched_at: null, checked_at: null, listed_at: null, by_basis: { listed: 0 }, sync: { last_attempt_ok: true, last_error: null } });
    expect(meta.issues.filter((issue) => issue.code.startsWith("listed"))).toEqual([]);
  });

  it("a listed list replaces the lower sources for its provider only, named by its client", async () => {
    const { meta, listing } = await built(json(listedFile()));
    const own = listing("provider-02")!;
    expect(ListingSchema.safeParse(own).error).toBeUndefined();
    expect(own).toMatchObject({ basis: "listed", listed_at: "2026-11-22", client: "provimux", client_label: "Provimux, a proxy built on CLIProxyAPI", model_count: 2 });
    expect(own.evidence).toEqual([{ kind: "listed", url: "https://github.com/ngvoicu/groundtruth/blob/main/listed.json", date: "2026-11-22", note: null }]);
    expect(own.models!.map((model) => model.id)).toEqual(["gemini-4-neon", "model-1"]);
    expect(own.models![0]).toMatchObject({ entry: null, context_window: 1048576, reasoning: { levels: ["low", "medium", "high"], supported: null }, variants: ["gemini-4-neon-low", "gemini-4-neon-medium", "gemini-4-neon-high"], sources: { context_window: "listed", variants: "listed" } });
    // model-1 is an entry: the vendor's list gives the plans, models.dev the window.
    expect(own.models![1]).toMatchObject({ entry: { provider: "provider-02", model: "model-1" }, plans: ["plus", "pro"], context_window: 200000, sources: { plans: "listed", context_window: "models.dev" } });
    expect(listing("provider-03")!.basis).toBe("models.dev");
    expect(meta.listings).toMatchObject({ by_basis: { listed: 1 }, listed_at: "2026-11-22", fetched_at: "2026-11-22T04:17:00.000Z" });
  });

  it("a malformed file keeps the last good copy and raises a sync issue", async () => {
    const { meta, listing } = await built(json(listedFile()), json("{not json"));
    expect(listing("provider-02")!.basis).toBe("listed");
    expect(meta.listings.sync).toEqual({ last_attempt_at: "2026-11-23T04:17:00.000Z", last_attempt_ok: false, last_error: "the discovery file is not JSON" });
    expect(meta.issues.filter((issue) => issue.code === "listed-sync-failed")).toEqual([
      { level: "warning", code: "listed-sync-failed", target: "data/sources/listed.json", message: "The last attempt to fetch the discovery file failed (the discovery file is not JSON). The last good copy is used." },
    ]);
  });

  it("a provider the catalog lacks and a client the labels lack are warnings, never a failed build", async () => {
    const file = listedFile();
    (file.providers as Record<string, unknown>)["nobody"] = { date: "2026-11-22", client: "someone-else", models: [{ id: "m" }] };
    (file.providers as Record<string, { client: string }>)["provider-02"]!.client = "someone-else";
    const { meta, listing } = await built(json(file));
    expect(listing("nobody")).toBeNull();
    expect(listing("provider-02")).toMatchObject({ client: "other", client_label: "Another client" });
    expect(meta.issues.filter((issue) => issue.code.startsWith("listed") || issue.code === "unmapped-listing-client").map((issue) => [issue.code, issue.target])).toEqual([
      ["listed-provider-unknown", "listed/nobody"],
      ["unmapped-listing-client", "listed/someone-else"],
    ]);
  });
});

describe("the client id", () => {
  it("provimux is in data/authored/measurement-labels.yaml", () => {
    const labels = MeasurementLabels.parse(parse(readFileSync(join(ROOT, "data", "authored", "measurement-labels.yaml"), "utf8")));
    expect(labels.clients.provimux).toEqual({ id: "provimux", label: "Provimux, a proxy built on CLIProxyAPI" });
  });

  it("the file's schema takes the fixture", () => {
    expect(ListedFile.safeParse(listedFile()).success).toBe(true);
  });
});
