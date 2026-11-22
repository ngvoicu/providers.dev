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
| `data/authored/` | our providers, overrides, catalog-wide rules, access rules, route map, measurement labels | people |
| `data/published/` | the resolved snapshot (not in git) | `npm run data` only |
| `src/core/` | pure logic shared by scripts, Worker, pages and browser: merge, resolve, entries, query, api, render | |
| `scripts/` | sync, data build, staging | |
| `worker/` | the Cloudflare Worker | |
| `src/pages/`, `src/client/` | the site | |

## Rules

- Never edit `data/upstream/`, `data/sources/` or `data/published/` by hand. A correction is an override in
  `data/authored/overrides/<provider>.yaml`; it survives every sync.
- To leave out the earlier versions of a model family everywhere (an editorial choice, such as "no Claude Opus before
  5.5"), add one rule to `data/authored/catalog-rules.yaml`, never an `exclude: true` per entry. It reads the version
  from each entry of the family at every provider, after every override, and follows syncs; it has a reason and a
  date and no evidence, and `/api/v1/meta` lists it once in `exclusions` with the number of entries it removed. Do not
  edit an override because a rule leaves out an entry it names: that raises no issue. Where ids are less regular
  (GPT), a rule can cover several families, read the id only, read two joined digits as major and minor, and keep
  an entry with no version silently (`family` list, `read`, `joined_digits`, `no_version`). The README says how.
- To leave out every model released in a span of dates, add an item under `exclude_released` in the same file
  (`from` inclusive, `before` exclusive, either may be left out). It reads only the published `release_date`, after
  the family rules; no date, or a date listed in `placeholder_release_dates` (1970-01-01), keeps the entry. Do not
  change a published date to make a rule match: correct it with an override, with evidence.
- Every override and every added provider or model needs a `reason` (where the schema has one) and `evidence` with
  `kind`, `url` and `date`. The build fails without them. Do not invent limits, lifetimes, model mappings or dates.
- Unknown is not zero and not unsupported. A missing value stays missing; `null` in an override means "publish as
  unknown"; `"$delete"` removes a field.
- One structure. Everything providers.dev publishes of its own (a summary, a `providers_dev` record, an evaluation,
  a correction, evidence, `/api/v1/meta`) has a fixed set of keys: `null` for a value that is not known, `[]` for
  an empty list, never a missing key, and the same keys whatever the query parameters. Do not add an optional field
  to a published type or to `src/core/contract.ts`; the contract test fails on two objects of a kind with different
  keys. Only the models.dev part of an entry keeps models.dev's shape, where a field can be absent.
- The structure of `/api/v1` only grows: add a path, an optional parameter, an allowed value, a property, a component
  or an enum value; never remove, rename or retype one, never make a property optional or nullable, never add a
  required parameter. That would be `/api/v2`. `structure/api-v1-1.0.0.json` is the structure of 1.0.0 and is never
  edited. A change of structure needs the record updated in the same commit (`npm run structure:update`, which writes
  `structure/api-v1.json`) and a version step in `src/core/openapi.ts`: a minor step for a release that adds something.
  This holds for everything providers.dev makes itself (summaries, `providers_dev` records, evaluations, corrections,
  evidence, paths, parameters). The fields imported from models.dev (`limit`, `cost`, `capabilities`, `modalities`
  and the like) follow the models.dev v2 schema, which models.dev calls experimental: when models.dev changes one of
  them, providers.dev takes the change over, and that is not a new major version of this API. The first case was on
  2026-11-17: `capabilities.tools.updates` went from a boolean to a list (`add`, `remove`, `replace`), and the owner
  had 1.0.0 corrected in place for it, record and baseline in one commit with the new checksum. That was this field
  only; any other edit of the baseline needs the owner.
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
- The import address (`UPSTREAM_URL` in `scripts/lib/sync.ts`) asks for `openai-codex` (`?include=openai-codex`):
  models.dev hides it by default since its commit `f648ddb` (2026-11-17), and the site lists it as a subscription.
  Do not drop the parameter, and do not author the provider by hand. The README says why (Syncing).
- Text on the site: plain, short, professional, no marketing. Say what a number means and where it comes from.
- An entry page states the safe value of each quantity, in the same sections, tables and rows on every entry, and a
  warning where its sources contradict each other (`agreement: "differ"`, `safe.differing`); it names no source in a
  cell. A row with nothing in it says so (Unknown, Not evaluated, Not applicable, None) and is never left out. It carries no sentence
  that would repeat on every page: how a value is made is said once, in the methodology. The source's own
  `description` of a model is in the API and not on the page.
- Wording: the four sources are named `Measured`, `providers.dev`, `models.dev` and `pi.dev` (never "ours"). A page
  labels the safe input window "Context window"; the API's name for it stays `input_window`. A cache run is an
  "evaluation". Pages use the full width of the home page (`.page`).
- Results by age use the API's exact ages and counts, short and long apart, per client. A cell shows the hit
  percentage rounded to a whole number; the exact percentage is in the API and in the hover text. Do not generate narrative lifetime verdicts. Individual evaluations are collapsed by default.
- The safe value of every quantity (the input window, the maximum output, the short and the long cache lifetime, the
  price) is worked out once, in `safeValues` (`src/core/safe.ts`), by one order of sources: the most direct
  measurement, providers.dev, models.dev, pi.dev; the first that states a value gives it. It is published as
  `providers_dev.safe` (`safe` of a summary) and copied by `mirror` into the records that carried it before:
  `providers_dev.limits.input_window` (`inputWindow`, `src/core/limits.ts`) and `providers_dev.cache.lifetime`
  (`cacheLifetime`, `src/core/cache.ts`), which make their records and choose nothing. A page prints `safe` and
  applies no rule: it compares nothing, takes no minimum, applies no margin and picks no source; the warning is
  `agreement: "differ"` and nothing else. `limit`, `cost` and `capabilities` of an imported entry stay models.dev's,
  and no limit is taken from another entry (an added entry's `inherited.from` gives it none). `null` is unknown; a
  limit of 0 is "none stated", a lifetime of 0 and a listed price of 0 are values. The documented items stay in the
  records beside the safe value. The safe value is a published number made by a published rule, not a verdict a page
  writes. Vendors' own model lists are not values of an entry; they stay in evaluation notes.
- pi's values stand last. They are never written into a field of the entry (`limit`, `cost` or any other), and a safe
  value is pi's only where no other source states one: laid on by `layPi` after the fence, from the statements the
  fence reads with `piStatements`. No value a measurement, providers.dev or models.dev states differs with or without
  pi's data (`npm run compare:published`). Where pi stands beside each value
  is worked out once, in `piValues` (`src/core/pi.ts`), into `providers_dev.pi.values`, from the same reading as
  `differences`; a page prints the `standing` and compares nothing (`design/pi-merged.md`).
- The safe value, like every figure the site shows, is worked out once, when the data is built, and published in the
  API. A page never works anything out: it prints fields of the API, formatted. The site never shows anything that is
  not from the API. One exception, the only thing a page works out: it marks providers.dev evidence stale by comparing
  a published date with today's date using the published threshold, `stale_after_days` of `/api/v1/meta` (set once in
  `scripts/lib/publish.ts`); a page has no threshold of its own in its code.
- Cache mode support comes from `providers_dev.cache.documented`; retention parameter support requires a sourced
  declaration. A requested setting or cache hit alone does not confirm parameter support.
- A retention declaration is a `request_controls` item with id `cache.retention` in
  `data/authored/overrides/<provider>.yaml`: the request field (`bindings`), the values (`options`, each with its
  `profile`: short or long), the default, and the provider's own page quoted in the evidence note. Where the page
  speaks for the provider's API as a whole, use a `select` rule instead of listing model ids: it applies to every
  entry of the provider that documents the lifetimes, follows the catalog as models come and go, and does not mark
  the entries as corrected (its source stays with the control). Where the page names the models its statement holds
  for, add them as `select.models`, and check each model's page. List only values the page shows; where the short
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
  `providers.dev`, and next to `pi.dev` the import of pi's catalog (`pi.snapshot.fetched_at` of `/api/v1/meta`, which
  like the models.dev date moves only when the data changed).
- A measurement names the client it went through: the provider directly, CLIProxyAPI, or a vendor's own CLI. Every
  client has a kind (`direct`, `own-client`, `proxy`), from the measurements file or
  `data/authored/measurement-labels.yaml`, where a new client must be added with its kind; which kind feeds a safe
  value is decided once, in `countingKind` (`src/core/safe.ts`). The
  coding agent used on top of CLIProxyAPI is not named ("A coding agent, through CLIProxyAPI"). The public names
  are in `data/authored/measurement-labels.yaml`; a new client id must be added there (the build warns and publishes
  it as "other"). Runs marked `lacks` are not published: they say something about a proxy build, not a provider.
- Commit messages carry no links to agent sessions (no `Claude-Session:` line). `scripts/commit-msg` removes one;
  install it once per clone with `ln -sf ../../scripts/commit-msg .git/hooks/commit-msg`.

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
npm run structure:update # write structure/api-v1.json after a change of the API's structure made on purpose
```

The Worker reads versioned snapshot assets at runtime; no dataset is bundled into its code.
Run `npm run build` before previewing a fresh clone. Data updates can use `npm run refresh:data` afterward.
Before finishing a change: `npm run build && npm run check`, and look at the affected page in a browser.

## Copies of the repository

The site is live at `https://providers.dev`. The repository has two remotes: `upstream` (GitHub
`ngvoicu/providers.dev`) and `origin` (the owner's Forgejo server). GitHub is where work and the daily snapshot land:
the `Publish` workflow runs on GitHub only and commits the snapshot there (04:17 and 06:47 UTC; the second is a fallback). The Forgejo server follows
GitHub by itself: its workflow `Follow GitHub` (`.forgejo/workflows/follow-github.yml`) fast-forwards its `main` to
GitHub's every hour. It never forces and never merges; if the server has a commit GitHub lacks, the run fails and
changes nothing. It has followed when the two heads are equal (`git ls-remote upstream refs/heads/main` and the same
for `origin`).

- Before any work: `git pull --ff-only upstream main`.
- After it: `git push upstream main`. You no longer have to push to `origin`: the server takes the commit within
  the hour (pushing there too does no harm). If GitHub refuses the push because a snapshot landed meanwhile, pull
  again (`--ff-only` fails on parted histories: rebase your own commits, never the snapshot).
- A push to `main` on GitHub starts `Publish`: build, check and deploy to `https://providers.dev` (no import). Pushing
  `main` is deploying.
- Do not run `npm run sync` and commit its result outside the workflow unless asked: the workflow does the import.

## Logo and icons

- The mark is a "p" and a "d" sharing one bowl: the ring is a provider, the dot is the model inside it, the two stems
  are the two ways in (API key and subscription). Its only source is `src/core/brand.ts`; the header and footer draw
  it through `src/components/Mark.astro` in the text colour with the dot in `--brand`.
- `public/favicon.svg`, `favicon.ico` and `apple-touch-icon.png` are written by `npm run icons`. Run it after
  changing the mark and commit the files.
- `public/og.png` (the link preview) is a 1200 x 630 screenshot of the card that `npm run og-card` writes into
  `dist/`; the steps are at the top of `scripts/og-card.ts`. Redo it when the mark or the tagline changes.
