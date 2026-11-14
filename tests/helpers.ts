import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import type { ApiDeps } from "../src/core/api.ts";
import type { Index } from "../src/core/entries.ts";
import type { Meta, UpstreamCatalog } from "../src/core/schema.ts";
import { ROOT } from "../scripts/lib/files.ts";

export const evidence = [{ kind: "documented", url: "https://example.com/docs", date: "2026-11-01" }];

/** A small upstream catalog in the v2 shape: big enough to pass the sync's size checks when repeated. */
export function fixtureUpstream(providers = 30, modelsEach = 20): UpstreamCatalog {
  const catalog: UpstreamCatalog = {};
  for (let p = 0; p < providers; p += 1) {
    const id = `provider-${String(p).padStart(2, "0")}`;
    const models: UpstreamCatalog[string]["models"] = {};
    for (let m = 0; m < modelsEach; m += 1) {
      const modelId = m % 2 === 0 ? `lab/model-${m}` : `model-${m}`;
      models[modelId] = {
        id: modelId,
        name: `Model ${m}`,
        type: m === 19 ? "embedding" : "chat",
        family: `family-${m % 3}`,
        canonical_id: `lab/model-${m}`,
        release_date: `2026-0${(m % 9) + 1}-01`,
        limit: m === 7 ? {} : { context: (m + 1) * 100000, output: m === 0 ? 0 : (m + 1) * 1000 },
        capabilities:
          m % 4 === 0
            ? { cache: { explicit: { ttl: ["5m", "1h"] } } }
            : m % 4 === 1
              ? { cache: { implicit: true } }
              : m % 4 === 2
                ? { cache: false }
                : {},
      };
    }
    catalog[id] = { id, name: `Provider ${p}`, doc: "https://example.com", models };
  }
  return catalog;
}

export function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), "providers-dev-"));
}

export function writeAuthored(dataDir: string): void {
  const authored = join(dataDir, "authored");
  mkdirSync(join(authored, "providers"), { recursive: true });
  mkdirSync(join(authored, "overrides"), { recursive: true });
  writeFileSync(join(authored, "access.yaml"), stringify({ default: "api", default_basis: "default", patterns: [], providers: {} }));
  writeFileSync(join(authored, "routes.yaml"), stringify({}));
  writeFileSync(
    join(authored, "providers", "added-login.yaml"),
    stringify({
      id: "added-login",
      name: "Added login",
      access: "subscription",
      access_basis: "a login",
      evidence,
      models: [{ id: "lab/model-2", inherits: "provider-00/lab/model-2", fields: { limit: { context: 900000 } }, evidence }],
    }),
  );
  writeFileSync(
    join(authored, "overrides", "provider-01.yaml"),
    stringify({
      provider: "provider-01",
      rules: [{ models: ["model-1"], set: { limit: { context: 5000000 } }, reason: "documented higher", evidence }],
    }),
  );
}

export function fetchReturning(body: string, init: ResponseInit = { status: 200, headers: { etag: '"v1"' } }): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("api.github.com")) return new Response(JSON.stringify({ sha: "abc123", commit: { committer: { date: "2026-11-12T00:00:00Z" } } }));
    if (url.includes("observed.json")) return new Response("not found", { status: 404 });
    return new Response(body, init);
  }) as typeof fetch;
}

export function depsFrom(publishedDir: string): ApiDeps {
  const index = JSON.parse(readFileSync(join(publishedDir, "site", "data", "index.json"), "utf8")) as Index;
  const meta = JSON.parse(readFileSync(join(publishedDir, "site", "data", "meta.json"), "utf8")) as Meta;
  return {
    index,
    meta,
    async asset(path) {
      if (/^\/reference-content\/docs\/(methodology|licensing)\.json$/.test(path)) {
        return new Response(JSON.stringify({ title: "Reference fixture", description: "Reference", lead: "Reference", toc: [], body_html: "<p>Reference fixture</p>" }));
      }
      const file = join(publishedDir, "site", path);
      return existsSync(file) ? new Response(readFileSync(file)) : null;
    },
  };
}

export { ROOT };
