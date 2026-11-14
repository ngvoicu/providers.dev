import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { sha256 } from "./files.ts";

/** Publish a complete, immutable snapshot before atomically changing its pointer. No template build. */
export function stageSnapshot(published: string, destination: string): string {
  const source = join(published, "site");
  const meta = readFileSync(join(source, "data", "meta.json"), "utf8");
  const id = sha256(meta).slice(0, 24);
  const manifestFile = join(destination, "current.json");
  const previous = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, "utf8")).id as string : undefined;
  const snapshots = join(destination, "snapshots");
  mkdirSync(snapshots, { recursive: true });
  const next = join(snapshots, `${id}.tmp`);
  rmSync(next, { recursive: true, force: true });
  cpSync(source, next, {
    recursive: true,
    // The full exports and the index are read from gzip; raw copies exceed, or come close to, Cloudflare's per-asset size limit.
    filter: (file) => !["api.json", "catalog.json", "index.json", "_headers"].includes(basename(file)),
  });
  const target = join(snapshots, id);
  if (existsSync(target)) rmSync(next, { recursive: true });
  else renameSync(next, target);
  writeFileSync(`${manifestFile}.tmp`, JSON.stringify({ id }));
  renameSync(`${manifestFile}.tmp`, manifestFile);
  // Keep the previous publication for requests pinned to it during a local refresh.
  for (const name of readdirSync(snapshots)) if (name !== id && name !== previous) rmSync(join(snapshots, name), { recursive: true, force: true });
  for (const legacy of ["data", "api.json", "api.json.gz"]) rmSync(join(destination, legacy), { recursive: true, force: true });
  writeFileSync(join(destination, "_headers"), "/snapshots/*\n  Cache-Control: public, max-age=31536000, immutable\n\n/current.json\n  Cache-Control: no-store\n");
  return id;
}
