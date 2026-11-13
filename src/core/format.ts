// How values are written on the site. Shared by the pages built ahead of time and the code that runs in the browser.
import type { Summary } from "./entries.ts";

/** Our evidence older than this is marked as stale. */
export const STALE_AFTER_DAYS = 90;

export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] as string);
}

/** 1048576 -> "1,048,576". */
export function exact(value: number): string {
  return value.toLocaleString("en-US");
}

/** 1048576 -> "1.05M", 128000 -> "128K". Always pair it with the exact number. */
export function compactTokens(value: number): string {
  if (value >= 1_000_000) return `${trim(value / 1_000_000)}M`;
  if (value >= 1_000) return `${trim(value / 1_000)}K`;
  return String(value);
}

function trim(value: number): string {
  return value >= 100 ? String(Math.round(value)) : String(Number(value.toFixed(2)));
}

/** 300 -> "5 min", 3600 -> "1 h", 450 -> "7.5 min". */
export function duration(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  if (seconds % 86400 === 0) return `${seconds / 86400} d`;
  if (seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds < 3600 || seconds % 60 !== 0) return `${Number((seconds / 60).toFixed(1))} min`;
  return `${Math.floor(seconds / 3600)} h ${(seconds % 3600) / 60} min`;
}

/**
 * The date of the models.dev import an index was built on. A browser can hold an index from before this field
 * existed for a few minutes after a release, so its absence is not an error.
 */
export function importDate(index: { upstream_fetched_at?: string }): string | undefined {
  return index.upstream_fetched_at?.slice(0, 10);
}

export function isStale(date: string | undefined, now: Date): boolean {
  if (!date) return false;
  return now.getTime() - new Date(`${date}T00:00:00Z`).getTime() > STALE_AFTER_DAYS * 86400 * 1000;
}

export function cacheLabel(entry: Pick<Summary, "cache" | "cache_modes" | "cache_ttl_s">): string {
  if (entry.cache === "no") return "None";
  if (entry.cache === "unknown") return "Unknown";
  const ttl = entry.cache_ttl_s.length > 0 ? ` · ${entry.cache_ttl_s.map(duration).join(", ")}` : "";
  return `${entry.cache_modes.join(" + ")}${ttl}`;
}

export function plural(count: number, word: string): string {
  return `${exact(count)} ${word}${count === 1 ? "" : "s"}`;
}

/**
 * "At least 30 min": the age up to which every re-send was served from the cache. Across several evaluations it is
 * a range, "At least 10 min to 30 min".
 */
export function warmRange(entry: Pick<Summary, "measured_warm_min_s" | "measured_warm_max_s">): string {
  if (entry.measured_warm_min_s === undefined || entry.measured_warm_max_s === undefined) return "";
  return entry.measured_warm_min_s === entry.measured_warm_max_s
    ? `At least ${duration(entry.measured_warm_min_s)}`
    : `At least ${duration(entry.measured_warm_min_s)} to ${duration(entry.measured_warm_max_s)}`;
}

/** A column heading for an age: "2.5 min", "1 h", "1 h 15". */
export function shortAge(seconds: number): string {
  if (seconds < 3600) return duration(seconds);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes}`;
}

export interface RunAges {
  all_warm_through_s: number | null;
  last_warm_s: number | null;
  first_all_cold_s: number | null;
  control?: { warm: number; total: number };
  checks?: { age_s: number }[];
}

/** One evaluation in words: what held for every re-send, and what was seen beyond that. */
export function runVerdict(run: RunAges): { head: string; detail: string } {
  const { all_warm_through_s: always, last_warm_s: last, first_all_cold_s: cold } = run;
  const ages = (run.checks ?? []).map((check) => check.age_s);
  const oldest = ages.length > 0 ? Math.max(...ages) : null;
  if (last === null) {
    return {
      head: ages.length > 0 || cold !== null ? "Not cached at any age checked" : "No result by age",
      detail: run.control && run.control.warm > 0 ? "Cached when sent again at once" : "",
    };
  }
  const head = always === null ? "Cached only part of the time" : `Always cached up to ${duration(always)}`;
  if (cold === null) {
    if (always === last) return { head, detail: last === oldest ? "That was the oldest age checked" : "" };
    return { head, detail: `Still cached at ${duration(last)}${last === oldest ? ", the oldest age checked" : ""}` };
  }
  if (cold < last) return { head, detail: `Nothing cached at ${duration(cold)}, but cached again as late as ${duration(last)}` };
  return { head, detail: always === last ? `Nothing cached at ${duration(cold)}` : `Last cached at ${duration(last)}; nothing cached at ${duration(cold)}` };
}

export const ORIGIN_LABEL: Record<Summary["origin"], string> = {
  upstream: "models.dev",
  modified: "models.dev + providers.dev",
  added: "providers.dev",
};

export const ORIGIN_TITLE: Record<Summary["origin"], string> = {
  upstream: "Imported from models.dev as is. Not independently checked.",
  modified: "Imported from models.dev, with providers.dev corrections or evaluations on top.",
  added: "Listed by providers.dev. models.dev has no entry for this access method.",
};

export function entryHref(ref: string): string {
  return `/entry/?ref=${encodeURIComponent(ref)}`;
}

export function modelHref(canonicalId: string): string {
  return `/models/${canonicalId.split("/").map(encodeURIComponent).join("/")}/`;
}
