# providers.dev

<img src="public/favicon.svg" width="56" height="56" alt="The providers.dev mark: a p and a d sharing one bowl" />

A developer reference and public JSON API for AI models **as each provider and access method really exposes
them**: context window, maximum output and prompt-cache behaviour, for API keys and subscription logins alike.

The baseline is imported daily from [models.dev](https://models.dev) (MIT). On top of it this project keeps:

- **providers models.dev does not list**, mainly subscription access (Claude Code, Devin,
  Google Antigravity);
- **corrections** to single fields, each with a reason and a source;
- **evaluations** of cache lifetimes and limits from [groundtruth](https://github.com/ngvoicu/groundtruth),
  shown next to the documented values, each with its source and date. A measured value takes the place of a
  documented one in two figures only, the safe cache lifetime and the input window, and only where a measurement
  clearly contradicts the documentation; the documented value stays beside it (and `limit` stays as imported).

It publishes metadata only. There is no chat and no inference proxy. List prices per token are shown as models.dev
records them; a subscription entry shows the API list price of the same model, marked as an API price. Subscription
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

To leave out a whole model family's earlier versions, or every model released in a span of dates, at every provider,
there is one catalog-wide rule instead of an `exclude` per entry: see
[Leave out earlier versions of a family](#leave-out-earlier-versions-of-a-family) and
[Leave out models by release date](#leave-out-models-by-release-date).

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
- **excluded-observation**: an evaluation names an entry that a catalog-wide rule leaves out. It is not published.
- **rule-version-unread**: an entry of a family a catalog-wide rule covers has no version the rule can read. It is
  published; correct its `canonical_id` with an override, or add the word it uses to the rule's `aliases`.
- **rule-date-unread**: an entry's `release_date` is neither a day (`YYYY-MM-DD`) nor a month (`YYYY-MM`), so the
  release rules cannot place it. It is published; correct the date with an override.

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

### Leave out earlier versions of a family

An editorial choice that holds for the whole catalog ("no Claude Opus before 5.5") is one rule in
`data/authored/catalog-rules.yaml`, not an `exclude` per entry. It applies at every provider, imported or added, after
every override, and follows each sync: an earlier version that appears at a new provider is left out without an edit.

```yaml
exclude:
  - id: claude-opus-before-5.5        # names the rule in /api/v1/meta
    family: claude-opus               # only entries whose published `family` is this
    word: opus                        # the version is read next to this word
    before: "5.5"                     # the first version kept; every one below it is left out
    aliases: [latest]                 # claude-opus-latest has no version and is kept
    leaves_out: Claude Opus versions before 5.5, at every provider
    reason: "Editorial choice of providers.dev: Claude Opus versions before 5.5 are not listed."
    date: "2026-11-16"
```

The version is read on either side of the word, in the entry's id, then its `canonical_id`, then its name
(`claude-opus-4-1`, `opus4-7`, `claude-3-opus`, `Claude Opus 4.1`); a date is not a version. A later version, and
every model of another family with the word in its name, is kept. An entry of the family with no version anywhere is
published and reported (**rule-version-unread**). An entry whose `family` models.dev leaves out, or writes otherwise,
is not looked at.

Where ids are less regular, a rule can say more (left out = the default, as for the Claude rules):

| Option | What it does |
|---|---|
| `family: [a, b]` | one rule over several families, published once with the count for all of them |
| `word: [gpt, chatgpt]` | the version can be written next to any of these words |
| `read: [id]` | where the version is read, in order; default `[id, canonical_id, name]`. `[id]` keeps an alias whose canonical id or name names a version |
| `joined_digits: true` | two digits together after the word are major and minor: `gpt-56-sol` is 5.6, `gpt-61-sol` 6.1. A version 10 or above cannot then be written that way |
| `no_version: keep` | an entry with no version where the rule reads is kept without an issue (moving aliases such as `gpt-sol-latest`, models numbered their own way such as `gpt-realtime-2`); default `report` |

The GPT rule (`gpt-before-6`) uses all five: see the comment above it in the file. A letter after the number is not
read, so `gpt-4o` is 4.

### Leave out models by release date

The second kind of rule in `data/authored/catalog-rules.yaml` leaves out every entry whose published `release_date`
falls in a span, at every provider, whatever its family or type, "latest" aliases included:

```yaml
placeholder_release_dates: ["1970-01-01"]   # stands for "not known": kept by every release rule

exclude_released:
  - id: released-2025
    from: "2025-01-01"                      # first day of the span, inclusive; left out = no lower bound
    before: "2026-01-01"                    # first day after the span, exclusive; left out = no upper bound
    leaves_out: Models released in 2025, at every provider
    reason: "Editorial choice of providers.dev: models released in 2025 are not listed."
    date: "2026-11-16"
```

The rule reads the release date the catalog publishes for the entry, after overrides, and nothing else: not the id,
not the name. A date given to the month (`2025-03`) counts as the first day of the month. An entry with no release
date, or with a placeholder date, is kept without an issue, and its date is published as it is. Release rules apply
after every family rule, to what is still in the catalog, so an entry is counted by one rule only. Each is one item
of `exclusions` in `/api/v1/meta`, like a family rule. A provider whose every entry a rule leaves out stays
published, with no entries. To add a rule, add an item under `exclude_released`; to drop one, delete its item.

A rule has no evidence: it says what providers.dev lists, not what a provider does. `/api/v1/meta` lists it once in
`exclusions` (`kind: rule`, its words, reason and date, and the number of entries it removed in this build), never
the entries one by one. An override that names an entry a rule leaves out stays valid and raises no issue; an
evaluation of such an entry is reported (**excluded-observation**). To add a rule, add an item under `exclude`.

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

That price rule is the same for every subscription entry, imported ones too: `providers_dev.pricing` is the API list
price of the same model (`billing: reference`, with `reference_ref` naming the API entry). The API entry is the one
the entry inherits from, or else the lab's own entry for its canonical model. An imported subscription entry keeps
its own `cost` field as models.dev has it. With no API entry of the same model the record is `not_applicable` and the
pages say "In plan".

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

Imported values never get a verification date. providers.dev evidence whose date is more than `stale_after_days` of
`/api/v1/meta` (90) days before today is shown as stale: a page compares a published date with today's date using
the published threshold, and that is the only thing a page works out.

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
The models of each provider are written sorted by id, so models.dev sending them in another order is not a change
in `data/upstream/`; everything else (the keys inside a model, every array) keeps the order models.dev sends.

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
| `GET /api/v1/evaluations/cache` | every cache evaluation, with the entry it was made on |
| `GET /api/v1/evaluations/limits` | every limit evaluation, with the entry it was made on |
| `GET /api/v1/catalog` | the complete merged catalog, `{ meta, data }` with `data` keyed by provider id |
| `GET /api/v1/meta` | dataset version, counts, freshness, the stale threshold (`stale_after_days`), upstream commit, sync status, open issues |
| `GET /api/v1/openapi.json` | the OpenAPI 3.1 document |
| `GET /api.json` | the merged catalog keyed by provider id, in the models.dev v2 structure, no envelope |

```
curl 'https://providers.dev/api/v1/entries?access=subscription&min_context=400000&sort=context&order=desc'
curl 'https://providers.dev/api/v1/entries?lifetime_basis=measured&sort=cache_long&order=desc'
curl https://providers.dev/api/v1/entries/openrouter/anthropic/claude-opus-5.5
curl -H 'If-None-Match: "<dataset version>"' -i https://providers.dev/api/v1/catalog     # 304 until the data changes
```

```ts
const base = "https://providers.dev/api/v1";
const page = await (await fetch(`${base}/entries?q=opus&cache=yes&limit=200`)).json();
for (const entry of page.data) console.log(entry.ref, entry.context, entry.input_window.tokens, entry.input_window.bound, entry.max_output, entry.cache_lifetime.short.safe_s, entry.cache_lifetime.lifetimes);

const { data } = await (await fetch(`${base}/entries/openrouter/anthropic/claude-opus-5.5`)).json();
console.log(data.entry.limit, data.entry.providers_dev.limits.input_window, data.entry.providers_dev.cache.retention, data.entry.providers_dev.cache.evaluations);
```

### One contract

One structure: everything providers.dev publishes of its own (a summary, a `providers_dev` record, an evaluation, a
correction, evidence, `/api/v1/meta`) has the same keys on every object of its kind. A value that is not known is
`null`, a list with nothing in it is `[]`, and no key is ever left out, whatever the query parameters. The contract
has no optional field for these objects, and a test fails when two objects of a kind differ in their keys. Only the
fields imported from models.dev (`limit`, `cost`, `capabilities` and the like) keep its shape, where a field can be
absent.

`src/core/contract.ts` defines the shape of everything the API returns. The OpenAPI document and the field tables of
`/docs/api/` are generated from it, and the tests check every published object against it (all entries, all
providers, every list). Every public page consumes serialized API responses through the same HTTP handler used by
external callers. The page layer has no index, catalog or filesystem access. Filtering and aggregation belong to
the API; the website formats its response. The homepage sends searches to `/api/v1/entries` instead of downloading
the entire index. Provider and model lists use API search and pagination, including without JavaScript.

Cache evaluations are published as counts and percentages at exact ages, the control ("at once") first: each
evaluation with its own results (`providers_dev.cache.evaluations` of an entry), and the evaluations of one client
with one retention setting added up as the `results` of a measured item of the lifetime record below, short and long
apart. A profile with no measured item has no lifetime measured, which is not 0 % (an evaluation whose control hit and
that has no timed check counts for no lifetime). The sums are made once, in
`src/core/cache.ts`, when the data is built.

Every entry has one cache lifetime record (`providers_dev.cache.lifetime`, and `cache_lifetime` of a summary):
`lifetimes`, one list of every lifetime known for the entry, documented by models.dev or providers.dev and measured
per client and retention setting, each item with its source and date; and for the `short` and the `long` profile a
safe value, `safe_s` in seconds, with its `basis`. The documented lifetime is the safe value unless an evaluation
contradicts it (at an age up to it, fewer than half of that evaluation's checks hit), and then the measured one is;
where nothing is documented, the measured one, the oldest age through which every check hit, lowest across clients.
`documented_s` and `measured_s` are published beside it, and `documented_status` says what the rule found where a
lifetime above 0 is documented and one is measured: `contradicted` or `not_contradicted` (else `null`). `0` is a value (documented as not caching, or no age at
which every check hit); `null` is not known. `cacheLifetime` in `src/core/cache.ts` works it out once, when the data
is built; the rule in full is in `design/safe-cache-lifetime.md` and in the guide of the OpenAPI document.
`/api/v1/entries` sorts by the safe values with `sort=cache_short` or `sort=cache_long` (`null` last in either order,
`0` a value), and `lifetime_basis=documented` or `measured` keeps the entries whose short or long safe value has that
basis.

Every entry has one input window record (`providers_dev.limits.input_window`, and `input_window` of a summary):
`tokens`, the most input a request can carry on the entry, in tokens as the provider counts them, the client's own
prompt included, with its `basis`, `bound` and `scope`. The documented input (`limit.input` above 0, else
`limit.context` above 0 that is not a measured value) is the value unless a limit evaluation of the entry clearly
contradicts it (a window named below it, or other than a documented window; an input refused at or below 99 % of it;
one accepted, below a refusal or read to the end, at or above 101 % of it), and then the measured one is; where
nothing is documented, the measured one: the window the route names (`bound: "limit"`), else the largest input seen
accepted (`bound: "at_least"`), lowest across clients. `null` is not known, and there is no `0`: a window of 0 is
"none stated". `documented_tokens` and `measured_tokens` are published beside it, with `documented_status` where
both exist, and every counted evaluation is an item of `measurements`. `inputWindow` in `src/core/limits.ts` works it
out once, when the data is built; the rule in full is in `design/usable-input-window.md` and in the guide of the
OpenAPI document. `limit` stays as imported, and `context`, `input`, `max_output` and the `measured_*` keys of a
summary keep their meaning. A limits row of the measurements file may carry `date` and `input_read` (the largest input
the reply showed was read to the end); a file with two rows for one route, client and model, or a row whose numbers
contradict each other, is refused when read and the last good copy stays.

The safe value, like every figure the site shows, is worked out once, when the data is built, and published in the
API. A page never works anything out: it prints fields of the API, formatted. The site never shows anything that is
not from the API.

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

The richer form of the same declaration is a `request_controls` item with id `cache.retention`: the request field
as a binding, each value as an option with its profile (short or long), and the default. That is the form the
declarations in `data/authored/overrides/` use; the flat retention record is made from it.

A rule that names its entries (`models`) applies to those entries and counts as evidence about them. Where the
provider's page speaks for its API as a whole, a rule selects its entries instead:

```yaml
provider: anthropic
rules:
  - select: { cache_mode: explicit, cache_ttl: ["5m", "1h"] }   # every entry here that documents both lifetimes
    reason: Anthropic's API reference names the field that sets the lifetime of a cache breakpoint.
    evidence: &source
      - kind: documented
        url: https://platform.claude.com/docs/en/api/messages/create
        date: "2026-11-14"
        note: >-
          cache_control: 'ttl: optional "5m" or "1h". [...] Defaults to 5m.'
    request_controls:
      - id: cache.retention
        support: supported
        when: null
        bindings: [{ location: body, path: /cache_control/ttl, scope: content_block }]
        options:
          - { value: "5m", attributes: { retention_s: 300, profile: short }, settings: null, when: null }
          - { value: "1h", attributes: { retention_s: 3600, profile: long }, settings: null, when: null }
        default: { value: "5m" }
        conditions: []
        evidence: *source
```

A `select` rule follows the catalog as models come and go, declares request controls only, and does not mark the
entries as corrected: its source stays with the control. List only the values the provider's page shows. Where the
short lifetime is what a request gets by leaving the field out, the option has `value: null`. A selection that
matches no entry is reported as an issue. Where the provider's page names the models its statement holds for,
`select.models` narrows the selection to them. No declaration is copied to another provider or access method: a
reseller needs its own page.

`pricing` and `request_controls` are present on every summary and under `providers_dev` on every full entry. They
are normalized once in `src/core/policies.ts`, including entries nested in provider, canonical-model and catalog
responses. The website renders these objects. `price_in` and `price_out` remain base rates per million tokens;
conditional prices are in `pricing.rules`. Original source fields are preserved.

The shared contract is in `src/core/policy-contract.ts`. It covers context thresholds, cache lifetimes, service
tiers, region/date conditions, nested AND/OR/NOT conditions, rates and multipliers, and body/header/query bindings.
Unknown source shapes remain in `unparsed` or an unknown condition. Imported records have partial coverage;
absence of a rule never proves a flat price. Subscription reference rates identify their source entry and are not a
subscription price.

Imported pricing follows the models.dev v2 schema. The rules are published in the order models.dev applies them
(`rule_order: listed`: base prices, its overrides in order, then every matching multiplier), each for the whole
request that matches its condition (`applies_to: all_usage`), and a factor scales every price under it. Two fields
are worked out from the rules, once, in `derivePricing`: `period` names a rule that depends on the hour or the day
(`peak` where it raises the base rate in its window, `off_peak` where it lowers it), and `resulting_rates` gives the
prices a multiplier makes of the base rates. A page multiplies nothing; it says a condition in words with
`src/core/conditions.ts`.

Every kind of content is a set of charges of the same shape: `text.input`, `audio.input`, `image.output`,
`video.output` and so on, plus `web_search`. Each rule carries its unit as models.dev defines it: per 1,000,000 for
a token or a character, per 1 for a second, a minute, an image or a megapixel, and per 1,000 web searches.
`price_in` and `price_out` are the text prices per million tokens only.

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

Full catalog exports and the index of summaries are stored as gzip assets and served by the Worker at their
existing JSON URLs. Staging excludes uncompressed copies from upload; they remain in `data/published/site/` for
validation. This keeps them within static-asset limits (25 MiB per file) as the catalog grows; an export is
streamed without being loaded in Worker memory, and the index is parsed once per publication.

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
compiles one shared shell with CSS and scripts, plus authored methodology, licensing and contributing documents. It does not
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

## Contributing

Anyone can propose a correction, a missing provider or model, a measurement or a request for one, with its evidence.
providers.dev takes no payment for listing, correcting or measuring an entry. How it works, and what each kind of
contribution needs: [providers.dev/docs/contributing](https://providers.dev/docs/contributing/) (the same text is
`src/pages/reference-content/docs/contributing.astro`); the essentials are in [`CONTRIBUTING.md`](./CONTRIBUTING.md).
A pull request writes the change as in [Authoring](#authoring); `.github/workflows/check.yml` builds and checks it.

## Licensing

- Code, our additions and our corrections: MIT, see [`LICENSE`](./LICENSE).
- The imported baseline: models.dev, MIT, Copyright (c) 2025 models.dev. The full text is in
  [`LICENSES/models.dev-MIT.txt`](./LICENSES/models.dev-MIT.txt) and ships with the dataset as
  `/data/LICENSE-models.dev.txt` and `/data/NOTICE.txt`.
- In the data, everything under `providers_dev`, every entry with `providers_dev.origin: "added"` and every field
  listed in a `providers_dev.provenance` array is ours; the rest is models.dev's.

providers.dev is not affiliated with or endorsed by models.dev or any provider it lists.
