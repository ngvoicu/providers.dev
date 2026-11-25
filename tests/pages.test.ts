import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { publish } from "../scripts/lib/publish.ts";
import { stageSnapshot } from "../scripts/lib/stage.ts";
import { sync } from "../scripts/lib/sync.ts";
import { handleApi, type ApiDeps, type LoadedDeps } from "../src/core/api.ts";
import { CorrectionSchema, DocumentationSchema, FacetsSchema, one, pageOf } from "../src/core/contract.ts";
import { escapeHtml } from "../src/core/format.ts";
import { fillShell, MARK } from "../src/core/page-shell.ts";
import { handlePage, type PageDeps } from "../src/core/pages.ts";
import { openapi } from "../src/core/openapi.ts";
import { PARAMS } from "../src/core/query.ts";
import { DOCUMENTS } from "../src/core/resources.ts";
import { readSnapshot, type AssetBinding } from "../src/core/snapshot.ts";
import worker from "../worker/index.ts";
import type { PiCatalog } from "../src/core/pi.ts";
import type { Summary } from "../src/core/entries.ts";
import type { JsonObject } from "../src/core/merge.ts";
import type { Meta } from "../src/core/schema.ts";
import { depsFrom, fetchReturning, fixturePi, fixtureUpstream, ROOT, tempDataDir, writeAuthored, writePiSnapshot } from "./helpers.ts";

const shell = `<html><head><title>${MARK.title} · providers.dev</title><meta name="description" content="${MARK.description}">${MARK.head}</head><body><nav>${MARK.nav}</nav><main>${MARK.html}</main><footer>${MARK.dataset}</footer></body></html>`;
const now = () => new Date("2026-11-14T12:00:00Z");
let deps: LoadedDeps;
let dataDir: string;

beforeAll(async () => {
  dataDir = tempDataDir();
  await sync({ dataDir, fetch: fetchReturning(JSON.stringify(fixtureUpstream())) });
  writeAuthored(dataDir);
  expect(publish({ dataDir, rootDir: ROOT, now }).errors).toEqual([]);
  deps = depsFrom(join(dataDir, "published"));
});

const api = (path: string) => handleApi(new Request(`https://providers.dev${path}`), deps);
const pageDeps = (read = api): PageDeps => ({ api: read, shell: async () => new Response(shell), site: "https://providers.dev", now });
const page = (path: string, read = api) => handlePage(new Request(`https://providers.dev${path}`), pageDeps(read));

describe("API response boundary", () => {
  it("serves filter options, grouped corrections, provider search and reference content through documented contracts", async () => {
    const facets = one(FacetsSchema).parse(await (await api("/api/v1/facets")).json()).data;
    expect(facets.providers).toHaveLength(31);
    expect(facets.types).toEqual(["chat", "embedding"]);
    const corrections = pageOf(CorrectionSchema).parse(await (await api("/api/v1/corrections?provider=provider-01")).json());
    expect(corrections.data[0]?.entry_refs).toEqual(["provider-01/model-1"]);
    expect(corrections.data[0]?.change.value).toBe(5000000);
    expect((await (await api("/api/v1/providers?q=Provider%202&limit=200")).json() as { data: { id: string }[] }).data.every((item) => item.id.includes("2"))).toBe(true);
    one(DocumentationSchema).parse(await (await api("/api/v1/docs/methodology")).json());
    one(DocumentationSchema).parse(await (await api("/api/v1/docs/contributing")).json());
    expect((await api("/api/v1/docs/missing")).status).toBe(404);
    expect((await api("/api/v1/corrections?limit=0")).status).toBe(400);
  });

  it("renders every public page family from API responses, without access to an index or catalog", async () => {
    const routes = [
      ["/?provider=provider-02&limit=2&offset=2", "/api/v1/entries?"],
      ["/providers/?q=Provider", "/api/v1/providers?q="],
      ["/providers/provider-02/", "/api/v1/providers/provider-02"],
      ["/models/?q=model", "/api/v1/models?q="],
      ["/models/lab/model-4/", "/api/v1/models/lab/model-4"],
      ["/entries/provider-02/lab/model-4", "/api/v1/entries/provider-02/lab/model-4"],
      ["/evidence/", "/api/v1/corrections?"],
      ["/docs/api/", "/api/v1/openapi.json"],
      ["/docs/methodology/", "/api/v1/docs/methodology"],
      ["/docs/licensing/", "/api/v1/docs/licensing"],
      ["/docs/contributing/", "/api/v1/docs/contributing"],
    ];
    for (const [path, endpoint] of routes) {
      const calls: string[] = [];
      const response = await page(path!, async (path) => { calls.push(path); return api(path); });
      expect(response.status, path).toBe(200);
      const html = await response.text();
      expect(html).not.toContain("%%PAGE_");
      expect(html).toContain(deps.meta.dataset_version);
      expect(calls.some((call) => call.startsWith(endpoint!)), path).toBe(true);
      expect(calls.every((call) => call.startsWith("/api/v1/"))).toBe(true);
    }
  });

  it("prints a provider's models from /api/v1/providers/{provider} and /api/v1/listings/{provider}, as the API answers them, in one table", async () => {
    const calls: string[] = [];
    const listing = {
      provider: "provider-02", basis: "listed", listed_at: "2026-11-13", client: "provimux", client_label: "API response only", model_count: 2,
      lists: { listed: { listed_at: "2026-11-13", model_count: 1 }, "providers.dev": null, "models.dev": { listed_at: "2026-11-12", model_count: 1 }, "pi.dev": null },
      evidence: [{ kind: "listed", url: "https://example.com/listed.json", date: "2026-11-13", note: null }],
      models: [
        { id: "lab/model-4", name: "Model four", entry: { provider: "provider-02", model: "lab/model-4" }, listed_by: ["models.dev"] },
        { id: "not-an-entry", name: "Not an entry", entry: null, plans: ["pro"], listed_by: ["listed"] },
      ].map((model) => ({
        owner: null, canonical: null, released: null, context_window: 2000000, max_input: null, max_output: null, input_modalities: null, output_modalities: null, reasoning: null,
        web_search: null, aliases: [], variants: [], plans: [], hidden: null,
        sources: { name: "listed", owner: null, released: null, context_window: "listed", max_input: null, max_output: null, input_modalities: null, output_modalities: null, reasoning: { supported: null, levels: null, budget_min: null, budget_max: null, can_disable: null, dynamic: null, disable_with: null }, web_search: null, aliases: null, variants: null, plans: null, hidden: null },
        ...model,
      })),
    };
    const html = await (await page("/providers/provider-02/", async (path) => {
      calls.push(path);
      if (path === "/api/v1/listings/provider-02") return Response.json({ meta: { dataset_version: deps.meta.dataset_version }, data: listing });
      return api(path);
    })).text();
    expect(calls).toContain("/api/v1/listings/provider-02");
    // Each list in the facts with its date; one table of models, the entry with a row of its own, the listed model folded under it.
    expect(html).toContain('<dt class="muted">Model lists</dt><dd><span class="sources side"><span class="badge listed" title="The vendor&#39;s own model list, read through API response only: 1 model.">vendor list</span><span class="muted date" title="The day the vendor&#39;s list was read.">2026-11-13</span><span class="origin upstream" title="models.dev&#39;s list of this provider: 1 model.">models.dev</span><span class="muted date" title="Imported from models.dev on this date.">2026-11-12</span></span>');
    expect(html.split("Read from one account&#39;s model list on that date; other plans may offer more or fewer models.").length - 1).toBe(1);
    expect(html).toContain("<div class=\"hint mt-1\">The vendor's list, 2026-11-13. Read from one account&#39;s model list");
    expect(html.split("<table").length - 1).toBe(1);
    expect(html).not.toContain("Model list</h2>");
    expect(html).toContain('<code>lab/model-4</code>');
    expect(html).toContain('<span class="count">1 more model</span>');
    expect(html).toContain('<span class="listed-name">Not an entry</span>');
    expect(html).toContain(">Not evaluated</span>");
    expect(html).toContain(">Plans: pro</div>");
    expect(html).toContain('<span title="2,000,000 tokens. From the vendor&#39;s own list.">2M</span>');
    // As published: the fixture's provider has models.dev's list of it, whose every model has its entry.
    const published = await (await page("/providers/provider-02/")).text();
    expect(published).toContain('<span class="origin upstream" title="models.dev&#39;s list of this provider: ');
    expect(published).toContain('<a href="/api/v1/listings/provider-02"><code>GET /api/v1/listings/provider-02</code></a>');
  });

  it("says a provider has no model list where the API has none for it, and fails where the API cannot answer", async () => {
    expect((await api("/api/v1/listings/added-login")).status).toBe(404);
    const response = await page("/providers/added-login/");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<dt class=\"muted\">Model lists</dt><dd><span class=\"muted\">None yet: no source gives a list of this provider's models.</span></dd>");
    expect(html).not.toContain("more-models");
    expect(html).not.toContain("/api/v1/listings/added-login");
    // A listing the API cannot serve is not "no list": the page is unavailable, as for any other answer it lacks.
    const failed = await page("/providers/provider-02/", async (path) => path.startsWith("/api/v1/listings/") ? new Response(null, { status: 503 }) : api(path));
    expect(failed.status).toBe(503);
  });

  it("uses response values even when they differ from internal dataset objects", async () => {
    const response = await page("/models/lab/model-4/", async (path) => {
      const response = await api(path);
      const body = await response.json() as { data: { name: string; entry_count: number; generated_at: string } };
      if (path === "/api/v1/models/lab/model-4") { body.data.name = "API response only"; body.data.entry_count = 12345; }
      if (path === "/api/v1/meta") body.data.generated_at = "2030-01-02T03:04:00Z";
      return Response.json(body);
    });
    const html = await response.text();
    expect(html).toContain("<h1>API response only</h1>");
    expect(html).toContain("12,345");
    expect(html).toContain("Published 2030-01-02 03:04 UTC");
  });

  it("prints cache lifetimes from safe, and the lifetime each client held under them", async () => {
    // Documented lifetimes, caching with no lifetime, does not cache, nothing known; and the lists.
    const paths = ["/?provider=provider-02&limit=8", "/providers/provider-02/", "/models/lab/model-4/", "/entries/provider-02/lab/model-4", "/entries/provider-02/model-1", "/entries/provider-02/lab/model-2", "/entries/provider-02/model-3"];
    for (const path of paths) {
      const response = await page(path);
      expect(response.status, path).toBe(200);
      const html = await response.text();
      expect(html, path).not.toContain("Cache, measured");
    }
    // model-4 documents 5m and 1h: the two values, and no documented lifetime listed under them.
    const entry = await (await page("/entries/provider-02/lab/model-4")).text();
    expect(entry).toContain("<h3>Cache evaluations</h3>");
    expect(entry).not.toContain('<tbody class="item documented">');
    expect(entry).toContain('<th scope="rowgroup" title="Short retention: the cache a request gets without asking for a lifetime, or with the provider\'s shortest setting.">Short retention</th>');
    expect(entry.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).toContain("Cache lifetime, short Without asking for a lifetime, or with the shortest one 5 min Cache lifetime, long When the request asks for a longer lifetime 1 h");
    const catalog = await (await page("/?provider=provider-02&limit=8")).text();
    expect(catalog).toContain('<td class="life-col" data-label="Cache lifetime"><span class="lifes">');
    expect(catalog).toContain('<a class="plain" href="/entries/provider-02/lab/model-4#cache" title="300 s.">5 min</a>');
  });

  it("prints the context window from safe.input_window of the API's answer, on the lists and on the entry page", async () => {
    // A value that is in no entry of the fixture: whatever the pages print of it, they read from the answer.
    const value = {
      value: 1047604, unit: "tokens", at_least: true, scope: "input", window_tokens: 1050000, source: "measured", date: "2026-11-10", agreement: "single",
      sources: [{ source: "measured", value: 1047604, withheld: false, at_least: true, below: 1050000, scope: "input", date: "2026-11-10", evidence_url: "https://example.com/limits.jsonl", client: "cliproxyapi", client_label: "Requests sent through Provimux", client_kind: "proxy", evaluation_id: null }],
    };
    type Answer = { data: unknown };
    const swapped = async (path: string): Promise<Response> => {
      const response = await api(path);
      if (!/^\/api\/v1\/(entries|providers\/|models\/)/.test(path)) return response;
      const answer = await response.json() as Answer;
      const swap = (inner: unknown, key = ""): unknown => {
        if (Array.isArray(inner)) return inner.map((item) => swap(item));
        if (inner === null || typeof inner !== "object") return inner;
        return Object.fromEntries(Object.entries(inner).map(([name, item]) => [name, key === "safe" && name === "input_window" ? value : swap(item, name)]));
      };
      return Response.json({ ...answer, data: swap(answer.data) });
    };
    for (const path of ["/?provider=provider-02&limit=8", "/providers/provider-02/", "/models/lab/model-4/"]) {
      const html = await (await page(path, swapped)).text();
      expect(html, path).toContain('title="At least 1,047,604 tokens. 1,050,000 including the response.">≥ 1.04M</a>');
      // As published, the fixture's own value.
      const published = await (await page(path)).text();
      expect(published, path).not.toContain("≥ 1.04M");
      expect(published, path).not.toMatch(/class="basis|>documented<|>measured</);
    }
    const entry = await (await page("/entries/provider-02/lab/model-4", swapped)).text();
    expect(entry).toContain('<span class="safe-cell"><span class="bound">at least</span> 1,047,604 <span class="unit">tokens</span></span>');
    expect(entry.split("1,050,000 including the response")).toHaveLength(3);
    const published = await (await page("/entries/provider-02/lab/model-4")).text();
    expect(published).toContain('<h2 id="limits">Limits</h2>');
    expect(published).not.toContain("1,047,604");
  });

  it("says in the methodology how one value per quantity is chosen, when sources disagree, and what the context window is", () => {
    const source = readFileSync(join(ROOT, "src", "pages", "reference-content", "docs", "methodology.astro"), "utf8").replace(/\s+/g, " ");
    for (const words of [
      '{ id: "safe-values", label: "One value per quantity" }', '<h2 id="safe-values">One value per quantity</h2>', "<code>providers_dev.safe</code>",
      '{ id: "input-window", label: "Context window" }', '<h2 id="input-window">Context window</h2>', "In the API its name stays <code>input_window</code>",
      "the client's own system prompt and tool definitions included", "it is what the route accepts, the client's own prompt and tools included, not what is left after them",
      "<strong>Measured</strong>", "<strong>providers.dev</strong>", "<strong>models.dev</strong>", "<strong>pi.dev</strong>",
      "only requests sent straight to the provider count", "the vendor's own client counts first", "<em>Not counted</em>",
      "A price is taken whole from one source, never mixed", "Pi's 0 states nothing", "the cap is the value",
      "at or below 99 %", "at or above 101 %", "A source that states nothing does not disagree", "prices agree only when exactly equal",
      "<code>agreement: \"differ\"</code>", "<code>disagree</code>", "<code>safe.input_window.window_tokens</code>", "rounded down, never up",
      "One account per route.", "goes stale as all providers.dev evidence does", "A refused size is the probe's count, not the provider's.",
      "A window a route names is its total.", "become the value of an entry only where no other source states one",
    ]) expect(source, words).toContain(words);
    // The rules the safe values replaced, and pi's standings, are gone; pi does give a safe value.
    for (const gone of ["Pi's data enters no safe value", "<em>Documentation contradicted</em>", "the lowest decides", "<strong>Pi agrees</strong>", "in two figures only", "<code>limit.context</code> and nothing else"]) expect(source, gone).not.toContain(gone);
    expect(source).not.toContain("limit-value");
  });

  it("serves the four reference documents, and only those, in the API, the OpenAPI document and on the site", async () => {
    expect([...DOCUMENTS]).toEqual(["methodology", "licensing", "contributing", "support"]);
    for (const name of DOCUMENTS) expect((await api(`/api/v1/docs/${name}`)).status, name).toBe(200);
    for (const name of DOCUMENTS.filter((name) => name !== "support")) {
      expect((await api(`/api/v1/docs/${name}`)).status, name).toBe(200);
      const response = await page(`/docs/${name}/`);
      expect(response.status, name).toBe(200);
      // A reference document sits under Methodology in the main navigation; no item of its own.
      const nav = (await response.text()).match(/<nav>(.*?)<\/nav>/)![1]!;
      expect(nav).toContain('<a href="/docs/methodology/" aria-current="page">Methodology</a>');
      expect(nav).not.toContain("Contributing");
    }
    for (const name of ["api", "contributors", "CONTRIBUTING"]) expect((await api(`/api/v1/docs/${name}`)).status, name).toBe(404);
    expect((await page("/docs/contributors/")).status).toBe(404);
    const operation = (openapi() as unknown as { paths: Record<string, { get: { description: string; parameters: { name: string; description: string }[] } }> }).paths["/api/v1/docs/{document}"]!.get;
    expect(operation.parameters.find((param) => param.name === "document")!.description).toBe("methodology, licensing, contributing or support.");
    expect(operation.description).toContain("The methodology, licensing, contributing and support text");
  });

  it("keeps the support document in the API and renders no support page on providers.dev: its page is on provimux.providers.dev", async () => {
    // The Worker sends /support/ and /docs/support/ to https://provimux.providers.dev/support/ (tests/provimux-site.test.ts).
    one(DocumentationSchema).parse(await (await api("/api/v1/docs/support")).json());
    for (const path of ["/support/", "/docs/support/", "/support/plans/"]) expect((await page(path)).status, path).toBe(404);
  });

  it("says on the support page what a company can buy, with the owner's decisions as written", () => {
    const source = readFileSync(join(ROOT, "src", "components", "provimux", "SupportBody.astro"), "utf8").replace(/\s+/g, " ");
    for (const words of [
      "Prices are approximate, per month, in US dollars. Prices in euros on request. Prices are before VAT; VAT is added where it applies.",
      "GitHub issues and discussions, in public", "Best effort: no reply time",
      "about $149 <span>/ month</span>", "First reply within 3 business days", "1 hour of help a month",
      "about $499 <span>/ month</span>", "First reply within 2 business days", "3 hours of help a month", "An onboarding call", "A vendor pack on request: company details, VAT number, tax forms",
      "about $1,499 <span>/ month, billed yearly</span>", "First reply the next business day", "8 hours of help a month", "At most three customers at a time",
      "$150 to $200 an hour",
      "<strong>A first reply, not a fix.</strong>", "Monday to Friday, 09:00 to 17:00 Central European Time (CET, and CEST in summer).",
      "Provimux is maintained by one person, working with AI agents.", "the unused part of what you paid is refunded, prorated. The code stays MIT",
      "Customers on a paid plan hear about a security fix before it is announced in public.",
      "Setup and upgrades.", "A review of your configuration.", "Moving from CLIProxyAPI.", "Debugging.", "Priority on bugs.",
      "providers.dev does not sell, pool, share or resell access to any model or account. You bring your own API keys or cloud accounts",
      'const email = "office@providers.dev";', "mailto:${email}?subject=", "bank transfer or by card (a Stripe invoice)", "a VAT-registered business in Romania", "reverse charge",
      'Or sponsor on GitHub: the Team and Business plans are also on <a href="https://github.com/sponsors/ngvoicu">GitHub Sponsors</a> as the $149 and $499 monthly tiers.',
      "Write to <a href={`mailto:${email}`}>{email}</a> after sponsoring so we can set up your support.",
      "We never ask for your API keys, logins or prompts",
    ]) expect(source, words).toContain(words);
    expect(source.match(/github\.com\/sponsors\b/gi)).toHaveLength(1);
    // The business name and VAT number go in the vendor pack, never on the page; no referral or affiliate link.
    for (const words of ["SRL", "S.R.L", "RO1", "RO2", "RO3", "RO4", "RO5", "RO6", "RO7", "RO8", "RO9", "referral", "affiliate", "cheapest", "compliant"]) expect(source, words).not.toContain(words);
    // The API's copy and the page are built from the one component, with the same title, lead and contents.
    const document = readFileSync(join(ROOT, "src", "pages", "reference-content", "docs", "support.astro"), "utf8");
    expect(document).toContain("<Doc {...SUPPORT}>");
    expect(document).toContain("<SupportBody home={`${PROVIMUX_SITE}/`} />");
    const supportPage = readFileSync(join(ROOT, "src", "pages", "provimux", "support", "index.astro"), "utf8");
    expect(supportPage).toContain('<SupportBody home="/" />');
    expect(supportPage).toContain("{SUPPORT.lead}");
  });

  it("says on the contributing page how to contribute, with the owner's decisions as written", () => {
    const source = readFileSync(join(ROOT, "src", "pages", "reference-content", "docs", "contributing.astro"), "utf8").replace(/\s+/g, " ");
    for (const words of [
      "providers.dev takes no payment for listing, correcting or measuring an entry. A provider may supply documentation, or access for a measurement; the result is published whatever it shows.",
      "Anyone may propose a correction or an addition with a link to the provider's own page that says so, the sentence quoted, and the day it was read. It is published as documented, with that link and date.",
      "A measured value is never accepted as a claim.", "An API key and a subscription login are different entries", "is never copied from one to the other",
      "the imported copy of models.dev is never edited",
      '<span class="badge documented">documented</span>', '<span class="badge measured">measured</span>', '<span class="badge listed">listed</span>',
      '"https://github.com/ngvoicu/providers.dev"', "${repository}/issues/new?template=value.yml", "${repository}/blob/main/README.md#authoring", '"https://github.com/ngvoicu/groundtruth"',
      "<code>observed.json</code>", "One change per pull request.", "<code>npm run build &amp;&amp; npm run check</code> must pass.", "The build fails when",
      "with the contributor's own key", "Small samples.", "One account per route.", "Dated.",
      "A value with no source.", "A measured value without its raw results.", "A value copied from another access method.", "A paid listing or a paid correction.",
      "providers.dev has one maintainer. No response time is promised. A request with a link to the provider's page is quick to check. A measurement waits for quota and time.",
      '<a href="/docs/licensing/">licensing</a>', "<em>I am asking for a measurement</em>", "blank issue",
      'const email = "office@providers.dev";', '<h2 id="contact">Contact</h2>', "write to <a href={`mailto:${email}`}>{email}</a>", "a correction that cannot be made public", "A wrong or missing value goes in an issue",
    ]) expect(source, words).toContain(words);
    // Astro drops a line break before a tag: a word at the end of a line and a tag at the start of the next would run together.
    // The same holds on the methodology ("an<em>Input window", "an<em>at least", ":<code>contradicted") and the licensing page ("as<a").
    for (const name of ["contributing", "methodology", "licensing", "support"]) {
      const raw = readFileSync(join(ROOT, "src", "pages", "reference-content", "docs", `${name}.astro`), "utf8");
      expect(raw, name).not.toMatch(/[\w,.;:)]\n\s*<(a|code|em|strong|span)\b/);
    }
    for (const file of [
      ["components", "provimux", "SupportBody.astro"], ["layouts", "Provimux.astro"], ["pages", "provimux", "index.astro"], ["pages", "provimux", "support", "index.astro"], ["pages", "provimux", "not-found", "index.astro"],
      ["layouts", "PiCacheKeeper.astro"], ["pages", "pi-cache-keeper", "index.astro"], ["pages", "pi-cache-keeper", "not-found", "index.astro"],
    ]) {
      expect(readFileSync(join(ROOT, "src", ...file), "utf8"), file.join("/")).not.toMatch(/[\w,.;:)]\n\s*<(a|code|em|strong|span)\b/);
    }
    // The worked examples are entries of data/authored, as written there.
    const openrouter = readFileSync(join(ROOT, "data", "authored", "overrides", "openrouter.yaml"), "utf8");
    for (const words of ["https://openrouter.ai/docs/guides/best-practices/prompt-caching#deepseek", "Prompt caching with DeepSeek is automated and does not require any additional configuration.", "results/openrouter-direct/R10-2026-11-04T19-00-07.json", "20 of 27 later re-sends were served from the cache, the oldest at 25 minutes."]) {
      expect(openrouter, words).toContain(words);
      expect(source, words).toContain(words);
    }
  });

  it("says on the methodology what a model list is and where it comes from, and that a plan appears by name only", () => {
    const methodology = readFileSync(join(ROOT, "src", "pages", "reference-content", "docs", "methodology.astro"), "utf8").replace(/\s+/g, " ");
    expect(methodology).toContain('{ id: "listings", label: "Model lists" }');
    expect(methodology).toContain('<h2 id="listings">Model lists</h2>');
    for (const words of ["the models the lists providers.dev has name for that provider and access method, evaluated or not", "A listing joins the lists of four sources, each model once", "so the joined list too can miss a model", "A model providers.dev leaves out of the provider with evidence is not on it, whichever list names it", "No list is taken as the whole", "published in its <code>listed.json</code>", "one table of its models", "folded behind one line, are the models a model list names that have no entry", "<em>subscription</em> where it was read through a subscription login", "nothing of it is written into an entry's limits or into a safe value", "never prices, allowances or quotas"]) {
      expect(methodology, words).toContain(words);
    }
    expect(methodology).toContain("Plans are not tracked: a plan's name appears only where a vendor's own model list attaches it to a model");
    expect(methodology).not.toContain("Plans, plan prices, allowances and quotas are not tracked.");
  });

  it("links the contributing page from the methodology, the footer and the evidence page, and states the same independence on the methodology", async () => {
    const methodology = readFileSync(join(ROOT, "src", "pages", "reference-content", "docs", "methodology.astro"), "utf8").replace(/\s+/g, " ");
    expect(methodology).toContain("providers.dev takes no payment for listing, correcting or measuring an entry. A provider may supply documentation, or access for a measurement; the result is published whatever it shows.");
    expect(methodology.match(/<a href="\/docs\/contributing\/">contributing<\/a>/g)).toHaveLength(2);
    const layout = readFileSync(join(ROOT, "src", "layouts", "Base.astro"), "utf8");
    expect(layout).toMatch(/<li><a href="\/docs\/licensing\/">Licensing and attribution<\/a><\/li>\s*<li><a href="\/docs\/contributing\/">Contributing<\/a><\/li>\s*<li><a href="https:\/\/provimux\.providers\.dev\/">Provimux<\/a><\/li>\s*<li><a href="https:\/\/provimux\.providers\.dev\/support\/">Provimux support<\/a><\/li>\s*<li><a href="https:\/\/pi-cache-keeper\.providers\.dev\/">pi-cache-keeper<\/a><\/li>\s*<li><a href="mailto:office@providers\.dev">Contact<\/a><\/li>/);
    expect(layout).not.toContain('href="/support/"');
    expect(methodology).toContain('A provider can write to <a href="mailto:office@providers.dev">office@providers.dev</a>.');
    const evidence = await (await page("/evidence/")).text();
    expect(evidence).toContain('To propose a correction or ask for an evaluation, see <a href="/docs/contributing/">Contributing</a>.');
  });

  it("has a contributing file, one issue form and a pull request check that imports, deploys and writes nothing", () => {
    const contributing = readFileSync(join(ROOT, "CONTRIBUTING.md"), "utf8");
    expect(contributing).toContain("https://providers.dev/docs/contributing/");
    expect(contributing).toContain("(./README.md#authoring)");
    expect(contributing).toContain("[office@providers.dev](mailto:office@providers.dev)");
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    const section = readme.slice(readme.indexOf("\n## Contributing\n"), readme.indexOf("\n## Licensing\n"));
    expect(section).toContain("https://providers.dev/docs/contributing/");
    expect(section).toContain("[office@providers.dev](mailto:office@providers.dev)");

    const form = parse(readFileSync(join(ROOT, ".github", "ISSUE_TEMPLATE", "value.yml"), "utf8")) as { name: string; body: { type: string; id?: string; attributes: { label?: string; options?: string[] }; validations?: { required: boolean } }[] };
    expect(form.name).toBe("A value is wrong or missing");
    const field = (id: string) => form.body.find((item) => item.id === id)!;
    expect(form.body.filter((item) => item.id).map((item) => item.id)).toEqual(["request", "provider", "access", "model", "field", "shown", "expected", "source", "quote", "date", "access-available"]);
    expect(field("source").validations?.required).toBe(true);
    expect(field("request").attributes.options).toContain("I am asking for a measurement");
    expect(field("access").attributes.options).toEqual(["API key", "Subscription", "Other"]);
    expect(field("field").attributes.options).toEqual(["Context", "Input window", "Output limit", "Cache lifetime", "Price", "Other"]);
    // Blank issues stay possible: no configuration turns them off.
    expect(existsSync(join(ROOT, ".github", "ISSUE_TEMPLATE", "config.yml"))).toBe(false);

    const text = readFileSync(join(ROOT, ".github", "workflows", "check.yml"), "utf8");
    const workflow = parse(text) as { on: Record<string, unknown>; permissions: Record<string, string>; jobs: Record<string, { steps: { run?: string; uses?: string }[] }> };
    expect(Object.keys(workflow.on)).toEqual(["pull_request"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    const runs = Object.values(workflow.jobs).flatMap((job) => job.steps.flatMap((step) => step.run ? [step.run] : []));
    expect(runs).toEqual(["npm ci", "npm run build", "npm run check"]);
    expect(text).not.toMatch(/pull_request_target|secrets\.|npm run sync|wrangler|deploy:|git push/);
  });

  it("renders the requested homepage filters and page before JavaScript runs", async () => {
    const path = "/?provider=provider-02&limit=2&offset=2&sort=model";
    const html = await (await page(path)).text();
    const result = await (await api("/api/v1/entries?provider=provider-02&limit=2&offset=2&sort=model")).json() as { data: { ref: string }[] };
    expect(html.match(/<tr>/g)?.length).toBe(3); // header + two requested rows
    for (const entry of result.data) expect(html).toContain(entry.ref);
    expect(html).toContain("Page 2 of 10");
    expect(html).toContain('href="/?provider=provider-02&amp;limit=2&amp;offset=4&amp;sort=model"');
    // A known filter with a value the API refuses is left out on the page (the API still refuses it).
    expect((await page("/?min_context=nope")).status).toBe(200);
  });

  it("shows the version and the Stability section of the OpenAPI document on /docs/api/", async () => {
    const html = await (await page("/docs/api/")).text();
    expect(html).toContain("Version 1.6.3 ·");
    expect(html).toContain('<h2 id="stability">Stability</h2>');
    expect(html).toContain("/api/v1 only grows.");
  });

  it("says on /docs/api/ that a summary's max_output is the safe maximum output, and what 1.4.0 changed in numbers", async () => {
    const text = (await (await page("/docs/api/")).text()).replace(/<[^>]+>/g, " ").replace(/&#39;|&#x27;/g, "'").replace(/\s+/g, " ");
    expect(text).toContain("Since 1.4.0 max_output of a summary is the safe maximum output (safe.max_output.value, see Safe values), not limit.output as published");
    expect(text).toContain("max_output of a summary is not, since 1.4.0: it is the safe maximum output, safe.max_output.value, null where no source states one");
    expect(text).not.toMatch(/max_output of a summary (are|is) limit as published/);
    for (const words of ["became null on 457 entries", "took pi.dev's figure on 5", "changed on 161 of 476 canonical models (the minimum on 161, the maximum on 157)", "input_window_unknown_count of a model changed on 3", "github-copilot/mai-code-1.1-flash"]) expect(text).toContain(words);
    // The field tables say it too: the summary's own key, and the two ends of a model.
    expect(text).toMatch(/max_output_min\*? .{0,40}The smallest max_output among its entries: the safe maximum output of each summary since 1\.4\.0/);
  });

  it("renders OpenAPI changes and examples without a documentation build", async () => {
    const html = await (await page("/docs/api/", async (path) => {
      if (path !== "/api/v1/openapi.json") return api(path);
      return Response.json({ info: { title: "API", version: "fixture", description: "From the API" }, paths: {}, components: { schemas: { NewPolicy: { description: "New policy from response", type: "object", properties: { condition: { type: "string", description: "Scoped rate" } }, examples: [{ condition: "new-value" }] } } } });
    })).text();
    expect(html).toContain("NewPolicy");
    expect(html).toContain("Scoped rate");
    expect(html).toContain("new-value");
  });

  it("takes the cache lifetime sorts and the basis filter through the catalog's address, as the API does", async () => {
    const response = await page("/?sort=cache_long&order=desc&lifetime_basis=documented");
    expect(response.status).toBe(200);
    const html = await response.text();
    const answer = await (await api("/api/v1/entries?lifetime_basis=documented&sort=cache_long&order=desc")).json() as { total: number; data: { ref: string }[] };
    expect(html).toContain(`<code>/api/v1/entries?lifetime_basis=documented&amp;sort=cache_long&amp;order=desc</code>`);
    expect(html).toContain(`${answer.total.toLocaleString("en-US")} entries`);
    // The rows in the API's order (each row's copy button carries its entry id).
    expect([...html.matchAll(/aria-label="Copy entry id"/g)].length).toBe(Math.min(answer.total, 50));
    expect([...html.matchAll(/data-copy="([^"]+)" aria-label="Copy entry id"/g)].map((match) => match[1])).toEqual(answer.data.map((item) => item.ref));
    // No header is marked as sorted: the table has no cache lifetime sort control.
    expect(html).not.toContain("aria-sort");
    expect((await page("/?lifetime_basis=none")).status).toBe(200);
  });

  it("the home page's lead names no count, and its facts line carries the counts from /api/v1/meta and the facets", async () => {
    const { data: meta } = (await (await api("/api/v1/meta")).json()) as { data: Meta };
    expect(meta.pi.snapshot).toBeNull();
    const facets = one(FacetsSchema).parse(await (await api("/api/v1/facets")).json()).data;
    const html = await (await page("/")).text();
    const lead = html.match(/<p class="lead">([\s\S]*?)<\/p>/)![1]!;
    expect(lead).toBe('Context window, maximum output, price and prompt caching for every model, at every provider and for each way in. Built on <a href="https://models.dev">models.dev</a>, with our own <a href="/?origin=modified,added">corrections and measurements</a> on top. Each quantity has one value; <a href="/docs/methodology/#safe-values">a warning</a> marks where its sources disagree.');
    const facts = html.match(/<p class="facts-line muted">([\s\S]*?)<\/p>/)![1]!;
    const n = (value: number) => value.toLocaleString("en-US");
    expect(facts).toBe(`<span>${n(meta.counts.entries)} entries</span><span><a href="/?origin=modified,added">${n(facets.evidence_entries)} corrected or evaluated</a></span><span>${n(meta.counts.providers)} providers, <a href="/?access=subscription">${n(facets.subscription_providers)} by subscription</a></span><span><a href="/models/">${n(meta.counts.models)} models</a></span><span><a href="/evidence/#cache">${n(meta.counts.cache_evaluations)} cache evaluations</a></span><span>Updated ${meta.generated_at.slice(0, 10)}</span>`);
  });

  it("keeps the basis filter in the catalog's form, with one value and with both", async () => {
    const form = (html: string): string => html.match(/<form id="filters"[\s\S]*?<\/form>/)?.[0] ?? "";
    const one = form(await (await page("/?lifetime_basis=measured&sort=cache_long&order=desc&limit=100")).text());
    expect(one).toContain('<input type="hidden" name="lifetime_basis" value="measured">');
    expect(one).toContain('<input type="hidden" name="sort" value="cache_long"><input type="hidden" name="order" value="desc"><input type="hidden" name="limit" value="100">');
    const both = form(await (await page("/?lifetime_basis=documented,measured")).text());
    expect(both).toContain('<input type="hidden" name="lifetime_basis" value="documented,measured">');
    expect(form(await (await page("/")).text())).not.toContain('name="lifetime_basis"');
  });

  it("has every declared filter of the entry list in the catalog's form, as a control or carried, once", async () => {
    // A query that sets every parameter, so that a carried one is written.
    const all = "q=model&provider=provider-02&family=f&canonical_id=lab/model-1&type=chat&access=api&origin=upstream&cache=yes&cache_mode=implicit&lifetime_basis=measured&min_context=1&min_output=1&min_input_window=1&max_age_months=600&evaluated=false&disagree=false&sort=cache_short&order=desc&limit=10&offset=0"; // offset 0: a later page of a list this query leaves empty is not a page
    expect(PARAMS.map(({ name }) => name).filter((name) => !all.includes(`${name}=`))).toEqual([]);
    const html = (await (await page(`/?${all}`)).text()).match(/<form id="filters"[\s\S]*?<\/form>/)?.[0] ?? "";
    const names = [...html.matchAll(/<(?:input|select)\b[^>]*\bname="([^"]+)"/g)].map((match) => match[1]);
    // offset is left out on purpose: a new filter starts again at the first page.
    expect([...names].sort()).toEqual(PARAMS.map(({ name }) => name).filter((name) => name !== "offset").sort());
  });

  it("takes the stale threshold from the published meta, on the pages and in the methodology", async () => {
    // A publication whose threshold is 7 days: the pages say 7, and nowhere 90.
    const sevenDays = async (path: string): Promise<Response> => {
      if (path === "/api/v1/meta") {
        const answer = await (await api(path)).json() as { meta: unknown; data: { stale_after_days: number } };
        return Response.json({ ...answer, data: { ...answer.data, stale_after_days: 7 } });
      }
      if (path === "/api/v1/docs/methodology") {
        const answer = await (await api(path)).json() as { meta: unknown; data: { body_html: string } };
        return Response.json({ ...answer, data: { ...answer.data, body_html: '<p>Older than <span data-meta="stale_after_days"><code>stale_after_days</code></span> days is stale.</p>' } });
      }
      return api(path);
    };
    const evidence = await (await page("/evidence/", sevenDays)).text();
    expect(evidence).toContain("Evidence older than 7 days is marked stale.");
    const methodology = await (await page("/docs/methodology/", sevenDays)).text();
    expect(methodology).toContain('Older than <span data-meta="stale_after_days">7</span> days is stale.');
    // The catalog hands the threshold to the list rendered in the browser.
    const catalog = await (await page("/", sevenDays)).text();
    expect(catalog).toContain('data-stale-after-days="7"');
    expect(`${evidence}${methodology}${catalog}`).not.toMatch(/90 days/);
  });

  it("takes the age columns of results by age from the published meta, on the entry page and the evidence page", async () => {
    // A publication whose ages are 10 minutes and 1 h 5: every table of results by age has those columns, after the control.
    const twoAges = async (path: string): Promise<Response> => {
      if (path !== "/api/v1/meta") return api(path);
      const answer = await (await api(path)).json() as { meta: unknown; data: { cache_ages_s: number[] } };
      return Response.json({ ...answer, data: { ...answer.data, cache_ages_s: [600, 3900] } });
    };
    const entry = await (await page("/entries/provider-02/lab/model-4", twoAges)).text();
    expect([...entry.matchAll(/<th scope="col" class="age"[^>]*>([^<]+)<\/th>/g)].map((match) => match[1])).toEqual(["At once", "10 min", "1 h 5"]);
    expect(entry).toContain('<th scope="colgroup" colspan="3" class="span"><span class="sr-only">Time since the prompt was cached');
    const strip = '<span class="strip"><span class="control">once</span><span>10m</span><span>65m</span></span>';
    const evidence = await (await page("/evidence/", twoAges)).text();
    expect(evidence).toContain(`<span class="heat-strip strip-head" aria-hidden="true"><span></span>${strip}`);
    expect(evidence).not.toContain("<span>2.5m</span>");
    // As published, the ladder of the build.
    const published = await (await page("/evidence/")).text();
    expect(published).toContain("<span>2.5m</span>");
  });

  it("takes the ages of cache evaluations in the methodology from the published meta, as the column heads write them", async () => {
    const slot = '<span data-meta="cache_ages_s"><code>cache_ages_s</code></span>';
    const withAges = (ages: number[] | null) => async (path: string): Promise<Response> => {
      if (path === "/api/v1/meta" && ages) {
        const answer = await (await api(path)).json() as { meta: unknown; data: { cache_ages_s: number[] } };
        return Response.json({ ...answer, data: { ...answer.data, cache_ages_s: ages } });
      }
      if (path === "/api/v1/docs/methodology") {
        const answer = await (await api(path)).json() as { meta: unknown; data: { body_html: string } };
        return Response.json({ ...answer, data: { ...answer.data, body_html: `<p>Then checked at ${slot}, the later ages where the cache lasts.</p>` } });
      }
      return api(path);
    };
    // As published: the ladder of the build, the same ages as the columns of the results by age.
    const published = await (await page("/docs/methodology/", withAges(null))).text();
    expect(published).toContain('Then checked at <span data-meta="cache_ages_s">2.5 min, 5 min, 7.5 min, 10 min, 15 min, 20 min, 25 min, 30 min, 40 min, 50 min, 1 h, 1 h 15, 1 h 30, 2 h, 4 h, 8 h, 12 h and 24 h</span>, the later ages where the cache lasts.');
    // A publication with other ages: the page lists those, and none of the build's.
    const other = await (await page("/docs/methodology/", withAges([600, 3900]))).text();
    expect(other).toContain('Then checked at <span data-meta="cache_ages_s">10 min and 1 h 5</span>, the later ages where the cache lasts.');
    expect(other).not.toContain("2.5 min");
    const one = await (await page("/docs/methodology/", withAges([300]))).text();
    expect(one).toContain('Then checked at <span data-meta="cache_ages_s">5 min</span>, the later ages');
  });

  it("fails visibly on API errors and does not substitute stale or private data", async () => {
    const response = await page("/providers/", async (path) => path === "/api/v1/meta" ? api(path) : new Response(null, { status: 503 }));
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).not.toContain("Provider 2");
    expect((await page("/models/no-such/model")).status).toBe(404);
    const result = fillShell(`${MARK.title}${MARK.html}`, { title: MARK.html, html: "actual content", description: "", head: "", dataset: "", nav: "" });
    expect(result).toBe(`${MARK.html}actual content`);
  });

  it("invalidates response validators on publication changes and does not reuse them across queries", async () => {
    const first = await api("/api/v1/entries?limit=1");
    const request = new Request("https://providers.dev/api/v1/entries?limit=1", { headers: { "If-None-Match": first.headers.get("etag")! } });
    expect((await handleApi(request, { ...deps, meta: { ...deps.meta, generated_at: "2030-01-01T00:00:00Z" } })).status).toBe(200);
    const other = await handleApi(new Request("https://providers.dev/api/v1/entries?limit=2", { headers: request.headers }), deps);
    expect(other.status).toBe(200);
  });
});

it("publishes new data without rebuilding the shell, while in-flight API reads stay on their pinned publication", async () => {
  const destination = tempDataDir();
  mkdirSync(join(destination, "site-shell"));
  writeFileSync(join(destination, "site-shell", "index.html"), shell);
  stageSnapshot(join(dataDir, "published"), destination);
  const assets: AssetBinding = { async fetch(request) {
    const path = new URL(typeof request === "string" ? request : request.url).pathname;
    const file = join(destination, path.endsWith("/") ? `${path}index.html` : path);
    return existsSync(file) ? new Response(readFileSync(file)) : new Response(null, { status: 404 });
  } };
  const pinned = await readSnapshot(assets, "https://providers.dev");
  // The index is staged as gzip only, well under the per-file limit of static assets, and served as plain JSON.
  const staged = join(destination, "snapshots", (JSON.parse(readFileSync(join(destination, "current.json"), "utf8")) as { id: string }).id, "data");
  expect([existsSync(join(staged, "index.json")), existsSync(join(staged, "index.json.gz"))]).toEqual([false, true]);
  const servedIndex = await worker.fetch(new Request("https://providers.dev/data/index.json"), { ASSETS: assets });
  expect(await servedIndex.json()).toEqual(JSON.parse(readFileSync(join(dataDir, "published", "site", "data", "index.json"), "utf8")));
  const first = await worker.fetch(new Request("https://providers.dev/providers/provider-02/"), { ASSETS: assets });
  const etag = first.headers.get("etag")!;
  expect(first.status).toBe(200);
  const changed = fixtureUpstream();
  changed["provider-02"]!.name = "Updated by data publication";
  changed["provider-02"]!.models["lab/model-4"]!.name = "Updated data entry";
  await sync({ dataDir, fetch: fetchReturning(JSON.stringify(changed), { headers: { etag: '"next"' } }) });
  expect(publish({ dataDir, rootDir: ROOT, now: () => new Date("2026-11-15T00:00:00Z") }).ok).toBe(true);
  stageSnapshot(join(dataDir, "published"), destination);
  const current = await readSnapshot(assets, "https://providers.dev");
  expect(current.meta.dataset_version).not.toBe(pinned.meta.dataset_version);
  const oldProvider = await (await handleApi(new Request("https://providers.dev/api/v1/providers/provider-02?view=full"), pinned)).json() as { data: { provider: { name: string } } };
  expect(oldProvider.data.provider.name).toBe("Provider 2");
  const oldEntry = await (await handleApi(new Request("https://providers.dev/api/v1/entries/provider-02/lab/model-4"), pinned)).json() as { data: { entry: { name: string } } };
  expect(oldEntry.data.entry.name).toBe("Model 4");
  const second = await worker.fetch(new Request("https://providers.dev/providers/provider-02/", { headers: { "If-None-Match": etag } }), { ASSETS: assets });
  expect(second.status).toBe(200);
  const html = await second.text();
  expect(html).toContain("<h1>Updated by data publication</h1>");
  expect(html).toContain("Updated data entry");
  expect(readFileSync(join(destination, "site-shell", "index.html"), "utf8")).toBe(shell);
  expect((await worker.fetch(new Request("https://providers.dev/current.json"), { ASSETS: assets })).status).toBe(404);
  expect((await worker.fetch(new Request("https://providers.dev/api/v1/entries"), { ASSETS: assets })).headers.get("X-Dataset-Version")).toBe(current.meta.dataset_version);
});

it("sends www and plain http at the edge to https://providers.dev in one step, and serves a local preview and any other host as they come", async () => {
  const destination = tempDataDir();
  mkdirSync(join(destination, "site-shell"));
  writeFileSync(join(destination, "site-shell", "index.html"), shell);
  stageSnapshot(join(dataDir, "published"), destination);
  let reads = 0;
  const assets: AssetBinding = { async fetch(request) {
    reads += 1;
    const path = new URL(typeof request === "string" ? request : request.url).pathname;
    const file = join(destination, path.endsWith("/") ? `${path}index.html` : path);
    return existsSync(file) ? new Response(readFileSync(file)) : new Response(null, { status: 404 });
  } };
  // At the edge Cloudflare sets X-Forwarded-Proto to the protocol the visitor used.
  const get = (url: string, proto?: string) => worker.fetch(new Request(url, { headers: proto ? { "X-Forwarded-Proto": proto } : {} }), { ASSETS: assets });
  for (const path of ["/some/path?x=1", "/", "/api/v1/entries?limit=1&offset=2", "/favicon.svg"]) {
    for (const [origin, proto] of [["http://providers.dev", "http"], ["https://www.providers.dev", "https"], ["http://www.providers.dev", "http"]] as const) {
      const redirect = await get(`${origin}${path}`, proto);
      // One step: www over http goes straight to the https apex, not to https://www first.
      expect([origin, redirect.status, redirect.headers.get("Location")]).toEqual([origin, 301, `https://providers.dev${path}`]);
    }
  }
  // A path that looks like another host stays a path on providers.dev.
  expect((await get("https://www.providers.dev//evil.example/x?y=1", "https")).headers.get("Location")).toBe("https://providers.dev//evil.example/x?y=1");
  expect((await get("http://providers.dev//evil.example/x", "http")).headers.get("Location")).toBe("https://providers.dev//evil.example/x");
  // The redirect comes before anything else: no asset is read for it.
  expect(reads).toBe(0);
  const served: [string, string | undefined][] = [
    ["https://providers.dev", "https"],
    // wrangler dev with `routes` in wrangler.jsonc: the local Worker sees the production host over http, no header.
    ["http://providers.dev", undefined],
    ["http://localhost:8787", undefined],
    ["http://localhost:8787", "http"],
    ["http://127.0.0.1:8788", undefined],
    ["http://providers-dev.example.workers.dev", "http"],
    ["https://other.providers.dev", "https"],
    // A local preview never sees an edge header, whatever host it is given.
    ["http://www.providers.dev", undefined],
  ];
  for (const [origin, proto] of served) {
    const page = await get(`${origin}/providers/provider-02/`, proto);
    const api = await get(`${origin}/api/v1/entries?limit=1`, proto);
    expect([origin, proto, page.status, page.headers.get("Location"), api.status, api.headers.get("Location")]).toEqual([origin, proto, 200, null, 200, null]);
  }
});

it("keeps a provider whose every entry a catalog rule leaves out, with no entries, in the API and on the pages", async () => {
  const emptied = tempDataDir();
  const upstream = fixtureUpstream();
  upstream["old-router"] = { id: "old-router", name: "Old router", doc: "https://example.com", models: { "oldfam-1": { id: "oldfam-1", name: "Oldfam 1", family: "oldfam" }, "oldfam-1.5": { id: "oldfam-1.5", name: "Oldfam 1.5", family: "oldfam" } } };
  await sync({ dataDir: emptied, fetch: fetchReturning(JSON.stringify(upstream)) });
  writeAuthored(emptied);
  writeFileSync(join(emptied, "authored", "catalog-rules.yaml"), "exclude:\n  - { id: oldfam-before-2, family: oldfam, word: oldfam, before: \"2\", leaves_out: Oldfam before 2, reason: Editorial choice., date: \"2026-11-16\" }\n");
  const report = publish({ dataDir: emptied, rootDir: ROOT, now });
  expect([report.errors, report.issues, report.meta?.counts.providers, report.meta?.exclusions[0]?.entries]).toEqual([[], [], 32, 2]);
  const destination = tempDataDir();
  mkdirSync(join(destination, "site-shell"));
  writeFileSync(join(destination, "site-shell", "index.html"), shell);
  stageSnapshot(join(emptied, "published"), destination);
  const assets: AssetBinding = { async fetch(request) {
    const path = new URL(typeof request === "string" ? request : request.url).pathname;
    const file = join(destination, path.endsWith("/") ? `${path}index.html` : path);
    return existsSync(file) ? new Response(readFileSync(file)) : new Response(null, { status: 404 });
  } };
  const get = (path: string) => worker.fetch(new Request(`https://providers.dev${path}`), { ASSETS: assets });
  const provider = await (await get("/api/v1/providers/old-router?view=full")).json() as { data: { provider: { entry_count: number }; entries: unknown[]; models: Record<string, unknown> } };
  expect([provider.data.provider.entry_count, provider.data.entries, provider.data.models]).toEqual([0, [], {}]);
  const entries = await (await get("/api/v1/entries?provider=old-router&q=oldfam")).json() as { total: number; data: unknown[] };
  expect([entries.total, entries.data]).toEqual([0, []]);
  expect((await get("/api/v1/entries/old-router/oldfam-1")).status).toBe(404);
  const providers = await (await get("/api/v1/providers?q=Old")).json() as { data: { id: string; entry_count: number }[] };
  expect(providers.data).toEqual([expect.objectContaining({ id: "old-router", entry_count: 0 })]);
  const page = await get("/providers/old-router/");
  expect(page.status).toBe(200);
  // Its entries are left out; the models models.dev lists for it are still the provider's models, with no entry.
  const html = await page.text();
  expect(html).toContain('<details class="more-models" open><summary><span class="count">2 models</span>');
  expect(html).toContain('<span class="listed-name">Oldfam 1.5</span>');
  const catalog = await get("/?provider=old-router");
  expect(catalog.status).toBe(200);
  expect(await catalog.text()).toMatch(/<div id="empty" class="empty">/);
  expect((await get("/providers/")).status).toBe(200);
});

// pi's catalog on the pages (design/pi-source.md, section h; step 6). A data directory of its own, with a pi snapshot:
// at provider-02, lab/model-0 is listed by pi and agrees; lab/model-4 differs in its context window, output limit and
// input price (an override gives the entry a price); model-9 is listed by pi as "Model-Nine", paired in the alias file.
// provider-20 is not in pi's catalog at all.
describe("pi's catalog on the pages", () => {
  let piDeps: ApiDeps;
  const piApi = (path: string) => handleApi(new Request(`https://providers.dev${path}`), piDeps);
  const piPage = async (path: string) => {
    const response = await handlePage(new Request(`https://providers.dev${path}`), { api: piApi, shell: async () => new Response(shell), site: "https://providers.dev", now });
    expect(response.status, path).toBe(200);
    return response.text();
  };
  /** The pi section of an entry's page, and the header line with the entry's sources. */
  const parts = (html: string) => ({ section: html.split('<section aria-labelledby="pi">')[1]!.split("</section>")[0]!, head: html.split('<p class="id">')[1]!.split("</p>")[0]! });
  /** The row of the entry whose id is `ref`, in a table of entries (each row's copy button carries its entry id). */
  const rowOf = (html: string, ref: string) => html.split("<tr>").find((row) => row.includes(`data-copy="${ref}"`))!;

  beforeAll(async () => {
    const dir = tempDataDir();
    await sync({ dataDir: dir, fetch: fetchReturning(JSON.stringify(fixtureUpstream())) });
    writeAuthored(dir);
    writeFileSync(join(dir, "authored", "overrides", "provider-02.yaml"), stringify({
      provider: "provider-02",
      rules: [{ models: ["lab/model-4"], set: { cost: { text: { input: { price: 2 }, output: { price: 16 } } } }, reason: "listed price", evidence: [{ kind: "documented", url: "https://example.com/prices", date: "2026-11-01" }] }],
    }));
    writeFileSync(join(dir, "authored", "pi-aliases.yaml"), stringify({ providers: { "provider-02": { checked: "2026-11-20", models: { "Model-Nine": { same_as: "model-9" } } } } }));
    const pi: PiCatalog = fixturePi(12, 30);
    const own = pi["provider-02"]!;
    own["lab/model-4"] = { ...own["lab/model-4"]!, contextWindow: 450000, maxTokens: 4000, compat: { supportsLongCacheRetention: false, thinkingFormat: "openai" }, thinkingLevelMap: { minimal: null, high: "high" } };
    own["Model-Nine"] = { ...own["model-9"]!, id: "Model-Nine", name: "Model Nine" };
    delete own["model-9"];
    writePiSnapshot(dir, pi);
    const report = publish({ dataDir: dir, rootDir: ROOT, now });
    expect(report.errors).toEqual([]);
    piDeps = depsFrom(join(dir, "published"));
    expect(piDeps.meta.pi.snapshot?.fetched_at).toBe("2026-11-20T14:19:45.000Z");
  });

  it("an entry page with a block: the request format, the address, each stated flag and level, whose data it is and when it was fetched and checked", async () => {
    const { entry } = (await (await piApi("/api/v1/entries/provider-02/lab/model-0")).json() as { data: { entry: JsonObject } }).data;
    const block = (entry.providers_dev as JsonObject).pi as JsonObject;
    expect(block).toMatchObject({ api: "anthropic-messages", base_url: "https://api.provider-02.example/v1", differences: [] });
    const html = await piPage("/entries/provider-02/lab/model-0");
    const { section, head } = parts(html);
    expect(section).toContain("Anthropic Messages<div class=\"id\"><code>anthropic-messages</code></div>");
    expect(section).toContain("<code class=\"break\">https://api.provider-02.example/v1</code>");
    // Each flag pi states, once, with pi's name and value; the provider's in words.
    for (const [name, value] of Object.entries(block.compat as JsonObject)) expect(section.split(`<code>${name}: ${escapeHtml(JSON.stringify(value))}</code>`).length - 1, name).toBe(1);
    expect(section).toContain("The <code>store</code> request field<div class=\"hint\"><code>supportsStore: false</code></div></dt><dd>Not accepted</dd>");
    for (const [level, value] of Object.entries(block.thinking_level_map as JsonObject)) expect(section).toContain(`<dt>${level}</dt><dd>${value === null ? '<span class="muted" title="Pi marks this level as not supported.">not supported</span>' : `<code>${value}</code>`}</dd>`);
    // Whose data it is, and as of when: fetched from pi, last checked unchanged, its values in the rows, pi's list.
    expect(section).toContain("Fetched <span class=\"date\" title=\"2026-11-20 14:19 UTC\">2026-11-20</span> from <a href=\"https://pi.dev/api/models\"");
    expect(section).toContain("Last checked <span class=\"date\" title=\"2026-11-21 04:17 UTC\">2026-11-21</span>, unchanged");
    expect(section).toContain("Not verified by providers.dev");
    expect(section).toContain("Its limits, prices and cache lifetimes: the last source of each value above");
    expect(section).toContain('href="https://pi.dev/models?provider=provider-02"');
    expect(section).toContain("The same provider and model id as this entry.");
    expect(section).not.toContain("The last import");
    // The section holds only what pi alone returns.
    expect(section).not.toMatch(/id="pi-prices"|Limits and prices|>Cache lifetimes<|No difference/);
    // No difference: the mark in the heading says no more than pi.dev, and no value warns.
    expect(html).not.toContain("warn-sign");
    expect(head).toContain('<span class="origin pi" title="Pi&#39;s model catalog (pi.dev) also lists this entry. Imported, not verified by providers.dev. It is the last source of each value.">pi.dev</span>');
    expect(head).toMatch(/>pi\.dev<\/span><span class="muted date" title="[^"]*">2026-11-20<\/span>/);
    expect(head).not.toContain("differ<");
  });

  it("an entry page with differences: the entry's own value in each row, a warning on it, pi's figure in its list; pi's price of 0 states nothing, never free", async () => {
    const { entry, summary } = (await (await piApi("/api/v1/entries/provider-02/lab/model-4")).json() as { data: { entry: JsonObject; summary: Summary } }).data;
    const block = (entry.providers_dev as JsonObject).pi as JsonObject;
    const differences = block.differences as { field: string; pi: number; published: number }[];
    expect(differences.map((item) => [item.field, item.pi, item.published])).toEqual([["context_window", 450000, 500000], ["max_tokens", 4000, 5000], ["cost.input", 4, 2]]);
    expect(summary.safe.differing).toEqual(["input_window", "max_output", "price"]);
    const html = await piPage("/entries/provider-02/lab/model-4");
    const { section, head } = parts(html);
    expect(head).not.toMatch(/pi-differ|\d differ/);
    const text = (part: string): string => part.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const listOf = (id: string): string => { const at = html.indexOf(`<div class="warn-tip" id="${id}"`); return text(html.slice(at, html.indexOf("</div>", at))); };
    expect(listOf("warn-row-input_window")).toMatch(/^Not all sources agree Context window models\.dev 500,000 tokens \(the value on this page\) \d{4}-\d\d-\d\d pi\.dev 450,000 tokens 2026-11-20 How a value is chosen$/);
    expect(listOf("warn-row-max_output")).toMatch(/^Not all sources agree Maximum output models\.dev 5,000 tokens \(the value on this page\) \d{4}-\d\d-\d\d pi\.dev 4,000 tokens 2026-11-20 How a value is chosen$/);
    // The input price: providers.dev's, with its evidence, is the value (the fixture's models.dev lists none); pi's beside it.
    expect(listOf("warn-price-input")).toBe("Not all sources agree Input providers.dev $2 / 1M (the value on this page) 2026-11-01 Evidence pi.dev $4 / 1M 2026-11-20 How a value is chosen");
    expect([...html.matchAll(/popovertarget="warn-([^"]+)"/g)].map((match) => match[1])).toEqual(["tile-input_window", "tile-max_output", "tile-price", "row-input_window", "row-max_output", "price-input"]);
    // The values stay the entry's own; pi's cache write is 0, which is not a statement.
    expect(text(html.slice(html.indexOf('<div class="tiles'), html.indexOf("<h3>Limit evaluations")).replace(/<div class="warn-tip"[\s\S]*?<\/div>/g, ""))).toMatch(/^Context window 500,000 tokens Maximum output 5,000 tokens Price \$2 \/ \$16/);
    expect(html).not.toContain('popovertarget="warn-price-cache_write"');
    expect(html.replace(/title="[^"]*"/g, "")).not.toMatch(/\bfree\b|pi (?:says|lists) \$0\b/i);
    for (const flag of ["supportsLongCacheRetention", "thinkingFormat"]) expect(section).toContain(`<code>${flag}: `);
  });

  it("every entry page with a block warns where safe.differing says so and nowhere else; a value only pi states is the value, unmarked", async () => {
    const { data } = (await (await piApi("/api/v1/entries?provider=provider-02&limit=200")).json() as { data: Summary[] });
    const listed = data.filter((summary) => summary.pi !== null);
    expect(listed.length).toBeGreaterThan(10);
    for (const summary of listed) {
      const html = await piPage(`/entries/${summary.ref}`);
      const tiles = [...html.matchAll(/popovertarget="warn-tile-([^"]+)"/g)].map((match) => match[1]);
      expect(tiles, summary.ref).toEqual(summary.safe.differing);
      expect(html, summary.ref).not.toMatch(/pi-note|pi-line|pi-from|\bpi (?:agrees|says|lists)\b|pi states [$\d]/);
    }
    // model-7 states no limit: pi's 800,000 is its context window, shown like any value; without pi's data, Unknown.
    const values = (html: string): string => html.slice(html.indexOf('<div class="tiles'), html.indexOf("<h3>Limit evaluations")).replace(/<div class="warn-tip"[\s\S]*?<\/div>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const only = values(await piPage("/entries/provider-02/model-7"));
    expect(only).toMatch(/^Context window 800,000 tokens/);
    expect(only).not.toMatch(/pi\.dev|\bpi\b/);
    expect(values((await (await page("/entries/provider-02/model-7")).text()))).toMatch(/^Context window Unknown/);
    // model-0 publishes an output limit of 0, which is none stated: pi's 1,000 is the value.
    expect(values(await piPage("/entries/provider-02/lab/model-0"))).toContain("Maximum output 1,000 tokens");
  });

  it("a page built without pi's data says nothing of pi in any row, and its section is one line", async () => {
    for (const ref of ["provider-02/lab/model-0", "provider-02/lab/model-4", "provider-02/model-7"]) {
      const html = await (await page(`/entries/${ref}`)).text();
      expect(html, ref).not.toMatch(/class="pi-(?:note|only|line|tiers-line)"|pi-tiers-table|class="origin pi"|<span class="warn-src">pi\.dev<\/span>/);
      const { section } = parts(html);
      expect(section.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(), ref).toMatch(/^How Pi calls the model (?:This dataset is built without Pi's catalog|Pi's model catalog does not list this entry)/);
    }
  });

  it("an entry paired through the alias file shows pi's own spelling", async () => {
    const { section, head } = parts(await piPage("/entries/provider-02/model-9"));
    expect(section).toContain("<code>provider-02/Model-Nine</code>");
    expect(section).toContain("<strong>Model Nine</strong>");
    expect(section).toContain("Paired by providers.dev: Pi spells the provider or model id otherwise than this entry.");
    expect(head).toContain("as provider-02/Model-Nine");
  });

  it("an entry page without a block: one line, the same section, no mark", async () => {
    const { entry } = (await (await piApi("/api/v1/entries/provider-20/lab/model-4")).json() as { data: { entry: JsonObject } }).data;
    expect((entry.providers_dev as JsonObject).pi).toBeNull();
    const html = await piPage("/entries/provider-20/lab/model-4");
    const { section, head } = parts(html);
    expect(section).toContain("Pi's model catalog does not list this entry.");
    expect(section).toContain("Fetched <span class=\"date\"");
    expect(section).not.toContain("<table");
    expect(head).not.toContain("pi.dev");
    expect(html).not.toContain('class="origin pi"');
  });

  it("a catalog row with a block has the pi.dev badge with its date and nothing about differences; a row without one has neither", async () => {
    const { snapshot } = (await (await piApi("/api/v1/meta")).json() as { data: Meta }).data.pi;
    // The date of the import that wrote pi's data (fetched_at), the kind of date the models.dev mark has; not the check.
    const [fetched, checked] = [snapshot!.fetched_at.slice(0, 10), snapshot!.checked_at.slice(0, 10)];
    expect(fetched).not.toBe(checked);
    for (const path of ["/?q=model-4&limit=200", "/providers/provider-02/", "/models/lab/model-4/"]) {
      const html = await piPage(path);
      const listed = rowOf(html, "provider-02/lab/model-4");
      expect(listed, path).toContain('<span class="origin pi" title="Pi&#39;s model catalog (pi.dev) also lists this entry.');
      // Three sources, each a mark and its date, pi's last.
      const sources = listed.split('<td class="nowrap source-col" data-label="Source">')[1]!.split("</td>")[0]!;
      expect(sources.replace(/<[^>]+>/g, " ").trim().split(/\s+/), path).toEqual(["models.dev", expect.stringMatching(/^\d{4}-\d\d-\d\d$/), "providers.dev", "2026-11-01", "pi.dev", fetched]);
      expect(sources, path).toMatch(new RegExp(`>pi\\.dev</span><span class="muted date" title="Fetched from Pi&#39;s catalog ${fetched} \\d\\d:\\d\\d UTC\\. Last checked ${checked} \\d\\d:\\d\\d UTC: unchanged since the fetch\\.">${fetched}</span></span>$`));
      expect(listed).not.toMatch(/\d differs?|otherwise/i);
      expect(listed).not.toContain("pi-differ");
      // The pi.dev mark and what follows it show fetched_at, not checked_at. Only that part is searched: the models.dev
      // date before it is the fixture's import, made with today's clock, and may be either day.
      const mark = sources.indexOf('<span class="origin pi"');
      expect(mark, path).toBeGreaterThan(0);
      const piPart = sources.slice(mark);
      expect(piPart, path).toContain(`>${fetched}<`);
      expect(piPart, path).not.toContain(`>${checked}<`);
      if (!path.startsWith("/providers/")) {
        const unlisted = rowOf(html, "provider-20/lab/model-4");
        expect(unlisted, path).not.toContain("pi.dev");
        expect(unlisted, path).not.toContain("Pi&#39;s catalog");
        // One source, one date: the models.dev import's.
        const own = unlisted.split('<td class="nowrap source-col" data-label="Source">')[1]!.split("</td>")[0]!;
        expect(own, path).toMatch(/^<span class="sources"><span class="origin upstream"[^>]*>models\.dev<\/span><span class="muted date" title="Imported from models\.dev on this date\.">\d{4}-\d\d-\d\d<\/span><\/span>$/);
      }
    }
  });

  it("the home page hands the browser pi's part of /api/v1/meta, from which the rows it draws take their date", async () => {
    const { pi } = (await (await piApi("/api/v1/meta")).json() as { data: Meta }).data;
    const html = await piPage("/");
    const attribute = html.match(/<table class="entries stack-tablet" id="entries"[^>]* data-pi="([^"]*)"/)![1]!;
    expect(JSON.parse(attribute.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"))).toEqual(pi);
  });

  it("the home page's lead names pi's model catalog, with a link to the methodology, where a pi snapshot exists", async () => {
    const html = await piPage("/");
    const lead = html.match(/<p class="lead">([\s\S]*?)<\/p>/)![1]!;
    expect(lead).toContain('Built on <a href="https://models.dev">models.dev</a> and <a href="/docs/methodology/#pi">Pi\'s model catalog</a>, with our own <a href="/?origin=modified,added">corrections and measurements</a> on top.');
    expect(lead).not.toMatch(/\d/);
  });

  it("the home page says nothing about differences in anything about pi: not in a row, not in a column's title", async () => {
    for (const path of ["/", "/?q=model-4&limit=200"]) {
      const html = await piPage(path);
      // Every text and every attribute value of the page, and of them those that speak of pi.
      const aboutPi = html.split(/[<>"]/).filter((piece) => /\bpi\b|pi\.dev|Pi&#39;s/i.test(piece));
      expect(aboutPi.length, path).toBeGreaterThan(2);
      expect(aboutPi.filter((piece) => /differ/i.test(piece)), path).toEqual([]);
      expect(html, path).toContain("and the import of Pi&#39;s catalog, where Pi lists the entry.");
    }
  });

  it("the pi.dev mark is a mark like the other sources, not a link, on rows and on the entry page", async () => {
    for (const path of ["/?q=model-4&limit=200", "/providers/provider-02/", "/entries/provider-02/lab/model-4", "/entries/provider-02/lab/model-0"]) {
      const html = await piPage(path);
      expect(html, path).toContain('<span class="origin pi"');
      expect(html, path).not.toMatch(/<a [^>]*class="origin pi"|href="(?:\/entries\/[^"]*)?#pi"/);
    }
  });

  it("7. the footer says \"last checked\" only after a check later than the fetch, and no last good snapshot without one", async () => {
    /** The pages read /api/v1/meta with `pi` replaced. */
    const withMeta = (pi: (meta: Meta["pi"]) => Meta["pi"]) => async (path: string) => {
      const response = await piApi(path);
      if (!path.startsWith("/api/v1/meta")) return response;
      const body = (await response.json()) as { meta: unknown; data: Meta };
      return new Response(JSON.stringify({ ...body, data: { ...body.data, pi: pi(body.data.pi) } }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const footer = async (read: (path: string) => Promise<Response>) => (await (await handlePage(new Request("https://providers.dev/providers/"), { api: read, shell: async () => new Response(shell), site: "https://providers.dev", now })).text()).split("<footer>")[1]!;
    const fetchedOnly = await footer(withMeta((pi) => ({ ...pi, snapshot: { ...pi.snapshot!, checked_at: pi.snapshot!.fetched_at } })));
    expect(fetchedOnly).toContain("<li>Pi's catalog fetched 2026-11-20</li>");
    expect(fetchedOnly).not.toContain("last checked");
    const failedFirst = await footer(withMeta((pi) => ({ ...pi, snapshot: null, sync: { last_attempt_at: "2026-11-21T04:17:00.000Z", last_attempt_ok: false, last_error: "pi.dev answered HTTP 503" }, counts: { entries_with_block: 0, left_out_models: 0, unmatched_models: 0 } })));
    expect(failedFirst).toContain('<li class="stale">The last import of Pi\'s catalog failed. This dataset has no Pi data.</li>');
    expect(failedFirst).not.toContain("Its data is the last good snapshot");
    const failedLater = await footer(withMeta((pi) => ({ ...pi, sync: { last_attempt_at: "2026-11-21T04:17:00.000Z", last_attempt_ok: false, last_error: "pi.dev answered HTTP 503" } })));
    expect(failedLater).toContain("The last import of Pi's catalog failed. Its data is the last good snapshot.");
    // The second review: by time, not by spelling. The same instant, and an earlier one, spelled to sort later as text.
    for (const [fetched, checked] of [["2026-11-21T05:00:00.000Z", "2026-11-21T05:00:00Z"], ["2026-11-21T05:00:00.418Z", "2026-11-21T05:00:00Z"]]) {
      const html = await footer(withMeta((pi) => ({ ...pi, snapshot: { ...pi.snapshot!, fetched_at: fetched!, checked_at: checked! } })));
      expect(html).toContain("<li>Pi's catalog fetched 2026-11-21</li>");
    }
    const later = await footer(withMeta((pi) => ({ ...pi, snapshot: { ...pi.snapshot!, fetched_at: "2026-11-21T05:00:00.000Z", checked_at: "2026-11-22T05:00:00Z" } })));
    expect(later).toContain("<li>Pi's catalog fetched 2026-11-21, last checked 2026-11-22</li>");
  });

  it("dates pi's catalog in the footer of every page, and says when its last import failed", async () => {
    const html = await piPage("/providers/");
    expect(html).toContain("<li>Pi's catalog fetched 2026-11-20, last checked 2026-11-21</li>");
    expect(html).not.toContain("The last import of Pi's catalog failed");
  });
});
