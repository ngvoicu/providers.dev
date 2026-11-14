# providers.dev site

An API-driven reference site and read-only JSON API for AI models as each provider and access method exposes them.
The baseline is imported from models.dev; our additions, corrections and measurements are merged on top.

## Stack

- TypeScript everywhere, run directly by Node 24+ (no build step for scripts: use `.ts` import paths, type-only
  imports with `import type`, no enums or parameter properties).
- Astro (static output) + Tailwind 4 for the shared shell and authored reference fragments. No UI framework: the small amount of browser code is plain
  TypeScript in `src/client/`.
- Zod for every input. YAML for authored data.
- Cloudflare Worker with static assets (`wrangler.jsonc`) for the API and all public HTML routes.
- Vitest, ESLint, `tsc`, `astro check`.

## Layout

| Path | What | Edited by |
|---|---|---|
| `data/upstream/` | the last good import of models.dev, one file per provider | `npm run sync` only |
| `data/sources/` | the measurements file from groundtruth | `npm run sync` only |
| `data/authored/` | our providers, overrides, access rules, route map, measurement labels | people |
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
- One structure. Everything providers.dev publishes of its own (a summary, a `providers_dev` record, an evaluation,
  a correction, evidence, `/api/v1/meta`) has a fixed set of keys: `null` for a value that is not known, `[]` for
  an empty list, never a missing key, and the same keys whatever the query parameters. Do not add an optional field
  to a published type or to `src/core/contract.ts`; the contract test fails on two objects of a kind with different
  keys. Only the models.dev part of an entry keeps models.dev's shape, where a field can be absent.
- A measurement never replaces a documented value on an upstream entry. It goes under `providers_dev`.
- Everything we add to a provider or model object lives under the `providers_dev` key. Do not add other top-level
  fields to upstream objects.
- An entry we add inherits identity fields only (`IDENTITY_FIELDS` in `src/core/resolve.ts`), never limits, cache
  behaviour or capabilities. One exception: an added subscription entry takes `cost` from the API entry it names,
  marked in `providers_dev.inherited.fields`.
- A subscription entry is not paid per token. One rule for all of them, imported or added: `providers_dev.pricing`
  is the API list price of the same model (`billing: reference`, `reference_ref`, and `price_from` in the summary):
  the entry it inherits from, else the lab's own API entry for its canonical model (`labEntry` in
  `src/core/resolve.ts`). Never shown as what the subscription costs. With no such API entry the record is
  `not_applicable` ("In plan"). An imported entry's own `cost` field is left as models.dev has it.
- No subscription plans, plan prices, allowances or quota data. Access is a classification only.
- The website and the API must read the same published snapshot and use the same query code (`src/core/query.ts`).
  Do not add a second filter implementation. Pages consume API responses through `PageDeps.api`; never import a
  catalog or index into a renderer. Browser filtering must call the public API.
- Public requests never fetch upstream. Only `npm run sync` does.
- Text on the site: plain, short, professional, no marketing. Say what a number means and where it comes from.
- Wording: the two sources are named `models.dev` and `providers.dev` (never "ours"). A cache run is an
  "evaluation". Pages use the full width of the home page (`.page`).
- Cache summaries use the API's exact ages, hit percentages and counts, with separate short/long settings on every
  page. Do not generate narrative lifetime verdicts. Individual evaluations are collapsed by default.
- Cache mode support comes from `providers_dev.cache.documented`; retention parameter support requires a sourced
  declaration. A requested setting or cache hit alone does not confirm parameter support.
- A retention declaration is a `request_controls` item with id `cache.retention` in
  `data/authored/overrides/<provider>.yaml`: the request field (`bindings`), the values (`options`, each with its
  `profile`: short or long), the default, and the provider's own page quoted in the evidence note. Where the page
  speaks for the provider's API as a whole, use a `select` rule instead of listing model ids: it applies to every
  entry of the provider that documents the lifetimes, follows the catalog as models come and go, and does not mark
  the entries as corrected (its source stays with the control). List only values the page shows; where the short
  lifetime is what a request gets by leaving the field out, the option is `value: null`. No control is copied from
  one provider to another: a reseller needs its own page.
- Pricing and request controls come from `providers_dev.pricing` and `providers_dev.request_controls`, also present
  on every summary. Normalize conditions once; preserve unfamiliar source shapes and mark coverage partial. Never
  infer flat pricing from absent rules or invent request headers from free-text locations.
- Imported pricing follows the models.dev v2 schema (`packages/core/src/schema-v2.ts` there): rules are published in
  the order models.dev applies them (`rule_order: listed`: base, overrides in order, then multipliers), each for the
  whole matching request (`applies_to: all_usage`), and a factor scales every price under it. What follows from the
  rules is worked out once in `derivePricing` (`src/core/policies.ts`): `period` (peak or off-peak for a time rule)
  and `resulting_rates` (the prices a multiplier makes of the base rates). A page never multiplies or compares; it
  says a condition in words with `src/core/conditions.ts`.
- Measured limits use numeric columns, not generated sentences. Free-text evaluation notes belong in raw evidence.
- Each source carries its own date: the import date next to `models.dev`, the newest evidence next to
  `providers.dev`.
- A measurement names the client it went through: the provider directly, CLIProxyAPI, or a vendor's own CLI. The
  coding agent used on top of CLIProxyAPI is not named ("A coding agent, through CLIProxyAPI"). The public names
  are in `data/authored/measurement-labels.yaml`; a new client id must be added there (the build warns and publishes
  it as "other"). Runs marked `lacks` are not published: they say something about a proxy build, not a provider.

## Commands

```
npm run sync        # import models.dev and the measurements (network)
npm run data        # resolve into data/published/
npm run build       # data + stage + template build -> dist/
npm run build:site  # rebuild templates only
npm run refresh:data # data + stage into public/ and dist/; no template build
npm run dev         # build + Wrangler dev (all pages and API)
npm run preview     # wrangler dev: the built site and the API as on Cloudflare
npm run check       # eslint + tsc + astro check + vitest
```

The Worker reads versioned snapshot assets at runtime; no dataset is bundled into its code.
Run `npm run build` before previewing a fresh clone. Data updates can use `npm run refresh:data` afterward.
Before finishing a change: `npm run build && npm run check`, and look at the affected page in a browser.

## Logo and icons

- The mark is a "p" and a "d" sharing one bowl: the ring is a provider, the dot is the model inside it, the two stems
  are the two ways in (API key and subscription). Its only source is `src/core/brand.ts`; the header and footer draw
  it through `src/components/Mark.astro` in the text colour with the dot in `--brand`.
- `public/favicon.svg`, `favicon.ico` and `apple-touch-icon.png` are written by `npm run icons`. Run it after
  changing the mark and commit the files.
- `public/og.png` (the link preview) is a 1200 x 630 screenshot of the card that `npm run og-card` writes into
  `dist/`; the steps are at the top of `scripts/og-card.ts`. Redo it when the mark or the tagline changes.
