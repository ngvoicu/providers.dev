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

export function isStale(date: string | undefined, now: Date): boolean {
  if (!date) return false;
  return now.getTime() - new Date(`${date}T00:00:00Z`).getTime() > STALE_AFTER_DAYS * 86400 * 1000;
}

export function cacheLabel(entry: Pick<Summary, "cache" | "cache_modes" | "cache_ttl_s">): string {
  if (entry.cache === "no") return "none";
  if (entry.cache === "unknown") return "unknown";
  const ttl = entry.cache_ttl_s.length > 0 ? ` · ${entry.cache_ttl_s.map(duration).join(", ")}` : "";
  return `${entry.cache_modes.join(" + ")}${ttl}`;
}

export function measuredLabel(entry: Pick<Summary, "measured_runs" | "measured_warm_min_s" | "measured_warm_max_s">): string {
  if (entry.measured_runs === 0) return "";
  const runs = `${entry.measured_runs} ${entry.measured_runs === 1 ? "run" : "runs"}`;
  if (entry.measured_warm_min_s === undefined || entry.measured_warm_max_s === undefined) return runs;
  const range =
    entry.measured_warm_min_s === entry.measured_warm_max_s
      ? duration(entry.measured_warm_min_s)
      : `${duration(entry.measured_warm_min_s)} to ${duration(entry.measured_warm_max_s)}`;
  return `warm at ${range} · ${runs}`;
}

export const ORIGIN_LABEL: Record<Summary["origin"], string> = {
  upstream: "models.dev",
  modified: "models.dev + ours",
  added: "ours",
};

export const ORIGIN_TITLE: Record<Summary["origin"], string> = {
  upstream: "Imported from models.dev as is. Not checked by us.",
  modified: "Imported from models.dev, with our own overrides or measurements on top.",
  added: "An entry models.dev does not have. Every value on it is ours.",
};

export function entryHref(ref: string): string {
  return `/entry/?ref=${encodeURIComponent(ref)}`;
}

export function modelHref(canonicalId: string): string {
  return `/models/${canonicalId.split("/").map(encodeURIComponent).join("/")}/`;
}
