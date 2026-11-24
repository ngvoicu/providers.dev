# providers.dev

<img src="public/favicon.svg" width="56" height="56" alt="The providers.dev mark: a p and a d sharing one bowl" />

A developer reference and public JSON API for AI models **as each provider and access method really exposes
them**: context window, maximum output and prompt-cache behaviour, for API keys and subscription logins alike.

The baseline is imported daily from [models.dev](https://models.dev) (MIT). On top of it this project keeps:

- **providers models.dev does not list**, mainly subscription access (Claude Code, Devin,
  Google Antigravity);
- **corrections** to single fields, each with a reason and a source;
- **evaluations** of cache lifetimes and limits from [groundtruth](https://github.com/ngvoicu/groundtruth),
  shown next to the documented values, each with its source and date.

For five quantities (the input window, the maximum output, the short and the long cache lifetime, and the price) the
API publishes one **safe value** (`providers_dev.safe`) and what every source states beside it. The order of the
sources: what providers.dev measured (the most direct measurement that exists), providers.dev's own corrections and
entries, models.dev, pi's catalog; the first that states a value gives it, and where two sources contradict each
other the website shows a warning. A measurement never changes `limit`, `cost` or `capabilities`: those stay as
imported and corrected.

Beside it, a second catalog is imported with the same daily run: the model catalog of the coding agent pi
([pi.dev/models](https://pi.dev/models), MIT, from `https://pi.dev/api/models`). What pi states for an entry (how pi
calls the model, its limits and prices, and where they differ from the published values) is published on that entry
under `providers_dev.pi`, and never merged into its fields: models.dev stays the reference. pi is also the last
source of the safe values: its figure is the safe value only where no other source states one. A model only pi lists
is not an entry.

It publishes metadata only. There is no chat and no inference proxy. List prices per token are shown as models.dev
records them; a subscription entry shows the API list price of the same model, marked as an API price. Subscription
plans, their prices and their quotas are not listed; the one exception is the plan names a vendor's own model list
attaches to a model, which a listing (`/api/v1/listings`) carries as they are.
A vendor's own model list is published as the provider's listing, never written into an entry's `limit` or into a
safe value.
It is not affiliated with models.dev or pi.

## Run it

Needs Node 24 or newer.

```
npm install
npm run sync      # import models.dev, pi's catalog and the measurements into data/ (needs the network)
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
data/sources/     observed.json and listed.json (groundtruth) written only by `npm run sync`
data/pi/          the last good import of pi's catalog    written only by `npm run sync`
data/authored/    our providers, overrides, rules, listings  written by people
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
- **client-kind-differs**: the measurements file gives a client another kind than `data/authored/measurement-labels.yaml`
  does. The measurements file's kind is published and decides which measurement counts; correct the labels file.
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
"Requests sent through Provimux") and its `kind`, required: `direct` (plain requests sent straight to the
provider), `own-client` (the vendor's own client) or `proxy` (requests through a proxy, plain or made by a coding
agent). The kind decides which measurement gives a safe value: on an API-key entry `direct` only; on a login
`own-client`, else `direct`, else `proxy` (`countingKind` in `src/core/safe.ts`). Where the measurements file states a
client's kind (in `client_kinds`, or as `kind` of the client's object in `clients`), that kind counts and the labels
file's is the fallback; the build warns where the two differ. A new client must be added here with its kind. The
file can also list words whose note parts are not published. Runs marked `lacks` in the measurement file are skipped.

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

### Pair pi's spelling with the catalog's

A pi model reaches the entry with its own provider id and model id. Where pi spells a provider or a model otherwise,
`data/authored/pi-aliases.yaml` pairs the two, and says nothing else:

```yaml
providers:
  fireworks:                       # pi's provider id
    same_as: fireworks-ai          # the provider of the catalog it is
    reason: Both catalogs give the same base URL for the provider.
    evidence:
      - { kind: listed, url: https://pi.dev/api/models, date: "2026-11-20", note: '...' }
  openrouter:                      # a pi provider id the catalog has itself: no same_as, only models
    checked: "2026-11-21"          # the day the model lines were checked against the report
    models:
      "vendor/model-v2": { same_as: "vendor/model-2" }   # pi's model id: the entry's model id
```

A provider line with `same_as` needs a `reason` and `evidence`, and is written only where the two ids name the same
service: the same base URL in both catalogs, or the provider's own documentation or models.dev's own record showing
pi's address. Equal model ids alone are not enough. A model line is written only where the two ids name the same model
at the same provider, the same deployment and price class; a `:batch` or `-batch` id is not the id without it. Equal
ids always win over a line, and where two pi models reach one entry, the one with the entry's own ids keeps it.
Nothing is matched by similarity. The file is checked like every authored file: a key it does not know, or a
`same_as` without its evidence, fails `npm run data`.

Matching is done before the catalog rules and the overrides leave entries out. `npm run data` writes
`data/published/pi-report.json` (beside the published data, never served): each pi model is matched, left out (its
entry is left out, by which rule) or unmatched (with the reason, and `alike` and `same_host` as hints for this file).
A line that no longer fits is reported in `/api/v1/meta`: `pi-alias-orphan` (it names a provider, entry or pi model
that is gone), `pi-provider-collides` (the catalog now has the pi provider id itself), `pi-alias-conflict`,
`pi-alias-redundant` (the entry now has the pi model's own id). None of them fails the build.

### State what a provider's model list holds

A listing (`/api/v1/listings`, since API 1.5.0) is the model list of one provider and access method: every model it
offers, evaluated or not. It is built in `src/core/listings.ts` from four sources, in this order: `listed` (the
vendor's own list, from groundtruth's discovery file `listed.json`), `providers.dev` (this folder), `models.dev` (the
provider's imported models, those a catalog rule leaves out of the catalog included: a rule says what providers.dev
lists as entries, not what a provider offers) and `pi.dev`. Since API 1.6.0 its models are every model any of the four
lists for the provider, each once: a login reads only what its own subscription offers, so no list is taken as the
whole. Each model names the lists that have it (`listed_by`), and the listing gives each source's list with its date
and size (`lists`); `basis` is the highest-ranked source with a list. A model an override leaves out with evidence is
in no listing of its provider, whichever list names it. Each field of a model is from the first source
that states it, and the model names that source per field. Nothing of a listing is written into an entry.

`data/authored/listings/<provider>.yaml` holds what providers.dev states, each statement with a reason and evidence:

```yaml
provider: devin
list:                     # optional: the provider's models, where no discovery lists them
  models: [swe-1-6, gemini-4-neon]
  reason: The vendor's model page lists these two.
  evidence:
    - { kind: documented, url: https://example.com/models, date: "2026-11-22" }
rules:                    # optional: fields of models, by id or for every model of the listing (all)
  - models: [gemini-4-neon]
    set: { max_output: 65536, reasoning: { budget_max: 32768 } }
    reason: The vendor's documentation states the output limit and the largest thinking budget.
    evidence:
      - { kind: documented, url: https://example.com/limits, date: "2026-11-22" }
```

`set` takes the fields of a listed model: `name`, `owner`, `released`, `context_window`, `max_input`, `max_output`,
`input_modalities`, `output_modalities`, `reasoning` (`supported`, `levels`, `budget_min`, `budget_max`,
`can_disable`, `dynamic`, `disable_with`), `web_search`, `aliases`, `variants`, `plans` (plan names only) and
`hidden`. A rule comes after the discovery and before models.dev; of two rules, the first that states a field gives it.
A statement without evidence, or a key the file does not know, fails `npm run data`. A rule for a model the listing
does not name raises `listing-rule-orphan`, and a file for a provider the catalog lacks `listing-provider-unknown`.
A model an override in `data/authored/overrides/` leaves out with evidence is left out of its provider's listing
whatever list names it (this folder's, models.dev's, pi's or the vendor's own); where the vendor's own list names it,
`listing-excluded-listed` asks for the override to be checked again.
No value is copied from router-for-me's model files: each comes from the vendor's list or documentation, models.dev,
pi or a measurement, and says which.

## Syncing

- **By hand:** `npm run sync` (add `-- --force` to download again even if nothing changed), then `npm run build`.
  `npm run sync -- --only=pi` imports pi's catalog alone and leaves models.dev and the measurements as they are.
- **Scheduled:** `.github/workflows/publish.yml` ("Publish", on) runs daily at 04:17 and 06:47 UTC, on every push to
  `main`, and from the Actions tab, on GitHub only. The second time is a fallback: GitHub can delay or drop a
  scheduled run, and neither scheduled run had fired by 2026-11-18. A run whose import finds nothing new commits
  nothing. It imports, builds, tests, commits the snapshot if the data changed, and
  deploys to `https://providers.dev`. A push to `main` builds, tests and deploys what is in the repository, without an
  import. Only one run is active at a time. The daily snapshot is committed on GitHub, so a clone pulls from GitHub
  before any work.
- **The copy on the owner's Forgejo server:** it follows GitHub by itself. `.forgejo/workflows/follow-github.yml`
  ("Follow GitHub") runs there every hour, at minute 03 (UTC), and by hand. It fetches `main` from GitHub and
  brings the server's `main` to it: a fast-forward when it can be one; when GitHub's `main` is not a descendant of the
  server's (the server got a commit GitHub lacks), the run first keeps the server's `main` as
  `refs/nas-backup/main-<UTC time>`, then sets it to GitHub's, in one atomic push, so no commit is lost there. It
  never merges and only reads GitHub. GitHub reads only `.github/workflows/`, so it never runs this file; Forgejo reads
  only `.forgejo/workflows/` once that folder exists, so the server runs neither `Publish` nor `Check`. Work is pushed
  to GitHub only; nobody has to push it to the server (doing so does no harm). The copy has followed when the two heads are equal
  (`git ls-remote` on both remotes, `refs/heads/main`).

`npm run sync` imports four sources, one after the other, each on its own: models.dev into `data/upstream/`, the
measurements file into `data/sources/`, groundtruth's discovery file into `data/sources/`, and
[pi's model catalog](https://pi.dev/api/models) (MIT) into `data/pi/`. models.dev is the reference; pi's catalog is a
second, extra source beside it. A failure of one source never touches another source's snapshot.

The discovery file (`LISTED_URL` in `scripts/lib/sync.ts`) is groundtruth's `listed.json`, at the root of its
repository beside `observed.json`: what each login's vendor listed, read daily through the owner's Provimux, for the
listings (`/api/v1/listings`). Its structure is `ListedFile` in `src/core/schema.ts` (schema 1; strict, so that no
account, email, token or file name can get in). Only what the site reads of it is stored, as `data/sources/listed.json` with
`listed.meta.json` beside it (`storedListed` in `src/core/listings.ts`): per provider its date and client, per model
its id and the kept values; every other field is left out, so the committed copy holds no text of the file. The
digest and the ETag are the fetched file's, and an ETag is sent. A missing file (404) is "no discovery yet": nothing changes, a copy
held before included, and `data/sync-status.json` records `listed: { status: "absent" }`. A file that is not JSON,
does not fit the structure, or answers another error keeps the last good copy: the part is recorded as `failed` with
the reason, the `Publish` run warns, and the build lists a `listed-sync-failed` warning in `/api/v1/meta`. Like pi's
part, it never changes `last_attempt_ok`.

What the file may hold, for whoever writes it (groundtruth's G1): per provider id of the catalog, `date`, `client`
and `models`; per model `id` and the fields the vendor's list stated, and nothing else. **A field the vendor did not
state is left out, never written as `null`**: `null` is refused, and with it the whole file. A key the structure does
not know refuses the file too.

Only values that cannot carry text are taken from it (`takeListed` in `src/core/listings.ts`): the model id, which must
match a strict model-id pattern (lower-case, at most 64 characters, no file name, nothing shaped like a credential) or
the file is refused; the numbers (`context_window`, `max_input`, `max_output`, the budgets); the booleans
(`reasoning.supported`, `can_disable`, `dynamic`, `web_search`, `hidden`); reasoning levels, modalities and plan names
from fixed lists in the code (`LISTED_LEVELS`, `LISTED_MODALITIES`, `LISTED_PLANS`: `free`, `go`, `plus`, `pro`,
`team`, `business`, `enterprise`, `edu`, `education`, `max`), anything else in those lists dropped from the row, not
refusing the file. `name`, `owner`, `released`, `aliases`, `variants`, `description`, `reasoning.disable_with` and the
file's `repository` are accepted and never read: a listed model's name comes from its entry or models.dev, else it is
its id, and the evidence link of a listed listing is the constant `LISTED_PAGE`.

A refused file is recorded with a fixed reason (`listed.json: refused by its schema`, `listed.json: not JSON`,
`listed.json: answered HTTP 500`, `listed.json: lists no model`, ...), never the parser's text: no key and no value of
the file reaches `data/sync-status.json` or `/api/v1/meta`. A file with no provider or no model is refused, on a first
sync too; one that lost more than 40 % of the providers or of the models of the last good copy is refused. A stored
copy that does not read never blocks a valid replacement: it counts as no copy.

What the sync checks before it replaces the snapshot: the answer is JSON in the expected v2 structure; every
provider and model id matches its key; the import is not empty and has not lost more than 40% of its providers or
entries since the last one. It sends the stored ETag, so an unchanged upstream costs one small request; an ETag
stored for another address is not sent, so the first import after a change of address is a full one.
The models of each provider are written sorted by id, so models.dev sending them in another order is not a change
in `data/upstream/`; everything else (the keys inside a model, every array) keeps the order models.dev sends.

If any check fails or models.dev is down, `data/upstream/` is left exactly as it was, the command exits with an
error, and the next build publishes the last good snapshot with a note that the last sync failed. A lock file
(`data/.sync.lock`) stops two syncs on one machine from running at once.

pi's catalog (`PI_URL` in `src/core/schema.ts`; pi's part of the sync is `scripts/lib/pi-sync.ts`) is checked the
same way: JSON in the expected structure (`PiFeed` in `src/core/pi.ts`), every provider key a valid provider id,
every model's `id` its key and its `provider` its provider key, no model id the build cannot hold (`__proto__`), at
least 10 providers and 300 models, and no more than 40% of either lost since the last import. The request and the
whole body must be done within 60 seconds, and the body is read from its stream and refused as soon as it passes
16 MB (the feed is about 1 MB), without reading the rest. It sends the stored ETag too, and an equal body counts as
unchanged. The new snapshot is swapped in as the very last step of the import, so a feed that fails a check never
replaces it. `data/pi/` holds `meta.json` (the
address, the times, the ETag, `Last-Modified` and pi's catalog revision as sent, the digest of the body and the
counts) and one file per provider key, its models sorted by id, each model exactly as the feed gives it.

The two kinds of failure are told apart:

- **Only the pi import fails** (pi down, not JSON, another structure, a key and an id that disagree, too small, 40%
  lost, too slow, too large, or any fault in pi's own code): `data/pi/` is left as it was, `meta.json` included, or,
  where pi's code failed after it had stored a good snapshot, as a healthy run leaves it; it is always a snapshot the
  build can use. models.dev and the measurements are imported as usual; the command prints why and exits 0. `data/sync-status.json` records it under its own `pi` key
  (`status: "failed"` and the error) and keeps `last_attempt_ok: true` with no `last_error`. The `Publish` run stays
  green, with a warning on the run, and builds and deploys with the last good pi snapshot.
- **models.dev or the measurements fail**: as described above, whatever pi did. `data/upstream/` stays as it was,
  `last_attempt_ok` is `false`, the command exits with an error and the `Publish` run is marked failed. A good pi
  import in the same run is still kept.

`last_attempt_at`, `last_attempt_ok` and `last_error` in `data/sync-status.json` speak of models.dev and the
measurements only; the `pi` key has its own time, status and error. The file is written twice in a run: once before
the pi part, with the five fields of models.dev and the measurements and a `pi` record that says
`The pi part did not finish.`, and once after it, with the pi part's outcome. So models.dev's result never waits on
pi, and a run that dies inside the pi part leaves a record of an attempt that did not finish, never the previous
attempt's success. `--only=pi` keeps the five fields as they were (a file that does not parse counts as having none),
writes the `pi` key, exits with an error if the pi import failed, and exists so that a pi snapshot can be taken
without moving `data/upstream/`.

pi's part runs behind a fence (`scripts/lib/pi-fence.ts`, design section k): in the sync and in the build, pi's
code is called in one guarded place each, and what it returns is taken only as plain data that fits the contract.
The dataset is complete without pi before any of pi's code runs; then what pi states of the safe values is read from
the checked blocks by the reference's own code (`piStatements`), through the same guard, and laid over the entries
(`layPi`). No value that a measurement, providers.dev or models.dev states is different with or without pi's data:
`npm run compare:published -- <without> <with>` checks it, taking pi's items off with `withoutPi`.
Nothing on pi's side can stop the models.dev import, the build or the deploy, within three limits: a pi part that
is well-formed, agrees with itself and is wrong is published as pi's part (it shows in `pi.counts` of
`/api/v1/meta` and in the line the build prints, and where it gives no entry a pi block at all, the build says so
with a warning), and can then publish a wrong number as a safe value where no other source states one, marked
`pi.dev` in the API, or a wrong warning wherever pi is listed; a computation that never ends is bounded only by the import's
deadline and size cap; and a broken commit of pi's code is caught by the push that brings it, whose run fails. Two
warnings say when pi's side went wrong:

- **The pi import failed** (the `Import` step's output `pi=failed`): the run stays green with the warning
  "The pi import failed", and the site is built with the last good pi snapshot.
- **pi data missing from the build** (the build step's output `pi=turned_away` or `pi=published_without_blocks`):
  - `turned_away`: the stored pi snapshot cannot be used, what pi's code gave does not fit the contract or does not
    agree with itself, or the `pi` record of `data/sync-status.json` does not fit. The dataset is built and deployed
    without that part, and `/api/v1/meta` lists the reason under `issues` (`pi-snapshot-unreadable`, one per part
    left out).
  - `published_without_blocks`: pi's data is usable and fits, and no entry has a pi block. When a usable pi
    snapshot gives no block at all, the build says so: `/api/v1/meta` lists a `pi-no-blocks` warning with the
    snapshot's number of models and how many were left out and unmatched, and the build prints it. The data is
    published as pi's code gave it: nothing is turned away or repaired.

  Either way the run carries the warning "pi data missing from the build", and the safe values only pi states are
  published as unknown. Without a folder `data/pi/` at all, the
  dataset simply has no pi data, with no warning about the data; a record of the last pi import in
  `data/sync-status.json` that cannot be used still gives its own warning, folder or not.

On GitHub the import step writes its outcome per source (`upstream`, `measurements`, `pi`) and `pi_revision7`, the
first seven characters of the stored pi snapshot's revision, to the step's outputs; the build step writes `pi`
(`published`, `published_without_blocks`, `none` or `turned_away`). The warning steps read them, and a snapshot
commit names what changed (`sync: models.dev <commit>`, `sync: pi <revision>`, both, or `sync: measurements`)
without reading any file of pi's.

The import is not made tolerant of a change in models.dev's structure: that is the owner's decision. When models.dev
changes the type of a field the site reads, the import fails on purpose: the site goes on serving the last good
snapshot, `/api/v1/meta` says the last sync failed, and the `Publish` run is marked failed on GitHub. Someone then
adapts the site to the new type, as was done on 2026-11-17 for `capabilities.tools.updates` (commit `1e5d380`).

The sync reads the experimental v2 endpoint, asking for one provider that models.dev leaves out by default
(`https://models.dev/experimental/v2.0/api.json?include=openai-codex`; the address is `UPSTREAM_URL` in
`scripts/lib/sync.ts`, and `upstream.source` of `/api/v1/meta` shows it). If that endpoint goes away, the sync fails
loudly; it does not fall back to the v1 file, which has no cache details.

Why `include=openai-codex`: since models.dev commit `f648ddb` (2026-11-17, "require explicit inclusion of
openai-codex"), its README says "`openai-codex` is hidden unless explicitly included", because "Its backend needs
client-managed ChatGPT OAuth. Clients must opt in only when they support that setup." providers.dev lists the
provider as what it is, a subscription login (`data/authored/access.yaml`), so it opts in. If models.dev withdraws
the provider altogether, the import drops it, its entries leave the site, and `/api/v1/meta` lists the warning
`unmapped-route` for `codex-subscription` (its measurements have no provider to land on).

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
| `GET /api/v1/listings` | listings: every model a provider offers, evaluated or not; `?view=full` adds the models, at most 40 listings a page (since 1.5.1), `?provider=` and `?basis=` filter (since 1.5.0) |
| `GET /api/v1/listings/{provider}` | one listing with its models (since 1.5.0) |
| `GET /api/v1/catalog` | the complete merged catalog, `{ meta, data }` with `data` keyed by provider id |
| `GET /api/v1/meta` | dataset version, counts, freshness, the stale threshold (`stale_after_days`), upstream commit, sync status, pi's catalog (`pi`), the listings and the discovery file (`listings`), open issues |
| `GET /api/v1/openapi.json` | the OpenAPI 3.1 document |
| `GET /api.json` | the merged catalog keyed by provider id, in the models.dev v2 structure, no envelope |

```
curl 'https://providers.dev/api/v1/entries?access=subscription&min_input_window=400000&sort=input_window&order=desc'
curl 'https://providers.dev/api/v1/entries?disagree=true&provider=openrouter'
curl 'https://providers.dev/api/v1/entries?lifetime_basis=measured&sort=cache_long&order=desc'
curl https://providers.dev/api/v1/entries/openrouter/anthropic/claude-opus-5.5
curl -H 'If-None-Match: "<dataset version>"' -i https://providers.dev/api/v1/catalog     # 304 until the data changes
```

```ts
const base = "https://providers.dev/api/v1";
const page = await (await fetch(`${base}/entries?q=opus&cache=yes&limit=200`)).json();
for (const entry of page.data) console.log(entry.ref, entry.safe.input_window.value, entry.safe.input_window.at_least, entry.safe.max_output.value, entry.safe.cache_short.value, entry.safe.differing);

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

The structure of `/api/v1` is locked: it only grows. `structure/api-v1.json` records it, as read from the OpenAPI
document the code generates: the paths and methods; each parameter (where it is, whether it is required, its type,
its allowed values); each response and its schema; each component schema (its properties, their types, which are
required, which may be null, enum values, array items). Descriptions, examples and the guide are not part of it.
`tests/api-structure.test.ts` fails when the structure of the API is not exactly the record. After a change of
structure made on purpose, run `npm run structure:update` and commit the record with the change. The record may only
grow from `structure/api-v1-1.0.0.json`, the structure of 1.0.0, which is never edited: a new path, optional
parameter, allowed value, property, component or enum value passes; a path, parameter, property, component or value
removed or renamed, a changed type, a property that may become absent or null, or a new required parameter fails,
and belongs in `/api/v2`. Once the record has grown beyond 1.0.0, the version (`info.version` in
`src/core/openapi.ts`) must be above it: a release that adds something takes a minor step. The version restarted at
1.0.0 with the first public release; the numbers before it were never public. 1.1.0 (2026-11-17) added the input window
range of a model: `input_window_min`, `input_window_max`, `input_window_unknown_count` and `input_window_reference`,
and the component `ModelInputWindowEnd`. 1.2.0 added pi's catalog: `providers_dev.pi` on every entry (the
block, or `null` where pi does not list it), `pi` on every entry summary, `pi` in `/api/v1/meta` with the keys `pi` and
`pi_notice` of its `license`, and the components `PiBlock`, `PiCost`, `PiCostTier`, `PiDifference` and `PiSummary`.
1.3.0 added `values` to the pi block, and the component `PiValue`: for each of the nine values pi's catalog can
state of an entry (its two limits, four prices, tiers and two cache lifetimes), pi's value and its standing beside
the entry's own (`agrees`, `differs`, `only`, `not_compared`, `silent`). A value only pi states is there and in no
field of the entry. With it, `differences` lists no price and no tiers on a subscription entry
(`design/pi-merged.md`).
1.4.0 added `safe` to every entry (`providers_dev.safe`) and every summary: for the input window, the maximum
output, the short and the long cache lifetime and the price, the safe value, the source it is from (`measured`,
`providers.dev`, `models.dev`, `pi.dev`, in that order: the first that states a value gives it), whether the sources
agree, and what each source states, with its date. It added the components `SafeValues`, `SafeValue`, `SourceValue`,
`SafePrice`, `PriceStatement` and `PriceTier`, the value `pi.dev` of `source` in the input window and lifetime
records, the value `listed` of the kind of a price's evidence, the sort key `input_window` and the parameters
`min_input_window` and `disagree`, and `client_kind` and `chosen` on evaluations and measured items. With it the rule
of the safe value changed: `input_window.tokens` and `cache_lifetime.*.safe_s` are the measured value wherever
providers.dev measured one, where before they were the documented value unless a measurement clearly contradicted it.
The measurement that counts is the most direct one: on an API-key entry requests sent straight to the provider, on a
login the vendor's own client, where there is none requests sent straight to the provider, and where there are none
either a proxy; the `measured_*` keys and `measured_s` follow it. `pricing` is the price of one source, whole; a
subscription entry with no API entry to refer to has no price (`pricing` not applicable, the safe price unknown).
`max_output` of a summary is the safe maximum output, where it was `limit.output` as published: `null` where no
source states one (a limit of 0 states nothing), and possibly pi.dev's figure. `documented_status` says whether the
measurement contradicts the documented value and no longer which of the two is the safe value
(`design/sources-side-by-side.md`). On the dataset of 2026-11-22 that changed, of the summaries, `max_output` on 462
entries (`null` on 457 whose `limit.output` is 0, pi.dev's figure on 5); of the canonical models, `max_output_min` or
`max_output_max` on 161 of 476 (the minimum on 161, the maximum on 157) and `input_window_unknown_count` on 3
(`openai/gpt-6.2-astra`, `openai/gpt-6.2-sol`, `xai/grok-voice-3.0`); and the price of the 3 subscription entries
without an API entry to refer to (`github-copilot/mai-code-1.1-flash`, `mai-code-2`, `mai-code-2-flash`).
1.5.0 added the listings: the paths `/api/v1/listings` (with `provider`, `basis`, `view`, `limit` and `offset`) and
`/api/v1/listings/{provider}`, `listings` in `/api/v1/meta`, the error code `listing_not_found`, and the components
`Listing`, `ListingModel`, `ListingReasoning`, `ListingSources` and `ListingReasoningSources`: every model a provider
and access method offers, evaluated or not, from the vendor's own list, providers.dev, models.dev or pi, each field
with its source.
1.5.1 changed no structure: it fixed a range that never worked. A page of `/api/v1/listings?view=full` holds at most
40 listings, and 40 when `limit` is not given; a larger `limit` returns 400 (`invalid_parameters`), as a limit above
200 does on every list. In 1.5.0 the range was 1 to 200 with a default of 50, and a page of more than 48 listings in
full failed with 500 on Cloudflare (each listing in full is a file, each file a subrequest; see
[Worker subrequests](#worker-subrequests)). `view=summary` keeps 1 to 200, default 50. The OpenAPI schema of `limit`
is shared by both views and stays as recorded (maximum 200, default 50); its description gives the range in full.
1.6.0 made a listing the union of its sources: its `models` are every model the vendor's own list, an authored list,
models.dev and pi list for the provider, each once, where until 1.5.1 they were the list of `basis` taken whole. It
added `listed_by` to `ListingModel` (the sources whose list names the model, in the fixed order), `lists` to `Listing`
(per source its list's `listed_at` and `model_count`, or `null`) and the components `ListingList` and `ListingLists`.
`basis` stays: the highest-ranked source that has a list, with its date in `listed_at`; it no longer means that the
list is whole. A model no source names takes its id as its name from the first list that has it. The fields of a model
are chosen as before.
That promise holds for everything providers.dev makes itself: summaries, `providers_dev` records, evaluations,
corrections, evidence, paths and parameters. The fields imported from models.dev (`limit`, `cost`, `capabilities`,
`modalities` and the like) follow the models.dev v2 schema, which models.dev calls experimental. When models.dev
changes one of them, providers.dev takes the change over, and that is not a new major version of this API. The first
case was on 2026-11-17: models.dev made `capabilities.tools.updates`, until then `true` or `false`, a list of the tool
changes an API accepts in the middle of a conversation (`add`, `remove`, `replace`; `[]` for none). Version 1.0.0 was
corrected in place for it, record and baseline together, by the owner's decision.

Cache evaluations are published as counts and percentages at exact ages, the control ("at once") first: each
evaluation with its own results (`providers_dev.cache.evaluations` of an entry), and the evaluations of one client
with one retention setting added up as the `results` of a measured item of the lifetime record below, short and long
apart. A profile with no measured item has no lifetime measured, which is not 0 % (an evaluation whose control hit and
that has no timed check counts for no lifetime). The sums are made once, in
`src/core/cache.ts`, when the data is built.

Every entry has one cache lifetime record (`providers_dev.cache.lifetime`, and `cache_lifetime` of a summary):
`lifetimes`, one list of every lifetime known for the entry, documented by models.dev or providers.dev and measured
per client and retention setting, each item with its source and date, its client's `client_kind` and whether it is
`chosen`; and for the `short` and the `long` profile a safe value, `safe_s` in seconds, with its `basis`: the safe
lifetime of `safe.cache_short` and `safe.cache_long`, copied (see the safe values below). `documented_s` (the lowest
documented lifetime) and `measured_s` (the lowest lifetime of the chosen items, the oldest age through which every
check hit) are published beside it, and `documented_status` says whether the measurement that counts contradicts a
documented lifetime above 0: `contradicted` where every check still hit after it or one missed at an age it covers,
`not_contradicted` otherwise (else `null`). `0` is a value (documented as not caching, or no age at which every check
hit); `null` is not known. `cacheLifetime` in `src/core/cache.ts` makes the record once, when the data is built; the
record is described in `design/safe-cache-lifetime.md`, the rule in `design/sources-side-by-side.md` and in the guide
of the OpenAPI document.
`/api/v1/entries` sorts by the safe values with `sort=cache_short` or `sort=cache_long` (`null` last in either order,
`0` a value), and `lifetime_basis=documented` or `measured` keeps the entries whose short or long safe value has that
basis.

Every entry has one input window record (`providers_dev.limits.input_window`, and `input_window` of a summary):
`tokens`, the most input a request can carry on the entry, in tokens as the provider counts them, the client's own
prompt included, with its `basis`, `bound` and `scope`: the safe input window of `safe.input_window`, copied. The
documented input (`limit.input` above 0, else `limit.context` above 0 that is not a measured value) and the measured
one (the window the route names, `bound: "limit"`, else the largest input seen accepted, `bound: "at_least"`, the
lowest of the chosen evaluations) are published beside it as `documented_tokens` and `measured_tokens`, with
`documented_status` where both exist: `contradicted` where a chosen evaluation clearly contradicts the documented value
(a window named below it, or other than a documented window; an input refused at or below 99 % of it; one accepted,
below a refusal or read to the end, at or above 101 % of it). `null` is not known, and there is no `0`: a window of 0
is "none stated". Every counted evaluation of every client is an item of `measurements`, with `client_kind` and
`chosen`. `inputWindow` in `src/core/limits.ts` makes the record once, when the data is built; the record is described
in `design/usable-input-window.md`, the rule in `design/sources-side-by-side.md` and in the guide of the OpenAPI
document. `limit` stays as imported, and `context`, `input` and the `measured_*` keys of a summary keep their
meaning; `max_output` of a summary is the safe maximum output since 1.4.0, not `limit.output`. A limits row of the measurements file may carry `date` and `input_read` (the largest input
the reply showed was read to the end); a file with two rows for one route, client and model, or a row whose numbers
contradict each other, or a token count that is not a whole number of 0 or more, is refused when read and the last
good copy stays.

A model (`/api/v1/models`, `/api/v1/models/{lab}/{model}`) gives the two ends among its entries, since 1.1.0:
`input_window_min` and `input_window_max`, each the entry it is on (`entry_ref`) with that entry's `tokens`, `bound`,
`basis` and `scope`, `input_window_unknown_count`, the entries with none, and `input_window_reference`, the same for
the reference entry (`reference_ref`, the lab's own). At an equal number of tokens a lower bound counts as the larger.
`src/core/resources.ts` works them out (`inputWindowRange`), beside `context_min` and `context_max`, which stay
`limit.context`.

Every entry has `providers_dev.safe`, and every summary the same object as `safe`: for the input window, the maximum
output, the short and the long cache lifetime and the price, the safe value, its source, its date, the agreement of
the sources (`agree`, `differ`, `single`, `none`) and what each source states (`sources`, in the order of the sources,
a measured item naming its client, its kind, its evaluation and its raw result). The first source that states a value
gives it: the most direct measurement (on an API-key entry, requests sent straight to the provider; on a login, the
vendor's own client, else direct, else a proxy), then providers.dev, then models.dev, then pi.dev. Where the first is
a window and a later source states a cap on the input not above it, the cap is the value. A price is taken whole from
one source. `differing` lists the quantities whose sources contradict each other: the website's warnings. pi's
statements are laid on after the fence (`layPi`), and change a value only where no other source states one.
`safeValues`, `layPi` and `mirror` in `src/core/safe.ts` work it out once; the records above carry the same values,
copied by `mirror`. `/api/v1/entries` sorts by the safe input window (`sort=input_window`), filters by it
(`min_input_window`) and by disagreement (`disagree=true` or `false`); `max_output` of a summary is the safe maximum
output.

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
upstream; `/api/v1/meta` reports it as `upstream_schema`. When models.dev changes one of these fields, providers.dev
follows it within `/api/v1` (see [One contract](#one-contract)).

`/api.json` is a superset of the models.dev v2 export in the same shape, not a byte-compatible copy: every provider
and model has an extra `providers_dev` key, and entries we add can lack fields that models.dev requires.

## Deploying to Cloudflare

### Worker memory

A Worker isolate has 128 MiB. The API keeps well under it by holding only the index of summaries and by never
assembling a large answer:

- The two catalog exports, the raw index and the full view of a provider (`/api/v1/providers/{id}?view=full`) are
  streamed. The full view writes its envelope around the published file of the provider's entries
  (`data/provider-models/{id}.json`), passed through unparsed. Its ETag is made of the API version, the publication,
  the path and the query, so it is known before the body (`sendStreamed` in `src/core/api.ts`).
- The Worker loads the index from `data/index-parts/` (a head and parts of `INDEX_PART_SIZE` summaries), one part
  after another, so that it never holds the whole 31 MB text beside the parsed summaries (`src/core/snapshot.ts`).
  `data/index.json` stays published as it was.
- Nothing a request makes is kept: one parsed publication per binding, and the canonical models of its index.

### Worker subrequests

Every read of the `ASSETS` binding is a subrequest, and Cloudflare allows a Worker 50 in one invocation; `wrangler
dev` has no such cap, so a local run never shows it (Cloudflare answers 500, error 1101, "Too many subrequests").
`tests/subrequests.test.ts` asks every route of the Worker (every API path, every page family, the data files) on a
fresh isolate, which reads the publication from nothing, against the fixture with more listings than a page in full
holds and against the build in `dist/`, and fails a route that reads `ASSETS` more than 45 times. What keeps them
under it:

- The pointer and `meta.json` are read at once; the index (its head and its parts) only by the first request that
  reads a summary (`src/core/snapshot.ts`). A request that reads none (the listings, `/meta`, the evaluations) does
  not read it.
- The index has at most `MAX_INDEX_PARTS` (30) parts (`scripts/lib/publish.ts`): past 7,500 summaries its parts grow
  instead of their number. On 2026-11-22 it has 26, and a page that reads the index on a fresh isolate makes at
  most 33 reads.
- A page of `/api/v1/listings?view=full` holds at most 40 listings (`FULL_LISTING_LIMIT`), each a file of its own:
  the pointer, the meta, the list and 40 files are 43 reads. Since API 1.5.1; in 1.5.0 such a page failed above 48.

Measured on 2026-11-22 with workerd 1.20261110.1 (`--max-old-space-size=128`), the release review's method: the
inspector's used heap plus backing storage and embedder heap, sampled every 2 ms, over one warm isolate serving in
sequence the full OpenRouter view twice, the catalog, `/api.json`, `/data/index.json`, the full Nano-GPT view, a page of
200 OpenRouter summaries, a page of 200 models and the full OpenRouter view again. Peak: 76.15 MiB (`main` at
`ef30d9c`: 85.13 MiB; this branch before: 138.67 MiB). After a forced collection, 26 MiB stay, the same after three
rounds of that sequence (`main`: 23.8 MiB). `tests/memory.test.ts` holds the code to it.

The Worker (`wrangler.jsonc`) serves the API and renders every public HTML route from API responses. Astro
compiles one shared shell with CSS and scripts, plus authored methodology, licensing and contributing documents. It does not
enumerate entries, providers or models. `/docs/api/` renders the actual `/api/v1/openapi.json` response, including
its guide, parameters, schemas and examples. Authored text is also public through `/api/v1/docs/{document}`.

The site has one address, `https://providers.dev`. `wrangler.jsonc` attaches four custom domains to the Worker,
`providers.dev`, `www.providers.dev`, and two products' own sites, `provimux.providers.dev` and
`pi-cache-keeper.providers.dev` (below), and turns off the `workers.dev` address and the preview URLs:

```jsonc
"routes": [
  { "pattern": "providers.dev", "custom_domain": true },
  { "pattern": "www.providers.dev", "custom_domain": true },
  { "pattern": "provimux.providers.dev", "custom_domain": true },
  { "pattern": "pi-cache-keeper.providers.dev", "custom_domain": true }
],
"workers_dev": false,
"preview_urls": false,
```

The Worker redirects, not the zone (no Cloudflare setting does it, so every deploy carries the redirects): a request
for `www.providers.dev`, over http or https, and a plain http request for `providers.dev` get one 301 to
`https://providers.dev` with the same path and query (`canonicalLocation` in `worker/index.ts`). It acts only on
requests from Cloudflare's edge, told apart by the `X-Forwarded-Proto` header the edge sets: `wrangler dev` with these
routes hands the local Worker `http://providers.dev/…` too, but no such header, so a local preview is never
redirected. HSTS is not set.

**Provimux's site, `https://provimux.providers.dev`.** Two static pages, `/` and `/support/`, built by Astro from
`src/pages/provimux/` into `dist/provimux/` with their own layout (`src/layouts/Provimux.astro`) and files
(`public/provimux/`: the console screenshots, icons, `robots.txt`, `sitemap.xml`). They read no dataset. On that host
the Worker serves `dist/provimux/` as the root and nothing else: no API, no providers.dev page; any other address gets
the site's own page with status 404, and plain http at the edge goes to https (`src/core/provimux-site.ts`, with the
rules every product site shares in `src/core/product-site.ts`). On
providers.dev, `/support/` and `/docs/support/` get a 301 to `https://provimux.providers.dev/support/`, and anything
under `/provimux/` a 301 to the same path on the subdomain, so the build is never a page of providers.dev. The support
text is one component (`src/components/provimux/SupportBody.astro`), also published as `/api/v1/docs/support`. To
preview the subdomain locally: `npx wrangler dev --port <port> --local-upstream provimux.providers.dev` (a second
preview at the same time needs its own `--persist-to` folder).

**pi-cache-keeper's site, `https://pi-cache-keeper.providers.dev`.** One static page, `/`, built the same way from
`src/pages/pi-cache-keeper/` into `dist/pi-cache-keeper/`, with its own layout (`src/layouts/PiCacheKeeper.astro`),
stylesheet (`src/styles/pi-cache-keeper.css`) and files (`public/pi-cache-keeper/`: icons, `og.png`, `robots.txt`,
`sitemap.xml`). Its text is taken from pi-cache-keeper's README; its terminal pictures are that README's sample sessions,
drawn as text. On that host the Worker serves `dist/pi-cache-keeper/` as the root and nothing else, by the same rules
as Provimux's site (`src/core/pi-cache-keeper-site.ts`); on providers.dev anything under `/pi-cache-keeper/` gets a 301
to the same path on the subdomain. Preview: `npx wrangler dev --port <port> --local-upstream pi-cache-keeper.providers.dev`.

A deploy takes its credentials from the environment, never from a file: `CLOUDFLARE_API_TOKEN` (an API token that
can edit Workers scripts and their routes and custom domains on the zone) and `CLOUDFLARE_ACCOUNT_ID`. By hand:

1. `npm run build`
2. `CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… npm run deploy` (try `npx wrangler deploy --dry-run` first)

The scheduled workflow uses the same token, from the repository secrets `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` on GitHub, which are set, so each run deploys. Without them it would build and test but not
deploy. It runs on GitHub only: its job has
`if: github.server_url == 'https://github.com'`, so a mirror that reads `.github/workflows/` would skip it. The
Forgejo server holding a copy of the repository does not read that folder at all: it runs only
`.forgejo/workflows/` (see [Syncing](#syncing)). Only GitHub commits the daily snapshot.

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
templates. The site is live at `https://providers.dev`; a change reaches it only through a deploy (the `Publish` run
that a push to `main` on GitHub starts, or `npm run deploy` by hand), never by editing a local file.

## Contributing

Anyone can propose a correction, a missing provider or model, a measurement or a request for one, with its evidence.
providers.dev takes no payment for listing, correcting or measuring an entry. How it works, and what each kind of
contribution needs: [providers.dev/docs/contributing](https://providers.dev/docs/contributing/) (the same text is
`src/pages/reference-content/docs/contributing.astro`); the essentials are in [`CONTRIBUTING.md`](./CONTRIBUTING.md).
A pull request writes the change as in [Authoring](#authoring); `.github/workflows/check.yml` builds and checks it.
For what does not fit an issue: [office@providers.dev](mailto:office@providers.dev).

## Licensing

- Code, our additions and our corrections: MIT, see [`LICENSE`](./LICENSE).
- The imported baseline: models.dev, MIT, Copyright (c) 2025 models.dev. The full text is in
  [`LICENSES/models.dev-MIT.txt`](./LICENSES/models.dev-MIT.txt) and ships with the dataset as
  `/data/LICENSE-models.dev.txt` and `/data/NOTICE.txt`.
- pi's model catalog: pi (https://github.com/earendil-works/pi), MIT, Copyright (c) 2025 Mario Zechner. The full text
  is in [`LICENSES/pi-MIT.txt`](./LICENSES/pi-MIT.txt) and ships with the dataset as `/data/LICENSE-pi.txt`; `/data/NOTICE.txt`
  names it. Every `providers_dev.pi` block is pi's.
- In the data, everything else under `providers_dev`, every entry with `providers_dev.origin: "added"` and every field
  listed in a `providers_dev.provenance` array is ours; the rest is models.dev's.

providers.dev is not affiliated with or endorsed by models.dev, pi or any provider it lists.
