// The title and the description of every page of providers.dev, from the API answer the page itself prints. They say
// what the page shows and nothing more: a lower bound stays "at least", unknown stays unknown (never 0), a
// subscription's price stays the API list price of another entry, a warning where the sources disagree stays a
// warning, and nothing is called measured. One module owns the full title (with " · providers.dev"): the page's
// <title>, its og:title and the name in its structured data are this string.
//
// Pure: no request, no catalog; a page passes in the API answers it read (UNIQUE says which). tests/seo-meta.test.ts
// applies every function to the whole publication in dist/ and checks that no two pages share a title or a description.
import type { ProviderSummary, Summary } from "./entries.ts";
import { exact, plural, usdUnrounded as dollars } from "./format.ts";
import type { CanonicalModel, Page } from "./resources.ts";
import { lifetimeWords } from "./safe-view.ts";
import type { SafeValue } from "./safe.ts";
import type { Meta } from "./schema.ts";

export interface PageMeta {
  /** The full title, as <title> and og:title carry it. */
  title: string;
  description: string;
}

export const SITE_NAME = "providers.dev";
/** The home page's own title: the site's name, then its h1. */
export const HOME_TITLE = `${SITE_NAME} · AI models as each provider exposes them`;

const full = (title: string): string => `${title} · ${SITE_NAME}`;
/** "1 entry", "6,528 entries". */
const entries = (count: number, word = "entry"): string => `${exact(count)} ${count === 1 ? word : `${word.slice(0, -1)}ies`}`;

/** "page 2 of 7" of a list, as its page links write it; "" on its first page. */
function pageOf(result: Pick<Page<unknown>, "offset" | "limit" | "total">): string {
  if (result.offset === 0) return "";
  return `page ${exact(Math.floor(result.offset / result.limit) + 1)} of ${exact(Math.max(1, Math.ceil(result.total / result.limit)))}`;
}

/** "Providers 51 to 100 of 335", the rows a page of a list holds. */
function rowsOf(word: string, result: Pick<Page<unknown>, "offset" | "total"> & { data: readonly unknown[] }): string {
  return `${word} ${exact(result.offset + 1)} to ${exact(result.offset + result.data.length)} of ${exact(result.total)}`;
}

const ACCESS_WORDS: Readonly<Record<Summary["access"], string>> = { api: "API key", subscription: "subscription", unknown: "access unclassified" };
const PROVIDER_ACCESS: Readonly<Record<ProviderSummary["access"], string>> = { api: "API key, billed by use", subscription: "subscription login", unknown: "access unclassified" };

/** The catalog, the home page and its pages. `indexed`: a plain page of the list (no search, filter or sort). */
export function catalogMeta(meta: Meta, result: Pick<Page<unknown>, "offset" | "limit" | "total"> & { data: readonly unknown[] }, indexed: boolean): PageMeta {
  const counts = `${entries(meta.counts.entries)}, ${plural(meta.counts.providers, "provider")}, ${plural(meta.counts.models, "model")}`;
  const built = `Built on models.dev${meta.pi.snapshot ? " and Pi's model catalog" : ""}, with providers.dev's corrections and measurements.`;
  if (indexed && result.offset === 0) {
    return { title: HOME_TITLE, description: `Context window, maximum output, price and prompt caching of AI models, per provider and access method: ${counts}. ${built}` };
  }
  const page = pageOf(result);
  if (indexed) {
    return { title: full(`AI model catalog, ${page}`), description: `${rowsOf("Entries", result)} in the providers.dev catalog: context window, maximum output, price and prompt caching per provider and access method.` };
  }
  return {
    title: full(`AI model catalog: ${entries(result.total)} in this view${page ? `, ${page}` : ""}`),
    description: `A searched, filtered or sorted view of the providers.dev catalog: ${result.total === 0 ? "no entries" : rowsOf("entries", result)}.`,
  };
}

/** The list of providers and its pages. */
export function providersMeta(result: Pick<Page<unknown>, "offset" | "limit" | "total"> & { data: readonly unknown[] }, indexed: boolean): PageMeta {
  const page = pageOf(result);
  const title = full(`Providers and access methods${indexed ? "" : ": search"}${page ? `, ${page}` : ""}`);
  if (result.offset === 0 && indexed) return { title, description: `${plural(result.total, "provider")} in the providers.dev catalog, each with how it is reached (API key, subscription or unclassified) and its number of model entries.` };
  return { title, description: `${result.total === 0 ? "No providers" : rowsOf("Providers", result)} in the providers.dev catalog${indexed ? "" : " that match this search"}: how each is reached and its number of model entries.` };
}

/** The list of canonical models and its pages. */
export function modelsMeta(result: Pick<Page<unknown>, "offset" | "limit" | "total"> & { data: readonly unknown[] }, indexed: boolean): PageMeta {
  const page = pageOf(result);
  const title = full(`Models across providers${indexed ? "" : ": search"}${page ? `, ${page}` : ""}`);
  if (result.offset === 0 && indexed) return { title, description: `${plural(result.total, "canonical model")} in the providers.dev catalog. Each model's page compares its entries across providers and access methods.` };
  return { title, description: `${result.total === 0 ? "No canonical models" : rowsOf("Canonical models", result)} in the providers.dev catalog${indexed ? "" : " that match this search"}, each with its entries across providers and access methods.` };
}

/**
 * Text from the data as a title or a description carries it: trimmed, and "at" between spaces only where this module
 * writes it. A name that holds the word ("Look at Me") gets a no-break space before it, which reads the same. So the
 * first " at " of an entry's title or description is the one between its name and its provider, and the title of a
 * model, a provider or a document holds none: what follows from it is set out at UNIQUE below.
 */
export const plain = (text: string): string => text.trim().replace(/ (?=at(?: |$))/g, "\u00A0");

/** The name a page goes by where the data gives none: an empty name is shown by its id, and an empty id by this. */
export const UNNAMED = "Unnamed model";

/**
 * Each provider's name as titles and descriptions write it: its name (plain), or its id where the name would make two
 * pages one, decided over all providers (`/api/v1/facets` lists them): where two providers have one name, or where one
 * name is another's followed by " (" and that provider's id and "/" or ")", the way an entry's or a provider's
 * description goes on after the name. An id is never one of these: ids are unique and hold no space.
 */
export function providerLabels(providers: readonly { id: string; name: string }[]): ReadonlyMap<string, string> {
  const label = new Map(providers.map((provider) => [provider.id, plain(provider.name) || provider.id]));
  let changed = true;
  while (changed) {
    changed = false;
    const owners = new Map<string, string[]>();
    for (const [id, text] of label) owners.set(text, [...(owners.get(text) ?? []), id]);
    for (const ids of owners.values()) {
      if (ids.length < 2) continue;
      for (const id of ids) if (label.get(id) !== id) { label.set(id, id); changed = true; }
    }
    for (const a of providers) {
      const before = `${label.get(a.id)!} (${a.id}`;
      for (const b of providers) {
        const text = label.get(b.id)!;
        if (a.id === b.id || text === b.id) continue;
        if (text.startsWith(`${before}/`) || text.startsWith(`${before})`)) { label.set(b.id, b.id); changed = true; }
      }
    }
  }
  return label;
}

/** A provider's page. The page shows its access, its number of entries and those with providers.dev evidence. */
export function providerMeta(provider: Pick<ProviderSummary, "id" | "name" | "access" | "entry_count" | "evidence_entry_count">, labels: ReadonlyMap<string, string>): PageMeta {
  const name = labels.get(provider.id) ?? provider.id;
  return {
    title: full(`${name} models`),
    description: `${name} (${provider.id}), ${PROVIDER_ACCESS[provider.access]}: ${entries(provider.entry_count, "model entry")} in the providers.dev catalog, ${exact(provider.evidence_entry_count)} with providers.dev evidence, each with its context window, maximum output, price and prompt caching.`,
  };
}

/** An end of a model's context window, as the page's hover text says it: "at least" where it is a lower bound. */
const windowEnd = (end: NonNullable<CanonicalModel["input_window_min"]>): string => `${end.bound === "at_least" ? "at least " : ""}${exact(end.tokens)}`;

/**
 * Whether an id is a name written another way: the same once both are in lower case with each run of spaces, hyphens,
 * underscores, colons and slashes as one hyphen ("Qwen3.5 27B" and "Qwen3.5-27B", "DeepSeek: DeepSeek V4" and
 * "deepseek/deepseek-v4", "GLM-5.3 Fast" and "glm-5.3:fast"). A dot counts: "gemini-3-8-flash" is not "Gemini 3.8 Flash".
 */
const spelling = (text: string): string => text.toLowerCase().replace(/[\s_:/-]+/g, "-");
const spelledAs = (name: string, id: string): boolean => spelling(name) === spelling(id);

/** Over this length a title shows the provider before a long id, so that what a search result shows names both. */
const LONG_TITLE = 70;

/*
 * UNIQUE. No two pages share a title or a description, whatever the data, and a page decides its own from the API
 * answers it reads. Each title or description is first written the short way (the id left out where the name says it,
 * the provider before a long id); where that gives two pages of its group one text, those pages take the id in brackets,
 * as every title did before the short way, and if even that is shared (a name that holds another page's name and id),
 * a number after the id. The group is what can collide:
 *
 * - Entries: those of the same provider whose name (plain) begins with the same word. Every form begins with the
 *   name and a space, so two entries of one provider with one title begin with the same word. The page reads its group
 *   from /api/v1/entries?provider=…&q=<that word>, which finds every entry whose name holds the word, and keeps those
 *   whose name begins with it; each member reads the same group and decides the same.
 * - Across providers: an entry's title and description hold " at " first between the name and the provider's label
 *   (plain), and labels are distinct (providerLabels). After it come the label alone, or the label and "(id)" where
 *   the provider comes before an id: that id holds no bracket or space, and the provider's is not a label equal to
 *   another label followed by "(id)". A description goes on after the label with " (" and the provider id and "/".
 * - Models: those whose name begins with the same word, from /api/v1/models?q=<that word>. A model's title holds no
 *   " at " and ends "across providers"; its description has no "/" after its first " at ", where an entry's has one.
 * - Providers: their labels. A provider's title ends "models" and holds no " at "; its description holds no " at ".
 */

/** The name an entry's or a model's title begins with, and the word that names its group. */
const shown = (name: string, id: string): string => plain(name) || plain(id) || UNNAMED;
const firstWord = (text: string): string => text.split(/\s+/)[0]!;

/**
 * The words of the API search that finds every member of a group: the first word of the name, cut to 100 characters
 * (the API takes 200), never ending in a sigma, whose lower case depends on what follows it. null: no search, the
 * whole provider or every model, where the name can be UNNAMED, which no entry or model holds.
 */
function groupWords(word: string): string | null {
  if (word === firstWord(UNNAMED)) return null;
  const characters = Array.from(word);
  if (characters.length <= 100) return word;
  const cut = characters.slice(0, 100);
  while (cut.length > 1 && /[Σσς]/.test(cut.at(-1)!)) cut.pop();
  return cut.join("");
}

/** Each member's title or description: the first choice of each, where no other member's first choice is the same; the next choice that is free where it is. */
function distinct<T>(members: readonly T[], key: (member: T) => string, choice: (member: T, attempt: number) => string): Map<string, string> {
  const first = new Map(members.map((member) => [key(member), choice(member, 0)]));
  const count = new Map<string, number>();
  for (const text of first.values()) count.set(text, (count.get(text) ?? 0) + 1);
  const result = new Map<string, string>();
  const used = new Set<string>();
  for (const [name, text] of first) if (count.get(text) === 1) { result.set(name, text); used.add(text); }
  const left = members.filter((member) => !result.has(key(member))).sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  for (const member of left) {
    for (let attempt = 1; ; attempt++) {
      const text = choice(member, attempt);
      if (!used.has(text)) { used.add(text); result.set(key(member), text); break; }
    }
  }
  return result;
}

/** The search that reads a model's group: the API path, without limit and offset. */
export function modelGroupPath(model: Pick<CanonicalModel, "id" | "name">): string {
  const words = groupWords(firstWord(shown(model.name, model.id)));
  return words === null ? "/api/v1/models" : `/api/v1/models?q=${encodeURIComponent(words)}`;
}

/**
 * A canonical model's page: its title and description among those of its group (`found`: what modelGroupPath reads, or
 * any list that holds the group). The description gives its context window and maximum output from smallest to
 * largest among its entries.
 */
export function modelMeta(model: ModelFacts, found: readonly ModelFacts[]): PageMeta {
  const word = firstWord(shown(model.name, model.id));
  const group = found.filter((item) => item.id !== model.id && firstWord(shown(item.name, item.id)) === word);
  group.push(model);
  const name = (item: ModelFacts): string => shown(item.name, item.id);
  const titles = distinct(group, (item) => item.id, (item, attempt) => {
    const slug = item.id.slice(item.id.indexOf("/") + 1);
    // The id in brackets unless it is the name, with the lab's id before it ("zhipuai/glm-5.3" of "GLM-5.3"), or the
    // name written another way (spelledAs): then it tells a reader nothing the name does not.
    if (attempt === 0 && (spelledAs(item.name, slug) || spelledAs(item.name, item.id))) return full(`${name(item)} across providers`);
    return full(`${name(item)} (${plain(item.id)}${attempt > 1 ? `, ${attempt}` : ""}) across providers`);
  });
  const descriptions = distinct(group, (item) => item.id, (item, attempt) => `${modelDescription(item, name(item))}${attempt > 0 ? ` (${attempt})` : ""}`);
  return { title: titles.get(model.id)!, description: descriptions.get(model.id)! };
}

type ModelFacts = Pick<CanonicalModel, "id" | "name" | "entry_count" | "subscription_entry_count" | "input_window_min" | "input_window_max" | "input_window_unknown_count" | "max_output_min" | "max_output_max">;

function modelDescription(model: ModelFacts, name: string): string {
  const { input_window_min: min, input_window_max: max } = model;
  let window: string;
  if (min === null || max === null) window = "context window unknown";
  else {
    const same = min.tokens === max.tokens && min.bound === max.bound;
    window = `context window ${same ? windowEnd(min) : `${windowEnd(min)} to ${windowEnd(max)}`} tokens${model.input_window_unknown_count > 0 ? ` (unknown at ${exact(model.input_window_unknown_count)} of ${exact(model.entry_count)} entries)` : ""}`;
  }
  const output = model.max_output_min === null || model.max_output_max === null
    ? "maximum output unknown"
    : `maximum output ${model.max_output_min === model.max_output_max ? exact(model.max_output_min) : `${exact(model.max_output_min)} to ${exact(model.max_output_max)}`} tokens`;
  const count = `${entries(model.entry_count)}${model.subscription_entry_count > 0 ? ` (${exact(model.subscription_entry_count)} by subscription)` : ""}`;
  return `${name} (${plain(model.id)}) at ${count} across providers and access methods: ${window}, ${output}.`;
}

/**
 * Whether an entry's model id says no more than its name: the name written another way (spelledAs), alone or after the
 * id of the lab of its canonical model ("moonshotai/Kimi-K2.6" of "Kimi K2.6", canonical model moonshotai/kimi-k2.6).
 * The id stays in the description, in the entry's ref. A route through another namespace keeps its id: "zai/glm-5.2"
 * and "fireworks/glm-5.2" at one provider are told apart by it.
 */
function idInName(summary: Pick<Summary, "name" | "model" | "canonical_id">): boolean {
  if (spelledAs(summary.name, summary.model)) return true;
  const cut = summary.model.lastIndexOf("/");
  if (cut < 0 || summary.canonical_id === null) return false;
  const lab = summary.canonical_id.slice(0, Math.max(0, summary.canonical_id.indexOf("/")));
  return summary.model.slice(0, cut).toLowerCase() === lab.toLowerCase() && spelledAs(summary.name, summary.model.slice(cut + 1));
}

/** The search that reads an entry's group: the API path, without limit and offset. */
export function entryGroupPath(summary: Pick<Summary, "provider" | "name" | "model">): string {
  const words = groupWords(firstWord(shown(summary.name, summary.model)));
  return `/api/v1/entries?provider=${encodeURIComponent(summary.provider)}${words === null ? "" : `&q=${encodeURIComponent(words)}`}`;
}

/**
 * An entry's title: its name, the model id in brackets unless it says no more than the name (idInName), and the
 * provider's label. Where that passes LONG_TITLE characters, the provider comes before an id that holds no bracket or
 * space, unless the label and that id in brackets are another provider's label. Then UNIQUE.
 */
function entryTitle(summary: Pick<Summary, "name" | "model" | "canonical_id">, label: string, labels: ReadonlySet<string>, attempt: number): string {
  const name = shown(summary.name, summary.model);
  const id = plain(summary.model);
  if (attempt === 0 && idInName(summary)) return full(`${name} at ${label}`);
  const title = full(`${name} (${id}${attempt > 1 ? `, ${attempt}` : ""}) at ${label}`);
  if (attempt > 0 || title.length <= LONG_TITLE || !/^[^\s()]+$/.test(summary.model) || labels.has(`${label} (${summary.model})`)) return title;
  return full(`${name} at ${label} (${summary.model})`);
}

const disagree = (safe: Pick<SafeValue, "agreement">): string => (safe.agreement === "differ" ? " (not all sources agree)" : "");

/** A token quantity as the entry's tile prints it: "at least 920,870 tokens", "unknown". */
function tokens(safe: SafeValue): string {
  if (safe.value === null) return `unknown${disagree(safe)}`;
  return `${safe.at_least ? "at least " : ""}${exact(safe.value)} tokens${disagree(safe)}`;
}

/** A known lifetime as the tile prints it: "5 min", "none" (a lifetime of 0). */
const lifetime = (seconds: number): string => lifetimeWords(seconds).replace(/^None$/, "none");

/**
 * The two cache lifetimes as the tiles "Cache lifetime, short" and "Cache lifetime, long" show them, in a sentence:
 * "prompt cache lifetime unknown" where both are, "prompt cache lifetime 5 min (short), long lifetime unknown" where
 * one is, "prompt cache lifetime 5 min (short) and 1 h (long)", "prompt cache lifetime 1 h, short and long". A warning
 * stays with the lifetime its tile warns on.
 */
export function cacheWords(short: SafeValue, long: SafeValue): string {
  const warned = (safe: SafeValue, kind: string): string => (safe.agreement === "differ" ? ` (${kind}, not all sources agree)` : ` (${kind})`);
  if (short.value === null && long.value === null) return `prompt cache lifetime unknown${disagree(short) || disagree(long)}`;
  if (short.value === null) return `prompt cache lifetime ${lifetime(long.value!)}${warned(long, "long")}, short lifetime unknown${disagree(short)}`;
  if (long.value === null) return `prompt cache lifetime ${lifetime(short.value)}${warned(short, "short")}, long lifetime unknown${disagree(long)}`;
  if (short.value === long.value) return `prompt cache lifetime ${lifetime(short.value)}, short and long${disagree(short) || disagree(long)}`;
  return `prompt cache lifetime ${lifetime(short.value)}${warned(short, "short")} and ${lifetime(long.value)}${warned(long, "long")}`;
}

/**
 * The price as the entry's tile shows it, in words; "" where the tile shows a rate of another kind (per image, per
 * second) or one side of the token price only, which a description cannot say as briefly as the page.
 */
export function priceWords(summary: Pick<Summary, "price_in" | "price_out" | "price_from" | "access" | "pricing" | "safe">): string {
  const rules = summary.pricing.rules;
  const conditional = rules?.some((rule) => rule.when !== null || rule.operation === "multiply") ? ", with conditional rates" : "";
  const warning = summary.safe.price.agreement === "differ" && summary.safe.price.differs.length > 0 ? " (not all sources agree)" : "";
  if (summary.price_in === null && summary.price_out === null) {
    if ((rules ?? []).some((rule) => rule.when === null && rule.operation === "set")) return "";
    return summary.pricing.billing === "not_applicable" ? "price: in plan" : "price unknown";
  }
  if (summary.price_in === null || summary.price_out === null) return "";
  const whose = summary.price_from ? ` (API list price of ${summary.price_from})` : summary.access === "subscription" && rules !== null ? " (listed price)" : "";
  return `price ${dollars(summary.price_in)} / ${dollars(summary.price_out)} per 1M input / output tokens${whose}${warning}${conditional}`;
}

/** An entry's description: its five safe values as its tiles show them. */
function entryDescription(summary: Summary, label: string): string {
  const safe = summary.safe;
  const price = priceWords(summary);
  const facts = [
    `context window ${tokens(safe.input_window)}`,
    `maximum output ${tokens(safe.max_output)}`,
    ...(price ? [price] : []),
    cacheWords(safe.cache_short, safe.cache_long),
  ];
  return `${shown(summary.name, summary.model)} at ${label} (${summary.ref}), ${ACCESS_WORDS[summary.access]}: ${facts.join(", ")}.`;
}

/**
 * An entry's page: its title and description among those of its group (`found`: what entryGroupPath reads, or any
 * list that holds the group), with the labels of every provider (providerLabels).
 */
export function entryMeta(summary: Summary, found: readonly Summary[], labels: ReadonlyMap<string, string>): PageMeta {
  const word = firstWord(shown(summary.name, summary.model));
  const group = found.filter((item) => item.ref !== summary.ref && item.provider === summary.provider && firstWord(shown(item.name, item.model)) === word);
  group.push(summary);
  const label = labels.get(summary.provider) ?? summary.provider;
  const all = new Set(labels.values());
  const titles = distinct(group, (item) => item.ref, (item, attempt) => entryTitle(item, label, all, attempt));
  const descriptions = distinct(group, (item) => item.ref, (item, attempt) => `${entryDescription(item, label)}${attempt > 0 ? ` (${attempt})` : ""}`);
  return { title: titles.get(summary.ref)!, description: descriptions.get(summary.ref)! };
}

/** The evidence page: the four counts it shows at its top. */
export function evidenceMeta(meta: Meta, indexed: boolean): PageMeta {
  return {
    title: full(`Evidence: corrections and evaluations${indexed ? "" : ", a later page"}`),
    description: `Corrections and evaluations published by providers.dev, each with its source and date: ${exact(meta.counts.corrected_entries)} corrected entries, ${exact(meta.counts.added_providers)} added providers, ${exact(meta.counts.cache_evaluations)} cache evaluations and ${exact(meta.counts.limit_evaluations)} measured limits.`,
  };
}

/** The documents, by name: a title that says what each is, from its own description; null keeps the document's. */
const DOCUMENT_TITLES: Readonly<Record<string, string>> = {
  methodology: "Methodology: where each value comes from",
  contributing: "Contributing: corrections, models and measurements",
};

/** A document's page (methodology, licensing, contributing): its description is the document's own. */
export function documentMeta(name: string, document: { title: string; description: string }): PageMeta {
  return { title: full(DOCUMENT_TITLES[name] ?? document.title), description: document.description };
}

/** The API's page, from the OpenAPI document it renders: the first sentence of its description and its last. */
export function apiDocsMeta(info: { description: string }): PageMeta {
  const sentences = info.description.split(/(?<=\.)\s+/);
  const first = sentences[0] ?? info.description;
  const last = sentences.length > 1 ? ` ${sentences.at(-1)}` : "";
  return { title: full("API reference: read-only JSON, no key"), description: `${first}${last} Endpoints, parameters, response schemas and examples.` };
}

/** An error page: its title is what happened, and so is its description. */
export function errorMeta(title: string): PageMeta {
  return { title: full(title), description: title };
}
