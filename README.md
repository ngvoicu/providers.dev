# providers.dev

<img src="public/favicon.svg" width="56" height="56" alt="The providers.dev mark: a p and a d sharing one bowl" />

A developer reference and public JSON API for AI models **as each provider and access method really exposes
them**: context window, maximum output and prompt-cache behaviour, for API keys and subscription logins alike.

The baseline is imported daily from [models.dev](https://models.dev) (MIT). On top of it this project keeps:

- **providers models.dev does not list**, mainly subscription access (Claude Code, Codex, Devin,
  Google Antigravity);
- **corrections** to single fields, each with a reason and a source;
- **evaluations** of cache lifetimes and limits from [groundtruth](https://github.com/ngvoicu/groundtruth),
  shown next to the documented values, never instead of them.

It publishes metadata only. There is no chat and no inference proxy. List prices per token are shown as models.dev
records them; a subscription entry carries the API list price of the same model, marked as inherited. Subscription
plans, their prices and their quotas are not listed.
It is not affiliated with models.dev.

## Run it

Needs Node 24 or newer.

```
npm install
npm run sync      # import models.dev and the measurements into data/ (needs the network)
npm run build     # resolve the dataset and build the site into dist/
npm run preview   # http://localhost:8787 : the site and the API, as on Cloudflare
```

`npm run dev` builds and starts Wrangler locally. All public routes require the Worker.
After editing templates, run `npm run build:site`; Wrangler serves the new assets.
`npm run check` runs ESLint, the type checks and the tests.

The repository already holds an imported snapshot, so `npm run build` works without `npm run sync`.
If there is no snapshot, the build stops and says so; it never falls back to sample data.

## How the data is put together

```
data/upstream/    the last good import of models.dev      written only by `npm run sync`
data/sources/     the measurements file (observed.json)   written only by `npm run sync`
data/authored/    our providers, overrides and rules      written by people
        │
        ▼  npm run data   (src/core/resolve.ts: deterministic, no network)
data/published/   the resolved snapshot                   not in git
        │
        ▼  npm run stage
versioned snapshot + current.json
        ▼
public API responses ──▶ HTML pages rendered on request
```

The published dataset is always `upstream + our additions + our overrides`, computed from scratch. Nothing is
edited in place, so a sync can never overwrite our work, and deleting an override brings the upstream value back.

### What an override can do

An override is a patch that is merged over one upstream entry, field by field.

| In the override | Published | 
|---|---|
| a field is not mentioned | the upstream value, which keeps following upstream |
| a value, including `false` and `0` | our value |
| an object | merged key by key |
| an array | replaces the upstream array as a whole |
| `null` | explicitly unknown: the field is left out and marked as unknown |
| `"$delete"` | removed: the field does not apply to this entry |
| `exclude: true` | the entry or provider is left out of the catalog and listed as excluded |

Example. Upstream says:

```yaml
limit: { context: 200000, output: 64000 }
capabilities: { temperature: true, cache: { explicit: { ttl: ["5m", "1h"], max_breakpoints: 4 } } }
```

With this override:

```yaml
set:
  limit: { context: 1000000 }                       # our value; limit.output still follows upstream
  capabilities:
    temperature: false                              # false is published, not dropped
    cache: { explicit: { ttl: ["30m"] } }           # the array is replaced; max_breakpoints stays
```

the published entry is:

```yaml
limit: { context: 1000000, output: 64000 }
capabilities: { temperature: false, cache: { explicit: { ttl: ["30m"], max_breakpoints: 4 } } }
```

and `providers_dev.provenance` lists the three changed paths with the upstream value, our value, the reason and the
evidence. If models.dev later changes `limit.output` to 128000, the published entry follows; if it changes
`limit.context`, ours stays and the provenance shows the new upstream value.

What the build reports (in the console, on the *Our data* page and in `/api/v1/meta`):

- **orphan-override**: the entry an override targets is gone upstream. The override is not applied and no entry is
  recreated from it.
- **redundant-override**: upstream now says what the override says. Delete the override.
- **addition-collides**: upstream added a provider with the id of one of ours.
- **orphan-observation**, **unmapped-route**: evaluations that have no entry or provider to land on.
- **unmapped-client**: an evaluation names a client that `data/authored/measurement-labels.yaml` does not describe.

## Authoring

### Correct a field

Add a rule to `data/authored/overrides/<provider id>.yaml` (the file name must be the provider id):

```yaml
provider: openrouter
rules:
  - models: [deepseek/deepseek-v4.1-flash, deepseek/deepseek-v4-pro]
    set:
      capabilities:
        cache: { implicit: true }
    reason: OpenRouter documents that prompt caching with DeepSeek is automatic.
    evidence:
      - kind: documented
        url: https://openrouter.ai/docs/guides/best-practices/prompt-caching#deepseek
        date: "2026-11-13"
        note: '"Prompt caching with DeepSeek is automated and does not require any additional configuration."'
```

`id`, `models` and `providers_dev` cannot be overridden. To remove an entry, use `exclude: true` instead of `set`.
To remove a whole provider, put `exclude: { reason, evidence }` at the top of the file.

### Add a provider or a model

Create `data/authored/providers/<id>.yaml`:

```yaml
id: devin
name: Devin
doc: https://docs.devin.ai
access: subscription          # api | subscription | unknown
access_basis: Reached with a Devin subscription. Devin serves other labs' models under its own model ids.
evidence:
  - { kind: measured, url: https://github.com/ngvoicu/groundtruth/blob/main/observed.json, date: "2026-11-12" }
models:
  - id: gpt-6-1-sol
    inherits: openai/gpt-6.1-sol      # optional: take the name, family and dates from this upstream entry
    fields:                           # optional: only values you have evidence for on THIS access
      limit: { output: 128000 }
    evidence:
      - { kind: listed, url: https://example.com/the-providers-own-model-list, date: "2026-11-13" }
```

`inherits` copies identity (name, description, family, type, dates, canonical model). Limits, cache behaviour and
capabilities are never copied from another access method: leave them out unless you have evidence for this one.
One exception: a subscription entry is not paid per token, so it takes the API list price (`cost`) of the entry it
names. It is marked: `providers_dev.inherited.fields` includes `cost`, and the summary has `price_from`. If a service does not say which model it serves, leave `inherits` out; do not guess.

Models that exist only because they were evaluated do not need to be listed by hand: an evaluation on a route that
`data/authored/routes.yaml` maps to one of our providers creates the entry.

`data/authored/measurement-labels.yaml` gives each client of the measurement file its public name (for example
"Requests sent through CLIProxyAPI") and can list words whose note parts are not published. Runs marked `lacks` in
the measurement file are skipped.

### Evidence requirements

Every rule, added provider and added model needs at least one evidence item, or the build fails:

| Field | Meaning |
|---|---|
| `kind` | `documented` (the provider says so), `measured` (we ran it), `listed` (the provider's own model list reports it) |
| `url` | the page, or the raw result |
| `date` | the day we read or ran it (`YYYY-MM-DD`) |
| `note` | optional: the sentence quoted, or what was run |

Imported values never get a verification date. Evidence older than 90 days is shown as stale.

### Access classification

`data/authored/access.yaml` decides `api`, `subscription` or `unknown` per provider: a provider named there wins,
then the first matching id pattern, then the default. Only providers named there, and the ones we add, count as
reviewed; the site marks the rest "by default" or "by name".

## Syncing

- **By hand:** `npm run sync` (add `-- --force` to download again even if nothing changed), then `npm run build`.
- **Scheduled:** `.github/workflows/publish.yml` runs daily, on every push to `main`, and from the Actions tab. It
  imports, builds, tests, commits the snapshot if the data changed, and deploys. Only one run is active at a time.

What the sync checks before it replaces the snapshot: the answer is JSON in the expected v2 structure; every
provider and model id matches its key; the import is not empty and has not lost more than 40% of its providers or
entries since the last one. It sends the stored ETag, so an unchanged upstream costs one small request.

If any check fails or models.dev is down, `data/upstream/` is left exactly as it was, the command exits with an
error, and the next build publishes the last good snapshot with a note that the last sync failed. A lock file
(`data/.sync.lock`) stops two syncs on one machine from running at once.

The sync reads the experimental v2 endpoint (`https://models.dev/experimental/v2.0/api.json`). If that endpoint
goes away, the sync fails loudly; it does not fall back to the v1 file, which has no cache details.

## API

Read-only, no key, CORS open. Full reference with every filter: `/docs/api/` on the site, and
`/api/v1/openapi.json`.

Four resources, with the same names on the website: **providers**, **entries** (a model at a provider and access
method), **models** (canonical: a model as its lab names it) and **evaluations**. Every collection answers
`{ meta, total, limit, offset, next_offset, data }`; every single object `{ meta, data }`.

| Request | Returns |
|---|---|
| `GET /api/v1/entries?…` | entry summaries: search, filters, sorting, pages of up to 200 |
| `GET /api/v1/entries/{provider}/{model}` | one entry in full (the model id is the rest of the path, slashes and all) |
| `GET /api/v1/providers` | providers |
| `GET /api/v1/providers/{id}` | one provider with the summaries of its entries; `?view=full` adds the entries in full |
| `GET /api/v1/models` | canonical models |
| `GET /api/v1/models/{lab}/{model}` | one canonical model with every entry that serves it |
| `GET /api/v1/evaluations` | every cache and limit evaluation, with the entry it was made on |
| `GET /api/v1/catalog` | the complete merged catalog, `{ meta, providers }` |
| `GET /api/v1/meta` | dataset version, counts, freshness, upstream commit, sync status, open issues |
| `GET /api/v1/openapi.json` | the OpenAPI 3.1 document |
| `GET /api.json` | the merged catalog keyed by provider id, in the models.dev v2 structure, no envelope |

```
curl 'https://providers.dev/api/v1/entries?access=subscription&min_context=400000&sort=context&order=desc'
curl https://providers.dev/api/v1/entries/openrouter/anthropic/claude-opus-5.5
curl -H 'If-None-Match: "<dataset version>"' -i https://providers.dev/api/v1/catalog     # 304 until the data changes
```

```ts
const base = "https://providers.dev/api/v1";
const page = await (await fetch(`${base}/entries?q=opus&cache=yes&limit=200`)).json();
for (const entry of page.data) console.log(entry.ref, entry.context, entry.max_output, entry.cache_ttl_s, entry.cache_results);

const { data } = await (await fetch(`${base}/entries/openrouter/anthropic/claude-opus-5.5`)).json();
console.log(data.entry.limit, data.entry.providers_dev.cache.retention, data.entry.providers_dev.cache.evaluations);
```

### One contract

`src/core/contract.ts` defines the shape of everything the API returns. The OpenAPI document and the field tables of
`/docs/api/` are generated from it, and the tests check every published object against it (all entries, all
providers, every list). Every public page consumes serialized API responses through the same HTTP handler used by
external callers. The page layer has no index, catalog or filesystem access. Filtering and aggregation belong to
the API; the website formats its response. The homepage sends searches to `/api/v1/entries` instead of downloading
the entire index. Provider and model lists use API search and pagination, including without JavaScript.

Cache evaluations are published as counts and percentages at exact ages (`cache_results` of a summary,
`providers_dev.cache` of an entry): one line per retention setting, short before long, the control ("at once") first.
`null` means not evaluated, never 0 %. The sums are made once, in `src/core/cache.ts`, when the data is built.

`providers_dev.cache.documented` publishes a support state and details for each cache mode. Its compact support
states are also in `cache_mode_support` on summaries. Pages render these states directly: an absent mode remains
unknown. Known prices, capabilities and API endpoint fields are described in OpenAPI, while additional upstream
fields are preserved.

Retention parameters require explicit evidence. Requested settings remain in evaluations, but sending a setting
or receiving a cache hit never promotes it to a supported parameter. Add a `cache_retention` declaration to an
authored model or an override rule when a source confirms the parameter, values and any restrictions. The fields
match the public retention record; evidence needs a URL, date and a note explaining the confirmation. For example
(placeholder provider and documentation):

```yaml
provider: example-provider
rules:
  - models: [example-model]
    reason: Document the confirmed retention parameter
    evidence:
      - { kind: documented, url: "https://example.com/cache", date: "2026-11-14" }
    cache_retention:
      support: supported
      parameter: { name: retention, location: Request body }
      accepted_values: [5m, 1h]
      default: 5m
      profiles:
        - { profile: short, value: 5m }
        - { profile: long, value: 1h }
      conditions: []
      evidence:
        - kind: documented
          url: https://example.com/cache
          date: "2026-11-14"
          note: The documentation confirms this request field and its allowed values.
```

Declarations apply only to their named entries and are never inherited by another access method.

`pricing` and `request_controls` are present on every summary and under `providers_dev` on every full entry. They
are normalized once in `src/core/policies.ts`, including entries nested in provider, canonical-model and catalog
responses. The website renders these objects. `price_in` and `price_out` remain base rates per million tokens;
conditional prices are in `pricing.rules`. Original source fields are preserved.

The shared contract is in `src/core/policy-contract.ts`. It covers context thresholds, cache lifetimes, service
tiers, region/date conditions, nested AND/OR/NOT conditions, rates and multipliers, and body/header/query bindings.
Unknown source shapes remain in `unparsed` or an unknown condition. Imported records have partial coverage;
absence of a rule never proves a flat price. Null rule ordering, units or applicability must not be guessed when
calculating a bill. Subscription reference rates identify their source entry and are not a subscription price.

An authored model or override rule may contain `pricing` (the complete normalized object) and `request_controls`
(an array of control declarations). Each declaration needs dated source evidence with a confirmation note.
Control declarations merge by semantic id and apply only to named entries. A `cache.retention` control is also
projected into the older cache-retention fields; use this richer declaration for new records with endpoint
conditions, structured bindings or companion headers. Do not maintain two competing cache declarations.

`src/core/policy-examples.ts` contains validated, fictional examples used by `/docs/api/` and OpenAPI. They are
documentation fixtures, never provider data. The public documentation explains coverage, null/default semantics,
exact threshold boundaries, whole-usage versus marginal rates, and rule ordering.

Measured-limit pages show numeric fields and their source links. Free-text evaluation notes remain in the API
and raw evidence, not in the main results table.

Full catalog exports are stored as gzip assets and streamed through the Worker at their existing JSON URLs.
Staging excludes uncompressed copies from upload; they remain in `data/published/site/` for validation.
This keeps the expanded catalog within static-asset limits without loading the entire export in Worker memory.

Every successful versioned API answer has an opaque representation `ETag`, `X-Dataset-Version`, `X-Dataset-Generated-At` and
`X-Upstream-Fetched-At`. Errors are always `{ "error": { "code", "message", "details"? } }`.
ETags cover response metadata as well as content. Reuse a validator only for the same URL. HTML validators
include the rendered page, so a template, stylesheet or metadata change invalidates cached pages even when the
catalog hash is unchanged.

`v1` is the version of this API. The model fields follow the models.dev **v2** schema, which is experimental
upstream; `/api/v1/meta` reports it as `upstream_schema`.

`/api.json` is a superset of the models.dev v2 export in the same shape, not a byte-compatible copy: every provider
and model has an extra `providers_dev` key, and entries we add can lack fields that models.dev requires.

## Deploying to Cloudflare

The Worker (`wrangler.jsonc`) serves the API and renders every public HTML route from API responses. Astro
compiles one shared shell with CSS and scripts, plus authored methodology/licensing documents. It does not
enumerate entries, providers or models. `/docs/api/` renders the actual `/api/v1/openapi.json` response, including
its guide, parameters, schemas and examples. Authored text is also public through `/api/v1/docs/{document}`.

1. `npx wrangler login`
2. `npm run build`
3. `npm run deploy`

For the custom domain, add the zone to Cloudflare and then, in `wrangler.jsonc`:

```jsonc
"routes": [{ "pattern": "providers.dev", "custom_domain": true }]
```

For the scheduled workflow, add the repository secrets `CLOUDFLARE_API_TOKEN` (a token that can edit Workers) and
`CLOUDFLARE_ACCOUNT_ID`. Without them the workflow builds and tests but does not deploy.

A deployment publishes the Worker and assets together. Each request reads `current.json` and pins its API calls
and data files to one immutable snapshot directory. The parsed index is cached by publication id, not bundled in
the Worker. A publication id includes all metadata, including its generated timestamp. No public request imports
upstream data. The preceding local publication is retained for requests already using it.

To refresh data after the initial template build:

```sh
npm run refresh:data  # resolve and stage into public/ and dist/; no Astro/template build
npm run deploy        # publish the prepared assets when ready
```

To rebuild templates without resolving the dataset, use `npm run build:site`. A full `npm run build` still does
both. Data refreshes update the API, page content, filter options and footer together. Existing client/HTTP caches
can retain responses for the advertised cache period (300 seconds, with stale revalidation up to 3600 seconds).
A browser filter response from a new publication triggers a page reload so its counts and footer stay consistent.
No model/provider HTML files are generated or maintained individually.

`/api/v1/facets` exposes catalog filter options and counts. `/api/v1/corrections` exposes grouped corrections and
their entry references. Evidence pages use those responses and independently paginated cache/limit evaluations.
The scheduled workflow currently runs the full build on clean CI checkouts; local data refreshes can reuse built
templates. Production still needs a publication/deployment step; editing a local source file does not update it.

## Licensing

- Code, our additions and our corrections: MIT, see [`LICENSE`](./LICENSE).
- The imported baseline: models.dev, MIT, Copyright (c) 2025 models.dev. The full text is in
  [`LICENSES/models.dev-MIT.txt`](./LICENSES/models.dev-MIT.txt) and ships with the dataset as
  `/data/LICENSE-models.dev.txt` and `/data/NOTICE.txt`.
- In the data, everything under `providers_dev`, every entry with `providers_dev.origin: "added"` and every field
  listed in a `providers_dev.provenance` array is ours; the rest is models.dev's.

providers.dev is not affiliated with or endorsed by models.dev or any provider it lists.
