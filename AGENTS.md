# providers.dev site

A static reference site and read-only JSON API for AI models as each provider and access method exposes them.
The baseline is imported from models.dev; our additions, corrections and measurements are merged on top.

## Stack

- TypeScript everywhere, run directly by Node 24+ (no build step for scripts: use `.ts` import paths, type-only
  imports with `import type`, no enums or parameter properties).
- Astro (static output) + Tailwind 4 for the pages. No UI framework: the small amount of browser code is plain
  TypeScript in `src/client/`.
- Zod for every input. YAML for authored data.
- Cloudflare Worker with static assets (`wrangler.jsonc`). The Worker runs only for `/api/v1/*`.
- Vitest, ESLint, `tsc`, `astro check`.

## Layout

| Path | What | Edited by |
|---|---|---|
| `data/upstream/` | the last good import of models.dev, one file per provider | `npm run sync` only |
| `data/sources/` | the measurements file from cache-ttl-probe | `npm run sync` only |
| `data/authored/` | our providers, overrides, access rules, route map | people |
| `data/published/` | the resolved snapshot (not in git) | `npm run data` only |
| `src/core/` | pure logic shared by scripts, Worker, pages and browser: merge, resolve, entries, query, api, render | |
| `scripts/` | sync, data build, staging | |
| `worker/` | the Cloudflare Worker | |
| `src/pages/`, `src/client/` | the site | |

## Rules

- Never edit `data/upstream/`, `data/sources/` or `data/published/` by hand. A correction is an override in
  `data/authored/overrides/<provider>.yaml`; it survives every sync.
- Every override and every added provider or model needs a `reason` (where the schema has one) and `evidence` with
  `kind`, `url` and `date`. The build fails without them. Do not invent limits, lifetimes, model mappings or dates.
- Unknown is not zero and not unsupported. A missing value stays missing; `null` in an override means "publish as
  unknown"; `"$delete"` removes a field.
- A measurement never replaces a documented value on an upstream entry. It goes under `providers_dev`.
- Everything we add to a provider or model object lives under the `providers_dev` key. Do not add other top-level
  fields to upstream objects.
- An entry we add inherits identity fields only (`IDENTITY_FIELDS` in `src/core/resolve.ts`), never limits, cache
  behaviour, prices or capabilities.
- No subscription plans, plan prices, allowances or quota data. Access is a classification only.
- The website and the API must read the same published snapshot and use the same query code (`src/core/query.ts`).
  Do not add a second filter implementation.
- Public requests never fetch upstream. Only `npm run sync` does.
- Text on the site: plain, short, no marketing. Say what a number means and where it comes from.

## Commands

```
npm run sync        # import models.dev and the measurements (network)
npm run data        # resolve into data/published/
npm run build       # data + stage + astro build -> dist/
npm run dev         # astro dev server (pages only; the API needs `npm run preview`)
npm run preview     # wrangler dev: the built site and the API as on Cloudflare
npm run check       # eslint + tsc + astro check + vitest
```

Run `npm run build` before `npm run check` on a fresh clone: type-checking the Worker needs `worker/generated/`.
Before finishing a change: `npm run build && npm run check`, and look at the affected page in a browser.
