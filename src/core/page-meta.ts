// The title and the description of every page of providers.dev, from the API answer the page itself prints. They say
// what the page shows and nothing more: a lower bound stays "at least", unknown stays unknown (never 0), a
// subscription's price stays the API list price of another entry, a warning where the sources disagree stays a
// warning, and nothing is called measured. One module owns the full title (with " · providers.dev"): the page's
// <title>, its og:title and the name in its structured data are this string.
//
// Pure: no request, no catalog. tests/page-meta.test.ts applies every function to the whole publication in dist/ and
// checks that no two pages share a title or a description.
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

/** A provider's page. The page shows its access, its number of entries and those with providers.dev evidence. */
export function providerMeta(provider: Pick<ProviderSummary, "id" | "name" | "access" | "entry_count" | "evidence_entry_count">): PageMeta {
  return {
    title: full(`${provider.name} models`),
    description: `${provider.name} (${provider.id}), ${PROVIDER_ACCESS[provider.access]}: ${entries(provider.entry_count, "model entry")} in the providers.dev catalog, ${exact(provider.evidence_entry_count)} with providers.dev evidence, each with its context window, maximum output, price and prompt caching.`,
  };
}

/** An end of a model's context window, as the page's hover text says it: "at least" where it is a lower bound. */
const windowEnd = (end: NonNullable<CanonicalModel["input_window_min"]>): string => `${end.bound === "at_least" ? "at least " : ""}${exact(end.tokens)}`;

/** A canonical model's page: its context window and maximum output from smallest to largest among its entries. */
export function modelMeta(model: Pick<CanonicalModel, "id" | "name" | "entry_count" | "subscription_entry_count" | "input_window_min" | "input_window_max" | "input_window_unknown_count" | "max_output_min" | "max_output_max">): PageMeta {
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
  return {
    title: full(`${model.name} (${model.id}) across providers`),
    description: `${model.name} (${model.id}) at ${count} across providers and access methods: ${window}, ${output}.`,
  };
}

/**
 * An entry's name in its title: the name, and the model id in brackets unless the id is the name written in lower case
 * with hyphens for spaces. Two entries of one provider with one name have different ids, and at most one of them is
 * that form, so the title tells them apart.
 */
export function entryName(summary: Pick<Summary, "name" | "model">): string {
  return summary.model === summary.name.toLowerCase().replace(/\s+/g, "-") ? summary.name : `${summary.name} (${summary.model})`;
}

const disagree = (safe: Pick<SafeValue, "agreement">): string => (safe.agreement === "differ" ? " (not all sources agree)" : "");

/** A token quantity as the entry's tile prints it: "at least 920,870 tokens", "unknown". */
function tokens(safe: SafeValue): string {
  if (safe.value === null) return `unknown${disagree(safe)}`;
  return `${safe.at_least ? "at least " : ""}${exact(safe.value)} tokens${disagree(safe)}`;
}

/** A lifetime as the tile prints it: "5 min", "None" (a lifetime of 0), "unknown". */
const lifetime = (safe: SafeValue): string => `${safe.value === null ? "unknown" : lifetimeWords(safe.value).replace(/^None$/, "none")}${disagree(safe)}`;

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

/** An entry's page: its five safe values as its tiles show them. */
export function entryMeta(summary: Summary, providerName: string): PageMeta {
  const safe = summary.safe;
  const price = priceWords(summary);
  const facts = [
    `context window ${tokens(safe.input_window)}`,
    `maximum output ${tokens(safe.max_output)}`,
    ...(price ? [price] : []),
    `prompt cache lifetime ${lifetime(safe.cache_short)} short, ${lifetime(safe.cache_long)} long`,
  ];
  return {
    title: full(`${entryName(summary)} at ${providerName}`),
    description: `${summary.name} at ${providerName} (${summary.ref}), ${ACCESS_WORDS[summary.access]}: ${facts.join(", ")}.`,
  };
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
