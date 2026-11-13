// The resources of the API beyond single entries: canonical models and evaluations. Built from the same catalog and
// index as everything else, by the same functions for the API and for the pages, so that a page shows what the API returns.
import type { CacheEvaluation } from "./cache.ts";
import type { Index, Summary } from "./entries.ts";
import { NS, type Access, type Catalog, type MeasuredLimit, type ModelExtension } from "./schema.ts";

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
}

export interface CanonicalModelDetail extends CanonicalModel {
  /** Every entry for the model: the lab's own API first, then subscriptions, then the rest by provider. */
  entries: Summary[];
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const range = (values: (number | undefined)[]): [number | null, number | null] => {
  const known = values.filter((value): value is number => value !== undefined);
  return known.length === 0 ? [null, null] : [Math.min(...known), Math.max(...known)];
};

function describe(id: string, entries: Summary[]): CanonicalModelDetail {
  const lab = id.split("/")[0] as string;
  const rank = (entry: Summary): number => (entry.provider === lab ? 0 : entry.access === "subscription" ? 1 : 2);
  const sorted = [...entries].sort((a, b) => rank(a) - rank(b) || compareText(a.provider, b.provider) || compareText(a.model, b.model));
  const own = sorted.find((entry) => entry.provider === lab);
  const [contextMin, contextMax] = range(sorted.map((entry) => entry.context));
  const [outputMin, outputMax] = range(sorted.map((entry) => entry.max_output));
  return {
    id,
    name: (sorted.find((entry) => entry.ref === id) ?? own ?? (sorted[0] as Summary)).name,
    lab,
    reference_ref: own?.ref ?? null,
    entry_count: sorted.length,
    subscription_entry_count: sorted.filter((entry) => entry.access === "subscription").length,
    evidence_entry_count: sorted.filter((entry) => entry.origin !== "upstream").length,
    context_min: contextMin,
    context_max: contextMax,
    max_output_min: outputMin,
    max_output_max: outputMax,
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
    for (const limit of extension.limits?.measured ?? []) limits.push({ kind: "limit", ...of, ...limit });
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
