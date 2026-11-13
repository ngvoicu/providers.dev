// Build-time access to the published snapshot. Pages read the same files the API serves.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Index, Summary } from "../core/entries.ts";
import { canonicalModels, listEvaluations } from "../core/resources.ts";
import type { Catalog, Meta } from "../core/schema.ts";

const dir = join(process.cwd(), "data", "published", "site");

function read<T>(file: string): T {
  const path = join(dir, file);
  if (!existsSync(path)) throw new Error(`No published snapshot at ${path}. Run \`npm run sync\` and \`npm run data\` first.`);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export const catalog = read<Catalog>("api.json");
export const index = read<Index>("data/index.json");
export const meta = read<Meta>("data/meta.json");
export const now = new Date();
/** The date of the models.dev import this dataset is built on. */
export const imported = meta.upstream.fetched_at.slice(0, 10);

export const providerNames: Record<string, string> = Object.fromEntries(index.providers.map((provider) => [provider.id, provider.name]));

export const entriesByProvider = new Map<string, Summary[]>();
for (const entry of index.entries) {
  (entriesByProvider.get(entry.provider) ?? entriesByProvider.set(entry.provider, []).get(entry.provider)!).push(entry);
}

/** The canonical models, as GET /api/v1/models and /api/v1/models/{id} return them. */
export const models = canonicalModels(index.entries);
/** Every evaluation, as GET /api/v1/evaluations returns them. */
export const evaluations = listEvaluations(catalog, index);

export function shortDate(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}
