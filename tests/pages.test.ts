import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { publish } from "../scripts/lib/publish.ts";
import { stageSnapshot } from "../scripts/lib/stage.ts";
import { sync } from "../scripts/lib/sync.ts";
import { handleApi, type ApiDeps } from "../src/core/api.ts";
import { CorrectionSchema, DocumentationSchema, FacetsSchema, one, pageOf } from "../src/core/contract.ts";
import { escapeHtml } from "../src/core/format.ts";
import { fillShell, MARK } from "../src/core/page-shell.ts";
import { emptyInputWindow } from "../src/core/limits.ts";
import { handlePage, type PageDeps } from "../src/core/pages.ts";
import { openapi } from "../src/core/openapi.ts";
import { PARAMS } from "../src/core/query.ts";
import { DOCUMENTS } from "../src/core/resources.ts";
import { readSnapshot, type AssetBinding } from "../src/core/snapshot.ts";
import worker from "../worker/index.ts";
import type { PiCatalog } from "../src/core/pi.ts";
import type { JsonObject } from "../src/core/merge.ts";
import { depsFrom, fetchReturning, fixturePi, fixtureUpstream, ROOT, tempDataDir, writeAuthored, writePiSnapshot } from "./helpers.ts";

const shell = `<html><head><title>${MARK.title} · providers.dev</title><meta name="description" content="${MARK.description}"><link rel="canonical" href="${MARK.canonical}"></head><body><nav>${MARK.nav}</nav><main>${MARK.html}</main><footer>${MARK.dataset}</footer></body></html>`;
const now = () => new Date("2026-11-14T12:00:00Z");
let deps: ApiDeps;
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
      ["/support/", "/api/v1/docs/support"],
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

  it("prints cache lifetimes from cache_lifetime", async () => {
    // Documented lifetimes, caching with no lifetime, does not cache, nothing known; and the lists.
    const paths = ["/?provider=provider-02&limit=8", "/providers/provider-02/", "/models/lab/model-4/", "/entries/provider-02/lab/model-4", "/entries/provider-02/model-1", "/entries/provider-02/lab/model-2", "/entries/provider-02/model-3"];
    for (const path of paths) {
      const response = await page(path);
      expect(response.status, path).toBe(200);
      const html = await response.text();
      expect(html, path).not.toContain("Cache, measured");
    }
    // model-4 documents 5m and 1h: two documented lifetimes, models.dev, on the date of the import.
    const entry = await (await page("/entries/provider-02/lab/model-4")).text();
    expect(entry).toContain("<h3>Lifetimes</h3>");
    expect(entry.match(/<tbody class="item documented">/g)).toHaveLength(2);
    expect(entry).toContain('<th scope="row" title="Short retention: the cache a request gets without asking for a lifetime, or with the provider\'s shortest setting.">Short retention</th>');
    const catalog = await (await page("/?provider=provider-02&limit=8")).text();
    expect(catalog).toContain('<td class="life-col" data-label="Cache lifetime"><a class="plain lifes" href="/entries/provider-02/lab/model-4#cache"');
  });

  it("prints the input window from input_window of the API's answer, on the lists and on the entry page", async () => {
    // A record that is in no entry of the fixture: whatever the pages print of it, they read from the answer.
    const record = {
      ...emptyInputWindow(), tokens: 1047604, basis: "measured", bound: "at_least", scope: "input", source: "providers.dev", date: "2026-11-10",
      measured_tokens: 1047604, measured_bound: "at_least", measured_kind: "bracket", measured_refused: 1050000, measured_date: "2026-11-10", clients: 1, evaluations: 1,
      measurements: [{ client: "cliproxyapi", client_label: "Requests sent through CLIProxyAPI", route: "login", route_label: "A login", date: "2026-11-10", tokens: 1047604, bound: "at_least", kind: "bracket", accepted: 1047604, refused: 1050000, named: null, read: null, source: "https://example.com/limits.jsonl" }],
    };
    type Answer = { data: unknown };
    const swapped = async (path: string): Promise<Response> => {
      const response = await api(path);
      if (!/^\/api\/v1\/(entries|providers\/|models\/)/.test(path)) return response;
      const answer = await response.json() as Answer;
      const swap = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(swap);
        if (value === null || typeof value !== "object") return value;
        return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, key === "input_window" ? record : swap(inner)]));
      };
      return Response.json({ ...answer, data: swap(answer.data) });
    };
    for (const path of ["/?provider=provider-02&limit=8", "/providers/provider-02/", "/models/lab/model-4/"]) {
      const html = await (await page(path, swapped)).text();
      expect(html, path).toContain('<span class="window-value">≥ 1.04M</span><span class="basis measured">measured</span>');
      // As published, the fixture's own record: documented from models.dev.
      const published = await (await page(path)).text();
      expect(published, path).not.toContain("≥ 1.04M");
      expect(published, path).toContain('<span class="basis documented">documented</span>');
    }
    const entry = await (await page("/entries/provider-02/lab/model-4", swapped)).text();
    expect(entry).toContain('<span class="window-value"><span class="bound">at least</span> 1,047,604 <span class="muted">tokens</span></span>');
    expect(entry).toContain("1,047,604 accepted · 1,050,000 refused");
    expect(entry).toContain('<a href="https://example.com/limits.jsonl" rel="noopener">Raw result</a>');
    const published = await (await page("/entries/provider-02/lab/model-4")).text();
    expect(published).toContain('<h3 id="input-window">Input window</h3>');
    expect(published).not.toContain("1,047,604");
  });

  it("says in the methodology how the input window is worked out and what it does not say", () => {
    const source = readFileSync(join(ROOT, "src", "pages", "reference-content", "docs", "methodology.astro"), "utf8").replace(/\s+/g, " ");
    for (const words of [
      '{ id: "input-window", label: "Input window" }', '<h2 id="input-window">Input window</h2>', "<code>providers_dev.limits.input_window</code>", "the client's own system prompt and tool definitions included",
      "in two figures only, the safe cache lifetime and the input window", "it is what the route accepts, the client's own prompt and tools included, not what is left after them",
      "at or below 99 %", "at or above 101 %", "the lowest decides", "<code>bound: at_least</code>", "rounded down, never up",
      "<em>Documentation contradicted</em>", "<em>Documentation not contradicted</em>", "<code>limit.context</code> and nothing else",
      "One account per route.", "goes stale as all providers.dev evidence does", "A refused size is the probe's count, not the provider's.",
      "A window a route names is its total.", "not contradicted is not confirmed",
    ]) expect(source, words).toContain(words);
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

  it("serves the support document at /support/ only, outside the main navigation", async () => {
    const response = await page("/support/");
    expect(response.status).toBe(200);
    const nav = (await response.text()).match(/<nav>(.*?)<\/nav>/)![1]!;
    expect(nav).not.toContain('aria-current="page"');
    expect(nav).not.toContain("Support");
    const moved = await page("/docs/support/");
    expect(moved.status).toBe(301);
    expect(moved.headers.get("Location")).toBe("https://providers.dev/support/");
    expect((await page("/support/plans/")).status).toBe(404);
  });

  it("says on the support page what a company can buy, with the owner's decisions as written", () => {
    const source = readFileSync(join(ROOT, "src", "pages", "reference-content", "docs", "support.astro"), "utf8").replace(/\s+/g, " ");
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
      "We never ask for your API keys, logins or prompts",
    ]) expect(source, words).toContain(words);
    // The business name and VAT number go in the vendor pack, never on the page; no referral, affiliate or sponsor link.
    for (const words of ["SRL", "S.R.L", "RO1", "RO2", "RO3", "RO4", "RO5", "RO6", "RO7", "RO8", "RO9", "github.com/sponsors", "referral", "affiliate", "cheapest", "compliant"]) expect(source, words).not.toContain(words);
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
    // The worked examples are entries of data/authored, as written there.
    const openrouter = readFileSync(join(ROOT, "data", "authored", "overrides", "openrouter.yaml"), "utf8");
    for (const words of ["https://openrouter.ai/docs/guides/best-practices/prompt-caching#deepseek", "Prompt caching with DeepSeek is automated and does not require any additional configuration.", "results/openrouter-direct/R10-2026-11-04T19-00-07.json", "20 of 27 later re-sends were served from the cache, the oldest at 25 minutes."]) {
      expect(openrouter, words).toContain(words);
      expect(source, words).toContain(words);
    }
  });

  it("links the contributing page from the methodology, the footer and the evidence page, and states the same independence on the methodology", async () => {
    const methodology = readFileSync(join(ROOT, "src", "pages", "reference-content", "docs", "methodology.astro"), "utf8").replace(/\s+/g, " ");
    expect(methodology).toContain("providers.dev takes no payment for listing, correcting or measuring an entry. A provider may supply documentation, or access for a measurement; the result is published whatever it shows.");
    expect(methodology.match(/<a href="\/docs\/contributing\/">contributing<\/a>/g)).toHaveLength(2);
    const layout = readFileSync(join(ROOT, "src", "layouts", "Base.astro"), "utf8");
    expect(layout).toMatch(/<li><a href="\/docs\/licensing\/">Licensing and attribution<\/a><\/li>\s*<li><a href="\/docs\/contributing\/">Contributing<\/a><\/li>\s*<li><a href="\/support\/">Provimux support<\/a><\/li>\s*<li><a href="mailto:office@providers\.dev">Contact<\/a><\/li>/);
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
    expect((await page("/?min_context=nope")).status).toBe(400);
  });

  it("shows the version and the Stability section of the OpenAPI document on /docs/api/", async () => {
    const html = await (await page("/docs/api/")).text();
    expect(html).toContain("Version 1.2.0 ·");
    expect(html).toContain('<h2 id="stability">Stability</h2>');
    expect(html).toContain("/api/v1 only grows.");
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
    expect((await page("/?lifetime_basis=none")).status).toBe(400);
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
    const all = "q=model&provider=provider-02&family=f&canonical_id=lab/model-1&type=chat&access=api&origin=upstream&cache=yes&cache_mode=implicit&lifetime_basis=measured&min_context=1&min_output=1&max_age_months=600&evaluated=false&sort=cache_short&order=desc&limit=10&offset=10";
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
    const result = fillShell(`${MARK.title}${MARK.html}`, { title: MARK.html, html: "actual content", description: "", canonical: "", dataset: "", nav: "" });
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
  expect(await page.text()).toContain("No entries are listed for this provider.");
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
    const { section, head } = parts(await piPage("/entries/provider-02/lab/model-0"));
    expect(section).toContain("<code>anthropic-messages</code>");
    expect(section).toContain("<code class=\"break\">https://api.provider-02.example/v1</code>");
    for (const [name, value] of Object.entries(block.compat as JsonObject)) expect(section).toContain(`<dt><code>${name}</code></dt><dd><code>${escapeHtml(JSON.stringify(value))}</code></dd>`);
    for (const [level, value] of Object.entries(block.thinking_level_map as JsonObject)) expect(section).toContain(`<dt>${level}</dt><dd>${value === null ? '<span class="muted" title="pi marks this level as not supported.">not supported</span>' : `<code>${value}</code>`}</dd>`);
    // Whose data it is, and as of when: fetched from pi, last checked unchanged, the page following models.dev, pi's list.
    expect(section).toContain("Fetched <span class=\"date\" title=\"2026-11-20 14:19 UTC\">2026-11-20</span> from <a href=\"https://pi.dev/api/models\"");
    expect(section).toContain("Last checked <span class=\"date\" title=\"2026-11-21 04:17 UTC\">2026-11-21</span>, unchanged");
    expect(section).toContain("Not verified by providers.dev");
    expect(section).toContain("This page follows models.dev");
    expect(section).toContain('href="https://pi.dev/models?provider=provider-02"');
    expect(section).toContain("The same provider and model id as this entry.");
    expect(section).not.toContain("The last import");
    // Agreeing everywhere: seven rows, each "No difference"; the mark in the heading says no more than pi.dev.
    expect(section.split(">No difference<").length - 1).toBe(7);
    expect(section).not.toContain("Differs");
    expect(head).toContain('<span class="origin pi" title="pi&#39;s model catalog (pi.dev) also lists this entry. Its price, context window and output limit agree with this page wherever both state one.');
    expect(head).toMatch(/>pi\.dev<\/span><span class="muted date" title="[^"]*">2026-11-20<\/span>/);
    expect(head).not.toContain("differ");
  });

  it("an entry page with differences: both values of each, and pi's price of 0 is not stated, never free", async () => {
    const { entry, summary } = (await (await piApi("/api/v1/entries/provider-02/lab/model-4")).json() as { data: { entry: JsonObject; summary: { pi: { difference_count: number } } } }).data;
    const differences = ((entry.providers_dev as JsonObject).pi as JsonObject).differences as { field: string; pi: number; published: number }[];
    expect(differences.map((item) => [item.field, item.pi, item.published])).toEqual([["context_window", 450000, 500000], ["max_tokens", 4000, 5000], ["cost.input", 4, 2]]);
    expect(summary.pi.difference_count).toBe(3);
    const { section, head } = parts(await piPage("/entries/provider-02/lab/model-4"));
    expect(head).toContain('<span class="pi-differ">3 differ<span class="sr-only"> from this page</span></span>');
    const row = (label: string) => section.split(`<th scope="row">${label}<`)[1]!.split("</tr>")[0]!;
    expect(row("Context window")).toMatch(/450,000 <span class="muted">tokens<\/span>.*Differs<\/span> 500,000 <span class="muted">tokens/);
    expect(row("Maximum output")).toMatch(/4,000 <span class="muted">tokens<\/span>.*Differs<\/span> 5,000 <span class="muted">tokens/);
    expect(row("Input")).toMatch(/\$4 <span class="muted">\/ 1M<\/span>.*Differs<\/span> \$2 <span class="muted">\/ 1M/);
    expect(section.split('<tr class="differs">').length - 1).toBe(3);
    // The output price agrees (16 and 16); pi's cache write is 0, which is not a statement.
    expect(row("Output")).toContain("No difference");
    expect(row("Cache write")).toContain(">Not stated</span>");
    expect(section.replace(/title="[^"]*"/g, "")).not.toMatch(/\bfree\b/i);
    for (const flag of ["supportsLongCacheRetention", "thinkingFormat"]) expect(section).toContain(`<code>${flag}</code>`);
  });

  it("an entry paired through the alias file shows pi's own spelling", async () => {
    const { section, head } = parts(await piPage("/entries/provider-02/model-9"));
    expect(section).toContain("<code>provider-02/Model-Nine</code>");
    expect(section).toContain("<strong>Model Nine</strong>");
    expect(section).toContain("Paired by providers.dev: pi spells the provider or model id otherwise than this entry.");
    expect(head).toContain("as provider-02/Model-Nine");
  });

  it("an entry page without a block: one line, the same section, no mark", async () => {
    const { entry } = (await (await piApi("/api/v1/entries/provider-20/lab/model-4")).json() as { data: { entry: JsonObject } }).data;
    expect((entry.providers_dev as JsonObject).pi).toBeNull();
    const html = await piPage("/entries/provider-20/lab/model-4");
    const { section, head } = parts(html);
    expect(section).toContain("pi's model catalog does not list this entry.");
    expect(section).toContain("Fetched <span class=\"date\"");
    expect(section).not.toContain("<table");
    expect(head).not.toContain("pi.dev");
    expect(html).not.toContain('class="origin pi"');
  });

  it("a catalog row with a block has the pi.dev badge and nothing about differences; a row without one has no badge", async () => {
    for (const path of ["/?q=model-4&limit=200", "/providers/provider-02/"]) {
      const html = await piPage(path);
      const listed = rowOf(html, "provider-02/lab/model-4");
      expect(listed, path).toContain('<span class="origin pi" title="pi&#39;s model catalog (pi.dev) also lists this entry.');
      expect(listed).toMatch(/>pi\.dev<\/span><\/span><\/td>/);
      expect(listed).not.toMatch(/differ|otherwise|agree/i);
      expect(listed).not.toContain("pi-differ");
      if (path.startsWith("/?")) expect(rowOf(html, "provider-20/lab/model-4")).not.toContain("pi.dev");
    }
  });

  it("the pi.dev mark is a mark like the other sources, not a link, on rows and on the entry page", async () => {
    for (const path of ["/?q=model-4&limit=200", "/providers/provider-02/", "/entries/provider-02/lab/model-4", "/entries/provider-02/lab/model-0"]) {
      const html = await piPage(path);
      expect(html, path).toContain('<span class="origin pi"');
      expect(html, path).not.toMatch(/<a [^>]*class="origin pi"|href="(?:\/entries\/[^"]*)?#pi"/);
    }
  });

  it("dates pi's catalog in the footer of every page, and says when its last import failed", async () => {
    const html = await piPage("/providers/");
    expect(html).toContain("<li>pi's catalog fetched 2026-11-20, last checked 2026-11-21</li>");
    expect(html).not.toContain("The last import of pi's catalog failed");
  });
});
