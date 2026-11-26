// What agents are given (src/core/agents.ts, src/core/markdown.ts, src/core/product-agents.ts): the markdown version
// of every page, how it is asked for, /llms.txt on each host and /.well-known/api-catalog. The one failure that matters
// is a markdown version that says something its page does not: tests/page-text.ts reads the page's HTML and the
// markdown apart and they are compared, on the fixture and on every entry, provider and model of the build in dist/.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import { publish } from "../scripts/lib/publish.ts";
import { stageSnapshot } from "../scripts/lib/stage.ts";
import { sync } from "../scripts/lib/sync.ts";
import { markdownBase, markdownHref, prefersMarkdown } from "../src/core/agents.ts";
import type { Index } from "../src/core/entries.ts";
import { entryHref, modelHref, providerHref } from "../src/core/format.ts";
import { htmlToMarkdown, pictureWords } from "../src/core/markdown.ts";
import { DOCUMENTS } from "../src/core/resources.ts";
import type { AssetBinding } from "../src/core/snapshot.ts";
import worker from "../worker/index.ts";
import { fetchReturning, fixtureUpstream, ROOT, tempDataDir, writeAuthored } from "./helpers.ts";
import { htmlText, markdownText, type PageText } from "./page-text.ts";

const SITE = "https://providers.dev";
const MARKDOWN = "text/markdown; charset=utf-8";

/** ASSETS over a folder as the build lays it out (current.json, snapshots/, site-shell/, product folders). */
function binding(root: string): AssetBinding {
  return {
    async fetch(request) {
      const path = decodeURIComponent(new URL(typeof request === "string" ? request : request.url).pathname);
      let file = join(root, path.endsWith("/") ? `${path}index.html` : path);
      if (!existsSync(file) && existsSync(join(file, "index.html"))) file = join(file, "index.html");
      return existsSync(file) ? new Response(readFileSync(file)) : new Response(null, { status: 404 });
    },
  };
}

type Ask = (url: string, headers?: Record<string, string>, method?: string) => Promise<Response>;
const asker = (root: string): Ask => {
  const assets = binding(root);
  return (url, headers = {}, method = "GET") => worker.fetch(new Request(url.startsWith("http") ? url : `${SITE}${url}`, { headers, method }), { ASSETS: assets });
};

/** Where the HTML page and its markdown version first differ, or null: the text outside tables, then each table, row by row. */
function difference(page: PageText, markdown: PageText): string | null {
  const at = (a: string, b: string): string => {
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    return `page …${a.slice(Math.max(0, i - 60), i + 60)}\n markdown …${b.slice(Math.max(0, i - 60), i + 60)}`;
  };
  if (page.text !== markdown.text) return `text: ${at(page.text, markdown.text)}`;
  if (page.tables.length !== markdown.tables.length) return `${page.tables.length} tables, ${markdown.tables.length} in markdown`;
  for (const [t, table] of page.tables.entries()) {
    const other = markdown.tables[t]!;
    if (table.length !== other.length) return `table ${t}: ${table.length} rows, ${other.length} in markdown`;
    for (const [r, row] of table.entries()) if (JSON.stringify(row) !== JSON.stringify(other[r])) return `table ${t}, row ${r}: ${at(JSON.stringify(row), JSON.stringify(other[r]))}`;
  }
  return null;
}

/** The HTML page at `path` and its markdown version at its own address, compared; null where they agree. */
async function compare(ask: Ask, path: string): Promise<string | null> {
  const page = await ask(path);
  const markdown = await ask(markdownHref(path));
  if (page.status !== 200 || markdown.status !== 200) return `${path}: ${page.status}, markdown ${markdown.status}`;
  const found = difference(htmlText(await page.text()), markdownText(await markdown.text()));
  return found && `${path}: ${found}`;
}

describe("asking for markdown", () => {
  it("chooses markdown only where the Accept header names it, with a quality above 0 and not below HTML's", () => {
    expect(prefersMarkdown(null)).toBe(false);
    expect(prefersMarkdown("*/*")).toBe(false);
    expect(prefersMarkdown("text/*")).toBe(false);
    expect(prefersMarkdown("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")).toBe(false);
    expect(prefersMarkdown("text/markdown")).toBe(true);
    // Both orders: the order of the ranges is not a preference (RFC 9110), only their quality.
    expect(prefersMarkdown("text/markdown, text/html")).toBe(true);
    expect(prefersMarkdown("text/html, text/markdown")).toBe(true);
    expect(prefersMarkdown("text/markdown, text/html;q=0.9, */*;q=0.8")).toBe(true);
    expect(prefersMarkdown("text/html, text/markdown;q=0.9")).toBe(false);
    expect(prefersMarkdown("text/markdown;q=0.9, text/html")).toBe(false);
    expect(prefersMarkdown("text/markdown;q=0, */*;q=1")).toBe(false);
    expect(prefersMarkdown("text/markdown;q=0")).toBe(false);
    expect(prefersMarkdown("text/markdown;q=0.5, text/*;q=0.9")).toBe(false);
    expect(prefersMarkdown("text/markdown;q=0.9, text/*;q=0.5")).toBe(true);
    expect(prefersMarkdown("text/markdown; charset=utf-8; q=0.8, text/html; q=0.8")).toBe(true);
  });

  it("reads a markdown address as the page it stands for, and writes it back", () => {
    expect(markdownBase("/index.html.md")).toBe("/");
    expect(markdownBase("/providers/anthropic/index.html.md")).toBe("/providers/anthropic/");
    expect(markdownBase("/models/openai/gpt-6.1-terra/index.html.md")).toBe("/models/openai/gpt-6.1-terra/");
    expect(markdownBase("/entries/openrouter/anthropic/claude-opus-5.5.md")).toBe("/entries/openrouter/anthropic/claude-opus-5.5");
    expect(markdownBase("/entries/a/b/index.html.md")).toBeNull();
    expect(markdownBase("/entries/a/.md")).toBeNull();
    expect(markdownBase("/providers/anthropic/")).toBeNull();
    expect(markdownBase("/index.md")).toBeNull();
    expect(markdownHref("/")).toBe("/index.html.md");
    expect(markdownHref("/providers/?offset=50")).toBe("/providers/index.html.md?offset=50");
    expect(markdownHref("/entries/a/b")).toBe("/entries/a/b.md");
  });
});

describe("the markdown of HTML", () => {
  const md = (html: string): string => htmlToMarkdown(html, { base: `${SITE}/x/` });

  it("keeps the lines of a drawn terminal and of a program, and no line numbers it does not show", () => {
    expect(md('<pre><code><span class="pmx-t-row">/model</span><span class="pmx-t-row">→ ✓ opus</span><span class="pmx-t-row">    gpt</span></code></pre>')).toBe("```\n/model\n→ ✓ opus\n    gpt\n```");
    expect(md("<pre>fn main() {\n    println!(\"hi\");\n}</pre>")).toBe('```\nfn main() {\n    println!("hi");\n}\n```');
  });

  it("writes a table whole: spans, a head of two rows, a term and its value in a cell", () => {
    const table = '<table><thead><tr><th rowspan="2">A</th><th colspan="2">Ages</th></tr><tr><th>1</th><th>2</th></tr></thead><tbody><tr><th rowspan="2">x</th><td>1</td><td>2</td></tr><tr><td>3</td><td>4 | 5</td></tr><tr><td colspan="9">None</td></tr><tr><td><dl><div><dt>low</dt><dd><code>low</code></dd></div><div><dt>max</dt><dd>not supported</dd></div></dl></td><td></td><td></td></tr></tbody></table>';
    expect(md(table)).toBe("| A | Ages 1 | 2 |\n| --- | --- | --- |\n| x | 1 | 2 |\n| x | 3 | 4 \\| 5 |\n| None |  |  |\n| low: `low`<br>max: not supported |  |  |");
  });

  it("leaves out controls, what the page hides, and drawings; keeps screen-reader words", () => {
    expect(md('<p>Value<button class="copy">Copy</button><span aria-hidden="true">x</span><span hidden>y</span><kbd class="hidden sm:block">/</kbd><span class="sr-only"> (the value on this page)</span><svg><path/></svg></p><form><label>Search<input></label></form>')).toBe("Value (the value on this page)");
  });

  it("sets apart elements the page's styles set apart, and escapes what markdown would read", () => {
    expect(md('<p><span class="origin">models.dev</span><span class="date">2026-11-25</span></p>')).toBe("models.dev 2026-11-25");
    expect(md("<p>67<small>2/3</small></p>")).toBe("67 2/3");
    expect(md("<p>a * b [c] `d` &lt;e&gt; _f_ g_h</p>")).toBe("a \\* b \\[c\\] \\`d\\` \\<e> \\_f\\_ g_h");
    expect(md("<p>1. not a list</p><p># not a heading</p>")).toBe("1\\. not a list\n\n\\# not a heading");
  });

  it("writes links in full, and a picture once, with no e-mail address but office@providers.dev", () => {
    expect(md('<p><a href="/providers/a/">A</a> <a href="#b">B</a></p>')).toBe(`[A](${SITE}/providers/a/) [B](${SITE}/x/#b)`);
    expect(md('<img src="/a.webp" alt="A card: alex@example.com, Working"><img src="/a-dark.webp" alt="A card: alex@example.com, Working">')).toBe(`![A card: an e-mail address, Working](${SITE}/a.webp)`);
    expect(pictureWords("Write to office@providers.dev or team@example.com")).toBe("Write to office@providers.dev or an e-mail address");
  });

  it("leaves out a fold of raw JSON it is told to, and keeps other folds", () => {
    const html = "<details><summary>Show the full entry as published</summary><pre>{}</pre></details><details><summary>Other prices (1)</summary><pre>[1]</pre></details>";
    expect(htmlToMarkdown(html, { base: SITE, omit: (summary) => summary === "Show the full entry as published" })).toBe("**Other prices (1)**\n\n```json\n[1]\n```");
  });

  it("is told apart from its page by the comparison when a figure or a label changes", () => {
    const html = '<main><p>Context window <span class="bound">at least</span> 920,870 <span class="unit">tokens</span></p><table><thead><tr><th>Source</th><th>Value</th></tr></thead><tbody><tr><th>Measured</th><td>921,500</td></tr></tbody></table></main>';
    const markdown = `---\ntitle: "x"\n---\n\n${htmlToMarkdown(html.slice(6, -7), { base: SITE })}\n`;
    expect(difference(htmlText(html), markdownText(markdown))).toBeNull();
    expect(difference(htmlText(html), markdownText(markdown.replace("at least ", "")))).not.toBeNull();
    expect(difference(htmlText(html), markdownText(markdown.replace("921,500", "921,600")))).not.toBeNull();
    expect(difference(htmlText(html), markdownText(markdown.replace("Measured", "models.dev")))).not.toBeNull();
  });
});

describe("pages, their markdown, llms.txt and the API catalogue, on the fixture", () => {
  let ask: Ask;
  let refs: string[];
  beforeAll(async () => {
    const dataDir = tempDataDir();
    // An entry whose model id ends in .md, beside the entry whose markdown address that would be.
    const upstream = fixtureUpstream();
    const models = upstream["provider-00"]!.models;
    models["lab/model-0.md"] = { ...models["lab/model-0"]!, id: "lab/model-0.md", name: "Model 0 notes" };
    await sync({ dataDir, fetch: fetchReturning(JSON.stringify(upstream)) });
    writeAuthored(dataDir);
    expect(publish({ dataDir, rootDir: ROOT, now: () => new Date("2026-11-22T12:00:00Z") }).errors).toEqual([]);
    const root = tempDataDir();
    const id = stageSnapshot(join(dataDir, "published"), root);
    mkdirSync(join(root, "site-shell"));
    writeFileSync(join(root, "site-shell", "index.html"), '<html><head><title>%%PAGE_TITLE%%</title><meta name="description" content="%%PAGE_DESCRIPTION%%">%%PAGE_HEAD%%</head><body><nav>%%PAGE_NAV%%</nav><main>%%PAGE_HTML%%</main><footer><ul>%%PAGE_DATASET%%</ul></footer></body></html>');
    mkdirSync(join(root, "reference-content", "docs"), { recursive: true });
    for (const document of DOCUMENTS) writeFileSync(join(root, "reference-content", "docs", `${document}.json`), JSON.stringify({ title: document, description: `About ${document}`, lead: document, toc: [{ id: "one", label: "One" }], body_html: '<h2 id="one">One</h2><p>Text with <code>code</code> and a <a href="/docs/api/">link</a>.</p><table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>' }));
    ask = asker(root);
    const index = JSON.parse(gunzipSync(readFileSync(join(root, "snapshots", id, "data", "index.json.gz"))).toString()) as Index;
    refs = index.entries.map((summary) => summary.ref);
  });

  it("says what its page says, on every page of the fixture", async () => {
    const pages = ["/", "/?offset=50", "/providers/", "/models/", "/evidence/", "/docs/api/", "/docs/methodology/", "/docs/licensing/", "/docs/contributing/", ...refs.filter((ref) => !ref.endsWith(".md") && !refs.includes(`${ref}.md`)).map(entryHref), providerHref("provider-00"), modelHref("lab/model-2")];
    const found: string[] = [];
    for (const path of pages) { const problem = await compare(ask, path); if (problem) found.push(problem); }
    expect(found).toEqual([]);
  });

  it("serves the markdown with its type, its canonical page, the content signals and a validator; the page names it", async () => {
    const page = await ask("/entries/provider-01/lab/model-2");
    expect(page.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("Vary")).toBe("Accept");
    expect(page.headers.get("Content-Signal")).toBe("search=yes, ai-input=yes, ai-train=yes");
    expect(page.headers.get("Link")).toBe(`<${SITE}/entries/provider-01/lab/model-2.md>; rel="alternate"; type="text/markdown", <${SITE}/llms.txt>; rel="describedby"`);
    const html = await page.text();
    expect(html).toContain(`<link rel="alternate" type="text/markdown" href="${SITE}/entries/provider-01/lab/model-2.md">`);
    expect(html).toContain(`<link rel="describedby" href="${SITE}/llms.txt">`);
    const markdown = await ask("/entries/provider-01/lab/model-2.md");
    expect(markdown.status).toBe(200);
    expect(markdown.headers.get("Content-Type")).toBe(MARKDOWN);
    expect(markdown.headers.get("Link")).toBe(`<${SITE}/entries/provider-01/lab/model-2>; rel="canonical"`);
    expect(markdown.headers.get("Content-Signal")).toBe("search=yes, ai-input=yes, ai-train=yes");
    expect(markdown.headers.get("X-Robots-Tag")).toBeNull();
    expect(markdown.headers.get("Cache-Control")).toBe(page.headers.get("Cache-Control"));
    expect(markdown.headers.get("Vary")).toBeNull();
    const text = await markdown.text();
    expect(text).toMatch(/^---\ntitle: ".+"\ndescription: ".+"\ncanonical: https:\/\/providers\.dev\/entries\/provider-01\/lab\/model-2\ndataset_version: \w+\ndataset_generated_at: \S+\n---\n\n/);
    expect(text).toContain("\n# Model 2\n");
    // The home page and the API guide also name where the API is described.
    for (const path of ["/", "/docs/api/"]) expect((await ask(path)).headers.get("Link")).toContain(`<${SITE}/api/v1/openapi.json>; rel="service-desc"; type="application/json", <${SITE}/docs/api/>; rel="service-doc"; type="text/html", <${SITE}/.well-known/api-catalog>; rel="api-catalog"`);
  });

  it("answers the Accept header at a page's own address, in either order, and respects q=0", async () => {
    const path = "/providers/provider-00/";
    const html = await (await ask(path)).text();
    const markdown = await (await ask(markdownHref(path))).text();
    for (const accept of ["text/markdown", "text/markdown, text/html", "text/html, text/markdown", "text/markdown, text/html;q=0.9, */*;q=0.8"]) {
      const response = await ask(path, { Accept: accept });
      expect([accept, response.headers.get("Content-Type"), response.headers.get("Vary")]).toEqual([accept, MARKDOWN, "Accept"]);
      expect(await response.text()).toBe(markdown);
    }
    for (const accept of ["*/*", "text/html", "text/markdown;q=0, */*;q=1", "text/html, text/markdown;q=0.5"]) {
      const response = await ask(path, { Accept: accept });
      expect([accept, response.headers.get("Content-Type")]).toEqual([accept, "text/html; charset=utf-8"]);
      expect(await response.text()).toBe(html);
    }
    // The markdown address is markdown whatever the Accept header says.
    expect((await ask(markdownHref(path), { Accept: "text/html" })).headers.get("Content-Type")).toBe(MARKDOWN);
  });

  it("answers HEAD and a conditional request for each, and never one with the other's validator", async () => {
    const path = "/models/lab/model-2/";
    for (const [address, headers] of [[path, { Accept: "text/markdown" }], [markdownHref(path), {}], [path, {}]] as const) {
      const full = await ask(address, headers);
      const etag = full.headers.get("ETag")!;
      const head = await ask(address, headers, "HEAD");
      expect([address, head.status, await head.text(), head.headers.get("ETag"), head.headers.get("Content-Type")]).toEqual([address, 200, "", etag, full.headers.get("Content-Type")]);
      const again = await ask(address, { ...headers, "If-None-Match": etag });
      expect([address, again.status, again.headers.get("Vary")]).toEqual([address, 304, full.headers.get("Vary")]);
    }
    const htmlTag = (await ask(path)).headers.get("ETag")!;
    expect((await ask(path, { Accept: "text/markdown", "If-None-Match": htmlTag })).status).toBe(200);
    expect((await ask(markdownHref(path), { "If-None-Match": htmlTag })).status).toBe(200);
  });

  it("keeps an entry whose id ends in .md at its address, and gives the other entry's markdown a dedicated one", async () => {
    expect(refs).toContain("provider-00/lab/model-0.md");
    const exact = await ask("/entries/provider-00/lab/model-0.md");
    expect([exact.status, exact.headers.get("Content-Type")]).toEqual([200, "text/html; charset=utf-8"]);
    expect(await exact.text()).toContain(`<link rel="canonical" href="${SITE}/entries/provider-00/lab/model-0.md">`);
    // Its own markdown is at its address plus .md, or by Accept.
    expect((await ask("/entries/provider-00/lab/model-0.md", { Accept: "text/markdown" })).headers.get("Content-Type")).toBe(MARKDOWN);
    const twin = await ask("/entries/provider-00/lab/model-0.md.md");
    expect([twin.status, twin.headers.get("Link")]).toEqual([200, `<${SITE}/entries/provider-00/lab/model-0.md>; rel="canonical"`]);
    // The entry whose .md address that is: its markdown is named at ?format=markdown, and answers there.
    const other = await ask("/entries/provider-00/lab/model-0");
    expect(other.headers.get("Link")).toContain(`<${SITE}/entries/provider-00/lab/model-0?format=markdown>; rel="alternate"`);
    const dedicated = await ask("/entries/provider-00/lab/model-0?format=markdown");
    expect([dedicated.status, dedicated.headers.get("Content-Type"), dedicated.headers.get("Link")]).toEqual([200, MARKDOWN, `<${SITE}/entries/provider-00/lab/model-0>; rel="canonical"`]);
  });

  it("answers 404, never cached and not indexed, for a markdown address with no page, as for a page", async () => {
    for (const path of ["/entries/nobody/nothing.md", "/providers/nobody/index.html.md", "/models/lab/nothing/index.html.md", "/docs/nothing/index.html.md", "/entries/nobody/nothing"]) {
      const response = await ask(path);
      expect([path, response.status, response.headers.get("Cache-Control"), response.headers.get("X-Robots-Tag")]).toEqual([path, 404, "no-store", "noindex"]);
      expect(response.headers.get("Content-Type")).toBe(path.endsWith(".md") ? MARKDOWN : "text/html; charset=utf-8");
    }
    // A list's page past its end, in markdown too.
    expect((await ask("/providers/index.html.md?offset=999999")).status).toBe(404);
    // No index.md alias, no llms-full.txt.
    for (const path of ["/index.md", "/llms-full.txt", "/providers/anthropic/index.md"]) expect([path, (await ask(path)).status]).toEqual([path, 404]);
  });

  it("keeps a list's own query in its markdown, and a view of a list out of the index there too", async () => {
    const view = await ask("/providers/index.html.md?q=provider-0");
    expect(view.status).toBe(200);
    expect(view.headers.get("Link")).toBe(`<${SITE}/providers/?q=provider-0>; rel="canonical"`);
    expect(view.headers.get("X-Robots-Tag")).toBe("noindex");
    expect((await ask("/providers/index.html.md")).headers.get("X-Robots-Tag")).toBeNull();
  });

  it("sends www and plain http to the one address, markdown and llms.txt included", async () => {
    for (const [from, to] of [["https://www.providers.dev/llms.txt", `${SITE}/llms.txt`], ["http://providers.dev/entries/a/b.md", `${SITE}/entries/a/b.md`], ["http://www.providers.dev/.well-known/api-catalog", `${SITE}/.well-known/api-catalog`]]) {
      const response = await ask(from!, { "X-Forwarded-Proto": from!.startsWith("https") ? "https" : "http" });
      expect([from, response.status, response.headers.get("Location")]).toEqual([from, 301, to]);
    }
    // A page without its final slash goes to it; its markdown address is not redirected.
    expect((await ask("/providers/provider-00")).headers.get("Location")).toBe(`${SITE}/providers/provider-00/`);
  });

  it("leaves every answer of the API as it was, whatever the Accept header", async () => {
    for (const path of ["/api/v1/meta", "/api/v1/entries?limit=2", `/api/v1${entryHref(refs[0]!)}`, "/api/v1/providers/provider-00", "/api/v1/models/lab/model-2", "/api/v1/nothing", "/api/v1/", "/api/v1/openapi.json"]) {
      const plain = await ask(path);
      const asked = await ask(path, { Accept: "text/markdown" });
      expect([path, asked.status, asked.headers.get("Content-Type"), asked.headers.get("Vary"), asked.headers.get("Link")]).toEqual([path, plain.status, plain.headers.get("Content-Type"), plain.headers.get("Vary"), plain.headers.get("Link")]);
      expect(await asked.text()).toBe(await plain.text());
    }
  });

  it("serves llms.txt: every link in it answers, markdown as markdown, JSON as JSON", async () => {
    const response = await ask("/llms.txt");
    expect([response.status, response.headers.get("Content-Type")]).toEqual([200, "text/plain; charset=utf-8"]);
    expect(response.headers.get("Content-Signal")).toBe("search=yes, ai-input=yes, ai-train=yes");
    const text = await response.text();
    expect(text).toMatch(/^# providers\.dev\n\n> /);
    expect((await ask("/llms.txt", {}, "HEAD")).status).toBe(200);
    const links = [...text.matchAll(/\]\((https:\/\/[^)]+)\)/g)].map((match) => match[1]!);
    expect(links.length).toBeGreaterThan(12);
    for (const link of links) {
      const url = new URL(link);
      // The products' files are built into dist/, not in this fixture; their own test follows them.
      if (url.hostname !== "providers.dev") { expect(link).toMatch(/^https:\/\/(provimux|pi-cache-keeper)\.providers\.dev\/llms\.txt$/); continue; }
      const answer = await ask(link);
      const type = answer.headers.get("Content-Type");
      expect([link, answer.status]).toEqual([link, 200]);
      if (url.pathname.endsWith(".md")) expect([link, type]).toEqual([link, MARKDOWN]);
      else expect([link, type]).toEqual([link, "application/json; charset=utf-8"]);
    }
  });

  it("serves the API catalogue: a linkset whose every address answers with the type it names", async () => {
    const response = await ask("/.well-known/api-catalog");
    expect([response.status, response.headers.get("Content-Type")]).toEqual([200, 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"']);
    expect(response.headers.get("Link")).toBe(`<${SITE}/.well-known/api-catalog>; rel="api-catalog"`);
    const { linkset } = (await response.json()) as { linkset: Record<string, unknown>[] };
    expect(linkset[0]).toEqual({ anchor: `${SITE}/.well-known/api-catalog`, item: [{ href: `${SITE}/api/v1/entries` }] });
    expect(linkset[1]).toEqual({ anchor: `${SITE}/api/v1/entries`, "service-desc": [{ href: `${SITE}/api/v1/openapi.json`, type: "application/json" }], "service-doc": [{ href: `${SITE}/docs/api/`, type: "text/html" }] });
    for (const [href, type] of [[`${SITE}/api/v1/entries`, "application/json"], [`${SITE}/api/v1/openapi.json`, "application/json"], [`${SITE}/docs/api/`, "text/html"]] as const) {
      const answer = await ask(href);
      expect([href, answer.status, answer.headers.get("Content-Type")?.split(";")[0]]).toEqual([href, 200, type]);
    }
    expect((await ask("/.well-known/api-catalog", {}, "HEAD")).status).toBe(200);
  });
});

// The build `npm run build` made (Publish and Check build before they check): every entry, provider and model of the
// real data, the docs, and the products' pages as built.
describe("the build in dist/", () => {
  const built = join(ROOT, "dist");
  const ready = existsSync(join(built, "current.json")) && existsSync(join(built, "site-shell", "index.html"));

  it.skipIf(!ready)("gives every page a markdown version that says what the page says: every entry, provider and model, the lists and the docs", { timeout: 600_000 }, async () => {
    const ask = asker(built);
    const id = (JSON.parse(readFileSync(join(built, "current.json"), "utf8")) as { id: string }).id;
    const index = JSON.parse(gunzipSync(readFileSync(join(built, "snapshots", id, "data", "index.json.gz"))).toString()) as Index;
    const models = [...new Set(index.entries.flatMap((summary) => (summary.canonical_id ? [summary.canonical_id] : [])))];
    const paths = [
      "/", "/?offset=50", "/providers/", "/providers/?offset=50", "/models/", "/models/?offset=50", "/evidence/", "/docs/api/", "/docs/methodology/", "/docs/licensing/", "/docs/contributing/",
      ...index.providers.map((provider) => providerHref(provider.id)),
      ...models.map(modelHref),
      ...index.entries.map((summary) => entryHref(summary.ref)),
    ];
    // The build's own pages, all of them: as many as it has entries, providers and models, whatever an import brought.
    expect(index.entries.length).toBeGreaterThan(0);
    expect(paths.length).toBe(11 + index.providers.length + models.length + index.entries.length);
    const found: string[] = [];
    for (const path of paths) {
      const problem = await compare(ask, path);
      if (problem) found.push(problem);
      if (found.length >= 5) break;
    }
    expect(found).toEqual([]);
    // A provider's markdown links an entry only where the entry exists (Anthropic lists models it has no entry for).
    const refs = new Set(index.entries.map((summary) => entryHref(summary.ref)));
    for (const provider of index.providers) {
      const markdown = await (await ask(markdownHref(providerHref(provider.id)))).text();
      for (const [, path] of markdown.matchAll(/\]\(https:\/\/providers\.dev(\/entries\/[^)#?]+)/g)) expect([provider.id, refs.has(path!)]).toEqual([provider.id, true]);
    }
  });

  it.skipIf(!existsSync(join(built, "provimux", "index.html.md")))("gives each product page a markdown version of the page as built, and each product site an llms.txt whose links are its files", () => {
    const sites = [
      { site: "https://provimux.providers.dev", folder: "provimux", pages: ["/", "/support/"] },
      { site: "https://pi-cache-keeper.providers.dev", folder: "pi-cache-keeper", pages: ["/"] },
    ];
    for (const { site, folder, pages } of sites) {
      for (const path of pages) {
        const html = readFileSync(join(built, folder, path, "index.html"), "utf8");
        const markdown = readFileSync(join(built, folder, path, "index.html.md"), "utf8");
        expect([path, difference(htmlText(html, pictureWords), markdownText(markdown))]).toEqual([path, null]);
        expect(markdown).toContain(`canonical: ${site}${path}\n`);
        // No e-mail address of a sample screen: only the site's own.
        for (const [address] of markdown.matchAll(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g)) expect(address).toBe("office@providers.dev");
        // Every heading of the page, and each drawn terminal's lines as the page shows them.
        for (const [, heading] of html.matchAll(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/g)) expect(markdown).toContain(heading!.replace(/<[^>]+>/g, "").replace(/&#39;/g, "'").replace(/&amp;/g, "&").trim());
        for (const [, rows] of html.matchAll(/<pre class="pmx-term-rows"><code>([\s\S]*?)<\/code><\/pre>/g)) {
          const lines = [...rows!.matchAll(/<span class="pmx-t-row[^"]*">/g)].length;
          const block = /```\n(\/model[\s\S]*?)\n```/.exec(markdown)?.[1] ?? "";
          expect(block.split("\n")).toHaveLength(lines);
        }
      }
      const llms = readFileSync(join(built, folder, "llms.txt"), "utf8");
      for (const [, link] of llms.matchAll(/\]\((https:\/\/[^)]+)\)/g)) {
        const url = new URL(link!);
        if (url.origin === site) expect([link, existsSync(join(built, folder, url.pathname))]).toEqual([link, true]);
        else expect(link).toMatch(/^https:\/\/(providers\.dev\/llms\.txt|github\.com\/ngvoicu\/[\w-]+)$/);
      }
    }
  });

  it.skipIf(!existsSync(join(built, "provimux", "index.html.md")))("serves a product page's markdown at its address and by Accept, with its canonical page", async () => {
    const ask = asker(built);
    const page = await ask("https://provimux.providers.dev/support/");
    expect(page.headers.get("Link")).toBe('<https://provimux.providers.dev/support/index.html.md>; rel="alternate"; type="text/markdown", <https://provimux.providers.dev/llms.txt>; rel="describedby"');
    expect(page.headers.get("Vary")).toBe("Accept");
    expect(await page.text()).toContain('<link rel="alternate" type="text/markdown" href="https://provimux.providers.dev/support/index.html.md">');
    const file = await ask("https://provimux.providers.dev/support/index.html.md");
    expect([file.status, file.headers.get("Content-Type"), file.headers.get("Link")]).toEqual([200, MARKDOWN, '<https://provimux.providers.dev/support/>; rel="canonical"']);
    const negotiated = await ask("https://pi-cache-keeper.providers.dev/", { Accept: "text/markdown" });
    expect([negotiated.status, negotiated.headers.get("Content-Type"), negotiated.headers.get("Vary")]).toEqual([200, MARKDOWN, "Accept"]);
    expect(await negotiated.text()).toBe(readFileSync(join(built, "pi-cache-keeper", "index.html.md"), "utf8"));
    expect((await ask("https://pi-cache-keeper.providers.dev/", { Accept: "text/markdown;q=0, */*" })).headers.get("Content-Type")).not.toBe(MARKDOWN);
    const llms = await ask("https://pi-cache-keeper.providers.dev/llms.txt");
    expect([llms.status, llms.headers.get("Content-Type")]).toEqual([200, "text/plain; charset=utf-8"]);
    expect((await ask("https://provimux.providers.dev/nothing.md")).status).toBe(404);
  });
});
