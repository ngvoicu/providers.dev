// groundtruth's discovery file, listed.json (Provimux's model-lists.md, sections 4.3 and 10, D3): fetched by the sync
// beside observed.json, checked, kept as it came; read by the build into the listings.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { publish } from "../scripts/lib/publish.ts";
import { LISTED_URL, OBSERVED_URL, sync } from "../scripts/lib/sync.ts";
import { ListingSchema } from "../src/core/contract.ts";
import { storedListed, type Listing } from "../src/core/listings.ts";
import { pretty } from "../scripts/lib/files.ts";
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

  it("a good file is kept as the site reads it, with its meta; the next run sends its ETag and a 304 changes nothing but checked_at", async () => {
    const dataDir = tempDataDir();
    const body = JSON.stringify(listedFile());
    const first = await sync({ dataDir, fetch: answering(json(body)), now: at(22) });
    expect(first.listed).toEqual({ status: "updated", summary: ["1 providers, 2 models"] });
    expect(readFileSync(stored(dataDir), "utf8")).toBe(pretty(storedListed(ListedFile.parse(JSON.parse(body)))));
    expect(JSON.parse(readFileSync(join(dataDir, "sources", "listed.meta.json"), "utf8"))).toMatchObject({ source: LISTED_URL, fetched_at: "2026-11-22T04:17:00.000Z", etag: '"l1"' });
    const seen: { headers?: Record<string, string> } = {};
    const second = await sync({ dataDir, fetch: answering(() => new Response(null, { status: 304 }), seen), now: at(23) });
    expect(seen.headers?.["If-None-Match"]).toBe('"l1"');
    expect(second.listed.status).toBe("unchanged");
    expect(readFileSync(stored(dataDir), "utf8")).toBe(pretty(storedListed(ListedFile.parse(JSON.parse(body)))));
    expect(JSON.parse(readFileSync(join(dataDir, "sources", "listed.meta.json"), "utf8"))).toMatchObject({ fetched_at: "2026-11-22T04:17:00.000Z", checked_at: "2026-11-23T04:17:00.000Z" });
    // A file that went missing later is still "no discovery": the last copy stays.
    await sync({ dataDir, fetch: answering(() => new Response("gone", { status: 404 })), now: at(24) });
    expect(readFileSync(stored(dataDir), "utf8")).toBe(pretty(storedListed(ListedFile.parse(JSON.parse(body)))));
  });

  it.each<[string, () => Response, string]>([
    ["not JSON", json("<html>"), "listed.json: not JSON"],
    ["an account in a model", json(listedFile({ providers: { "provider-02": { date: "2026-11-22", client: "provimux", models: [{ id: "m", email: "ada@example.com" }] } } })), "listed.json: refused by its schema"],
    ["an auth file name beside a provider", json(listedFile({ providers: { "provider-02": { date: "2026-11-22", client: "provimux", auth_file: "devin-ada.json", models: [{ id: "m" }] } } })), "listed.json: refused by its schema"],
    ["a count of logins at the top", json({ ...listedFile(), logins: 2 }), "listed.json: refused by its schema"],
    ["a provider with no model", json(listedFile({ providers: { "provider-02": { date: "2026-11-22", client: "provimux", models: [] } } })), "listed.json: refused by its schema"],
    ["a model twice", json(listedFile({ providers: { "provider-02": { date: "2026-11-22", client: "provimux", models: [{ id: "m" }, { id: "m" }] } } })), "listed.json: refused by its schema"],
    ["schema 2", json({ ...listedFile(), schema: 2 }), "listed.json: refused by its schema"],
    ["HTTP 500", () => new Response("down", { status: 500 }), "listed.json: answered HTTP 500"],
    ["an auth file name as the id", json(listedFile({ providers: { "provider-02": { date: "2026-11-22", client: "provimux", models: [{ id: "codex-ada@example.com-plus.json" }] } } })), "listed.json: refused by its schema"],
    ["a token as the id", json(listedFile({ providers: { "provider-02": { date: "2026-11-22", client: "provimux", models: [{ id: `sk-ant-oat01-${"A".repeat(80)}` }] } } })), "listed.json: refused by its schema"],
    ["a network error", () => { throw new Error("getaddrinfo ENOTFOUND raw.githubusercontent.com for ada@example.com"); }, "listed.json: could not be fetched"],
    // Finding 8: a valid file that lost more than 40 % of the providers of the last good one.
    // Second review, finding 4: a file with no provider or no model is refused, on a first sync too (below); one that
    // lost more than 40 % of the providers or of the models of the last good copy is refused.
    ["no provider at all", json({ ...listedFile(), providers: {} }), "listed.json: lists no model"],
    ["one of its two models lost (a truncated array, the same providers)", json(listedFile({ providers: { "provider-02": { date: "2026-11-22", client: "provimux", models: [{ id: "model-1" }] } } })), "listed.json: lost more than 40 % of its models"],
  ])("a malformed file (%s) keeps the last good copy, fails only its part, and records a fixed reason", async (_name, answer, reason) => {
    const dataDir = tempDataDir();
    await sync({ dataDir, fetch: answering(json(listedFile())), now: at(22) });
    const before = readFileSync(stored(dataDir), "utf8");
    const report = await sync({ dataDir, fetch: answering(answer), now: at(23) });
    expect(report.upstream.status).not.toBe("failed");
    expect(report.listed.status).toBe("failed");
    // A fixed reason: no key's name, no value and no parser text.
    expect(report.listed.error).toBe(reason);
    expect(JSON.stringify(statusOf(dataDir))).not.toMatch(/ada|example\.com|ghp_|sk-ant|email|auth_file|logins|Unrecognized|expected/);
    expect(readFileSync(stored(dataDir), "utf8")).toBe(before);
    expect(statusOf(dataDir).listed).toEqual({ last_attempt_at: "2026-11-23T04:17:00.000Z", status: "failed", error: report.listed.error });
    // The five fields of models.dev and the measurements say nothing of it.
    expect(statusOf(dataDir).last_error).toBe("the measurements file answered HTTP 404");
  });

  it("a file with more providers is taken, and one that keeps 60 % of them is too (finding 8)", async () => {
    const dataDir = tempDataDir();
    const five = listedFile({ providers: Object.fromEntries(["provider-01", "provider-02", "provider-03", "provider-04", "provider-05"].map((id) => [id, { date: "2026-11-22", client: "provimux", models: [{ id: "m" }] }])) });
    await sync({ dataDir, fetch: answering(json(five)), now: at(22) });
    const three = listedFile({ providers: Object.fromEntries(["provider-01", "provider-02", "provider-03"].map((id) => [id, { date: "2026-11-23", client: "provimux", models: [{ id: "m" }] }])) });
    expect((await sync({ dataDir, fetch: answering(json(three, '"l2"')), now: at(23) })).listed.status).toBe("updated");
    const one = listedFile({ providers: { "provider-01": { date: "2026-11-24", client: "provimux", models: [{ id: "m" }] } } });
    expect((await sync({ dataDir, fetch: answering(json(one, '"l3"')), now: at(24) })).listed).toEqual({ status: "failed", error: "listed.json: lost more than 40 % of its providers" });
  });

  it("a file with no provider, or with providers and no model, is refused on a first sync too (second review, finding 4)", async () => {
    for (const body of [{ ...listedFile(), providers: {} }]) {
      const dataDir = tempDataDir();
      const report = await sync({ dataDir, fetch: answering(json(body)), now: at(22) });
      expect(report.listed).toEqual({ status: "failed", error: "listed.json: lists no model" });
      expect(existsSync(stored(dataDir))).toBe(false);
    }
  });

  it("a damaged stored copy never blocks a valid replacement (second review, finding 4; 941927a's behaviour)", async () => {
    const dataDir = tempDataDir();
    await sync({ dataDir, fetch: answering(json(listedFile())), now: at(22) });
    writeFileSync(stored(dataDir), '{"cf-review-private-key@example.invalid":');
    const next = listedFile({ providers: { "provider-02": { date: "2026-11-23", client: "provimux", models: [{ id: "model-1" }, { id: "model-3" }, { id: "model-5" }] } } });
    const seen: { headers?: Record<string, string> } = {};
    // The stored copy does not read: no ETag is sent, so the answer is the file, and it replaces the damaged copy.
    const report = await sync({ dataDir, fetch: answering(json(next, '"l1"'), seen), now: at(23) });
    expect(seen.headers?.["If-None-Match"]).toBeUndefined();
    expect(report.listed.status).toBe("updated");
    expect(readFileSync(stored(dataDir), "utf8")).toBe(pretty(storedListed(ListedFile.parse(next))));
    // A damaged meta file beside a good copy does not block either.
    writeFileSync(join(dataDir, "sources", "listed.meta.json"), "{");
    expect((await sync({ dataDir, fetch: answering(json(listedFile({ providers: { "provider-02": { date: "2026-11-24", client: "provimux", models: [{ id: "model-1" }, { id: "model-3" }] } } }))), now: at(24) })).listed.status).toBe("updated");
  });

  it("the stored copy holds only what the site reads: no private text of a crafted file is ever written to data/sources/listed.json", async () => {
    // Every private value of both reviews, in every field the site never takes, beside values it does take.
    const crafted = {
      schema: 1,
      repository: "https://ada:ghp_secret@github.com/ngvoicu/sk-live-CFReviewFixture",
      providers: {
        "provider-02": {
          date: "2026-11-22",
          client: "provimux",
          models: [
            {
              id: "model-1",
              name: "Neon (ada@example.com, team of 3 seats) Morgan Example 202-555-0142",
              owner: "acct-cfreview-private-ops",
              released: "login of ada@example.com, team plan, 3 seats",
              aliases: ["codex-ada@example.com-plus.json", "eyJhbGciOiJIUzI1NiJ9.exampleCFReview.fixture"],
              variants: ["ghp_0123456789abcdefghijABCDEFGHIJ012345", "codex-morgan-example-plus.json"],
              description: "ada@example.com not published",
              context_window: 400000,
              max_output: 128000,
              input_modalities: ["text", "image/png", "acct-cfreview-private-ops"],
              reasoning: { supported: true, levels: ["low", "high", "sess-cfreview-fixture-only"], disable_with: "qa+cf-review@example.invalid" },
              plans: ["plus", "Plus 150 messages", "Pro 20 USD", "plus: 150 messages / 3h, $20/month"],
              hidden: false,
            },
            { id: "model-3", name: "Morgan Example", aliases: ["codex-morgan-example-plus.json"] },
          ],
        },
      },
    };
    const dataDir = tempDataDir();
    const report = await sync({ dataDir, fetch: answering(json(crafted)), now: at(22) });
    expect(report.listed.status).toBe("updated");
    const text = readFileSync(stored(dataDir), "utf8");
    for (const words of ["ada", "example.com", "Morgan", "202-555-0142", "team of 3", "acct-cfreview", "codex-", "eyJhbGci", "ghp_", "sk-live", "not published", "sess-cfreview", "qa+", "cf-review", "150 messages", "20 USD", "repository", "name", "owner", "released", "aliases", "variants", "description", "disable_with"]) {
      expect(text, words).not.toContain(words);
    }
    // Only the kept values, in the file's own shape, which the build reads as it reads the file.
    expect(JSON.parse(text)).toEqual({
      schema: 1,
      providers: {
        "provider-02": {
          date: "2026-11-22",
          client: "provimux",
          models: [
            { id: "model-1", context_window: 400000, max_output: 128000, input_modalities: ["text", "image"], plans: ["plus"], hidden: false, reasoning: { supported: true, levels: ["low", "high"] } },
            { id: "model-3" },
          ],
        },
      },
    });
    expect(ListedFile.safeParse(JSON.parse(text)).success).toBe(true);
    // Its meta and the sync's record hold none of it either.
    for (const other of [readFileSync(join(dataDir, "sources", "listed.meta.json"), "utf8"), readFileSync(join(dataDir, "sync-status.json"), "utf8")]) expect(other).not.toMatch(/ada|Morgan|cf-review|ghp_|sk-live|150 messages/);
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
    // Only values that cannot carry text are taken: no name and no variants from the file; the name is the id.
    expect(own.models![0]).toMatchObject({ entry: null, name: "gemini-4-neon", context_window: 1048576, reasoning: { levels: ["low", "medium", "high"], supported: null }, variants: [], sources: { name: "listed", context_window: "listed", variants: null } });
    // model-1 is an entry: the vendor's list gives the plans, models.dev the window.
    expect(own.models![1]).toMatchObject({ entry: { provider: "provider-02", model: "model-1" }, plans: ["plus", "pro"], context_window: 200000, sources: { plans: "listed", context_window: "models.dev" } });
    expect(listing("provider-03")!.basis).toBe("models.dev");
    expect(meta.listings).toMatchObject({ by_basis: { listed: 1 }, listed_at: "2026-11-22", fetched_at: "2026-11-22T04:17:00.000Z" });
  });

  it("a malformed file keeps the last good copy and raises a sync issue", async () => {
    const { meta, listing } = await built(json(listedFile()), json("{not json"));
    expect(listing("provider-02")!.basis).toBe("listed");
    expect(meta.listings.sync).toEqual({ last_attempt_at: "2026-11-23T04:17:00.000Z", last_attempt_ok: false, last_error: "listed.json: not JSON" });
    expect(meta.issues.filter((issue) => issue.code === "listed-sync-failed")).toEqual([
      { level: "warning", code: "listed-sync-failed", target: "data/sources/listed.json", message: "The last attempt to fetch the discovery file failed (listed.json: not JSON). The last good copy is used." },
    ]);
  });

  it("a recorded error that is not one of the sync's fixed reasons never reaches /api/v1/meta", async () => {
    const dataDir = tempDataDir();
    await sync({ dataDir, fetch: answering(json(listedFile())), now: at(22) });
    const statusPath = join(dataDir, "sync-status.json");
    const status = JSON.parse(readFileSync(statusPath, "utf8")) as Record<string, unknown>;
    // As the sync of 941927a wrote it: the parser's text, with a key's name and a value.
    writeFileSync(statusPath, JSON.stringify({ ...status, listed: { last_attempt_at: "2026-11-23T04:17:00.000Z", status: "failed", error: 'the discovery file does not match the expected structure (1 problems; first: providers.openai-codex: Unrecognized key: "ada@example.com")' } }));
    writeAuthored(dataDir);
    const report = publish({ dataDir, rootDir: ROOT, now: at(23) });
    expect(report.meta!.listings.sync.last_error).toBe("listed.json: refused");
    expect(JSON.stringify(report.meta)).not.toContain("ada@example.com");
  });

  // Every private value of both reviews: the file is taken (it is well formed), and nothing of the value is published,
  // because no text is taken from it. Each case is checked in everything a reader can get: /api/v1/meta, the listing
  // files and the list of listings.
  const SECRET = /ada@example|team of 3 seats|codex-ada|Morgan Example|202-555-0142|codex-morgan|150 messages|20 USD|sess-cfreview|acct-cfreview|sk-live-CFReviewFixture|cf-review|eyJhbGciOiJIUzI1NiJ9|ghp_|not published|qa\+/;
  const withModel = (more: Record<string, unknown>, top: Record<string, unknown> = {}) => ({ ...listedFile({ providers: { "provider-02": { date: "2026-11-22", client: "provimux", models: [{ id: "model-1", ...more }, { id: "model-3" }] } } }), ...top });
  it.each<[string, Record<string, unknown>]>([
    // First review (finding 1, 7).
    ["an e-mail in a name", withModel({ name: "Neon (ada@example.com, team of 3 seats)" })],
    ["an auth file name as an alias", withModel({ aliases: ["codex-ada@example.com-plus.json"] })],
    ["a token in a variant", withModel({ variants: ["ghp_0123456789abcdefghijABCDEFGHIJ012345"] })],
    ["an e-mail as the owner", withModel({ owner: "ada@example.com" })],
    ["free text in released", withModel({ released: "login of ada@example.com, team plan, 3 seats" })],
    ["a name of 10,000 characters", withModel({ name: `Morgan Example ${"x".repeat(10000)}` })],
    ["a quota as a plan name", withModel({ plans: ["plus: 150 messages / 3h, $20/month"] })],
    ["an e-mail in the description", withModel({ description: "ada@example.com not published" })],
    ["a javascript: repository", withModel({}, { repository: "javascript:alert('cf-review')" })],
    ["an http repository", withModel({}, { repository: "http://cf-review.example/groundtruth" })],
    ["a repository with a password", withModel({}, { repository: "https://ada:ghp_secret@github.com/a/b" })],
    // Second review (followup2): what the patterns of 0afdc92 still let through.
    ["an e-mail in reasoning.disable_with", withModel({ reasoning: { disable_with: "qa+cf-review@example.invalid" } })],
    ["a JWT-shaped alias", withModel({ aliases: ["eyJhbGciOiJIUzI1NiJ9.exampleCFReview.fixture"] })],
    ["a non-https repository scheme", withModel({}, { repository: "file:///Users/cfreview/private.json" })],
    ["a token in the repository path", withModel({}, { repository: "https://github.com/ngvoicu/sk-live-CFReviewFixture" })],
    ["an encoded e-mail in the repository path", withModel({}, { repository: "https://github.com/ngvoicu/cf-review%40example.invalid" })],
    ["a full name and a phone number as the name", withModel({ name: "Morgan Example 202-555-0142" })],
    ["an auth file name with no e-mail as an alias", withModel({ aliases: ["codex-morgan-example-plus.json"] })],
    ["a session token in reasoning.disable_with", withModel({ reasoning: { disable_with: "sess-cfreview-fixture-only" } })],
    ["a quota and a price as plan names", withModel({ plans: ["Plus 150 messages", "Pro 20 USD"] })],
    ["an account as the owner", withModel({ owner: "acct-cfreview-private-ops" })],
    ["a word outside the levels", withModel({ reasoning: { levels: ["low", "sess-cfreview-fixture-only"] } })],
    ["a word outside the modalities", withModel({ input_modalities: ["text", "acct-cfreview-private-ops"] })],
  ])("from %s nothing is published: the file is taken, only values that cannot carry text are read", async (_name, file) => {
    const { meta, dataDir, listing } = await built(json(file));
    expect(meta.listings.sync).toMatchObject({ last_attempt_ok: true, last_error: null });
    const own = listing("provider-02")!;
    expect(own.basis).toBe("listed");
    // The evidence link is the code's constant, whatever the file's repository says.
    expect(own.evidence).toEqual([{ kind: "listed", url: "https://github.com/ngvoicu/groundtruth/blob/main/listed.json", date: "2026-11-22", note: null }]);
    const published = join(dataDir, "published", "site", "data");
    const everything = [JSON.stringify(meta), readFileSync(join(published, "listings.json"), "utf8"), readFileSync(join(published, "listings", "provider-02.json"), "utf8")].join("");
    expect(everything).not.toMatch(SECRET);
    // What is kept of a list: only the allowed words.
    const row = own.models!.find((model) => model.id === "model-1")!;
    expect(row.aliases).toEqual([]);
    expect(row.variants).toEqual([]);
    expect(row.name).toBe("Model 1");
    expect(row.sources.name).toBe("models.dev");
  });

  it("plan names: the allowed single words are kept in lower case, anything else is dropped from the row (not the file)", async () => {
    const { listing } = await built(json(withModel({ plans: ["ChatGPT Plus", "Pro", "plus", "Plus 150 messages", "team", "Pro 20 USD"] })));
    const row = listing("provider-02")!.models!.find((model) => model.id === "model-1")!;
    expect(row).toMatchObject({ plans: ["pro", "plus", "team"], sources: { plans: "listed" } });
    // A list that kept nothing states nothing.
    const { listing: other } = await built(json(withModel({ plans: ["Plus 150 messages"] })));
    expect(other("provider-02")!.models!.find((model) => model.id === "model-1")).toMatchObject({ plans: [], sources: { plans: null } });
  });

  it("the review's crafted file publishes nothing of its private values (its providers moved onto the fixture's)", async () => {
    const crafted = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "listed.crafted.json"), "utf8")) as { providers: Record<string, unknown> };
    const ids = ["provider-02", "provider-03", "provider-04", "provider-05", "provider-06"];
    crafted.providers = Object.fromEntries(Object.values(crafted.providers).map((part, index) => [ids[index]!, part]));
    const { meta, dataDir, listing } = await built(json(crafted));
    expect(listing("provider-02")!.models!.map((model) => model.id)).toEqual(["gpt-6.1-sol", "gpt-6.2-sol", "gpt-7-neon", "gpt-6-astra"]);
    expect(listing("provider-02")!.models!.find((model) => model.id === "gpt-7-neon")).toMatchObject({ name: "gpt-7-neon", aliases: [], hidden: true });
    const published = join(dataDir, "published", "site", "data");
    const everything = [JSON.stringify(meta), readFileSync(join(published, "listings.json"), "utf8"), ...ids.map((id) => readFileSync(join(published, "listings", `${id}.json`), "utf8"))].join("");
    for (const words of ["ada@example.com", "team of 3 seats", "codex-ada", "not published"]) expect(everything).not.toContain(words);
  });

  it("a provider the catalog lacks and a client the labels lack are warnings, never a failed build", async () => {
    const file = listedFile();
    (file.providers as Record<string, unknown>)["nobody"] = { date: "2026-11-22", client: "someone-else", models: [{ id: "m" }] };
    (file.providers as Record<string, { client: string }>)["provider-02"]!.client = "someone-else";
    const { meta, listing } = await built(json(file));
    expect(listing("nobody")).toBeNull();
    expect(listing("provider-02")).toMatchObject({ client: "other", client_label: "Another client" });
    // Counted, not named: no key and no client of the file reaches /api/v1/meta.
    expect(meta.issues.filter((issue) => issue.code.startsWith("listed") || issue.code === "unmapped-listing-client").map((issue) => [issue.code, issue.target, issue.message])).toEqual([
      ["listed-provider-unknown", "listed", "The discovery file lists 1 provider the catalog does not have. Its list is not published."],
      ["unmapped-listing-client", "listed", 'The discovery file names 1 client that data/authored/measurement-labels.yaml does not describe. It is published as "other".'],
    ]);
    expect(JSON.stringify(meta)).not.toMatch(/nobody|someone-else/);
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
