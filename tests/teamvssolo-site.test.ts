// teamvssolo.providers.dev: the results site of the Team vs Solo benchmark, a fifth address of the Worker
// (src/core/teamvssolo-site.ts). Its pages are built from one file, data/teamvssolo/results.json, in the benchmark's
// published shape. Until the first round is complete there is no such file: the site is live with the question, the
// method and the tests, says that the round is being played, and has no page of results or of a run. The tests make
// their own records (run, below), with made-up names and numbers. The routing is the one every product site shares
// (src/core/product-site.ts).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { siteRoute } from "../src/core/product-site.ts";
import type { AssetBinding } from "../src/core/snapshot.ts";
import { auditWords, boards, clock, endedWords, isSample, judgedInFull, median, MODEL_ENTRIES, parseResults, roleView, routeWords, runPath, shownRuns, statusWords, TESTS, toolName, usd, whyNotRanked, type Results, type RunRecord } from "../src/core/teamvssolo.ts";
import { readResults, RESULTS_FILE, teamVsSoloBoards, teamVsSoloResults } from "../src/core/teamvssolo-data.ts";
import { movedToTeamVsSolo, TEAMVSSOLO, TEAMVSSOLO_PAGE_FAMILIES, TEAMVSSOLO_PAGES, TEAMVSSOLO_SITE } from "../src/core/teamvssolo-site.ts";
import worker from "../worker/index.ts";
import { ROOT, tempDataDir } from "./helpers.ts";

const HOST = "https://teamvssolo.providers.dev";
const ROUTE = '{ "pattern": "teamvssolo.providers.dev", "custom_domain": true }';

/** A build with the product sites' files only: no snapshot, so a request that read the dataset would fail. */
function assets() {
  const dist = tempDataDir();
  const files: Record<string, string> = {
    "teamvssolo/index.html": "<h1>Team vs Solo home</h1>",
    "teamvssolo/index.html.md": "# Team vs Solo home",
    "teamvssolo/results/index.html": "<h1>Results</h1>",
    "teamvssolo/results/alpha/index.html": "<h1>Alpha results</h1>",
    "teamvssolo/runs/alpha/full/lead-a--helper-b/active/2/index.html": "<h1>One run</h1>",
    "teamvssolo/runs/alpha/full/lead-a--helper-b/active/2/index.html.md": "# One run",
    "teamvssolo/tests/index.html": "<h1>Tests</h1>",
    "teamvssolo/method/index.html": "<h1>Method</h1>",
    "teamvssolo/not-found/index.html": "<h1>Nothing at this address</h1>",
    "teamvssolo/og.png": "png",
    "teamvssolo/robots.txt": "User-agent: *",
    "teamvssolo/sitemap.xml": "<urlset/>",
    "teamvssolo/llms.txt": "# Team vs Solo",
    "provimux/index.html": "<h1>Provimux home</h1>",
    "_astro/site.css": "body{}",
    "site-shell/index.html": "providers.dev shell",
  };
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dist, path)), { recursive: true });
    writeFileSync(join(dist, path), body);
  }
  const reads: string[] = [];
  const binding: AssetBinding = { async fetch(request) {
    const path = new URL(typeof request === "string" ? request : request.url).pathname;
    reads.push(path);
    const file = join(dist, path.endsWith("/") ? `${path}index.html` : path);
    return existsSync(file) ? new Response(readFileSync(file)) : new Response(null, { status: 404 });
  } };
  return { binding, reads };
}
const get = (binding: AssetBinding, url: string, init: RequestInit = {}) => worker.fetch(new Request(url, init), { ASSETS: binding });

describe("teamvssolo.providers.dev on the Worker", () => {
  it("serves its pages and its files at the subdomain's root, from the build's teamvssolo folder", async () => {
    const { binding, reads } = assets();
    for (const [path, words] of [["/", "Team vs Solo home"], ["/results/", "Results"], ["/results/alpha/", "Alpha results"], ["/runs/alpha/full/lead-a--helper-b/active/2/", "One run"], ["/tests/", "Tests"], ["/method/", "Method"]] as const) {
      const response = await get(binding, `${HOST}${path}`);
      expect([path, response.status]).toEqual([path, 200]);
      expect(await response.text(), path).toContain(words);
      expect(response.headers.get("Link"), path).toBe(`<${HOST}${path}index.html.md>; rel="alternate"; type="text/markdown", <${HOST}/llms.txt>; rel="describedby"`);
    }
    for (const path of ["/og.png", "/robots.txt", "/sitemap.xml", "/llms.txt", "/_astro/site.css"]) expect([path, (await get(binding, `${HOST}${path}`)).status]).toEqual([path, 200]);
    // Every file but Astro's shared stylesheets is the subdomain's own: never another site's, never the dataset.
    expect(reads.every((path) => path.startsWith("/teamvssolo/") || path === "/_astro/site.css")).toBe(true);
  });

  it("gives a run's page as markdown to a reader that asks for it, and names the page as the one to show", async () => {
    const { binding } = assets();
    const path = "/runs/alpha/full/lead-a--helper-b/active/2/";
    const negotiated = await get(binding, `${HOST}${path}`, { headers: { Accept: "text/markdown" } });
    expect([negotiated.status, negotiated.headers.get("Content-Type"), await negotiated.text()]).toEqual([200, "text/markdown; charset=utf-8", "# One run"]);
    const file = await get(binding, `${HOST}${path}index.html.md`);
    expect([file.status, file.headers.get("Content-Type"), file.headers.get("Link")]).toEqual([200, "text/markdown; charset=utf-8", `<${HOST}${path}>; rel="canonical"`]);
  });

  it("answers anything else there with its own page and status 404: no API, no providers.dev page, no run the build lacks", async () => {
    const { binding, reads } = assets();
    for (const path of ["/api/v1/meta", "/providers/", "/support/", "/teamvssolo/", "/provimux/", "/not-found/", "/index.html", "/results/nothing/", "/runs/alpha/full/solo-nobody/solo/1/", "/runs/alpha/", "/runs/alpha/full/a/team/1/", "/media/missing.png"]) {
      const response = await get(binding, `${HOST}${path}`);
      expect([path, response.status, response.headers.get("Content-Type"), response.headers.get("Cache-Control")]).toEqual([path, 404, "text/html; charset=utf-8", "no-store"]);
      expect(await response.text(), path).toContain("Nothing at this address");
    }
    expect(reads.some((path) => path.startsWith("/snapshots/") || path === "/current.json" || path.startsWith("/site-shell") || path.startsWith("/provimux"))).toBe(false);
  });

  it("answers GET and HEAD only, sends an address without its final slash to the one with it, and plain http at the edge to https", async () => {
    const { binding } = assets();
    expect((await get(binding, `${HOST}/`, { method: "POST" })).status).toBe(405);
    expect((await get(binding, `${HOST}/method/`, { method: "HEAD" })).status).toBe(200);
    for (const path of ["/method", "/results/alpha", "/runs/alpha/full/lead-a--helper-b/active/2"]) {
      const response = await get(binding, `${HOST}${path}?x=1`);
      expect([path, response.status, response.headers.get("Location")]).toEqual([path, 301, `${HOST}${path}/?x=1`]);
    }
    const edge = await get(binding, "http://teamvssolo.providers.dev/method/?x=1", { headers: { "X-Forwarded-Proto": "http" } });
    expect([edge.status, edge.headers.get("Location")]).toEqual([301, `${HOST}/method/?x=1`]);
    expect((await get(binding, "http://teamvssolo.providers.dev/")).status).toBe(200);
  });

  it("routes a path by the shared rules, with the pages its results file gives told by the shape of their address", () => {
    expect(TEAMVSSOLO_PAGES).toEqual(["/", "/results/", "/tests/", "/method/"]);
    expect(TEAMVSSOLO).toEqual({ site: HOST, host: "teamvssolo.providers.dev", assets: "/teamvssolo", notFound: "/teamvssolo/not-found/", pages: TEAMVSSOLO_PAGES, families: TEAMVSSOLO_PAGE_FAMILIES });
    expect(siteRoute(TEAMVSSOLO, "/results/beta/")).toEqual({ asset: "/teamvssolo/results/beta/", status: 200 });
    expect(siteRoute(TEAMVSSOLO, "/runs/beta/full/solo-a/solo/3/")).toEqual({ asset: "/teamvssolo/runs/beta/full/solo-a/solo/3/", status: 200 });
    for (const path of ["/runs/", "/runs/beta/full/solo-a/solo/0/", "/runs/beta/full/solo-a/duo/1/", "/runs/Beta/full/x/solo/1/", "/runs/beta/full/a+b/active/1/", "/results/a/b/", "//evil.example/results/"]) {
      expect(siteRoute(TEAMVSSOLO, path), path).toEqual({ asset: "/teamvssolo/not-found/", status: 404 });
    }
  });

  it("is sent to from providers.dev: anything under /teamvssolo/ goes to the same path on the subdomain, before reading anything", async () => {
    const { binding, reads } = assets();
    for (const [path, location] of [["/teamvssolo", `${HOST}/`], ["/teamvssolo/method/?a=b", `${HOST}/method/?a=b`], ["/teamvssolo/og.png", `${HOST}/og.png`]] as const) {
      const response = await get(binding, `https://providers.dev${path}`, { headers: { "X-Forwarded-Proto": "https" } });
      expect([path, response.status, response.headers.get("Location")]).toEqual([path, 301, location]);
    }
    expect(reads).toEqual([]);
    for (const path of ["/", "/teamvssolox/", "/team/", "/docs/methodology/"]) expect(movedToTeamVsSolo(new URL(`https://providers.dev${path}`)), path).toBeNull();
  });
});

describe("going live", () => {
  it("has the subdomain as a custom domain of the Worker", () => {
    expect(readFileSync(join(ROOT, "wrangler.jsonc"), "utf8")).toContain(ROUTE);
  });

  it("publishes no sample: the build refuses one, and the repository holds real results or none", () => {
    const sample = join(tempDataDir(), "results.json");
    writeFileSync(sample, JSON.stringify(file([run({ setup: "solo-a" })], null, null)));
    expect(() => readResults(sample)).toThrow(/is not results the benchmark built from a clean commit \(a sample\?\): it is never published/);
    const published = teamVsSoloResults(ROOT);
    expect(published === null ? !existsSync(join(ROOT, RESULTS_FILE)) : !isSample(published)).toBe(true);
  });
});

/** A run of a made-up file: the keys the pages read, each as plain as can be. */
function run(more: { suite?: string; domain?: string; setup: string; mode?: RunRecord["mode"]; n?: number; passed?: number[]; usd?: number | null; seconds?: number; ranked?: boolean; unranked_why?: string | null; status?: string; status_why?: string | null; ended_by?: string; round?: string | null; state?: string; model?: string }): unknown {
  const mode = more.mode ?? "solo";
  const role = { harness: "claude", model: more.model ?? "claude-fable-5-2", family: "claude", models_dev: null, effort: "high", route: "claude-subscription", count: 1, sessions: 1, calls: 10, tokens: null, usd_at_list: more.usd ?? null, complete: true };
  const suite = more.suite ?? "alpha";
  return {
    schema: "team-vs-solo-record-v1", id: `${suite}/full/${more.setup}/${mode}/${more.n ?? 1}`, round: more.round === undefined ? "round-1" : more.round, repeat: { n: more.n ?? 1, of: null }, runner: { version: "0.12.0" },
    suite: { name: suite, version: "1", domain: more.domain ?? "backend", request: "full" }, mode, setup: { name: more.setup, parallel: 2, time_limit_minutes: null },
    roles: { chief: role, worker: mode === "solo" ? null : { ...role, model: "claude-sonnet-5-5" }, reviewer: null },
    versions: { harnesses: [{ name: "claude", before: "2.1.325", after: "2.1.325" }], prices: { version: 3, fetched: "2026-11-30" }, node: "24.11.1", machine: null, toolchains: null },
    started_at: "2026-12-01T10:00:00.000Z", ended_at: null, ended_by: more.ended_by ?? "done-word", status: more.status ?? "done", status_why: more.status_why ?? null, ranked: more.ranked ?? true, unranked_why: more.unranked_why ?? null,
    owner: null, owner_change: null,
    quality: { checks: (more.passed ?? [10, 5]).map((passed, i) => ({ name: i === 0 ? "first" : "second", kind: "tests", state: more.state ?? "scored", passed: more.state === "not-judged" ? null : passed, total: more.state === "not-judged" ? null : i === 0 ? 20 : 10, parts: null, not_judged: more.state === "not-judged" ? 3 : 0 })), scored_again: [] },
    time: { wall_seconds: more.seconds ?? 3600, to_first_task: null, most_at_once: null }, cost: { usd_at_list: more.usd === undefined ? 10 : more.usd, complete: true }, windows: [], messages: null,
    validity: { read_audit: { verdict: "clean", complete: true }, look: null, mode_kept: null, lock: { on_every_session: true, not_expected: 0 }, network: { complete: true } },
  };
}
const file = (runs: unknown[], commit: string | null = "a".repeat(40), dirty: boolean | null = false): Results =>
  parseResults({ schema: "team-vs-solo-results-v1", built_at: "2026-12-05T00:00:00.000Z", built_from: { commit, dirty }, suites: [{ name: "alpha", version: "1", domain: "backend", checks: [{ name: "first", kind: "tests" }, { name: "second", kind: "tests" }], runs: runs.length }], runs });

describe("the results file as the pages read it", () => {
  it("takes a file as real results only when the benchmark built it from a clean commit and no round is a sample's", () => {
    const real = [run({ setup: "solo-a" })];
    expect(isSample(file(real))).toBe(false);
    expect(isSample(file(real, null, null))).toBe(true);
    expect(isSample(file(real, "a".repeat(40), true))).toBe(true);
    expect(isSample(file([run({ setup: "solo-a", round: "sample-round-1" })]))).toBe(true);
    expect(isSample(file([run({ setup: "solo-a", round: null })]))).toBe(true);
  });

  it("refuses a file it cannot read, naming the key, and two runs with one id", () => {
    expect(() => parseResults({ schema: "team-vs-solo-results-v1" })).toThrow(/is not a results file the pages can read: built_at/);
    expect(() => parseResults({ ...file([]), schema: "other" })).toThrow(/schema/);
    expect(() => file([run({ setup: "solo-a" }), run({ setup: "solo-a" })])).toThrow(/two runs with the id alpha\/full\/solo-a\/solo\/1/);
    expect(() => file([{ ...(run({ setup: "solo-a" }) as object), id: "/etc/passwd" }])).toThrow(/runs\.0\.id/);
  });

  it("shows the middle run of a setup's ranked runs, and never counts a run that is not ranked", () => {
    expect([median([]), median([3]), median([5, 1, 3]), median([4, 1])]).toEqual([null, 3, 3, 2.5]);
    const [board] = boards(file([
      run({ setup: "solo-a", n: 1, passed: [12, 5], usd: 30, seconds: 100 }),
      run({ setup: "solo-a", n: 2, passed: [18, 9], usd: 10, seconds: 300 }),
      run({ setup: "solo-a", n: 3, passed: [14, 7], usd: 20, seconds: 200 }),
      run({ setup: "solo-a", n: 4, passed: [20, 10], usd: 1, seconds: 1, ranked: false, unranked_why: "price-unknown" }),
    ]));
    const row = board!.solos[0]!;
    expect([row.runs.length, row.ranked.length, row.passed, row.usd, row.seconds]).toEqual([4, 3, [14, 7], 20, 200]);
    expect([board!.runs, board!.ranked, board!.maxUsd, board!.maxSeconds]).toEqual([4, 3, 30, 300]);
  });

  it("puts the solos first and each group best first: the first check, then the next, then the lower price; a row with no ranked run last", () => {
    const [board] = boards(file([
      run({ setup: "solo-b", passed: [15, 9] }), run({ setup: "solo-a", passed: [15, 8] }), run({ setup: "solo-c", passed: [16, 1] }),
      run({ setup: "solo-d", passed: [20, 10], ranked: false, status: "cut", ended_by: "no-progress", unranked_why: "no-progress" }),
      run({ setup: "a+w", mode: "active", passed: [16, 1], usd: 9 }), run({ setup: "a+w", mode: "delegation", passed: [16, 1], usd: 8 }), run({ setup: "b+w", mode: "active", passed: [17, 0] }),
    ]));
    expect(board!.solos.map((row) => row.setup)).toEqual(["solo-c", "solo-b", "solo-a", "solo-d"]);
    expect(board!.teams.map((row) => row.key)).toEqual(["b+w/active", "a+w/delegation", "a+w/active"]);
    expect([board!.best?.setup, board!.solos.map((row) => row.best)]).toEqual(["solo-c", [true, false, false, false]]);
  });

  it("counts a team as matching the best solo only when it passed as many cases in every check, and then compares price and time", () => {
    const [board] = boards(file([
      run({ setup: "solo-a", passed: [15, 8], usd: 20, seconds: 1000 }),
      run({ setup: "t1+w", mode: "active", passed: [15, 8], usd: 19, seconds: 900 }),
      run({ setup: "t2+w", mode: "active", passed: [18, 9], usd: 25, seconds: 800 }),
      run({ setup: "t3+w", mode: "active", passed: [19, 7], usd: 5, seconds: 100 }),
      run({ setup: "t4+w", mode: "active", passed: [16, 8], usd: 20, seconds: 1000 }),
      run({ setup: "t5+w", mode: "active", passed: [20, 10], usd: 1, seconds: 1, ranked: false, status: "void", status_why: "mode-not-kept" }),
    ]));
    expect(board!.answer).toEqual({ teams: 4, matched: 3, cheaper: 1, faster: 2, both: 1 });
    expect(board!.teams.filter((row) => row.matched).map((row) => row.setup).sort()).toEqual(["t1+w", "t2+w", "t4+w"]);
    // With no ranked solo there is nothing to compare with.
    expect(boards(file([run({ setup: "t1+w", mode: "active" })]))[0]!.answer).toBeNull();
  });

  it("shows the benchmark's tests only, never its own trial suites", () => {
    const made = file([run({ setup: "solo-a" }), run({ suite: "smoke", domain: "smoke", setup: "solo-a" }), run({ suite: "trial", domain: "proof", setup: "solo-a" }), run({ suite: "toy", domain: "toy", setup: "solo-a" })]);
    expect(shownRuns(made).map((item) => item.suite.name)).toEqual(["alpha"]);
    expect(boards(made).map((board) => board.suite)).toEqual(["alpha"]);
  });

  it("says in plain words why a run is not ranked, for every word a record can carry", () => {
    // The words of the record's vocabularies the pages say in words.
    const vocabularies: Record<string, string[]> = {
      unranked_why: ["no-audit", "needs-look", "change-unanswered", "no-progress", "runaway-price", "price-stop", "price-unknown", "not-judged", "suite-dirty", "pin-not-matched", "parts-missing", "model-mismatch", "extension-changed"],
      status_why: ["read-outside", "mode-not-kept", "by-hand", "owner-setup-seen", "scoring-failed"],
      ended_by: ["done-word", "chief-ended", "owner-turns-used-up", "time-up", "price-stop", "no-progress", "runaway-price", "chief-failed", "aborted", "runner-error"],
      status: ["done", "cut", "stopped", "failed", "void"],
      route: ["claude-subscription", "codex-subscription", "anthropic-api", "openai-api", "proxy-subscription-pool", "proxy-key", "unknown"],
      harness: ["claude", "codex", "pi"],
      read_audit_verdict: ["clean", "outside", "suspect", "void", "incomplete"],
    };
    const sentence = /^[A-Z][^_]*\.$/;
    for (const word of vocabularies.unranked_why!) expect([word, sentence.test(whyNotRanked(parseResults({ ...file([run({ setup: "solo-a", ranked: false, unranked_why: word })]) }).runs[0]!)!)]).toEqual([word, true]);
    for (const word of vocabularies.status_why!) expect([word, sentence.test(whyNotRanked(file([run({ setup: "solo-a", ranked: false, status: "void", status_why: word })]).runs[0]!)!)]).toEqual([word, true]);
    for (const word of vocabularies.ended_by!) expect([word, sentence.test(endedWords(word))]).toEqual([word, true]);
    for (const word of vocabularies.status!) expect([word, statusWords(word)]).not.toEqual([word, word]);
    for (const word of vocabularies.route!) expect([word, routeWords(word)]).not.toEqual([word, word]);
    for (const word of vocabularies.harness!) expect([word, toolName(word)]).not.toEqual([word, word]);
    for (const word of vocabularies.read_audit_verdict!) expect([word, sentence.test(auditWords(word))]).toEqual([word, true]);
    expect(whyNotRanked(file([run({ setup: "solo-a" })]).runs[0]!)).toBeNull();
    expect(whyNotRanked(file([run({ setup: "solo-a", ranked: false, status: "cut", ended_by: "time-up" })]).runs[0]!)).toBe("It reached its time limit.");
  });

  it("says whether a run was judged in full, and gives a check that was not no number", () => {
    expect(judgedInFull(file([run({ setup: "solo-a" })]).runs[0]!)).toEqual({ full: true, words: "Yes. Every case of every check was judged." });
    const open = judgedInFull(file([run({ setup: "solo-a", state: "not-judged", ranked: false, unranked_why: "not-judged" })]).runs[0]!);
    expect([open.full, open.words]).toEqual([false, "No. first: 3 cases could not be judged; second: 3 cases could not be judged. A check that is not judged in full gets no number."]);
  });

  it("names a model plainly and links its entry on providers.dev: the record's own id first, else the site's, else none", () => {
    const role = (model: string, models_dev: string | null = null) => roleView({ harness: "pi", model, family: null, models_dev, effort: null, route: "proxy-subscription-pool", count: 1, sessions: 1, calls: null, tokens: null, usd_at_list: null, complete: true });
    expect(role("provimux/claude-sonnet-5-5")).toMatchObject({ name: "Claude Sonnet 5.5", short: "Sonnet 5.5 in Pi", entry: "https://providers.dev/entries/anthropic/claude-sonnet-5-5", gateway: true, tool: "Pi", how: "effort not set, Pi through Provimux" });
    expect(role("claude-sonnet-5-5", "openrouter/claude-sonnet-5-5").entry).toBe("https://providers.dev/entries/openrouter/claude-sonnet-5-5");
    expect(role("provimux/devin/swe-2.1")).toMatchObject({ name: "SWE-2.1", entry: null });
    expect(role("some-new-model")).toMatchObject({ name: "some-new-model", entry: null, gateway: false });
    // Every entry the site links for a model of the round is in the catalog it imports.
    for (const entry of MODEL_ENTRIES) {
      const [provider, model] = entry.split("/") as [string, string];
      const catalog = JSON.parse(readFileSync(join(ROOT, "data", "upstream", "providers", `${provider}.json`), "utf8")) as { models: Record<string, unknown> };
      expect([entry, model in catalog.models]).toEqual([entry, true]);
    }
    expect([usd(38.2), usd(1234.5), clock(40), clock(2880), clock(7500)]).toEqual(["$38.20", "$1,234.50", "40 s", "48 min", "2 h 05 min"]);
  });
});

describe("made-up runs, as the pages would show them", () => {
  it("breaks a tie on every check by the lower price, then the shorter time, then the setup's name", () => {
    const [board] = boards(file([
      run({ setup: "solo-c", passed: [10, 5], usd: 10, seconds: 500 }),
      run({ setup: "solo-b", passed: [10, 5], usd: 10, seconds: 400 }),
      run({ setup: "solo-a", passed: [10, 5], usd: 10, seconds: 400 }),
      run({ setup: "solo-d", passed: [10, 5], usd: 9, seconds: 900 }),
    ]));
    expect(board!.solos.map((row) => row.setup)).toEqual(["solo-d", "solo-a", "solo-b", "solo-c"]);
    expect(board!.best?.setup).toBe("solo-d");
  });

  it("lists a setup whose runs are none of them ranked, counts none of them, and gives it no middle run", () => {
    const [board] = boards(file([
      run({ setup: "solo-a", n: 1, ranked: false, status: "cut", ended_by: "no-progress", unranked_why: "no-progress" }),
      run({ setup: "solo-a", n: 2, ranked: false, unranked_why: "not-judged", state: "not-judged" }),
    ]));
    const row = board!.solos[0]!;
    expect([row.runs.length, row.ranked.length, row.passed, row.usd, row.seconds, board!.ranked, board!.best, board!.answer]).toEqual([2, 0, [null, null], null, null, 0, null, null]);
  });

  it("gives every run its own page address, of the shape the Worker serves", () => {
    const made = file([run({ setup: "solo-a", n: 1 }), run({ setup: "solo-a", n: 2 }), run({ setup: "lead-a+helper-b", mode: "delegation" }), run({ setup: "lead-a+helper-b", mode: "active", n: 3 })]);
    const paths = made.runs.map((item) => runPath(item.id));
    expect(new Set(paths).size).toBe(paths.length);
    for (const path of paths) expect([path, siteRoute(TEAMVSSOLO, path)]).toEqual([path, { asset: `/teamvssolo${path}`, status: 200 }]);
    expect(runPath("alpha/full/lead-a+helper-b/active/2")).toBe("/runs/alpha/full/lead-a--helper-b/active/2/");
  });
});

describe("Team vs Solo's pages", () => {
  const source = (...path: string[]) => readFileSync(join(ROOT, ...path), "utf8");
  const walk = (folder: string): string[] => readdirSync(join(ROOT, folder), { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(folder, entry.name)) : [join(folder, entry.name)]));
  const files = [...walk(join("src", "pages", "teamvssolo")), ...walk(join("src", "components", "teamvssolo")), join("src", "layouts", "TeamVsSolo.astro"), join("src", "core", "teamvssolo.ts"), join("src", "core", "teamvssolo-site.ts"), join("src", "core", "teamvssolo-data.ts"), join("src", "styles", "teamvssolo.css")];
  const layout = source("src", "layouts", "TeamVsSolo.astro");
  const text = files.map((path) => source(path)).join("\n").replace(/\s+/g, " ");

  it("say nothing of sample data, and ask not to be indexed only where a page has no address of its own", () => {
    for (const path of files.filter((item) => !item.endsWith(".ts"))) expect([path, /sample/i.test(source(path).replace(/one run is one sample/gi, ""))]).toEqual([path, false]);
    expect(layout).toContain('{canonical === null && <meta name="robots" content="noindex" />}');
  });

  it("have a canonical address on the subdomain, a robots.txt that names its sitemap, and their own icons", () => {
    expect(layout).toContain("const canonical = path === null ? null : new URL(path, TEAMVSSOLO_SITE).toString();");
    expect(TEAMVSSOLO_SITE).toBe(HOST);
    expect(source("public", "teamvssolo", "robots.txt")).toContain(`Sitemap: ${HOST}/sitemap.xml`);
    // The sitemap is written at build, from the pages the results file gives (scripts/finalize-site.ts).
    expect(readdirSync(join(ROOT, "public", "teamvssolo")).sort()).toEqual(["apple-touch-icon.png", "favicon.ico", "favicon.svg", "og.png", "robots.txt"]);
    expect(source("src", "pages", "teamvssolo", "not-found", "index.astro")).toContain("path={null}");
  });

  it("describe each test in a paragraph, with the size of its checks", () => {
    expect(TESTS.map((test) => test.name)).toEqual(["tally", "conduit", "valkey", "ferry"]);
    for (const words of ["440 hidden tests and 67 harder probes", "157 through the API, 139 in a browser and 13 more", "1,707 cases", "the groups of behaviour held, out of the groups counted"]) expect(text, words).toContain(words);
  });

  it("keep to the public wording: the modes as the benchmark describes them, no other e-mail, no local paths, no board numbers, no promises", () => {
    for (const words of ["/Users/", "guaranteed", "cheapest", "always better", "proves"]) expect(text.toLowerCase().includes(words.toLowerCase()), words).toBe(false);
    // The only products the pages name are the coding tools a run used, and the gateway a model was reached through.
    expect([...new Set(text.match(/\b(Claude Code|Codex|Pi|Provimux)\b/g))].sort()).toEqual(["Claude Code", "Codex", "Pi", "Provimux"]);
    expect(text, "a task number").not.toMatch(/\b[TmM]-\d{2,}\b/);
    for (const address of text.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? []) expect(address).toBe("office@providers.dev");
    // Small samples are said where the numbers are.
    for (const words of ["Most rows rest on a single run, so a small gap between two rows says little.", "rows rest on a single run.", "One run is one sample", "It is not what was paid."]) expect(text, words).toContain(words);
  });

  // The pages as Astro builds them.
  const built = join(ROOT, "dist", "teamvssolo");
  const page = (path: string): string => readFileSync(join(built, path, "index.html"), "utf8");
  it.skipIf(!existsSync(join(built, "index.html")))("are built for every page the results give, each indexable, with its markdown version and a place in the sitemap", () => {
    const all = teamVsSoloBoards(ROOT);
    const runs = all.flatMap((board) => [...board.solos, ...board.teams].flatMap((row) => row.runs));
    const paths = [...TEAMVSSOLO_PAGES, ...all.map((board) => `/results/${board.suite}/`), ...runs.map((item) => runPath(item.id))];
    const sitemap = [...readFileSync(join(built, "sitemap.xml"), "utf8").matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]!);
    expect([...sitemap].sort()).toEqual(paths.map((path) => `${HOST}${path}`).sort());
    for (const path of paths) {
      const html = page(path);
      expect([path, html.includes('<meta name="robots" content="noindex">'), html.includes(`<link rel="canonical" href="${HOST}${path}">`), /sample/i.test(html.replace(/one run is one sample/gi, ""))]).toEqual([path, false, true, false]);
      expect([path, (html.match(/<h1/g) ?? []).length]).toEqual([path, 1]);
      expect([path, existsSync(join(built, path, "index.html.md"))]).toEqual([path, true]);
      // Every link of a page to a page of the site is to one the build has.
      for (const [, href] of html.matchAll(/<a[^>]* href="(\/[^"#?]*)(?:#[^"]*)?"/g)) expect([path, href, existsSync(join(built, href!, "index.html"))]).toEqual([path, href, true]);
    }
    const llms = readFileSync(join(built, "llms.txt"), "utf8");
    expect(llms).toMatch(/^# Team vs Solo\n\n> A benchmark of coding models by providers\.dev/);
    for (const path of TEAMVSSOLO_PAGES) expect(llms).toContain(`(${HOST}${path}index.html.md)`);
  });

  it.skipIf(!existsSync(join(built, "index.html")) || teamVsSoloResults(ROOT) !== null)("say, while there are no results, that the first round is being played, and build no page of results or of a run", () => {
    const words = "The first round is being played. Its results appear here when it is complete.";
    for (const path of ["/", "/results/"]) {
      expect([path, page(path).replace(/\s+/g, " ").includes(words)]).toEqual([path, true]);
      expect([path, readFileSync(join(built, path, "index.html.md"), "utf8").replace(/\s+/g, " ").includes(words)]).toEqual([path, true]);
    }
    expect(existsSync(join(built, "runs"))).toBe(false);
    expect(readdirSync(join(built, "results"))).toEqual(["index.html", "index.html.md"]);
    // No number of a run, no ranking, no date of a round: the pages hold the question, the method and the tests.
    const front = page("/").replace(/\s+/g, " ");
    for (const words of ["Best solo", "teams passed", "ranked", "$"]) expect([words, front.includes(words)]).toEqual([words, false]);
    const method = page("/method/").replace(/\s+/g, " ");
    expect(method.includes("How these pages count")).toBe(false);
  });
});
