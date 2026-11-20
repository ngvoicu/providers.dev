// The resources of the API beyond single entries: canonical models and evaluations. Built from the same catalog and
// index as everything else, by the same functions for the API and for the pages, so that a page shows what the API returns.
import type { CacheEvaluation } from "./cache.ts";
import type { Index, Summary } from "./entries.ts";
import type { WindowBound } from "./limits.ts";
import { NS, type Access, type Catalog, type MeasuredLimit, type ModelExtension, type Provenance } from "./schema.ts";

export interface Facets {
  providers: { id: string; name: string }[];
  types: string[];
  evidence_entries: number;
  subscription_providers: number;
}

export function facets(index: Index): Facets {
  return {
    providers: index.providers.map(({ id, name }) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    types: [...new Set(index.entries.flatMap((entry) => entry.type ? [entry.type] : []))].sort(),
    evidence_entries: index.entries.filter((entry) => entry.origin !== "upstream").length,
    subscription_providers: index.providers.filter((provider) => provider.access === "subscription").length,
  };
}

export interface Correction {
  provider: string;
  change: Provenance;
  entry_refs: string[];
}

/** Group only identical corrections, including the original value and all evidence. */
export function listCorrections(catalog: Catalog, index: Index): Correction[] {
  const groups = new Map<string, Correction>();
  for (const entry of index.entries) {
    const extension = catalog[entry.provider]?.models[entry.model]?.[NS] as unknown as ModelExtension | undefined;
    for (const change of extension?.provenance ?? []) {
      const key = JSON.stringify([entry.provider, change]);
      const group = groups.get(key) ?? { provider: entry.provider, change, entry_refs: [] };
      group.entry_refs.push(entry.ref);
      groups.set(key, group);
    }
  }
  return [...groups.values()];
}

/** The authored reference documents: `/docs/{name}/` on the site (support: `/support/`) and `/api/v1/docs/{name}` in the API. */
export const DOCUMENTS = ["methodology", "licensing", "contributing", "support"] as const;

/** Authored reference text, published through the API along with the machine-readable contract. */
export interface Documentation {
  title: string;
  description: string;
  lead: string;
  toc: { id: string; label: string }[];
  body_html: string;
}

/** A model as its lab names it, and how the catalog's entries for it compare. */
export interface CanonicalModel {
  /** `lab/model`, the `canonical_id` of its entries. */
  id: string;
  name: string;
  /** The first part of the id. */
  lab: string;
  /** The entry of the lab's own provider for this model, where the catalog has one: the closest reference for the model's own limits. */
  reference_ref: string | null;
  entry_count: number;
  subscription_entry_count: number;
  /** Entries with providers.dev corrections or evaluations. */
  evidence_entry_count: number;
  /** The smallest and largest context window among its entries, in tokens. Null = no entry states one. */
  context_min: number | null;
  context_max: number | null;
  max_output_min: number | null;
  max_output_max: number | null;
  /**
   * The smallest and the largest input window among its entries (`input_window` of each), each with the entry it is
   * on. At an equal number of tokens a lower bound (`at_least`) counts as the larger. Null = no entry has one.
   */
  input_window_min: ModelInputWindowEnd | null;
  input_window_max: ModelInputWindowEnd | null;
  /** Entries with no input window (`input_window.tokens` null). */
  input_window_unknown_count: number;
  /** The input window of the reference entry (`reference_ref`). Null where there is none, or where its input window is not known. */
  input_window_reference: ModelInputWindowEnd | null;
}

/** One end of the input windows of a model's entries: the entry, and its `input_window` as its summary publishes it. */
export interface ModelInputWindowEnd {
  entry_ref: string;
  tokens: number;
  bound: WindowBound;
  basis: "documented" | "measured";
  scope: "input" | "window";
}

export interface CanonicalModelDetail extends CanonicalModel {
  /** Every entry for the model: the lab's own API first, then subscriptions, then the rest by provider. */
  entries: Summary[];
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const range = (values: (number | null)[]): [number | null, number | null] => {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? [null, null] : [Math.min(...known), Math.max(...known)];
};

/** An entry's input window as an end of a model's: null where it is not known. */
function windowEnd({ ref, input_window: w }: Summary): ModelInputWindowEnd | null {
  // A record with a value has its bound, basis and scope (contract: null exactly with none).
  if (w.tokens === null || w.basis === "none" || w.bound === null || w.scope === null) return null;
  return { entry_ref: ref, tokens: w.tokens, bound: w.bound, basis: w.basis, scope: w.scope };
}

/**
 * The smallest and the largest input window among a model's entries, and how many have none, from `input_window` of
 * each summary: the published record, not worked out again. At an equal number of tokens a lower bound ranks above a
 * value that is not one: the smallest is then the one that is not a bound, the largest the one that may be more. Of
 * records that rank the same, the first in the order given is taken (the model's own order: the lab's entry first).
 */
export function inputWindowRange(entries: readonly Summary[]): Pick<CanonicalModel, "input_window_min" | "input_window_max" | "input_window_unknown_count"> {
  const below = (a: ModelInputWindowEnd, b: ModelInputWindowEnd): boolean => a.tokens < b.tokens || (a.tokens === b.tokens && a.bound !== "at_least" && b.bound === "at_least");
  let min: ModelInputWindowEnd | null = null;
  let max: ModelInputWindowEnd | null = null;
  let unknown = 0;
  for (const entry of entries) {
    const end = windowEnd(entry);
    if (end === null) {
      unknown += 1;
      continue;
    }
    if (min === null || below(end, min)) min = end;
    if (max === null || below(max, end)) max = end;
  }
  return { input_window_min: min, input_window_max: max, input_window_unknown_count: unknown };
}

function describe(id: string, entries: Summary[]): CanonicalModelDetail {
  const lab = id.split("/")[0] as string;
  const rank = (entry: Summary): number => (entry.provider === lab ? 0 : entry.access === "subscription" ? 1 : 2);
  const sorted = [...entries].sort((a, b) => rank(a) - rank(b) || compareText(a.provider, b.provider) || compareText(a.model, b.model));
  // The lab's own entry: the one with the canonical id itself, else its first by id. Subscription entries take
  // their API reference price by the same choice (resolve.ts, labEntry).
  const own = sorted.find((entry) => entry.ref === id) ?? sorted.find((entry) => entry.provider === lab);
  const [contextMin, contextMax] = range(sorted.map((entry) => entry.context));
  const [outputMin, outputMax] = range(sorted.map((entry) => entry.max_output));
  return {
    id,
    name: (own ?? (sorted[0] as Summary)).name,
    lab,
    reference_ref: own?.ref ?? null,
    entry_count: sorted.length,
    subscription_entry_count: sorted.filter((entry) => entry.access === "subscription").length,
    evidence_entry_count: sorted.filter((entry) => entry.origin !== "upstream").length,
    context_min: contextMin,
    context_max: contextMax,
    max_output_min: outputMin,
    max_output_max: outputMax,
    ...inputWindowRange(sorted),
    input_window_reference: own ? windowEnd(own) : null,
    entries: sorted,
  };
}

/** Every canonical model with its entries: the one with the most entries first, then by id. */
export function canonicalModels(entries: readonly Summary[]): CanonicalModelDetail[] {
  const groups = new Map<string, Summary[]>();
  for (const entry of entries) {
    if (!entry.canonical_id) continue;
    (groups.get(entry.canonical_id) ?? groups.set(entry.canonical_id, []).get(entry.canonical_id)!).push(entry);
  }
  return [...groups].map(([id, members]) => describe(id, members)).sort((a, b) => b.entry_count - a.entry_count || compareText(a.id, b.id));
}

/** The list form of a canonical model: everything but its entries. */
export function withoutEntries(model: CanonicalModelDetail): CanonicalModel {
  const { entries: _entries, ...rest } = model;
  return rest;
}

interface OfEntry {
  entry_ref: string;
  entry_name: string;
  access: Access;
}
export type CacheEvaluationRecord = { kind: "cache" } & OfEntry & CacheEvaluation;
export type LimitEvaluationRecord = { kind: "limit" } & OfEntry & MeasuredLimit;
export type EvaluationRecord = CacheEvaluationRecord | LimitEvaluationRecord;

/** Every evaluation in the catalog, each with the entry it was made on: cache evaluations newest first, then limits. */
export function listEvaluations(catalog: Catalog, index: Pick<Index, "entries">): EvaluationRecord[] {
  const cache: CacheEvaluationRecord[] = [];
  const limits: LimitEvaluationRecord[] = [];
  for (const entry of index.entries) {
    if (entry.evaluation_count === 0 && entry.measured_limit_count === 0) continue;
    const extension = catalog[entry.provider]?.models[entry.model]?.[NS] as unknown as ModelExtension | undefined;
    if (!extension) continue;
    const of: OfEntry = { entry_ref: entry.ref, entry_name: entry.name, access: entry.access };
    for (const evaluation of extension.cache.evaluations) cache.push({ kind: "cache", ...of, ...evaluation });
    for (const limit of extension.limits.measured) limits.push({ kind: "limit", ...of, ...limit });
  }
  cache.sort((a, b) => compareText(b.date, a.date) || compareText(a.entry_ref, b.entry_ref) || compareText(a.id, b.id));
  limits.sort((a, b) => compareText(b.date ?? "", a.date ?? "") || compareText(a.entry_ref, b.entry_ref));
  return [...cache, ...limits];
}

export interface Page<T> {
  total: number;
  limit: number;
  offset: number;
  next_offset: number | null;
  data: T[];
}

/** One page of a list, in the envelope every collection of the API uses. */
export function page<T>(items: readonly T[], limit: number, offset: number): Page<T> {
  const data = items.slice(offset, offset + limit);
  const next = offset + data.length;
  return { total: items.length, limit, offset, next_offset: next < items.length ? next : null, data };
}
