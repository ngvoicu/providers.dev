// Small file helpers shared by the sync and the data build.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const DATA = join(ROOT, "data");

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function readJsonIfExists<T>(path: string): T | undefined {
  return existsSync(path) ? readJson<T>(path) : undefined;
}

/** Stable, line-oriented JSON so that a daily snapshot gives small diffs. */
export function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 1)}\n`;
}

/** Write through a temporary file and a rename, so a reader never sees half a file. */
export function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, content);
  renameSync(temporary, path);
}

/**
 * Replace the directory `live` with the finished directory `next`.
 * The old one is moved aside first and put back if the second rename fails, so `live` is never half-written.
 */
export function swapDir(next: string, live: string): void {
  const old = `${live}.old-${process.pid}`;
  rmSync(old, { recursive: true, force: true });
  const hadLive = existsSync(live);
  if (hadLive) renameSync(live, old);
  try {
    renameSync(next, live);
  } catch (error) {
    if (hadLive) renameSync(old, live);
    throw error;
  }
  rmSync(old, { recursive: true, force: true });
}
