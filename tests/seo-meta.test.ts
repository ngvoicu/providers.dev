// What a search engine or an agent reads first on a page: its title, its description, its social tags and its
// structured data (src/core/page-meta.ts, src/core/structured-data.ts). Every page type, on the fixture through
// handlePage; titles and descriptions over the whole publication in dist/; the product pages as built in dist/.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import { publish } from "../scripts/lib/publish.ts";
import { sync } from "../scripts/lib/sync.ts";
import { handleApi, modelsFor, type LoadedDeps } from "../src/core/api.ts";
import type { Index, Summary } from "../src/core/entries.ts";
import { MARK } from "../src/core/page-shell.ts";
import { cacheWords, documentMeta, entryMeta, HOME_TITLE, modelMeta, plain, providerLabels, providerMeta, UNNAMED, type PageMeta } from "../src/core/page-meta.ts";
import type { SafeValue } from "../src/core/safe.ts";
import { handlePage, type PageDeps } from "../src/core/pages.ts";
import type { Meta } from "../src/core/schema.ts";
import { depsFrom, fetchReturning, fixtureUpstream, ROOT, tempDataDir, writeAuthored } from "./helpers.ts";
import type { UpstreamCatalog } from "../src/core/schema.ts";

// The shell's head as Base.astro writes it: the title, description and social tags from the markers, then the page's head.
const shell = `<html><head><title>${MARK.title}</title><meta name="description" content="${MARK.description}"><meta property="og:title" content="${MARK.title}"><meta property="og:description" content="${MARK.description}"><meta name="twitter:title" content="${MARK.title}">${MARK.head}</head><body><nav>${MARK.nav}</nav><main>${MARK.html}</main><footer>${MARK.dataset}</footer></body></html>`;
const now = () => new Date("2026-11-14T12:00:00Z");
const SITE = "https://providers.dev";
let deps: LoadedDeps;

beforeAll(async () => {
  const dataDir = tempDataDir();
  await sync({ dataDir, fetch: fetchReturning(JSON.stringify(fixtureUpstream())) });
  writeAuthored(dataDir);
  expect(publish({ dataDir, rootDir: ROOT, now }).errors).toEqual([]);
  deps = depsFrom(join(dataDir, "published"));
});

const api = (path: string, from: LoadedDeps = deps) => handleApi(new Request(`${SITE}${path}`), from);
const pageDeps = (from: LoadedDeps = deps): PageDeps => ({ api: (path) => api(path, from), shell: async () => new Response(shell), site: SITE, now });
const page = (path: string, from: LoadedDeps = deps) => handlePage(new Request(`${SITE}${path}`), pageDeps(from));

const unescape = (text: string): string => text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
type Node = Record<string, unknown>;

/** What a page's head says of it, and its structured data, parsed. */
interface Read { status: number; title: string; description: string; ogTitle: string; ogUrl: string | null; canonical: string | null; h1: string[]; crumbs: string | null; scripts: string[]; graph: Node[] }
function readHtml(status: number, html: string): Read {
  const pick = (re: RegExp): string | null => { const found = re.exec(html)?.[1]; return found === undefined ? null : unescape(found); };
  const scripts = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((match) => match[1]!);
  return {
    status,
    title: pick(/<title>([^<]*)<\/title>/)!,
    description: pick(/<meta name="description" content="([^"]*)"/)!,
    ogTitle: pick(/<meta property="og:title" content="([^"]*)"/)!,
    ogUrl: pick(/<meta property="og:url" content="([^"]*)"/),
    canonical: pick(/<link rel="canonical" href="([^"]*)"/),
    h1: [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)].map((match) => unescape(match[1]!.replace(/<[^>]+>/g, "").trim())),
    crumbs: pick(/<p class="crumbs">([\s\S]*?)<\/p>/),
    scripts,
    graph: scripts.flatMap((script) => {
      const parsed = JSON.parse(script) as Node;
      expect(parsed["@context"]).toBe("https://schema.org");
      return parsed["@graph"] as Node[];
    }),
  };
}
async function read(path: string, from: LoadedDeps = deps): Promise<Read> {
  const response = await page(path, from);
  return readHtml(response.status, await response.text());
}

/** Every value of a graph, with the key it is under, at any depth. */
function walk(value: unknown, visit: (key: string, value: unknown) => void, key = ""): void {
  if (Array.isArray(value)) for (const item of value) walk(item, visit, key);
  else if (value && typeof value === "object") for (const [name, inner] of Object.entries(value)) { visit(name, inner); walk(inner, visit, name); }
}

/** The owner, as every footer links him and as his own site identifies him. */
const OWNER = { "@type": "Person", "@id": "https://ngvoicu.dev/#person", name: "Gabriel Voicu", url: "https://ngvoicu.dev/" };
const OWNER_LINK = '<a href="https://ngvoicu.dev/" rel="author">Gabriel Voicu</a>';

/**
 * Nothing the pages do not show: no rating, review, offer, search action, date or founder. The persons are those the
 * page credits, and the owner, whom every footer links, exactly as his site names him and in the roles given (by key).
 */
function claimsNothingElse(graph: Node[], persons: readonly string[] = [], roles: readonly string[] = []): void {
  const owned: string[] = [];
  const others: string[] = [];
  walk(graph, (key, value) => {
    expect(["aggregateRating", "review", "offers", "potentialAction", "datePublished", "dateModified", "dateCreated", "founder", "sameAs"], key).not.toContain(key);
    if (key === "@type") expect(["Offer", "AggregateRating", "Review", "SearchAction", "Product"]).not.toContain(value);
    const node = value as Node | null;
    if (node && typeof node === "object" && !Array.isArray(node) && node["@type"] === "Person") {
      if (node["@id"] === OWNER["@id"]) { expect(node).toEqual(OWNER); owned.push(key); } else others.push(node.name as string);
    }
  });
  // The owner's name and site appear nowhere but in that one object.
  expect(JSON.stringify(graph).split(JSON.stringify(OWNER)).join("null")).not.toMatch(/ngvoicu\.dev|Gabriel/);
  expect(owned.sort()).toEqual([...roles].sort());
  expect(others.sort()).toEqual([...persons].sort());
}

function byType(graph: Node[], type: string): Node[] {
  return graph.filter((node) => node["@type"] === type);
}

/** The page node of a graph: the node whose @id is the page's canonical address. */
function pageNode(result: Read): Node {
  const node = result.graph.find((item) => item["@id"] === result.canonical);
  expect(node, `${result.canonical}: a node for the page itself`).toBeDefined();
  return node!;
}

/** Each page type of the fixture, with what its structured data must hold. */
async function pagePaths(from: LoadedDeps = deps): Promise<{ providers: string[]; models: string[]; entries: Summary[] }> {
  const providers = (await (await api("/api/v1/providers?limit=200", from)).json() as { data: { id: string }[] }).data.map((item) => item.id);
  const models = (await (await api("/api/v1/models?limit=200", from)).json() as { data: { id: string }[] }).data.map((item) => item.id);
  return { providers, models, entries: from.index.entries };
}

/** Every provider, model and entry page of a publication through handlePage: each with its own title and description. */
async function everyPageOwnsItsTitle(from: LoadedDeps): Promise<Map<string, string>> {
  const { providers, models, entries } = await pagePaths(from);
  const paths = [
    ...providers.map((id) => `/providers/${encodeURIComponent(id)}/`),
    ...models.map((id) => `/models/${id.split("/").map(encodeURIComponent).join("/")}/`),
    ...entries.map((summary) => `/entries/${summary.ref.split("/").map(encodeURIComponent).join("/")}`),
  ];
  const titles = new Map<string, string>();
  const descriptions = new Map<string, string>();
  const byPath = new Map<string, string>();
  for (const path of paths) {
    const result = await read(path, from);
    expect([path, result.status]).toEqual([path, 200]);
    expect(pageNode(result).name, path).toBe(result.title);
    expect(titles.get(result.title), `${path} has the title of ${titles.get(result.title)}`).toBeUndefined();
    expect(descriptions.get(result.description), `${path} has the description of ${descriptions.get(result.description)}`).toBeUndefined();
    titles.set(result.title, path);
    descriptions.set(result.description, path);
    byPath.set(path, result.title);
  }
  return byPath;
}

/** The titles and descriptions of every entry, provider and model of an index, as their pages make them. */
function metasOf(index: Index): [string, PageMeta][] {
  const labels = providerLabels(index.providers);
  const byProvider = new Map<string, Summary[]>();
  for (const summary of index.entries) byProvider.set(summary.provider, [...(byProvider.get(summary.provider) ?? []), summary]);
  const models = modelsFor(index);
  return [
    ...index.entries.map((summary): [string, PageMeta] => {
      const meta = entryMeta(summary, byProvider.get(summary.provider)!, labels);
      checkEntry(summary, meta, labels.get(summary.provider)!);
      return [summary.ref, meta];
    }),
    ...index.providers.map((provider): [string, PageMeta] => [provider.id, providerMeta(provider, labels)]),
    ...models.map((model): [string, PageMeta] => [model.id, modelMeta(model, models)]),
  ];
}

/** An entry of the fixture with other names and ids, for the title rules. */
function variant(over: Partial<Summary>): Summary {
  const base = deps.index.entries[1]!;
  const model = over.model ?? base.model;
  return { ...base, ...over, model, ref: `${over.provider ?? base.provider}/${model}` };
}
const titleOf = (summary: Summary, group: Summary[] = [summary], providers: { id: string; name: string }[] = [{ id: summary.provider, name: "P" }]): string =>
  entryMeta(summary, group, providerLabels(providers)).title;

describe("titles and descriptions", () => {
  it("gives every page of the fixture its own title and description, the same in the title, og:title and structured data", async () => {
    const { providers, models, entries } = await pagePaths();
    const paths = [
      "/", "/?offset=50", "/providers/", "/models/", "/evidence/", "/docs/api/", "/docs/methodology/", "/docs/licensing/", "/docs/contributing/",
      ...providers.map((id) => `/providers/${encodeURIComponent(id)}/`),
      ...models.map((id) => `/models/${id.split("/").map(encodeURIComponent).join("/")}/`),
      ...entries.map((summary) => `/entries/${summary.ref.split("/").map(encodeURIComponent).join("/")}`),
    ];
    const titles = new Map<string, string>();
    const descriptions = new Map<string, string>();
    for (const path of paths) {
      const result = await read(path);
      expect([path, result.status]).toEqual([path, 200]);
      expect(result.h1, path).toHaveLength(1);
      expect(result.ogTitle, path).toBe(result.title);
      expect(result.ogUrl, path).toBe(result.canonical);
      expect(pageNode(result).name, path).toBe(result.title);
      expect(pageNode(result).description, path).toBe(result.description);
      expect(result.title.endsWith(" · providers.dev") || result.title === HOME_TITLE, path).toBe(true);
      // The site's name once, never twice.
      expect(result.title.match(/providers\.dev/g), path).toHaveLength(1);
      for (const text of [result.title, result.description]) expect(text, path).not.toMatch(/undefined|\bnull\b|NaN|%%PAGE|\$-|<|>/);
      expect(result.description.length, path).toBeLessThanOrEqual(400);
      expect(titles.get(result.title), `${path} has the title of ${titles.get(result.title)}`).toBeUndefined();
      titles.set(result.title, path);
      // The fixture's documents are one stand-in text; their own descriptions are checked on the build below.
      if (path.startsWith("/docs/") && path !== "/docs/api/") continue;
      expect(descriptions.get(result.description), `${path} has the description of ${descriptions.get(result.description)}`).toBeUndefined();
      descriptions.set(result.description, path);
    }
    expect(titles.size).toBe(paths.length);
  });

  it("says the two cache lifetimes as a sentence, unknown as unknown and 0 as none", () => {
    const life = (value: number | null, differ = false): SafeValue => ({ value, agreement: differ ? "differ" : "agree" }) as unknown as SafeValue;
    expect(cacheWords(life(null), life(null))).toBe("prompt cache lifetime unknown");
    expect(cacheWords(life(null, true), life(null, true))).toBe("prompt cache lifetime unknown (not all sources agree)");
    expect(cacheWords(life(300), life(null))).toBe("prompt cache lifetime 5 min (short), long lifetime unknown");
    expect(cacheWords(life(1500, true), life(null))).toBe("prompt cache lifetime 25 min (short, not all sources agree), long lifetime unknown");
    expect(cacheWords(life(null), life(3600))).toBe("prompt cache lifetime 1 h (long), short lifetime unknown");
    expect(cacheWords(life(0), life(null))).toBe("prompt cache lifetime none (short), long lifetime unknown");
    expect(cacheWords(life(300), life(3600))).toBe("prompt cache lifetime 5 min (short) and 1 h (long)");
    expect(cacheWords(life(0), life(14400))).toBe("prompt cache lifetime none (short) and 4 h (long)");
    expect(cacheWords(life(3600), life(3600))).toBe("prompt cache lifetime 1 h, short and long");
    expect(cacheWords(life(0), life(0))).toBe("prompt cache lifetime none, short and long");
  });

  it("leaves out an id that is the name written another way, and puts the provider before a long id", () => {
    expect(titleOf(variant({ name: "Kimi K2.6", model: "moonshotai/Kimi-K2.6", canonical_id: "moonshotai/kimi-k2.6" }))).toBe("Kimi K2.6 at P · providers.dev");
    expect(titleOf(variant({ name: "GLM-5.2", model: "fireworks/glm-5.2", canonical_id: "zhipuai/glm-5.2" }))).toBe("GLM-5.2 (fireworks/glm-5.2) at P · providers.dev");
    expect(titleOf(variant({ name: "MiniMax-M2.5", model: "MiniMax-M2.5", canonical_id: null }))).toBe("MiniMax-M2.5 at P · providers.dev");
    expect(titleOf(variant({ name: "DeepSeek: DeepSeek V4", model: "deepseek/deepseek-v4", canonical_id: null }))).toBe("DeepSeek: DeepSeek V4 at P · providers.dev");
    expect(titleOf(variant({ name: "Gemini 3.8 Flash", model: "gemini-3-8-flash", canonical_id: "google/gemini-3.8-flash" }))).toBe("Gemini 3.8 Flash (gemini-3-8-flash) at P · providers.dev");
    const long = variant({ name: "Nemotron 3 Super", model: "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16", canonical_id: "nvidia/nemotron-3-super" });
    expect(titleOf(long, [long], [{ id: long.provider, name: "Thinking Machines" }])).toBe("Nemotron 3 Super at Thinking Machines (nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16) · providers.dev");
    // Not where another provider's name is this provider's followed by that id in brackets.
    expect(titleOf(long, [long], [{ id: long.provider, name: "Thinking Machines" }, { id: "tm-x", name: "Thinking Machines (nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16)" }]))
      .toBe("Nemotron 3 Super (nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16) at Thinking Machines · providers.dev");
  });

  it("keeps the id where leaving it out would give two entries of a provider one title: ids that differ in case, or in a separator", () => {
    const lower = variant({ name: "Twin Model", model: "twin-model", canonical_id: null });
    const upper = variant({ name: "Twin Model", model: "Twin-Model", canonical_id: null });
    const under = variant({ name: "Twin Model", model: "twin_model", canonical_id: null });
    const other = variant({ name: "Twin Engine", model: "twin-engine", canonical_id: null });
    const group = [lower, upper, under, other];
    expect(group.map((summary) => titleOf(summary, group))).toEqual([
      "Twin Model (twin-model) at P · providers.dev",
      "Twin Model (Twin-Model) at P · providers.dev",
      "Twin Model (twin_model) at P · providers.dev",
      "Twin Engine at P · providers.dev",
    ]);
    // Alone, the id is left out again.
    expect(titleOf(lower)).toBe("Twin Model at P · providers.dev");
    // A name that holds another entry's name and id: the second takes a number after its id.
    const named = variant({ name: "Twin Model (twin-model)", model: "twin-model-2", canonical_id: null });
    expect(new Set([lower, upper, named].map((summary, _, all) => titleOf(summary, all))).size).toBe(3);
  });

  it("names a provider by its id where its name would make two pages one", () => {
    const labels = providerLabels([
      { id: "a", name: "Same" }, { id: "b", name: "Same" }, { id: "c", name: "C" }, { id: "d", name: "C (c/x)" }, { id: "e", name: "Look at Me" }, { id: "f", name: "  " }, { id: "g", name: "MiniMax" }, { id: "h", name: "MiniMax (minimax.io)" },
    ]);
    expect(Object.fromEntries(labels)).toEqual({ a: "a", b: "b", c: "C", d: "d", e: "Look\u00A0at Me", f: "f", g: "MiniMax", h: "MiniMax (minimax.io)" });
    // A name holding " at " keeps the first " at " of a title the one before the provider; an empty name is shown by its id.
    expect(titleOf(variant({ name: "Look at", model: "look", canonical_id: null }))).toBe("Look\u00A0at (look) at P · providers.dev");
    expect(titleOf(variant({ name: " ", model: "blank-name", canonical_id: null }))).toBe("blank-name (blank-name) at P · providers.dev");
    expect(titleOf(variant({ name: "", model: " ", canonical_id: null }))).toBe(`${UNNAMED} () at P · providers.dev`);
  });

  it("builds and gives every page its own title and description where the data holds such entries and providers", async () => {
    const dataDir = tempDataDir();
    const upstream: UpstreamCatalog = fixtureUpstream();
    const twin = (id: string, name: string) => ({ ...upstream["provider-00"]!.models["model-1"]!, id, name, canonical_id: undefined });
    for (const [id, name] of [["twin-model", "Twin Model"], ["Twin-Model", "Twin Model"], ["twin_model", "Twin Model"], ["twin model at", "Twin Model (twin-model)"], ["look-at", "Look at"], ["blank", " "]]) upstream["provider-00"]!.models[id!] = twin(id!, name!);
    upstream["provider-01"]!.name = "Provider 0";
    upstream["provider-02"]!.name = "Provider 0 (provider-00/twin-model), API key";
    const synced = await sync({ dataDir, fetch: fetchReturning(JSON.stringify(upstream)) });
    expect(synced.upstream, JSON.stringify(synced.upstream)).not.toMatchObject({ status: "failed" });
    writeAuthored(dataDir);
    expect(publish({ dataDir, rootDir: ROOT, now }).errors).toEqual([]);
    const twins = depsFrom(join(dataDir, "published"));
    const titles = await everyPageOwnsItsTitle(twins);
    expect(["twin-model", "Twin-Model", "twin_model"].map((id) => titles.get(`/entries/provider-00/${id}`))).toEqual([
      "Twin Model (twin-model) at provider-00 · providers.dev",
      "Twin Model (Twin-Model) at provider-00 · providers.dev",
      "Twin Model (twin_model) at provider-00 · providers.dev",
    ]);
    // The same, from the index as the build's test reads it.
    for (const key of ["title", "description"] as const) {
      const texts = metasOf(twins.index).map(([, meta]) => meta[key]);
      expect(new Set(texts).size, key).toBe(texts.length);
    }
  });

  it("keeps the qualifiers its page shows: at least, unknown, whose price, a warning; never measured", () => {
    const labels = providerLabels(deps.index.providers);
    for (const summary of deps.index.entries) checkEntry(summary, entryMeta(summary, deps.index.entries, labels), labels.get(summary.provider)!);
  });

  // The publication `npm run build` made: every entry, provider and model of the real data.
  const built = join(ROOT, "dist");
  it.skipIf(!existsSync(join(built, "current.json")))("has no two pages with one title or one description in the publication in dist/", () => {
    const id = (JSON.parse(readFileSync(join(built, "current.json"), "utf8")) as { id: string }).id;
    const index = JSON.parse(gunzipSync(readFileSync(join(built, "snapshots", id, "data", "index.json.gz"))).toString()) as Index;
    const pages = metasOf(index);
    // The documents' own descriptions, as the build wrote them.
    for (const name of ["methodology", "licensing", "contributing"]) {
      const document = JSON.parse(readFileSync(join(built, "reference-content", "docs", `${name}.json`), "utf8")) as { title: string; description: string };
      pages.push([`/docs/${name}/`, documentMeta(name, document)]);
    }
    // Every entry, provider and model of the build, whatever an import brought, and the three documents.
    expect(index.entries.length).toBeGreaterThan(0);
    expect(pages.length).toBe(index.entries.length + index.providers.length + modelsFor(index).length + 3);
    for (const key of ["title", "description"] as const) {
      const seen = new Map<string, string>();
      const twice = pages.filter(([ref, meta]) => { const before = seen.get(meta[key]); seen.set(meta[key], ref); return before !== undefined; });
      expect(twice.map(([ref, meta]) => `${ref}: ${meta[key]}`), key).toEqual([]);
    }
  });
});

/**
 * The description of an entry against its summary: what its tiles say, qualifiers included. Only the words this module
 * writes are read, never the data's own (a name, an id, a ref): a model named "Measured 7B" fails nothing.
 */
function checkEntry(summary: Summary, meta: PageMeta, label: string): void {
  const { input_window: window, max_output: output } = summary.safe;
  const name = plain(summary.name) || plain(summary.model) || UNNAMED;
  const head = `${name} at ${label} (${summary.ref}), `;
  expect(meta.description.startsWith(head), meta.description).toBe(true);
  expect(meta.title.startsWith(name), meta.title).toBe(true);
  // What follows the ref and the access ("API key: "), less the ref a reference price names.
  const rest = meta.description.slice(head.length);
  const facts = rest.slice(rest.indexOf(": ") + 2);
  const words = summary.price_from ? facts.replace(`(API list price of ${summary.price_from})`, "(API list price of …)") : facts;
  const warned = (safe: typeof window): string => (safe.agreement === "differ" ? " (not all sources agree)" : "");
  const said = (safe: typeof window): string => `${safe.value === null ? "unknown" : `${safe.at_least ? "at least " : ""}${safe.value.toLocaleString("en-US")} tokens`}${warned(safe)},`;
  expect(facts.startsWith(`context window ${said(window)}`), facts).toBe(true);
  expect(words).toContain(`maximum output ${said(output)}`);
  if (summary.price_from && summary.price_in !== null && summary.price_out !== null) expect(facts).toContain(`(API list price of ${summary.price_from})`);
  if (summary.price_in === null && summary.price_out === null && summary.pricing.billing === "not_applicable") expect(words).toContain("price: in plan");
  // An unknown price is never written as zero.
  if (summary.price_in === null || summary.price_out === null) expect(words).not.toMatch(/price \$/);
  expect(words).not.toMatch(/measured/i);
  expect(words).not.toMatch(/unknown (short|long)\b/);
}

describe("structured data", () => {
  it("describes the home page as the site, its publisher and the catalog as a dataset, from the same meta", async () => {
    const result = await read("/");
    const meta = (await (await api("/api/v1/meta")).json() as { data: Meta }).data;
    expect(result.scripts).toHaveLength(1);
    expect(result.scripts[0]).not.toMatch(/[<>]/);
    const [organization] = byType(result.graph, "Organization");
    expect(organization).toMatchObject({ "@id": `${SITE}/#organization`, name: "providers.dev", url: `${SITE}/`, logo: `${SITE}/apple-touch-icon.png`, email: "office@providers.dev" });
    expect(byType(result.graph, "WebSite")[0]).toMatchObject({ "@id": `${SITE}/#website`, name: "providers.dev", url: `${SITE}/` });
    const [dataset] = byType(result.graph, "Dataset");
    expect(dataset).toMatchObject({ "@id": `${SITE}/#catalog`, url: `${SITE}/`, version: meta.dataset_version, license: `${SITE}/docs/licensing/`, isAccessibleForFree: true });
    expect((dataset!.description as string).length).toBeGreaterThanOrEqual(50);
    expect(dataset!.description).toContain(`${meta.counts.entries.toLocaleString("en-US")} entries`);
    expect(dataset!.distribution).toEqual([
      { "@type": "DataDownload", encodingFormat: "application/json", contentUrl: `${SITE}/api.json` },
      { "@type": "DataDownload", encodingFormat: "application/json", contentUrl: `${SITE}/api/v1/catalog` },
    ]);
    // The owner maintains the site and made and maintains the catalog; the publisher stays the organization, which has no founder.
    expect(dataset).toMatchObject({ creator: OWNER, maintainer: OWNER, publisher: { "@id": `${SITE}/#organization` } });
    expect(byType(result.graph, "WebSite")[0]).toMatchObject({ maintainer: OWNER, publisher: { "@id": `${SITE}/#organization` } });
    claimsNothingElse(result.graph, [], ["creator", "maintainer", "maintainer"]);
    await answers(result.graph);
  });

  it("gives each detail page a page node and the trail it shows above its h1", async () => {
    const { providers, models, entries } = await pagePaths();
    const entry = entries.find((summary) => summary.provider === providers[1])!;
    const cases: [string, string[]][] = [
      [`/providers/${providers[1]}/`, ["Providers", "{name}"]],
      [`/models/${models[0]}/`, ["Models", "{name}"]],
      [`/entries/${entry.ref}`, ["Providers", "{provider}", "{name}"]],
    ];
    for (const [path, shape] of cases) {
      const result = await read(path);
      const node = pageNode(result);
      expect(node["@type"]).toBe("WebPage");
      expect(node.isPartOf).toEqual([{ "@id": `${SITE}/#website` }, { "@id": `${SITE}/#catalog` }]);
      expect(node.breadcrumb).toEqual({ "@id": `${result.canonical}#breadcrumb` });
      const [trail] = byType(result.graph, "BreadcrumbList");
      const items = trail!.itemListElement as { "@type": string; position: number; name: string; item: string }[];
      expect(items.map((item) => item.position)).toEqual(shape.map((_, index) => index + 1));
      expect(items.every((item) => item["@type"] === "ListItem" && item.item.startsWith(`${SITE}/`))).toBe(true);
      // The last step is the page, named by its h1; every other step is a link of the trail on the page.
      expect(items.at(-1)).toMatchObject({ name: result.h1[0], item: result.canonical });
      for (const item of items.slice(0, -1)) expect(result.crumbs, path).toContain(`<a href="${new URL(item.item).pathname}">${item.name}</a>`);
      claimsNothingElse(result.graph);
      await answers(result.graph);
    }
  });

  it("marks the documents as technical articles (licensing as a page) and names the API by addresses that answer", async () => {
    for (const name of ["methodology", "contributing", "licensing"]) {
      const result = await read(`/docs/${name}/`);
      const node = pageNode(result);
      expect(node["@type"]).toBe(name === "licensing" ? "WebPage" : "TechArticle");
      if (name !== "licensing") expect(node).toMatchObject({ headline: result.h1[0], author: { "@id": `${SITE}/#organization` }, publisher: { "@id": `${SITE}/#organization` } });
      claimsNothingElse(result.graph);
    }
    const result = await read("/docs/api/");
    const node = pageNode(result);
    expect(node).toMatchObject({ "@type": "TechArticle", headline: "API" });
    const webApi = node.about as Node;
    expect(webApi).toMatchObject({ "@type": "WebAPI", url: `${SITE}/docs/api/`, documentation: [`${SITE}/docs/api/`, `${SITE}/api/v1/openapi.json`] });
    // Never the API's root, which answers 404.
    expect(JSON.stringify(result.graph)).not.toContain(`"${SITE}/api/v1/"`);
    expect((await api("/api/v1/")).status).toBe(404);
    await answers(result.graph);
  });

  it("marks the lists and the evidence as pages of the catalog, and gives an error page none", async () => {
    for (const path of ["/providers/", "/models/", "/?offset=50", "/evidence/", "/?q=model"]) {
      const result = await read(path);
      expect(pageNode(result)["@type"], path).toBe(path === "/evidence/" ? "WebPage" : "CollectionPage");
      claimsNothingElse(result.graph);
    }
    for (const path of ["/nothing-here", "/providers/nobody/", "/entries/nobody/nothing"]) {
      const result = await read(path);
      expect([path, result.status, result.scripts, result.ogUrl]).toEqual([path, 404, [], null]);
    }
  });

  it("writes a value that could close the script as an escape", async () => {
    const { jsonLdScript } = await import("../src/core/structured-data.ts");
    const script = jsonLdScript([{ "@type": "WebPage", name: "</script><script>alert(1)</script> & more" }]);
    expect(script.slice(0, -"</script>".length)).not.toMatch(/<\/script>/i);
    expect(JSON.parse(script.replace(/^<script[^>]*>|<\/script>$/g, ""))["@graph"][0].name).toBe("</script><script>alert(1)</script> & more");
  });

  // The product pages as Astro builds them.
  const built = join(ROOT, "dist");
  const product = (path: string): Read => readHtml(200, readFileSync(join(built, path), "utf8"));
  it.skipIf(!existsSync(join(built, "provimux", "index.html")))("describes each product as free software built on the project it credits, with no offer, rating or review", () => {
    const cases = [
      // Provimux is his distribution of another project: its maintainer, not its author.
      { path: "provimux/index.html", site: "https://provimux.providers.dev", name: "Provimux", repository: "https://github.com/ngvoicu/provimux", upstream: "CLIProxyAPI", persons: [] as string[], role: "maintainer" },
      { path: "pi-cache-keeper/index.html", site: "https://pi-cache-keeper.providers.dev", name: "pi-cache-keeper", repository: "https://github.com/ngvoicu/pi-cache-keeper", upstream: "pi-cached-compaction", persons: ["Nico Bailon"], role: "author" },
    ];
    for (const { path, site, name, repository, upstream, persons, role } of cases) {
      const html = readFileSync(join(built, path), "utf8");
      const result = product(path);
      expect(result.canonical).toBe(`${site}/`);
      expect(result.h1).toHaveLength(1);
      expect(byType(result.graph, "WebSite")[0]).toMatchObject({ "@id": `${site}/#website`, name, url: `${site}/` });
      const [application] = byType(result.graph, "SoftwareApplication");
      expect(application).toMatchObject({ "@id": `${site}/#software`, name, url: `${site}/`, applicationCategory: "DeveloperApplication", isAccessibleForFree: true, license: "https://opensource.org/licenses/MIT", description: result.description, publisher: { "@id": `${SITE}/#organization` } });
      const sources = byType(result.graph, "SoftwareSourceCode");
      expect(sources.find((node) => node.codeRepository === repository)).toMatchObject({ targetProduct: { "@id": `${site}/#software` } });
      const credited = sources.find((node) => node.name === upstream)!;
      expect(application!.isBasedOn).toEqual({ "@id": credited["@id"] });
      // What it says is on the page: the credit, the requirement, the platforms.
      expect(html).toContain(`href="${credited.codeRepository as string}"`);
      if (application!.softwareRequirements) expect(html).toContain(application!.softwareRequirements as string);
      if (application!.operatingSystem) for (const system of (application!.operatingSystem as string).split(", ")) expect(html).toContain(system);
      expect(application!.softwareRequirements ?? "Pi 1.6.0 or newer").toBe("Pi 1.6.0 or newer");
      expect(application![role]).toEqual(OWNER);
      claimsNothingElse(result.graph, persons, [role]);
      for (const person of persons) expect(html).toContain(person);
      expect(html).toContain(OWNER_LINK);
    }
    const support = product("provimux/support/index.html");
    expect(pageNode(support)).toMatchObject({ "@type": "WebPage", name: "Support · Provimux", isPartOf: { "@id": "https://provimux.providers.dev/#website" } });
    expect(byType(support.graph, "BreadcrumbList")[0]!.itemListElement).toEqual([
      { "@type": "ListItem", position: 1, name: "Provimux", item: "https://provimux.providers.dev/" },
      { "@type": "ListItem", position: 2, name: "Support", item: "https://provimux.providers.dev/support/" },
    ]);
    claimsNothingElse(support.graph);
    for (const path of ["provimux/not-found/index.html", "pi-cache-keeper/not-found/index.html"]) expect(product(path).scripts).toEqual([]);
  });

  // Every page of providers.dev is written into one shell, whose footer names the owner; each product page has its own.
  it.skipIf(!existsSync(join(built, "site-shell", "index.html")))("links the owner's site from the footer of every page of the three sites, and from their markdown", () => {
    const footer = (html: string): string => html.slice(html.indexOf("<footer"), html.indexOf("</footer>"));
    for (const path of ["site-shell/index.html", "provimux/index.html", "provimux/support/index.html", "provimux/not-found/index.html", "pi-cache-keeper/index.html", "pi-cache-keeper/not-found/index.html"]) {
      const html = readFileSync(join(built, path), "utf8");
      expect(footer(html).split(OWNER_LINK).length - 1, path).toBe(1);
      // The link is followed by the contact, as the plan places it.
      expect(footer(html), path).toMatch(/Gabriel Voicu<\/a><\/li>\s*<li><a href="mailto:office@providers\.dev">Contact<\/a>/);
    }
    for (const path of ["provimux/index.html.md", "provimux/support/index.html.md", "pi-cache-keeper/index.html.md"]) {
      expect(readFileSync(join(built, path), "utf8"), path).toContain("[Gabriel Voicu](https://ngvoicu.dev/)");
    }
  });
});

/** Every providers.dev address in a graph answers: a page, an API path, or a public file. Fragment ids are names, not addresses. */
async function answers(graph: Node[]): Promise<void> {
  const addresses = new Set<string>();
  walk(graph, (key, value) => {
    if (typeof value === "string" && value.startsWith(`${SITE}/`) && key !== "@id") addresses.add(value);
  });
  for (const address of addresses) {
    const { pathname, search } = new URL(address);
    let status: number;
    if (pathname.startsWith("/api/v1/") || pathname === "/api.json") status = (await api(`${pathname}${search}`)).status;
    else if (/\.[a-z]+$/.test(pathname)) status = existsSync(join(ROOT, "public", pathname)) ? 200 : 404;
    else status = (await page(`${pathname}${search}`)).status;
    expect([address, status]).toEqual([address, 200]);
  }
}
