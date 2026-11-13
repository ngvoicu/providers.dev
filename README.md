# providers.dev

<img src="public/favicon.svg" width="56" height="56" alt="The providers.dev mark: a p and a d sharing one bowl" />

A developer reference and public JSON API for AI models **as each provider and access method really exposes
them**: context window, maximum output and prompt-cache behaviour, for API keys and subscription logins alike.

The baseline is imported daily from [models.dev](https://models.dev) (MIT). On top of it this project keeps:

- **providers models.dev does not list**, mainly subscription access (Claude Code subscription, Codex subscription,
  Devin, Google Antigravity);
- **corrections** to single fields, each with a reason and a source;
- **evaluations** of cache lifetimes and limits from [groundtruth](https://github.com/ngvoicu/groundtruth),
  shown next to the documented values, never instead of them.

It publishes metadata only. There is no chat and no inference proxy. List prices per token are shown as models.dev
records them; subscription plans, their prices and their quotas are not listed.
It is not affiliated with models.dev.

## Run it

Needs Node 24 or newer.

```
npm install
npm run sync      # import models.dev and the measurements into data/ (needs the network)
npm run build     # resolve the dataset and build the site into dist/
npm run preview   # http://localhost:8787 : the site and the API, as on Cloudflare
```

`npm run dev` starts Astro's dev server for working on pages (the `/api/v1/*` endpoints need `npm run preview`).
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
        ├─▶ the website (built from it)
        └─▶ the API and /api.json (served from it)
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

`inherits` copies identity only (name, description, family, type, dates, canonical model). Limits, cache behaviour,
prices and capabilities are never copied from another access method: leave them out unless you have evidence for
this one. If a service does not say which model it serves, leave `inherits` out; do not guess.

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

| Request | Returns |
|---|---|
| `GET /api/v1/models?…` | entry summaries: search, filters, sorting, pages of up to 200 |
| `GET /api/v1/entry?ref=provider/model` | one entry in full (model ids contain slashes, so the name is a query parameter) |
| `GET /api/v1/providers` | the provider directory |
| `GET /api/v1/providers/{id}` | one provider with all its models |
| `GET /api/v1/catalog` | the complete merged catalog, `{ meta, providers }` |
| `GET /api/v1/meta` | dataset version, freshness, upstream commit, sync status, open issues |
| `GET /api/v1/openapi.json` | the OpenAPI 3.1 document |
| `GET /api.json` | the merged catalog keyed by provider id, in the models.dev v2 structure, no envelope |

```
curl 'https://providers.dev/api/v1/models?access=subscription&min_context=400000&sort=context&order=desc'
curl 'https://providers.dev/api/v1/entry?ref=openrouter%2Fanthropic%2Fclaude-opus-5.5'
curl -H 'If-None-Match: "<dataset version>"' -i https://providers.dev/api/v1/catalog     # 304 until the data changes
```

```ts
const base = "https://providers.dev/api/v1";
const page = await (await fetch(`${base}/models?q=opus&cache=yes&limit=200`)).json();
for (const entry of page.data) console.log(entry.ref, entry.context, entry.max_output, entry.cache_ttl_s);

const ref = "openrouter/anthropic/claude-opus-5.5";
const { data } = await (await fetch(`${base}/entry?ref=${encodeURIComponent(ref)}`)).json();
console.log(data.model.limit, data.model.providers_dev.cache?.observed);
```

Every answer has an `ETag` (the dataset version), `X-Dataset-Version`, `X-Dataset-Generated-At` and
`X-Upstream-Fetched-At`. Errors are always `{ "error": { "code", "message", "details"? } }`.

`v1` is the version of this API. The model fields follow the models.dev **v2** schema, which is experimental
upstream; `/api/v1/meta` reports it as `upstream_schema`.

`/api.json` is a superset of the models.dev v2 export in the same shape, not a byte-compatible copy: every provider
and model has an extra `providers_dev` key, and entries we add can lack fields that models.dev requires.

## Deploying to Cloudflare

The site is static files plus one small Worker for `/api/v1/*` (`wrangler.jsonc`).

1. `npx wrangler login`
2. `npm run build`
3. `npm run deploy`

For the custom domain, add the zone to Cloudflare and then, in `wrangler.jsonc`:

```jsonc
"routes": [{ "pattern": "providers.dev", "custom_domain": true }]
```

For the scheduled workflow, add the repository secrets `CLOUDFLARE_API_TOKEN` (a token that can edit Workers) and
`CLOUDFLARE_ACCOUNT_ID`. Without them the workflow builds and tests but does not deploy.

A deployment replaces the whole site at once, and a failed build deploys nothing, so visitors always see one
complete snapshot. Pages, `/api.json` and `/data/*` are static assets; only `/api/v1/*` uses Worker requests.

## Licensing

- Code, our additions and our corrections: MIT, see [`LICENSE`](./LICENSE).
- The imported baseline: models.dev, MIT, Copyright (c) 2025 models.dev. The full text is in
  [`LICENSES/models.dev-MIT.txt`](./LICENSES/models.dev-MIT.txt) and ships with the dataset as
  `/data/LICENSE-models.dev.txt` and `/data/NOTICE.txt`.
- In the data, everything under `providers_dev`, every entry with `providers_dev.origin: "added"` and every field
  listed in a `providers_dev.provenance` array is ours; the rest is models.dev's.

providers.dev is not affiliated with or endorsed by models.dev or any provider it lists.
