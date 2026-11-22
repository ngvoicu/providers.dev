// The whole-dataset comparison (design/pi-source.md, section j; design/sources-side-by-side.md, section 4): two
// data/published/ directories built from the same models.dev snapshot and the same measurements must be the same in
// everything once what the pi work adds is taken off on both sides (providers_dev.pi of an entry, pi of a summary,
// pi's items of `safe` with `withoutPi` and the copies of `safe` made again with `mirror`, meta.pi, meta.license.pi
// and pi_notice, the issues whose code starts with "pi-") and what every build renews (dataset_version, generated_at).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { basePrice, type Index, type Summary } from "../../src/core/entries.ts";
import { pricingOf } from "../../src/core/policies.ts";
import { withoutPi, type SafeValues } from "../../src/core/safe.ts";
import { canonicalModels } from "../../src/core/resources.ts";
import type { Catalog, JsonObject, Meta, ModelExtension } from "../../src/core/schema.ts";

export interface Comparison {
  /** Why the two cannot be compared, or null. */
  refused: string | null;
  /** The lines to print. */
  lines: string[];
  /** Every differing object with the path of its first difference. */
  differences: string[];
  ok: boolean;
}

interface Published {
  meta: Meta;
  catalog: Catalog;
  index: Index;
  evaluations: unknown;
  corrections: unknown;
}

function read(dir: string): Published {
  const json = <T>(path: string): T => JSON.parse(readFileSync(join(dir, "site", path), "utf8")) as T;
  return {
    meta: json<Meta>(join("data", "meta.json")),
    catalog: json<Catalog>("api.json"),
    index: json<Index>(join("data", "index.json")),
    evaluations: json<{ data: unknown }>(join("data", "evaluations.json")).data,
    corrections: json<{ data: unknown }>(join("data", "corrections.json")).data,
  };
}

/** The path of the first place where `a` and `b` differ, or null where they are equal. */
export function firstDifference(a: unknown, b: unknown, path = ""): string | null {
  if (isDeepStrictEqual(a, b)) return null;
  const objectLike = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
  if (!objectLike(a) || !objectLike(b) || Array.isArray(a) !== Array.isArray(b)) return path || "(root)";
  if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length) return `${path}.length`;
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  for (const key of keys) {
    if (!(key in a) || !(key in b)) return `${path}.${key}`;
    const inner = firstDifference(a[key], b[key], `${path}.${key}`);
    if (inner !== null) return inner;
  }
  return path || "(root)";
}

/**
 * The parts of an entry's providers_dev record that carry its safe values, with pi's items taken off `safe` and the
 * copies made again by the one copy step. Where the price was pi's, `pricing` is the record of an entry no source
 * prices (what resolve() publishes for it). A record without `safe` is passed as it is.
 */
function withoutPiOfRecord<T extends { safe?: SafeValues; access: ModelExtension["access"]; pricing: ModelExtension["pricing"]; limits: { input_window: ModelExtension["limits"]["input_window"] }; cache: { lifetime: ModelExtension["cache"]["lifetime"] } }>(record: T): T {
  if (!record.safe) return record;
  const copy = structuredClone(record);
  const safe = copy.safe!;
  copy.safe = withoutPi(safe, { access: copy.access, chosen: copy.limits.input_window.measurements.filter((item) => item.chosen) });
  // The copies of a value pi gave are made again; every other copy is compared as published.
  if (safe.input_window.source === "pi.dev") Object.assign(copy.limits.input_window, { tokens: null, basis: "none", bound: null, scope: null, source: null, date: null });
  for (const [profile, key] of [["short", "cache_short"], ["long", "cache_long"]] as const) {
    if (safe[key].source === "pi.dev") Object.assign(copy.cache.lifetime[profile], { safe_s: null, basis: "none", source: null, date: null });
  }
  if (safe.price.source === "pi.dev") copy.pricing = pricingOf({}, copy.access, null, []);
  return copy;
}

const withoutPiOfEntry = (entry: JsonObject): JsonObject => {
  const extension = entry.providers_dev;
  if (typeof extension !== "object" || extension === null || Array.isArray(extension)) return entry;
  const { pi: _pi, ...rest } = extension;
  return { ...entry, providers_dev: withoutPiOfRecord(rest as unknown as ModelExtension) as unknown as JsonObject };
};
const withoutPiOfSummary = (summary: Summary): Omit<Summary, "pi"> => {
  const { pi: _pi, ...rest } = summary;
  if (!rest.safe) return rest;
  const record = withoutPiOfRecord({ safe: rest.safe, access: rest.access, pricing: rest.pricing, limits: { input_window: rest.input_window }, cache: { lifetime: rest.cache_lifetime } });
  return {
    ...rest,
    safe: record.safe!,
    input_window: record.limits.input_window,
    cache_lifetime: record.cache.lifetime,
    max_output: rest.safe.max_output.source === "pi.dev" ? null : rest.max_output,
    pricing: record.pricing,
    ...(rest.safe.price.source === "pi.dev" ? { price_in: basePrice(record.pricing, "input"), price_out: basePrice(record.pricing, "output"), price_from: null } : {}),
  };
};

/** How many safe values are pi's, and how many items of `sources` are, in a catalog. */
function piCounts(catalog: Catalog): { values: number; items: number } {
  let values = 0;
  let items = 0;
  for (const provider of Object.values(catalog)) {
    for (const entry of Object.values(provider.models)) {
      const safe = (entry.providers_dev as unknown as { safe?: SafeValues }).safe;
      if (!safe) continue;
      for (const quantity of ["input_window", "max_output", "cache_short", "cache_long", "price"] as const) {
        if (safe[quantity].source === "pi.dev") values += 1;
        items += (safe[quantity].sources as { source: string }[]).filter((item) => item.source === "pi.dev").length;
      }
    }
  }
  return { values, items };
}
const withoutPiOfMeta = (meta: Meta): unknown => {
  const { pi: _pi, dataset_version: _version, generated_at: _generated, license, issues, ...rest } = meta;
  const { pi: _license, pi_notice: _notice, ...ownLicense } = license;
  return { ...rest, license: ownLicense, issues: issues.filter((issue) => !issue.code.startsWith("pi-")) };
};

export function comparePublished(beforeDir: string, afterDir: string): Comparison {
  const before = read(beforeDir);
  const after = read(afterDir);
  const lines: string[] = [];
  if (before.meta.upstream.sha256 !== after.meta.upstream.sha256) {
    const refused = `refused: the two are built from different models.dev snapshots (upstream.sha256 ${before.meta.upstream.sha256} and ${after.meta.upstream.sha256})`;
    return { refused, lines: [refused], differences: [], ok: false };
  }
  if ((before.meta.measurements?.sha256 ?? null) !== (after.meta.measurements?.sha256 ?? null)) {
    const refused = `refused: the two are built from different measurements files (measurements.sha256 ${before.meta.measurements?.sha256 ?? "none"} and ${after.meta.measurements?.sha256 ?? "none"})`;
    return { refused, lines: [refused], differences: [], ok: false };
  }

  const differences: string[] = [];
  const note = (what: string, a: unknown, b: unknown): void => {
    const path = firstDifference(a, b);
    if (path !== null) differences.push(`${what}: ${path}`);
  };

  // The providers and the entries: none missing, none new, each deep-equal without its pi block.
  const refs = (catalog: Catalog): Set<string> => new Set(Object.entries(catalog).flatMap(([id, provider]) => Object.keys(provider.models).map((model) => `${id}/${model}`)));
  const beforeRefs = refs(before.catalog);
  const afterRefs = refs(after.catalog);
  for (const id of Object.keys(before.catalog)) if (!after.catalog[id]) differences.push(`provider ${id}: missing after`);
  for (const id of Object.keys(after.catalog)) if (!before.catalog[id]) differences.push(`provider ${id}: new after`);
  for (const ref of beforeRefs) if (!afterRefs.has(ref)) differences.push(`entry ${ref}: missing after`);
  for (const ref of afterRefs) if (!beforeRefs.has(ref)) differences.push(`entry ${ref}: new after`);
  let entries = 0;
  let keyBefore = 0;
  let keyAfter = 0;
  let blockBefore = 0;
  let blockAfter = 0;
  const count = (entry: JsonObject): [number, number] => {
    const extension = entry.providers_dev as JsonObject | undefined;
    const has = extension !== undefined && Object.hasOwn(extension, "pi");
    return [has ? 1 : 0, has && extension.pi !== null ? 1 : 0];
  };
  for (const [id, provider] of Object.entries(before.catalog)) {
    const { models: _models, ...ownBefore } = provider;
    for (const entry of Object.values(provider.models)) {
      const [key, block] = count(entry);
      keyBefore += key;
      blockBefore += block;
    }
    const other = after.catalog[id];
    if (!other) continue;
    const { models: _otherModels, ...ownAfter } = other;
    note(`provider ${id}`, ownBefore, ownAfter);
    for (const [model, entry] of Object.entries(provider.models)) {
      const counterpart = other.models[model];
      if (!counterpart) continue;
      entries += 1;
      note(`entry ${id}/${model}`, withoutPiOfEntry(entry), withoutPiOfEntry(counterpart));
    }
  }
  for (const provider of Object.values(after.catalog)) {
    for (const entry of Object.values(provider.models)) {
      const [key, block] = count(entry);
      keyAfter += key;
      blockAfter += block;
    }
  }

  // The summaries, the provider summaries, the canonical models, the evaluations and the corrections, and meta.
  const summaries = (index: Index): Map<string, Omit<Summary, "pi">> => new Map(index.entries.map((entry) => [entry.ref, withoutPiOfSummary(entry)]));
  const beforeSummaries = summaries(before.index);
  const afterSummaries = summaries(after.index);
  for (const [ref, summary] of beforeSummaries) {
    const other = afterSummaries.get(ref);
    if (other) note(`summary ${ref}`, summary, other);
    else differences.push(`summary ${ref}: missing after`);
  }
  for (const ref of afterSummaries.keys()) if (!beforeSummaries.has(ref)) differences.push(`summary ${ref}: new after`);
  note("the order of the summaries", before.index.entries.map((entry) => entry.ref), after.index.entries.map((entry) => entry.ref));
  const providers = (index: Index) => new Map(index.providers.map((provider) => [provider.id, provider]));
  const beforeProviders = providers(before.index);
  const afterProviders = providers(after.index);
  for (const [id, provider] of beforeProviders) {
    const other = afterProviders.get(id);
    if (other) note(`provider summary ${id}`, provider, other);
    else differences.push(`provider summary ${id}: missing after`);
  }
  for (const id of afterProviders.keys()) if (!beforeProviders.has(id)) differences.push(`provider summary ${id}: new after`);
  const models = (index: Index) => canonicalModels(index.entries.map((entry) => withoutPiOfSummary(entry) as Summary)).map((model) => ({ ...model, entries: model.entries.map((entry) => withoutPiOfSummary(entry)) }));
  note("canonical models", models(before.index), models(after.index));
  note("evaluations", before.evaluations, after.evaluations);
  note("corrections", before.corrections, after.corrections);
  note("meta", withoutPiOfMeta(before.meta), withoutPiOfMeta(after.meta));

  lines.push(`compared: ${Object.keys(before.catalog).length} providers, ${entries} entries`);
  lines.push(`entries with the key pi: ${keyBefore} -> ${keyAfter}`);
  lines.push(`entries with a pi block: ${blockBefore} -> ${blockAfter}`);
  const piBefore = piCounts(before.catalog);
  const piAfter = piCounts(after.catalog);
  lines.push(`items of safe.*.sources from pi.dev: ${piBefore.items} -> ${piAfter.items}`);
  lines.push(`safe values from pi.dev: ${piBefore.values} -> ${piAfter.values}`);
  lines.push(`differing objects: ${differences.length}`);
  for (const line of differences.slice(0, 20)) lines.push(`  ${line}`);
  return { refused: null, lines, differences, ok: differences.length === 0 };
}
