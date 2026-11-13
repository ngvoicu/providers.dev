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
/** A price in US dollars: `$10`, `$12.50`, `$0.075`. */
export function usd(value: number): string {
  const digits = value !== 0 && Math.abs(value) < 1 ? 4 : 2;
  const text = value.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(value) ? 0 : 2, maximumFractionDigits: digits });
  return `$${text}`;
}

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

/** A column heading for an age: "2.5 min", "1 h", "1 h 15". */
export function shortAge(seconds: number): string {
  if (seconds < 3600) return duration(seconds);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes}`;
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

/** The page of an entry: /entries/{provider}/{model}, each part of the path encoded. The API has the same path under /api/v1. */
export function entryHref(ref: string): string {
  return `/entries/${ref.split("/").map(encodeURIComponent).join("/")}`;
}

export function modelHref(canonicalId: string): string {
  return `/models/${canonicalId.split("/").map(encodeURIComponent).join("/")}/`;
}
