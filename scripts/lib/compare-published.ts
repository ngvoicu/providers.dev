// The whole-dataset comparison (design/pi-source.md, section j): two data/published/ directories built from the same
// models.dev snapshot and the same measurements must be the same in everything once what the pi work adds is taken
// off on both sides (providers_dev.pi of an entry, pi of a summary, meta.pi, meta.license.pi and pi_notice, the
// issues whose code starts with "pi-") and what every build renews (dataset_version, generated_at).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Index, Summary } from "../../src/core/entries.ts";
import { canonicalModels } from "../../src/core/resources.ts";
import type { Catalog, JsonObject, Meta } from "../../src/core/schema.ts";

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

const withoutPiOfEntry = (entry: JsonObject): JsonObject => {
  const extension = entry.providers_dev;
  if (typeof extension !== "object" || extension === null || Array.isArray(extension)) return entry;
  const { pi: _pi, ...rest } = extension;
  return { ...entry, providers_dev: rest };
};
const withoutPiOfSummary = (summary: Summary): Omit<Summary, "pi"> => {
  const { pi: _pi, ...rest } = summary;
  return rest;
};
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
  lines.push(`differing objects: ${differences.length}`);
  for (const line of differences.slice(0, 20)) lines.push(`  ${line}`);
  return { refused: null, lines, differences, ok: differences.length === 0 };
}
