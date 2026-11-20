// The pi import, the third part of `npm run sync` (design/pi-source.md, sections a and b; step 1, PIC-03).
// Every case runs on a temp data directory with a first good import of all three sources behind it.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPi, loadUpstream, OBSERVED_URL, PI_DEADLINE_MS, PI_URL, sync, SyncBusyError, UPSTREAM_COMMIT_URL, UPSTREAM_URL, writeStepOutputs, type SyncOptions, type SyncStatus } from "../scripts/lib/sync.ts";
import { sha256 } from "../scripts/lib/files.ts";
import type { PiCatalog } from "../src/core/pi.ts";
import { fetchByAddress, fixturePi, fixtureUpstream, tempDataDir, type RecordedRequest } from "./helpers.ts";

const OBSERVED = JSON.stringify({
  schema: 1, repository: "https://github.com/example/probe", routes: {}, clients: {},
  cache: [{ id: "probe/R1", route: "provider-00", client: "direct", model: "model-1", date: "2026-11-12", source: "results/r1.json", latest: true, control: { warm: 1, total: 1 }, checks: [{ age_s: 150, warm: 1, total: 1 }, { age_s: 300, warm: 0, total: 1 }] }],
});
const COMMIT = JSON.stringify({ sha: "abc123", commit: { committer: { date: "2026-11-12T00:00:00Z" } } });
/** The first pi import: 20 providers of 30 models, big enough that losing 40 % of either still passes the size floor. */
const FIRST_PI = fixturePi(20, 30);
const PI_HEADERS = { etag: '"p1"', "last-modified": "Fri, 20 Nov 2026 13:53:59 GMT", "x-pi-model-catalog-revision": "sha256-dd93eb2741d05a80" };

const ok = (body: string, headers: Record<string, string> = {}) => () => new Response(body, { status: 200, headers });
const status = (code: number, body: string | null = null) => () => new Response(body, { status: code });

interface Answers {
  upstream?: () => Response;
  observed?: () => Response;
  pi?: () => Response;
}

/** models.dev, its commit, the measurements and pi, each with its own answer; good and unchanged unless given. */
function stand(answers: Answers = {}, requests: RecordedRequest[] = []): typeof fetch {
  return fetchByAddress(
    {
      [UPSTREAM_URL]: answers.upstream ?? ok(JSON.stringify(fixtureUpstream()), { etag: '"u1"' }),
      [UPSTREAM_COMMIT_URL]: ok(COMMIT),
      [OBSERVED_URL]: answers.observed ?? ok(OBSERVED, { etag: '"o1"' }),
      [PI_URL]: answers.pi ?? ok(JSON.stringify(FIRST_PI), PI_HEADERS),
    },
    requests,
  );
}

const at = (day: number) => () => new Date(`2026-11-${String(day).padStart(2, "0")}T00:00:00Z`);

async function run(dataDir: string, answer: typeof fetch, more: Partial<SyncOptions> = {}) {
  return sync({ dataDir, fetch: answer, now: at(14), ...more });
}

/** A data directory after a first good import of models.dev, the measurements and pi. */
async function firstImport(): Promise<string> {
  const dataDir = tempDataDir();
  const report = await sync({ dataDir, fetch: stand(), now: at(13) });
  expect([report.ok, report.upstream.status, report.measurements.status, report.pi.status]).toEqual([true, "updated", "updated", "updated"]);
  return dataDir;
}

/** Every file under `dir`, path -> content. */
function filesUnder(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir, { recursive: true }).map(String).sort()) {
    const path = join(dir, name);
    if (statSync(path).isFile()) out[name] = readFileSync(path, "utf8");
  }
  return out;
}

const statusOf = (dataDir: string): SyncStatus => JSON.parse(readFileSync(join(dataDir, "sync-status.json"), "utf8"));
const piMeta = (dataDir: string) => JSON.parse(readFileSync(join(dataDir, "pi", "meta.json"), "utf8"));
const piFile = (dataDir: string, id: string) => readFileSync(join(dataDir, "pi", "providers", `${id}.json`), "utf8");
const isPi = (request: RecordedRequest) => request.url === PI_URL;

/** models.dev with one model more, under a new ETag: an import that gives `updated`. */
const changedUpstream = (): string => {
  const catalog = fixtureUpstream();
  catalog["provider-02"]!.models.fresh = { id: "fresh", name: "Fresh" };
  return JSON.stringify(catalog);
};

/** pi with a model removed, one changed and one added. */
const changedPi = (): PiCatalog => {
  const catalog = fixturePi(20, 30);
  delete catalog["provider-00"]!["model-1"];
  catalog["provider-01"]!["model-1"]!.contextWindow = 1;
  catalog["provider-02"]!.fresh = { ...catalog["provider-02"]!["model-1"]!, id: "fresh", name: "Fresh" };
  return catalog;
};

describe("the pi import", () => {
  it("1. a first import writes meta.json and one file per provider, models sorted by id, headers and key order kept", async () => {
    // The feed sends the providers and the models of each in reverse order.
    const sent = Object.fromEntries(Object.entries(FIRST_PI).reverse().map(([id, models]) => [id, Object.fromEntries(Object.entries(models).reverse())]));
    const body = JSON.stringify(sent);
    const dataDir = tempDataDir();
    const report = await sync({ dataDir, fetch: stand({ pi: ok(body, PI_HEADERS) }), now: at(13) });
    expect(report.pi).toEqual({ status: "updated", summary: ["first import: 20 providers, 600 models"] });
    expect(piMeta(dataDir)).toEqual({
      source: PI_URL,
      fetched_at: "2026-11-13T00:00:00.000Z",
      checked_at: "2026-11-13T00:00:00.000Z",
      etag: '"p1"',
      last_modified: "Fri, 20 Nov 2026 13:53:59 GMT",
      revision: "sha256-dd93eb2741d05a80",
      sha256: sha256(body),
      providers: 20,
      models: 600,
    });
    expect(Object.keys(piMeta(dataDir))).toEqual(["source", "fetched_at", "checked_at", "etag", "last_modified", "revision", "sha256", "providers", "models"]);
    expect(readdirSync(join(dataDir, "pi", "providers")).sort()).toEqual(Object.keys(FIRST_PI).map((id) => `${id}.json`).sort());

    const stored = JSON.parse(piFile(dataDir, "provider-03"));
    expect(Object.keys(stored)).toEqual(["id", "models"]);
    expect(stored.id).toBe("provider-03");
    expect(Object.keys(stored.models)).toEqual(Object.keys(FIRST_PI["provider-03"]!).sort());
    // A model as the feed gives it: every key, in the feed's order, headers included.
    expect(stored.models["model-1"]).toEqual(FIRST_PI["provider-03"]!["model-1"]);
    expect(Object.keys(stored.models["model-1"])).toEqual(Object.keys(FIRST_PI["provider-03"]!["model-1"]!));
    expect(stored.models["model-1"].headers).toEqual({ "X-Example": "1" });
    expect(piFile(dataDir, "provider-03")).toBe(`${JSON.stringify({ id: "provider-03", models: stored.models }, null, 1)}\n`);
    expect(loadPi(dataDir)!.catalog).toEqual(FIRST_PI);

    expect(statusOf(dataDir).pi).toEqual({ last_attempt_at: "2026-11-13T00:00:00.000Z", status: "updated" });
    // Nothing of pi under data/upstream/, nothing of models.dev under data/pi/.
    expect(readdirSync(join(dataDir, "pi")).sort()).toEqual(["meta.json", "providers"]);
    expect(readdirSync(join(dataDir, "upstream", "providers"))).toHaveLength(30);
  });

  it("2. an unchanged feed (304): the stored ETag is sent, only checked_at moves", async () => {
    const dataDir = await firstImport();
    const before = filesUnder(join(dataDir, "pi", "providers"));
    const meta = piMeta(dataDir);
    const requests: RecordedRequest[] = [];
    const report = await run(dataDir, stand({ pi: status(304) }, requests));
    expect(requests.find(isPi)?.headers).toMatchObject({ "If-None-Match": '"p1"', Accept: "application/json", "User-Agent": "providers.dev sync" });
    expect(report.pi).toEqual({ status: "unchanged" });
    expect(piMeta(dataDir)).toEqual({ ...meta, checked_at: "2026-11-14T00:00:00.000Z" });
    expect(filesUnder(join(dataDir, "pi", "providers"))).toEqual(before);
    expect(statusOf(dataDir).pi).toEqual({ last_attempt_at: "2026-11-14T00:00:00.000Z", status: "unchanged" });
  });

  it("3. the same body without a 304 (an equal digest): unchanged, no provider file rewritten", async () => {
    const dataDir = await firstImport();
    const dir = join(dataDir, "pi", "providers");
    const before = filesUnder(dir);
    const times = Object.fromEntries(readdirSync(dir).map((file) => [file, statSync(join(dir, file)).mtimeMs]));
    const meta = piMeta(dataDir);
    const report = await run(dataDir, stand({ pi: ok(JSON.stringify(FIRST_PI), { ...PI_HEADERS, etag: '"p2"' }) }));
    expect(report.pi).toEqual({ status: "unchanged" });
    expect(piMeta(dataDir)).toEqual({ ...meta, checked_at: "2026-11-14T00:00:00.000Z", etag: '"p2"' });
    expect(filesUnder(dir)).toEqual(before);
    expect(Object.fromEntries(readdirSync(dir).map((file) => [file, statSync(join(dir, file)).mtimeMs]))).toEqual(times);
  });

  it("4. a changed feed: updated, with the models added, removed and changed counted", async () => {
    const dataDir = await firstImport();
    const report = await run(dataDir, stand({ pi: ok(JSON.stringify(changedPi()), { ...PI_HEADERS, etag: '"p2"' }) }));
    expect(report.pi).toEqual({ status: "updated", summary: ["models: +1 added, -1 removed, 1 changed"] });
    expect(loadPi(dataDir)!.catalog).toEqual(changedPi());
    expect(piMeta(dataDir)).toMatchObject({ etag: '"p2"', fetched_at: "2026-11-14T00:00:00.000Z", providers: 20, models: 600 });

    const more = fixturePi(21, 30);
    delete more["provider-00"];
    const second = await run(dataDir, stand({ pi: ok(JSON.stringify(more), { etag: '"p3"' }) }));
    expect(second.pi.summary).toEqual(["providers added: provider-20", "providers removed: provider-00", "models: +30 added, -30 removed, 1 changed"]);
  });

  const withModel = (change: (catalog: PiCatalog) => void): string => {
    const catalog = fixturePi(20, 30);
    change(catalog);
    return JSON.stringify(catalog);
  };
  it.each<[string, () => Response, RegExp]>([
    ["down (HTTP 503)", status(503, "down"), /^pi\.dev answered HTTP 503$/],
    ["not JSON", ok("<html>"), /^pi\.dev did not return JSON$/],
    ["another structure: a model without cost", ok(withModel((c) => delete (c["provider-04"]!["model-3"] as Record<string, unknown>).cost)), /^the pi feed does not match the expected structure \(1 problems; first: provider-04\.model-3\.cost: /],
    ["another structure: contextWindow a string", ok(withModel((c) => ((c["provider-04"]!["model-3"] as Record<string, unknown>).contextWindow = "200000"))), /^the pi feed does not match the expected structure \(1 problems; first: provider-04\.model-3\.contextWindow: /],
    ["a model whose key and id disagree", ok(withModel((c) => (c["provider-04"]!["model-3"]!.id = "model-4"))), /^pi model key "provider-04\/model-3" does not match its id "model-4"$/],
    ["a model whose provider is not its provider key", ok(withModel((c) => (c["provider-04"]!["model-3"]!.provider = "provider-05"))), /^pi model "provider-04\/model-3" names the provider "provider-05", not its provider key$/],
    ["a provider key that is not a valid id", ok(withModel((c) => (c["../x"] = { m: { ...c["provider-00"]!["model-1"]!, id: "m", provider: "../x" } }))), /^pi provider key "\.\.\/x" is not a valid provider id$/],
    ["empty", ok("{}"), /^the pi feed is unexpectedly small: 0 providers, 0 models$/],
    ["too small", ok(JSON.stringify(fixturePi(12, 20))), /^the pi feed is unexpectedly small: 12 providers, 240 models$/],
    ["40 % of the models lost", ok(JSON.stringify(fixturePi(20, 17))), /^the pi feed shrank too much to trust: 20 providers and 340 models, from 20 and 600$/],
    ["40 % of the providers lost", ok(JSON.stringify(fixturePi(11, 30))), /^the pi feed shrank too much to trust: 11 providers and 330 models, from 20 and 600$/],
  ])("5. a pi feed that is %s fails the pi part alone: data/pi/ as it was, the run ok, models.dev imported", async (_name, answer, words) => {
    const dataDir = await firstImport();
    const before = filesUnder(join(dataDir, "pi"));
    const upstreamBefore = filesUnder(join(dataDir, "upstream"));
    const report = await run(dataDir, stand({ upstream: ok(changedUpstream(), { etag: `"u2"` }), pi: answer }));
    expect(report.pi.status).toBe("failed");
    expect(report.pi.error).toMatch(words);
    expect(filesUnder(join(dataDir, "pi"))).toEqual(before);
    expect(report.ok).toBe(true);
    expect(report.upstream.status).toBe("updated");
    expect(filesUnder(join(dataDir, "upstream"))).not.toEqual(upstreamBefore);
    expect(loadUpstream(dataDir)!.catalog["provider-02"]!.models.fresh).toBeDefined();
    const recorded = statusOf(dataDir);
    expect(recorded).toEqual({
      last_attempt_at: "2026-11-14T00:00:00.000Z",
      last_attempt_ok: true,
      upstream: "updated",
      measurements: "unchanged",
      pi: { last_attempt_at: "2026-11-14T00:00:00.000Z", status: "failed", error: report.pi.error },
    });
    expect(existsSync(join(dataDir, ".sync.lock"))).toBe(false);
    expect(readdirSync(dataDir).filter((name) => name.startsWith("pi.")).length).toBe(0);
  });

  it("6. models.dev fails and pi succeeds: the run fails as today, data/upstream/ as it was, data/pi/ replaced", async () => {
    const dataDir = await firstImport();
    const upstreamBefore = filesUnder(join(dataDir, "upstream"));
    const report = await run(dataDir, stand({ upstream: status(503), pi: ok(JSON.stringify(changedPi()), { etag: '"p2"' }) }));
    expect(report.ok).toBe(false);
    expect(report.upstream.status).toBe("failed");
    expect(report.pi.status).toBe("updated");
    expect(filesUnder(join(dataDir, "upstream"))).toEqual(upstreamBefore);
    expect(loadPi(dataDir)!.catalog).toEqual(changedPi());
    const recorded = statusOf(dataDir);
    expect(recorded).toMatchObject({ last_attempt_ok: false, last_error: "models.dev answered HTTP 503", upstream: "failed", measurements: "unchanged" });
    expect(recorded.pi).toEqual({ last_attempt_at: "2026-11-14T00:00:00.000Z", status: "updated" });
  });

  it("7. both fail: both folders as they were, both failures recorded apart", async () => {
    const dataDir = await firstImport();
    const upstreamBefore = filesUnder(join(dataDir, "upstream"));
    const piBefore = filesUnder(join(dataDir, "pi"));
    const report = await run(dataDir, stand({ upstream: status(502), pi: status(503) }));
    expect([report.ok, report.upstream.status, report.pi.status]).toEqual([false, "failed", "failed"]);
    expect(filesUnder(join(dataDir, "upstream"))).toEqual(upstreamBefore);
    expect(filesUnder(join(dataDir, "pi"))).toEqual(piBefore);
    const recorded = statusOf(dataDir);
    expect(recorded).toMatchObject({ last_attempt_ok: false, last_error: "models.dev answered HTTP 502", upstream: "failed" });
    expect(recorded.pi).toEqual({ last_attempt_at: "2026-11-14T00:00:00.000Z", status: "failed", error: "pi.dev answered HTTP 503" });
  });

  it("8. an ETag stored for another address is not sent, and its digest not compared", async () => {
    const dataDir = await firstImport();
    const path = join(dataDir, "pi", "meta.json");
    writeFileSync(path, JSON.stringify({ ...piMeta(dataDir), source: "https://pi.dev/api/other" }));
    const requests: RecordedRequest[] = [];
    const report = await run(dataDir, stand({}, requests));
    expect(requests.find(isPi)?.headers["If-None-Match"]).toBeUndefined();
    expect(report.pi.status).toBe("updated");
    expect(piMeta(dataDir)).toMatchObject({ source: PI_URL, fetched_at: "2026-11-14T00:00:00.000Z" });
  });

  it("9. --force sends no If-None-Match and rewrites an equal body", async () => {
    const dataDir = await firstImport();
    const requests: RecordedRequest[] = [];
    const report = await run(dataDir, stand({}, requests), { force: true });
    expect(requests.find(isPi)?.headers["If-None-Match"]).toBeUndefined();
    expect(report.pi).toEqual({ status: "updated", summary: ["models: +0 added, -0 removed, 0 changed"] });
    expect(piMeta(dataDir)).toMatchObject({ fetched_at: "2026-11-14T00:00:00.000Z", checked_at: "2026-11-14T00:00:00.000Z" });
  });

  it("10. only: \"pi\" requests pi alone and leaves the five fields of models.dev and the measurements as they were", async () => {
    const dataDir = await firstImport();
    const { pi: _pi, ...before } = statusOf(dataDir);
    const upstreamBefore = filesUnder(join(dataDir, "upstream"));
    const sourcesBefore = filesUnder(join(dataDir, "sources"));
    const requests: RecordedRequest[] = [];
    const report = await run(dataDir, stand({ upstream: status(503), observed: status(503), pi: ok(JSON.stringify(changedPi()), { etag: '"p2"' }) }, requests), { only: "pi" });
    expect(requests.map((request) => request.url)).toEqual([PI_URL]);
    expect(report.pi.status).toBe("updated");
    expect(report.ok).toBe(true);
    // The parts that did not run say so in the report, and only there.
    expect([report.upstream, report.measurements]).toEqual([{ status: "skipped" }, { status: "skipped" }]);
    expect(readFileSync(join(dataDir, "sync-status.json"), "utf8")).not.toContain("skipped");
    const { pi, ...after } = statusOf(dataDir);
    expect(after).toEqual(before);
    expect(pi).toEqual({ last_attempt_at: "2026-11-14T00:00:00.000Z", status: "updated" });
    expect(filesUnder(join(dataDir, "upstream"))).toEqual(upstreamBefore);
    expect(filesUnder(join(dataDir, "sources"))).toEqual(sourcesBefore);

    // On a data directory with no status yet, only the pi key is written.
    const fresh = tempDataDir();
    await run(fresh, stand(), { only: "pi" });
    expect(statusOf(fresh)).toEqual({ pi: { last_attempt_at: "2026-11-14T00:00:00.000Z", status: "updated" } });

    // A failed pi part is recorded the same way, and the rest still stays.
    await run(dataDir, stand({ pi: status(500) }), { only: "pi" });
    const failed = statusOf(dataDir);
    expect(failed.pi).toEqual({ last_attempt_at: "2026-11-14T00:00:00.000Z", status: "failed", error: "pi.dev answered HTTP 500" });
    const { pi: _failedPi, ...rest } = failed;
    expect(rest).toEqual(before);
  });

  it("11. a second sync while one holds the lock throws SyncBusyError, with or without only", async () => {
    const dataDir = await firstImport();
    const piBefore = filesUnder(join(dataDir, "pi"));
    writeFileSync(join(dataDir, ".sync.lock"), "1");
    await expect(run(dataDir, stand({ pi: ok(JSON.stringify(changedPi())) }))).rejects.toBeInstanceOf(SyncBusyError);
    await expect(run(dataDir, stand({ pi: ok(JSON.stringify(changedPi())) }), { only: "pi" })).rejects.toBeInstanceOf(SyncBusyError);
    expect(filesUnder(join(dataDir, "pi"))).toEqual(piBefore);
  });

  it("12. writeStepOutputs appends upstream=, measurements= and pi= to the file and keeps what it held; a skipped part gets no line", () => {
    const path = join(tempDataDir(), "github-output");
    writeFileSync(path, "earlier=1\n");
    writeStepOutputs({ ok: true, upstream: { status: "updated" }, measurements: { status: "unchanged" }, pi: { status: "failed", error: "pi.dev answered HTTP 503" } }, path);
    expect(readFileSync(path, "utf8")).toBe("earlier=1\nupstream=updated\nmeasurements=unchanged\npi=failed\n");

    // A part that did not run (`only: "pi"`) gets no line.
    writeStepOutputs({ ok: true, upstream: { status: "skipped" }, measurements: { status: "skipped" }, pi: { status: "unchanged" } }, path);
    expect(readFileSync(path, "utf8")).toBe("earlier=1\nupstream=updated\nmeasurements=unchanged\npi=failed\npi=unchanged\n");
  });
});

describe("the pi deadline (release review, blocker 2)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const turn = () => new Promise((resolve) => setImmediate(resolve));

  it.each([
    ["a body that trickles in, one byte a minute", "body"],
    ["headers that never come", "headers"],
  ])("%s fails the pi part after 60 s; models.dev is imported as usual and data/pi/ stays as it was", async (_name, slow) => {
    const dataDir = await firstImport();
    const piBefore = filesUnder(join(dataDir, "pi"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let piSignal: AbortSignal | undefined;
    const otherSignals: (AbortSignal | undefined)[] = [];
    const answers = stand({ upstream: ok(changedUpstream(), { etag: '"u2"' }) });
    const slowFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== PI_URL) {
        otherSignals.push(init?.signal ?? undefined);
        return answers(input, init);
      }
      piSignal = init?.signal ?? undefined;
      if (slow === "headers") return new Promise<Response>(() => {});
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{"));
          piSignal?.addEventListener("abort", () => controller.error(new Error("aborted")));
        },
      });
      return new Response(body, { status: 200, headers: { etag: '"p2"' } });
    }) as typeof fetch;
    let settled = false;
    const pending = run(dataDir, slowFetch).then((report) => {
      settled = true;
      return report;
    });
    while (!piSignal) await turn();
    await vi.advanceTimersByTimeAsync(PI_DEADLINE_MS - 1000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    const report = await pending;
    expect(PI_DEADLINE_MS).toBe(60_000);
    expect(piSignal.aborted).toBe(true);
    expect(report.pi).toEqual({ status: "failed", error: "pi.dev did not answer in full within 60 s" });
    expect([report.ok, report.upstream.status]).toEqual([true, "updated"]);
    expect(filesUnder(join(dataDir, "pi"))).toEqual(piBefore);
    expect(statusOf(dataDir)).toMatchObject({ last_attempt_ok: true, pi: { status: "failed", error: "pi.dev did not answer in full within 60 s" } });
    expect(existsSync(join(dataDir, ".sync.lock"))).toBe(false);
    // Only the pi request has a deadline: the models.dev and measurements downloads are as they were.
    expect(otherSignals.length).toBeGreaterThan(0);
    expect(otherSignals.every((signal) => signal === undefined)).toBe(true);
  });
});
