# pi's model catalog as a second imported source

Design for spec item PIC-01 (`pi-catalog-source`). Written 2026-11-20 against `main` at `6b95938`
(models.dev snapshot `e06a33e`, 329 providers, 10,698 models) and the pi feed as served that day
(ETag `"2197505f0de684a3eec3fcf68f253e97"`, revision `sha256-dd93eb27…`, 43 provider keys, 1,698 models).

This document says what the software is. The spec says what work is done and in what order. Where a worker's
brief and this document disagree, this document is corrected first.

**Decided by the owner, not open here:** models.dev stays the reference; pi is an extra source, imported
automatically; a model that only pi lists is published as an entry, as models.dev's entries are.

**pi** is a coding agent (`github.com/earendil-works/pi`, MIT). Its model catalog is served as JSON at
`https://pi.dev/api/models`. providers.dev is not affiliated with pi.

Sections (a) to (j) follow the letters of the task. Section 0 holds what was measured, because four of the
decisions below rest on it. Section 11 lists where the spec and the code do not fit.

---

## 0. What was measured

All counts: the pi feed of 2026-11-20 against the dataset built from `main` `6b95938` (6,318 entries).

**The feed.** One JSON object keyed by provider id; each value an object keyed by model id. 43 provider keys,
one of them (`typesafe`) with no models. Every model has `id`, `name`, `api`, `provider`, `baseUrl`, `reasoning`,
`input`, `cost`, `contextWindow`, `maxTokens`, `type`; every `id` equals its key and every `provider` equals its
provider key. There is **no provider record**: no provider name, documentation link or environment variable.
The response carries `ETag`, `Last-Modified` and `x-pi-model-catalog-revision`.

**Matching by equal provider id and model id.**

| pi models | count |
|---|---|
| equal ids with a published entry | 570 (566 imported, 4 added by providers.dev) |
| equal ids with a models.dev entry that the catalog rules leave out | 481 |
| no entry with these ids, in models.dev or in our additions | 647 |
| total | 1,698 |

So of the 1,128 pi models that match no *published* entry, 481 are not "pi only": models.dev lists them and
`data/authored/catalog-rules.yaml` leaves them out (released before 2026, Claude before 5.5, GPT before 6).

**The provider ids.** Of the 11 pi provider ids the catalog does not have, most are a provider the catalog has
under another id:

| pi provider id | catalog provider | what shows it | certain? |
|---|---|---|---|
| `fireworks` | `fireworks-ai` | 27 of 27 model ids equal; same base URL | yes |
| `together` | `togetherai` | 16 of 16 model ids equal | yes |
| `vercel-ai-gateway` | `vercel` ("Vercel AI Gateway") | 257 of 305 model ids equal; same host | yes |
| `kimi-coding` | `kimi-code-plan-cn` | same base URL `https://api.kimi.com/coding/v1`; 6 of 6 ids equal | yes |
| `zai-coding-cn` | `zhipuai-coding-plan` | same base URL; 4 of 4 ids equal | yes |
| `ant-ling` | `bailing` | same base URL `https://api.ant-ling.com/v1`; no id equal | provider yes, models to check |
| `qwen-token-plan` | `alibaba-token-plan` | 20 of 20 ids equal; **another host** | to check |
| `qwen-token-plan-cn` | `alibaba-token-plan-cn` | 20 of 20 ids equal; **another host** | to check |
| `qwen-token-plan-individual` | none found | 13 of 13 ids exist at `alibaba-token-plan` | to check |
| `qwen-token-plan-individual-cn` | none found | as above | to check |
| `radius` | none | pi's own gateway, `https://radius.pi.dev/v1` | new |

With the first five and the two `qwen-token-plan` ids paired, 1,391 pi models have equal ids in the models.dev
snapshot (803 published, 588 left out by the catalog rules), 4 match entries we added, and **303** match nothing:
`openrouter` 95 and `vercel-ai-gateway` 48 (nearly all `:batch` and `-batch` variants), `cloudflare-ai-gateway` 63,
`radius` 39, `azure` 15, the two `qwen-token-plan-individual` ids 13 each, `kimi-coding` 6 (0 once paired),
`openai-codex` 4, `ant-ling` 3, `zai` 2, `mistral` 1, `openai` 1.

This table is input for PIC-07, not a decision: each pairing is written into the alias file by the worker who has
checked it (section c).

**Differences, over the 807 entries that would carry a pi block:** input price differs on 17, output price on 17,
cache-read price on 17, context window on 28, output limit on 19; one side has price tiers and the other none on 5.
pi writes a cache-write price of 0 on 1,278 of its 1,698 models and both prices 0 on 135: in pi's catalog a price
is a required number, so **0 stands for "no charge" and for "no price recorded" alike**.

**How pi reads its own fields** (pi's package `@earendil-works/pi-ai`, its type comments and `calculateCost`):
a tier prices the **whole request** once the input tokens (input + cache read + cache write) are above
`inputTokensAbove`, the highest such tier winning; `cacheWrite` is the price of a short-lifetime write;
`thinkingLevelMap`: "Missing keys use provider defaults. null marks a level as unsupported";
`promptCache`: "Prompt cache lifetimes per retention tier. Unset when the provider's cache behavior is unknown";
`inputLimits`: "Provider input limits and cache-safe preprocessing metadata"; `compat`: "Compatibility overrides
[…] If not set, auto-detected from baseUrl".

---

## a. The snapshot

```
data/pi/                     the last good import of pi's feed     written only by `npm run sync`
  meta.json                  where it came from and when
  providers/<provider>.json  one file per provider key of the feed
```

`data/upstream/` is never touched by the pi import, and `data/pi/` never by the models.dev import.

`providers/<provider>.json` is `{ "id": "<provider key>", "models": { "<model id>": { … } } }`. The models are
written **sorted by id** (plain character order); a model is written **as the feed gives it**, every key, in the
feed's key order, `headers` included. The snapshot is the feed, split; what is published is decided when the data
is built (section f). A provider with no models (`typesafe`) gets its file with `"models": {}`. Files are written
with `pretty()` of `scripts/lib/files.ts`, as `data/upstream/` is.

`meta.json`:

```ts
/** data/pi/meta.json. In src/core/schema.ts. */
export interface PiMeta {
  source: string;          // PI_URL, the address the snapshot was read from
  fetched_at: string;      // ISO time of the import that wrote the snapshot
  checked_at: string;      // ISO time of the last request that confirmed it (a 304 or an equal digest)
  etag?: string;           // the response's ETag
  last_modified?: string;  // the response's Last-Modified, as sent
  revision?: string;       // the response's x-pi-model-catalog-revision, as sent
  sha256: string;          // of the response body
  providers: number;       // provider keys in the feed
  models: number;          // models in the feed
}
```

`.gitignore` gains `data/pi.tmp*/` beside `data/upstream.tmp*/`. `data/pi/` is committed, as `data/upstream/` is.

---

## b. The import

### The code

`scripts/lib/sync.ts` gains a third part beside `syncUpstream` and `syncMeasurements`:

```ts
export const PI_URL = "https://pi.dev/api/models";

/** An import smaller than this is treated as broken, whatever the previous snapshot held. */
const PI_MIN_PROVIDERS = 10;
const PI_MIN_MODELS = 300;
// MIN_SHARE (0.6) is shared: an import that lost more than 40 % of its providers or models is broken.

export function loadPi(dataDir: string): { catalog: PiCatalog; meta: PiMeta } | undefined;
export function piProviderFile(id: string, models: Record<string, PiModel>): string;
async function syncPi(options): Promise<PartReport>;

export interface SyncOptions { /* as today */ only?: "pi" }
export interface SyncReport {
  ok: boolean;               // unchanged meaning: models.dev and the measurements did not fail
  upstream: PartReport;
  measurements: PartReport;
  pi: PartReport;
}
export interface SyncStatus {
  // the five fields of today, with today's meaning: they speak of models.dev and the measurements only
  last_attempt_at: string;
  last_attempt_ok: boolean;
  last_error?: string;
  upstream: PartReport["status"];
  measurements: PartReport["status"];
  // new
  pi?: { last_attempt_at: string; status: PartReport["status"]; error?: string };
}
```

`sync()` runs the three parts in this order: models.dev, measurements, pi. Each runs inside the existing `part()`
wrapper, so an exception in one never reaches another. One lock (`data/.sync.lock`) covers the run, as today.

`loadPi` returns `undefined` when `data/pi/meta.json` or `data/pi/providers/` is missing. It does not validate;
the data build does (section i, "a snapshot the code cannot read").

### What `syncPi` does, in order

1. Read the previous snapshot (`loadPi`). Send `If-None-Match: <stored etag>` when there is a previous snapshot,
   its `meta.source` is `PI_URL`, it has an ETag and `--force` was not given. Headers: `Accept: application/json`,
   `User-Agent: providers.dev sync`.
2. `304` with a previous snapshot of the same source: rewrite `meta.json` with a new `checked_at`, return
   `unchanged`. Nothing else is written.
3. Any other status that is not 2xx: fail with `pi.dev answered HTTP <status>`.
4. The body is not JSON: fail with `pi.dev did not return JSON`.
5. Structure (`PiFeed` of `src/core/pi.ts`, below): fail with
   `the pi feed does not match the expected structure (<n> problems; first: …)`, the first five problems named, as
   the models.dev import words it.
6. Identity: every provider key matches `PROVIDER_ID` (`src/core/schema.ts`; it becomes a file name); every model's
   `id` equals its key; every model's `provider` equals its provider key. Otherwise fail, naming the key.
7. Size: fewer than `PI_MIN_PROVIDERS` provider keys or `PI_MIN_MODELS` models: fail with
   `the pi feed is unexpectedly small: <p> providers, <m> models`. This is the "empty" case.
8. Shrinkage, where there is a previous snapshot: fewer than 60 % of its providers or of its models: fail with
   `the pi feed shrank too much to trust: …`, as the models.dev import words it.
9. Digest: where the body's sha256 equals the previous one, same source, no `--force`: rewrite `meta.json` with a
   new `checked_at` and the new ETag, return `unchanged`.
10. Write `data/pi.tmp-<pid>/` in full, then `swapDir` it over `data/pi/`. Return `updated` with a summary in the
    same words as the models.dev one (`first import: …`, or providers added and removed and
    `models: +a added, -r removed, c changed`).

The structure the import accepts. Loose on purpose where pi may add keys, strict on every field the build reads:

```ts
// src/core/pi.ts
export const PiModel = z.looseObject({
  id: z.string().min(1),
  name: z.string().min(1),
  api: z.string().min(1),
  provider: z.string().min(1),
  baseUrl: z.string(),                                   // "" on 48 azure models
  reasoning: z.boolean(),
  input: z.array(z.string()),
  type: z.string().min(1),
  contextWindow: z.number().int().nonnegative(),
  maxTokens: z.number().int().nonnegative(),
  cost: z.looseObject({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cacheRead: z.number().nonnegative(),
    cacheWrite: z.number().nonnegative(),
    tiers: z.array(z.looseObject({
      inputTokensAbove: z.number().int().nonnegative(),
      input: z.number().nonnegative(),
      output: z.number().nonnegative(),
      cacheRead: z.number().nonnegative(),
      cacheWrite: z.number().nonnegative(),
    })).optional(),
  }),
  compat: z.record(z.string(), z.json()).optional(),
  thinkingLevelMap: z.record(z.string(), z.string().nullable()).optional(),
  promptCache: z.looseObject({ short: z.number().int().nonnegative().optional(), long: z.number().int().nonnegative().optional() }).optional(),
  inputLimits: z.looseObject({
    maxRequestBytes: z.number().int().nonnegative().optional(),
    images: z.looseObject({ maxPerRequest: z.number().int().nonnegative().optional(), maxPerMessage: z.number().int().nonnegative().optional() }).optional(),
  }).optional(),
  enabled: z.boolean().optional(),
});
export type PiModel = z.infer<typeof PiModel>;
export const PiFeed = z.record(z.string(), z.record(z.string(), PiModel));
/** The snapshot as the build reads it: provider key -> model id -> model. */
export type PiCatalog = z.infer<typeof PiFeed>;
```

As for models.dev, the import is not made tolerant of a change of structure: when pi changes the type of a field
named above, the pi import fails on purpose, the last good pi snapshot stays, and someone adapts `PiModel`.

### Each source on its own: what a failure leaves and records

| What happens | `data/upstream/` | `data/pi/` | `data/sync-status.json` | exit code of `npm run sync` |
|---|---|---|---|---|
| both good | replaced if changed | replaced if changed | `last_attempt_ok: true`; `pi.status: updated` or `unchanged` | 0 |
| pi down, not JSON, other structure, key and id disagree, too small, 40 % lost | as a good models.dev import leaves it | **exactly as it was**, `meta.json` included | `last_attempt_ok: true`, no `last_error`; `pi: { status: "failed", error: "<the reason>" }` | **0** |
| models.dev fails (any of today's reasons), pi good | exactly as it was | replaced if changed | `last_attempt_ok: false`, `last_error` as today; `pi.status: updated` or `unchanged` | 1, as today |
| both fail | exactly as it was | exactly as it was | `last_attempt_ok: false`, `last_error` as today (models.dev and measurements only); `pi.status: failed`, `pi.error` | 1 |
| measurements fail | as today | unaffected | as today; `pi` as its own part went | 1, as today |

`last_attempt_at`, `last_attempt_ok` and `last_error` keep today's meaning word for word: the pi part never
changes them. `pi.last_attempt_at` is the time the pi part ended.

`scripts/sync.ts` prints one more line, `pi: <status>[ - <error>]`, with the summary lines under it. When pi alone
failed it prints `The pi import failed. The last good pi snapshot is unchanged and is still what gets published.`
and exits 0. When the environment variable `GITHUB_OUTPUT` is set, it appends three lines to that file:
`upstream=<status>`, `measurements=<status>`, `pi=<status>`.

`npm run sync -- --only=pi` runs the pi part alone: the other two do not run, their five fields in
`sync-status.json` stay as they were, and the exit code is 1 if the pi part failed. It exists so that the first pi
snapshot can be written into a branch without moving `data/upstream/`. `--force` applies to every part that runs.

### A fresh clone without a pi snapshot

`npm run build` works: `loadPi` returns `undefined`, no entry gets a pi block, no entry comes from pi, and
`/api/v1/meta` says so (`pi.snapshot: null`, every pi count 0). The build never stops for want of pi data. (It
still stops, as today, for want of a models.dev snapshot.)

### The workflow (`.github/workflows/publish.yml`)

- The import step is renamed `Import models.dev, the measurements and pi`; the command is unchanged
  (`npm run sync -- ${{ inputs.force && '--force' || '' }}`); `continue-on-error: true` stays. The description of
  the `force` input becomes `Download again even if a source says nothing changed`.
- `Keep the new snapshot` keeps its condition (`steps.sync.outcome == 'success'`, which is now also true when pi
  alone failed). Its test becomes
  `git status --porcelain data/upstream/providers data/sources/observed.json data/pi/providers`, it adds
  `data/pi` to `git add`, and the commit message names what changed: `sync: models.dev <commit7>` when
  `data/upstream/providers` changed, `sync: pi <revision7>` when only `data/pi/providers` did (the seven characters
  after `sha256-` of `meta.revision`, else `snapshot`), `sync: models.dev <commit7>, pi <revision7>` for both, and
  `sync: measurements` when only the measurements file did.
- The last step, `Report a failed import`, gets the condition
  `steps.sync.outcome == 'failure' || steps.sync.outputs.pi == 'failed'`. It prints one `::error::` line per
  failed source and exits 1:
  - models.dev or the measurements (`steps.sync.outcome == 'failure'`): today's sentence, unchanged.
  - pi (`steps.sync.outputs.pi == 'failed'`): `The pi import failed. The site was built and deployed with the last
    good pi snapshot; models.dev was imported as usual. See the 'Import' step for the reason.`

So a pi failure never stops the build, the tests, the snapshot commit or the deploy: they have all run when the
report step marks the run as failed. The run is marked failed on purpose, as for models.dev: a source that stops
importing must not stay unnoticed behind a green run. On a push to `main` the import step is skipped, its output
is empty and nothing is reported.

`.github/workflows/check.yml` is unchanged: a pull request builds from the snapshots in the repository.

---

## c. Matching

Matching decides, for each pi model, which entry it speaks of. It is done once per build, in `resolve()`, from the
pi snapshot and one authored file. **Nothing is ever matched by similarity when the data is built.**

### The alias file, `data/authored/pi-aliases.yaml`

Authored by people, checked by the build like every file in `data/authored/` (a file that is not valid YAML or
does not fit the schema fails `npm run data`). The file may be absent: then only equal ids match.

```yaml
# data/authored/pi-aliases.yaml
providers:
  vercel-ai-gateway:                       # a pi provider id the catalog does not have
    same_as: vercel                        # it is this provider of the catalog
    reason: pi's vercel-ai-gateway and models.dev's vercel are the Vercel AI Gateway.
    evidence:
      - { kind: listed, url: "https://pi.dev/api/models", date: "2026-11-21", note: "baseUrl https://ai-gateway.vercel.sh" }
    checked: "2026-11-21"                  # the day the model lines below were checked against the report
    models:
      "anthropic/claude-opus-5.5-batch":   # a pi model id of this provider
        only_pi: true                      # no entry of `vercel` is this model: publish it as an entry from pi
        inherits: vercel/anthropic/claude-opus-5.5   # optional: take identity from this entry

  openrouter:                              # a pi provider id the catalog has: only `models` applies
    checked: "2026-11-21"
    models:
      "~anthropic/claude-fable-latest":
        same_as: "anthropic/claude-fable-latest"     # the entry of openrouter with this id is the same model

  radius:                                  # a provider only pi has
    new:
      name: Radius
      doc: https://pi.dev/models
      access: api
      access_basis: pi's own gateway, reached with a pi API key and billed by use.
      evidence:
        - { kind: listed, url: "https://pi.dev/api/models", date: "2026-11-21" }
    checked: "2026-11-21"
    models:
      claude-opus-5-5: { inherits: anthropic/claude-opus-5-5 }
      balanced: { inherits: false }        # looked at: a router alias, no single model
```

(The ids and words above show the shape; the real lines are written in PIC-07 and PIC-08 from the report.)

```ts
// src/core/pi.ts
const PiModelLine = z.strictObject({
  /** The model id of the entry, at the catalog's provider, that is this pi model under another spelling. */
  same_as: z.string().min(1).optional(),
  /** Confirmed: no entry of the provider is this model. It is published as an entry that comes from pi. */
  only_pi: z.literal(true).optional(),
  /** For an entry that comes from pi: `provider/model` of the entry it takes identity from; false = looked at, there is none. */
  inherits: z.union([z.string().min(3), z.literal(false)]).optional(),
  note: z.string().optional(),
}).superRefine(/* same_as excludes only_pi and inherits; a line states at least one of the three */);

const PiProviderLine = z.strictObject({
  same_as: z.string().regex(PROVIDER_ID).optional(),
  new: z.strictObject({
    name: z.string().min(1), doc: z.url().optional(), access: Access, access_basis: z.string().min(1),
    note: z.string().optional(), evidence: z.array(Evidence).min(1),
  }).optional(),
  reason: z.string().min(1).optional(),          // required with same_as
  evidence: z.array(Evidence).min(1).optional(), // required with same_as
  checked: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), // required when `models` has a line
  models: z.record(z.string().min(1), PiModelLine).default({}),
}).superRefine(/* same_as and new exclude each other; the requirements named above */);

export const PiAliases = z.strictObject({ providers: z.record(z.string().regex(PROVIDER_ID), PiProviderLine).default({}) })
  .superRefine(/* two pi provider ids may not have the same same_as */);
export type PiAliases = z.infer<typeof PiAliases>;
```

When a line may be written:

- `same_as` on a provider: only where the two ids name the same service: the same base URL in both catalogs, or
  the provider's own documentation showing both names. Equal model ids alone are not enough (the two
  `qwen-token-plan` ids have all their model ids at `alibaba-token-plan` and another host).
- `same_as` on a model: only where the two ids name the same model at the same provider, the same deployment and
  price class. A `:batch` or `-batch` id is **not** the same as the id without it: it is another way to buy the
  model, with its own price, and gets `only_pi` with `inherits`.
- `only_pi`: only after the report (below) and the provider's entries have been read and no entry is this model.
- `new`: only where no provider of the catalog is this service.

### The rule

"The catalog" below is the catalog as `resolve()` has it **before any exclusion**: the models.dev snapshot, our
additions and the entries that exist because we measured them (after step 3 of `resolve()`). A pi model whose
feed record has `enabled: false` is skipped as if the feed did not list it.

1. **The provider.** For a pi provider id `P`:
   - the catalog has a provider `P`: that is its provider (the provider is *shared*);
   - else `providers.P.same_as` names a provider the catalog has: that one (*paired*);
   - else `providers.P.new` is written: `P` itself, a provider that comes from pi (*new*, section g);
   - else the provider is *undecided*: none of its models is matched or published.
2. **The entry.** For a pi model `M` of a shared or paired provider `T`:
   - `T` has an entry with the id `M`: that entry (**`id`**). Equal ids always come first;
   - else `models.M.same_as` names an entry `T` has: that entry (**`alias`**);
   - else the model matches nothing.
3. **One pi model per entry.** Where two pi models reach the same entry, the one with the equal id keeps it; among
   aliases, the first by pi provider id and then pi model id in plain character order. The others match nothing.
4. **What a pi model then is**, exactly one of:
   - **matched**: its entry is in the published catalog. The entry carries the pi block (section d).
   - **from pi alone**: it matches nothing, and it is published as an entry of its own (section g). That entry
     carries the pi block too.
   - **left out**: its entry, matched or from pi alone, was in the catalog before the exclusions and an override or
     a catalog rule left it out. Nothing of it is published.
   - **unmatched**: everything else. Nothing of it is published.

The four counts add up to the models in the snapshot (less the `enabled: false` ones), every build.

What the build reports as an issue (`/api/v1/meta`, the console, the *Our data* page). None is an error: no
change in pi's feed or in models.dev can make the build fail through this file.

| code | level | when |
|---|---|---|
| `pi-provider-undecided` | notice | a pi provider id the catalog does not have and the alias file does not name. One issue per provider, with its number of models. |
| `pi-provider-collides` | warning | the alias file says `same_as` or `new` for a pi provider id that the catalog has itself (models.dev or we added it since). The catalog's provider is used and the line's `same_as` or `new` is ignored. |
| `pi-alias-orphan` | warning | a `same_as` names a provider or an entry the catalog does not have; or a model line names a pi model the snapshot does not have. |
| `pi-alias-conflict` | warning | rule 3 took an entry away from a pi model. |
| `pi-alias-redundant` | notice | a model line is no longer needed: the entry now has the pi model's own id (`same_as` or `only_pi` on a model that matches by `id`). |
| `pi-identity-unknown` | notice | entries that come from pi alone and have no `inherits` line (section g). One issue per provider, with the count and the first ten ids. |
| `pi-snapshot-unreadable` | warning | `data/pi/` is there and does not fit `PiFeed` (section i). |

These are added to `Issue["code"]` in `src/core/schema.ts`.

### The report

`npm run data` writes `data/published/pi-report.json`: beside the published data, not under `site/`, so it is
never staged, served or part of the API (`scripts/lib/stage.ts` copies `data/published/site/` only), and not in
git (`data/published/` is ignored). `publish()` writes it into the temporary directory before the swap. Without a
pi snapshot the file is not written.

```ts
// src/core/pi.ts. resolve() returns it as `pi`; publish() writes it and takes the /meta counts from `totals`.
export interface PiReport {
  totals: { models: number; disabled: number; matched_id: number; matched_alias: number; sole: number; left_out: number; unmatched: number };
  providers: {
    pi_provider: string;
    state: "shared" | "paired" | "new" | "undecided";
    catalog_provider: string | null;
    models: number; matched: number; sole: number; left_out: number; unmatched: number;
    /** A hint for a person: providers of the catalog with an entry whose api base_url has the host of this provider's baseUrl. */
    same_host: string[];
  }[];
  unmatched: {
    pi_provider: string; pi_model: string; name: string;
    why: "provider-undecided" | "not-confirmed" | "alias-orphan" | "alias-conflict";
    /** A hint for a person: ids of the provider's entries that are equal to pi_model once both are lower-cased and every character that is not a letter or a digit is dropped. */
    alike: string[];
    /** The feed's `lab`, where it has one. A hint for `inherits`. */
    lab: string | null;
  }[];
  left_out: { pi_provider: string; pi_model: string; entry: string; by: string }[];  // by: a rule id, or "override"
}
```

The lists are sorted by pi provider id, then pi model id. `same_host` and `alike` are the only places where
anything like similarity is computed; they are read by the person who writes the alias file and by nothing else.
`scripts/build-data.ts` prints one line after the published line:
`pi: <n> entries with a pi block (<s> from pi alone), <l> left out, <u> unmatched`.

---

## d. The additions to `v1`

The OpenAPI document is generated: its component schemas come from `COMPONENTS` in `src/core/contract.ts`, its
types from `src/core/schema.ts` and `src/core/entries.ts`, its parameter lists from `src/core/query.ts`.
`src/core/openapi.ts` itself only gets the version, one sentence and one guide section. "A change to
`src/core/openapi.ts`" is therefore the following changes, in those four files.

**Version:** `info.version` becomes `1.2.0`.

Everything below is added. Nothing that exists is renamed, retyped or removed, and no description of an existing
field changes its meaning.

### 1. On every entry: `providers_dev.pi`

`EntryExtensionSchema` gains one key, on every entry: `pi`, the pi block, or `null` where pi's catalog does not
list the entry. New components `PiBlock`, `PiCost`, `PiCostTier`, `PiDifference`.

```ts
// src/core/contract.ts
export const PiCostTierSchema = z.strictObject({
  input_tokens_above: z.int().min(0).describe("The tier prices the whole request once its input tokens (input, cache reads and cache writes together) are above this number."),
  input: z.number().min(0).nullable().describe("US dollars per million input tokens. Null only on a tier read from the entry's own cost, where the entry states none."),
  output: z.number().min(0).nullable(),
  cache_read: z.number().min(0).nullable(),
  cache_write: z.number().min(0).nullable(),
}).describe("One price tier by size of request.") satisfies z.ZodType<PiCostTier>;

export const PiCostSchema = z.strictObject({
  input: z.number().min(0).describe("US dollars per million input tokens, as pi's catalog states it."),
  output: z.number().min(0),
  cache_read: z.number().min(0),
  cache_write: z.number().min(0).describe("The price of a cache write of the short lifetime."),
  tiers: z.array(PiCostTierSchema).describe("Tiers by size of request, ascending. Empty = pi states none."),
}).describe("pi's prices. In pi's catalog a price is always a number: 0 stands for no charge and for no price recorded alike, so a 0 here is not a statement that the provider charges nothing.") satisfies z.ZodType<PiCost>;

export const PiDifferenceSchema = z.strictObject({
  field: z.enum(["context_window", "max_tokens", "cost.input", "cost.output", "cost.cache_read", "cost.cache_write", "cost.tiers"]).describe("The field of the pi block that differs."),
  entry_field: z.string().describe("The field of the entry it was compared with: limit.context, limit.output, cost.text.input.price, cost.text.output.price, cost.text.input.cache.read, cost.text.input.cache.write, or cost.text for the tiers."),
  unit: z.enum(["tokens", "usd_per_million_tokens"]),
  pi: z.number().nullable().describe("pi's value. Null for cost.tiers."),
  published: z.number().nullable().describe("The entry's value, as published. Null for cost.tiers."),
  pi_tiers: z.array(PiCostTierSchema).nullable().describe("For cost.tiers: pi's tiers. Null otherwise."),
  published_tiers: z.array(PiCostTierSchema).nullable().describe("For cost.tiers: the entry's tiers by size of request, read from its cost. Null otherwise."),
}).describe("One value that pi's catalog states otherwise than the entry publishes it.") satisfies z.ZodType<PiDifference>;

export const PiBlockSchema = z.strictObject({
  ref: z.string().describe("provider/model in pi's catalog: pi's provider id, then pi's model id. They can be spelled otherwise than the entry's."),
  provider: z.string().describe("pi's provider id."),
  model: z.string().describe("pi's model id."),
  match: z.enum(["id", "alias", "sole"]).describe("How the entry and pi's model belong together. id = the same provider id and model id. alias = providers.dev paired two spellings by hand. sole = the entry itself comes from pi's catalog (origin pi)."),
  name: z.string(),
  type: z.string().describe("As pi states it, for example chat."),
  api: z.string().describe("The request format pi uses for the model, in pi's words: openai-completions, openai-responses, azure-openai-responses, openai-codex-responses, anthropic-messages, bedrock-converse-stream, google-generative-ai, google-vertex, mistral-conversations, pi-messages. Other values may be added."),
  base_url: z.string().nullable().describe("The address pi sends requests to, as stated, placeholders such as {CLOUDFLARE_ACCOUNT_ID} included. Null = pi states none."),
  reasoning: z.boolean().describe("Whether pi treats the model as one that reasons."),
  input: z.array(z.string()).describe("The kinds of input pi sends: text, image."),
  context_window: z.int().min(0).describe("Tokens."),
  max_tokens: z.int().min(0).describe("Tokens: the most pi asks for in one response."),
  cost: PiCostSchema,
  thinking_level_map: z.record(z.string(), z.string().nullable()).nullable().describe("pi's thinking levels (off, minimal, low, medium, high, xhigh, max) and the value pi sends for each. A level whose value is null is one pi marks as not supported. A level that is not named follows pi's own default for the request format, which is not published here. Null = pi states no map."),
  compat: z.record(z.string(), json).nullable().describe("pi's compatibility flags for the model, names and values exactly as pi's catalog states them (supportsLongCacheRetention, cacheControlFormat, forceAdaptiveThinking, thinkingFormat, supportsStrictTools and others; the set grows with pi). Only what the catalog states: a flag that is not here follows pi's own default for the request format, which lives in pi's code and is not published. Null = pi states none."),
  prompt_cache: z.strictObject({ short_s: z.int().min(0).nullable(), long_s: z.int().min(0).nullable() }).nullable().describe("The cache lifetimes pi reckons with, in seconds, for its short and its long retention. Null = pi states none, which pi reads as: the provider's cache behaviour is not known. Not part of providers_dev.cache."),
  input_limits: z.strictObject({
    max_request_bytes: z.int().min(0).nullable(),
    max_images_per_request: z.int().min(0).nullable(),
    max_images_per_message: z.int().min(0).nullable(),
  }).describe("The provider's limits on a request as pi states them. Each is null where pi states none."),
  differences: z.array(PiDifferenceSchema).describe("Where pi's price, context window or output limit is not the entry's published value, in a fixed order: context_window, max_tokens, cost.input, cost.output, cost.cache_read, cost.cache_write, cost.tiers. Empty = they agree wherever both state a value."),
}).describe("What pi's model catalog (https://pi.dev/api/models) states for this entry. Imported, not checked by providers.dev, and never merged into the entry's own fields: models.dev stays the reference.") satisfies z.ZodType<PiBlock>;
```

`EntryExtensionSchema` gains
`pi: PiBlockSchema.nullable().describe("What pi's catalog states for this entry. Null = pi does not list it.")`,
and `ModelExtension` gains `pi: PiBlock | null`.

### 2. On every entry summary: `pi`

`EntrySummarySchema` gains `pi`, the block in short, or `null`. New component `PiSummary`.

```ts
export const PiSummarySchema = z.strictObject({
  ref: z.string().describe("providers_dev.pi.ref of the full entry."),
  api: z.string().describe("providers_dev.pi.api of the full entry."),
  match: z.enum(["id", "alias", "sole"]).describe("providers_dev.pi.match of the full entry."),
  difference_count: z.int().min(0).describe("How many items providers_dev.pi.differences of the full entry has."),
}).describe("The pi block of an entry in short.") satisfies z.ZodType<PiSummary>;
```

### 3. New values of existing enumerated fields

A value is added; no entry published today gets it.

| field | new value | meaning |
|---|---|---|
| `providers_dev.origin` of an entry | `pi` | the entry comes from pi's catalog alone: models.dev has no entry for it, and providers.dev did not add it by hand |
| `providers_dev.origin` of a provider, `origin` of a provider summary | `pi` | pi's catalog lists the provider and models.dev does not. Its name, documentation link and access are providers.dev's, with evidence; its entries come from pi |
| `origin` of an entry summary | `pi` | as imported from pi's catalog, with no providers.dev correction or evaluation. With one, the summary's origin is `modified`, as for an entry imported from models.dev; `pi.match: "sole"` still says where it comes from |
| `source` and `documented_source` of `InputWindow` | `pi` | the documented value is the context window pi's catalog states, on an entry with origin `pi` |
| query parameter `origin` of `/api/v1/entries` | `pi` | entries whose summary origin is `pi` |
| query parameter `origin` of `/api/v1/providers` | `pi` | providers with origin `pi` |

The descriptions of `upstream`, `modified` and `added` are not touched. The description of `Provenance.upstream`
and `had_upstream` gains one sentence: on an entry with origin `pi` they hold what pi's catalog states.
`CacheLifetimeItem.source` and `SafeLifetime.source` get **no** new value: an entry from pi documents no cache
lifetime (section g).

### 4. In `/api/v1/meta`: `pi`, and two keys of `license`

```ts
// in MetaSchema
pi: z.strictObject({
  source: z.string().describe("The address pi's catalog is imported from."),
  snapshot: z.strictObject({
    fetched_at: z.string().describe("When the pi data of this dataset was imported."),
    checked_at: z.string().describe("When pi last confirmed that it had not changed."),
    etag: z.string().nullable(),
    last_modified: z.string().nullable().describe("The Last-Modified of pi's answer, as sent."),
    revision: z.string().nullable().describe("pi's own revision of its catalog, as sent."),
    sha256: z.string(),
    providers: z.int().describe("Provider ids in pi's catalog."),
    models: z.int().describe("Models in pi's catalog."),
  }).nullable().describe("The pi import this dataset is built on. Null = it is built without pi data: no entry has a pi block and none comes from pi."),
  sync: z.strictObject({ last_attempt_at: z.string().nullable(), last_attempt_ok: z.boolean().nullable(), last_error: z.string().nullable() })
    .describe("The last attempt to import pi's catalog. All null = no attempt is recorded. A failed attempt leaves the snapshot above as it was. `sync` beside `upstream` speaks of models.dev and the evaluations only."),
  counts: z.strictObject({
    entries_with_block: z.int().describe("Entries with a pi block, those that come from pi alone included."),
    sole_entries: z.int().describe("Entries that come from pi alone (origin pi)."),
    sole_providers: z.int().describe("Providers that come from pi alone (origin pi)."),
    left_out_models: z.int().describe("pi models whose entry providers.dev leaves out (exclusions)."),
    unmatched_models: z.int().describe("pi models that belong to no entry and are not published."),
  }),
}).describe("pi's model catalog, the second imported source: where it came from, whether the last import worked, and how much of it is in this dataset."),
```

`Meta` (`src/core/schema.ts`) gains the same `pi`. `license` (an open object) gains
`pi: "pi (https://github.com/earendil-works/pi), MIT License, <the copyright line of pi's LICENSE file>"` and
`pi_notice: "The pi block of an entry, and every entry and provider with origin pi, are imported from https://pi.dev/api/models. providers.dev is not affiliated with or endorsed by pi."`.
`license.data`, `license.upstream` and `license.notice` keep their text.

`counts` of `/meta` gains nothing and loses nothing; what its numbers mean for entries from pi is in section i.

### 5. In `src/core/openapi.ts`

- `info.version: "1.2.0"`.
- `info.description` gains one sentence after the models.dev one: `A second catalog, pi's (MIT), is imported
  beside it: what it states for an entry is under providers_dev.pi, and an entry only pi lists has origin pi.`
- `x-guide` gains a section `{ id: "pi", title: "pi's catalog" }` after `input-window`, with these paragraphs, in
  this order: (1) what the second source is, that models.dev stays the reference, and that nothing of pi's is
  merged into `limit`, `cost` or `capabilities` of an entry models.dev lists; (2) the pi block and its `match`;
  (3) only what the feed states: flags and levels not named follow pi's own defaults, which are not published; a
  price of 0 in the block is not a statement of no charge; (4) the differences, with the rule of section e in
  full; (5) entries with origin `pi`: which fields they have and where each comes from (section g); (6) `/meta.pi`.
  The words are the worker's; the facts are this document's. Since 1.2.0 is named in the section.
- Nothing else. `ENDPOINTS` is unchanged: no new path, no new parameter.

### Example 1: a full entry with a pi block

`GET /api/v1/entries/deepseek/deepseek-v4-pro`, `data.entry`. Everything outside `providers_dev.pi` is the entry
exactly as published on 2026-11-20; the long records that do not change are cut short with `…`.

```json
{
  "id": "deepseek-v4-pro",
  "name": "DeepSeek V4 Pro",
  "description": "DeepSeek V4 Pro snapshot with million-token context and support for thinking and non-thinking modes",
  "type": "chat",
  "family": "deepseek-thinking",
  "canonical_id": "deepseek/deepseek-v4-pro-0813",
  "release_date": "2026-08-13",
  "limit": { "context": 1048576, "output": 393216 },
  "capabilities": { "cache": { "implicit": true }, "temperature": true, "reasoning": { "supported": true, "toggle": true, "effort": ["low", "high", "max"] }, "…": "…" },
  "cost": {
    "text": { "input": { "price": 0.66, "cache": { "read": 0.022 } }, "output": { "price": 1.98, "reasoning": 1.98 } },
    "multipliers": [ { "when": { "…": "weekdays, 01:00 to 04:00 and 06:00 to 10:00 UTC, not a holiday in CN" }, "factor": 2 } ]
  },
  "modalities": { "input": ["text"], "output": ["text"] },
  "api": { "chat-completions": { "base_url": "https://api.deepseek.com", "…": "…" } },
  "providers_dev": {
    "origin": "upstream",
    "access": "api",
    "provenance": [],
    "inherited": null,
    "cache": { "…": "unchanged" },
    "pricing": { "…": "unchanged" },
    "request_controls": { "…": "unchanged" },
    "limits": { "measured": [], "from_measurement": [], "input_window": { "tokens": 1048576, "basis": "documented", "source": "models.dev", "…": "unchanged" } },
    "evidence": [],
    "verified": null,
    "pi": {
      "ref": "deepseek/deepseek-v4-pro",
      "provider": "deepseek",
      "model": "deepseek-v4-pro",
      "match": "id",
      "name": "DeepSeek V4 Pro",
      "type": "chat",
      "api": "openai-completions",
      "base_url": "https://api.deepseek.com",
      "reasoning": true,
      "input": ["text"],
      "context_window": 1000000,
      "max_tokens": 384000,
      "cost": { "input": 1.32, "output": 3.96, "cache_read": 0.044, "cache_write": 0, "tiers": [] },
      "thinking_level_map": { "minimal": null, "low": null, "medium": null, "high": "high", "max": "max" },
      "compat": {
        "supportsStore": false,
        "maxTokensField": "max_tokens",
        "requiresReasoningContentOnAssistantMessages": true,
        "thinkingFormat": "deepseek",
        "supportsStrictMode": true,
        "supportsMidConvoSystemMessages": true
      },
      "prompt_cache": null,
      "input_limits": { "max_request_bytes": null, "max_images_per_request": null, "max_images_per_message": null },
      "differences": [
        { "field": "context_window", "entry_field": "limit.context", "unit": "tokens", "pi": 1000000, "published": 1048576, "pi_tiers": null, "published_tiers": null },
        { "field": "max_tokens", "entry_field": "limit.output", "unit": "tokens", "pi": 384000, "published": 393216, "pi_tiers": null, "published_tiers": null },
        { "field": "cost.input", "entry_field": "cost.text.input.price", "unit": "usd_per_million_tokens", "pi": 1.32, "published": 0.66, "pi_tiers": null, "published_tiers": null },
        { "field": "cost.output", "entry_field": "cost.text.output.price", "unit": "usd_per_million_tokens", "pi": 3.96, "published": 1.98, "pi_tiers": null, "published_tiers": null },
        { "field": "cost.cache_read", "entry_field": "cost.text.input.cache.read", "unit": "usd_per_million_tokens", "pi": 0.044, "published": 0.022, "pi_tiers": null, "published_tiers": null }
      ]
    }
  }
}
```

`cost.cache_write` is not listed: pi's value is 0 (section e). The summary of the same entry
(`data.summary`, and its item in `/api/v1/entries`) gains
`"pi": { "ref": "deepseek/deepseek-v4-pro", "api": "openai-completions", "match": "id", "difference_count": 5 }`
and is otherwise as today. An entry pi does not list has `"pi": null` in both places.

### Example 2: an entry that comes from pi alone

`GET /api/v1/entries/radius/claude-opus-5-5`, `data.entry`, with the alias file of section c
(`radius` declared `new`, the model with `inherits: anthropic/claude-opus-5-5`), pi data fetched 2026-11-21.

```json
{
  "id": "claude-opus-5-5",
  "name": "Claude Opus 5.5",
  "type": "chat",
  "limit": { "context": 1000000, "output": 128000 },
  "capabilities": { "reasoning": { "supported": true } },
  "cost": { "text": { "input": { "price": 4, "cache": { "read": 0.2, "write": 5 } }, "output": { "price": 20 } } },
  "description": "Claude model for long-running agentic coding and knowledge work",
  "family": "claude-opus",
  "open_weights": false,
  "knowledge": "2026-06",
  "release_date": "2026-09-22",
  "last_updated": "2026-09-22",
  "canonical_id": "anthropic/claude-opus-5-5",
  "providers_dev": {
    "origin": "pi",
    "access": "api",
    "provenance": [],
    "inherited": { "from": "anthropic/claude-opus-5-5", "fields": ["description", "family", "open_weights", "knowledge", "release_date", "last_updated", "canonical_id"] },
    "cache": { "documented": { "…": "every mode unknown" }, "retention": { "support": "unknown", "…": "…" }, "lifetime": { "short": { "safe_s": null, "basis": "none", "…": "…" }, "long": { "safe_s": null, "basis": "none", "…": "…" }, "lifetimes": [] }, "evaluations": [] },
    "pricing": { "coverage": "partial", "billing": "per_use", "reference_ref": null, "rules": [ { "id": "cost.text.input.price", "when": null, "meter": "text.input", "operation": "set", "amount": 4, "…": "…" }, "…" ], "rule_order": "listed", "unparsed": [], "evidence": [ { "kind": "documented", "url": "https://pi.dev/api/models", "date": "2026-11-21", "note": "The cost pi's catalog records for this entry." } ] },
    "request_controls": { "…": "as on any entry with nothing declared" },
    "limits": { "measured": [], "from_measurement": [], "input_window": { "tokens": 1000000, "basis": "documented", "bound": "limit", "scope": "window", "source": "pi", "date": "2026-11-21", "documented_tokens": 1000000, "documented_field": "limit.context", "documented_source": "pi", "documented_date": "2026-11-21", "…": "the measured keys null, 0 or []" } },
    "evidence": [],
    "verified": null,
    "pi": {
      "ref": "radius/claude-opus-5-5",
      "provider": "radius",
      "model": "claude-opus-5-5",
      "match": "sole",
      "name": "Claude Opus 5.5",
      "type": "chat",
      "api": "pi-messages",
      "base_url": "https://radius.pi.dev/v1",
      "reasoning": true,
      "input": ["text", "image"],
      "context_window": 1000000,
      "max_tokens": 128000,
      "cost": { "input": 4, "output": 20, "cache_read": 0.2, "cache_write": 5, "tiers": [] },
      "thinking_level_map": { "off": null, "minimal": null, "low": "low", "medium": "medium", "high": "high", "xhigh": "xhigh", "max": "max" },
      "compat": null,
      "prompt_cache": { "short_s": 300, "long_s": 3600 },
      "input_limits": { "max_request_bytes": null, "max_images_per_request": null, "max_images_per_message": null },
      "differences": []
    }
  }
}
```

Its summary has `"origin": "pi"` and
`"pi": { "ref": "radius/claude-opus-5-5", "api": "pi-messages", "match": "sole", "difference_count": 0 }`.
Its provider, `data.provider`:

```json
{
  "id": "radius", "name": "Radius", "doc": "https://pi.dev/models", "env": [],
  "access": "api", "access_reviewed": true, "origin": "pi", "entry_count": 28, "evidence_entry_count": 0,
  "providers_dev": {
    "origin": "pi", "access": "api",
    "access_basis": "pi's own gateway, reached with a pi API key and billed by use.",
    "access_reviewed": true, "access_source": null, "note": null,
    "evidence": [ { "kind": "listed", "url": "https://pi.dev/api/models", "date": "2026-11-21", "note": null } ],
    "provenance": []
  }
}
```

(`entry_count` is an illustration: pi lists 39 models at `radius`, and the catalog rules leave out the ones whose
inherited identity is an earlier Claude or GPT version.)

### Example 3: `/api/v1/meta`

`data`, as the build of 2026-11-20 would give it with **no alias file** (the state after PIC-06) and a pi snapshot
written that day at 14:19 UTC by `npm run sync -- --only=pi` (so the top-level `sync` still shows the morning's
run). Everything outside `pi` and the two new keys of `license` is as published today.

```json
{
  "api_version": "v1",
  "upstream_schema": "models.dev v2 (experimental)",
  "dataset_version": "<changes: the catalog now holds the pi blocks>",
  "generated_at": "2026-11-20T14:20:26.623Z",
  "counts": { "providers": 333, "entries": 6318, "models": 474, "added_providers": 4, "added_entries": 29, "corrected_entries": 44, "evaluated_entries": 134, "cache_evaluations": 186, "limit_evaluations": 36 },
  "cache_ages_s": [150, 300, 450, 600, 900, 1200, 1500, 1800, 2400, 3000, 3600, 4500, 5400, 7200, 14400, 28800, 43200, 86400],
  "stale_after_days": 90,
  "upstream": {
    "source": "https://models.dev/experimental/v2.0/api.json?include=openai-codex",
    "schema": "models.dev v2 (experimental)",
    "fetched_at": "2026-11-20T13:06:42.615Z",
    "checked_at": "2026-11-20T13:06:42.615Z",
    "etag": "W/\"01793df2c805bbe6c02e4e7f6c45b183\"",
    "commit": "e06a33eb4d68f2ad6b06fa0da13a847441ddf8c1",
    "commit_date": "2026-11-20T12:31:39Z",
    "sha256": "01793df2c805bbe6c02e4e7f6c45b183ebd4ed40f127eaae635ce5f26c8f0352",
    "providers": 329,
    "models": 10698
  },
  "measurements": { "source": "https://raw.githubusercontent.com/ngvoicu/groundtruth/main/observed.json", "…": "as today" },
  "sync": { "last_attempt_at": "2026-11-20T13:06:44.825Z", "last_attempt_ok": true, "last_error": null },
  "pi": {
    "source": "https://pi.dev/api/models",
    "snapshot": {
      "fetched_at": "2026-11-20T14:19:45.000Z",
      "checked_at": "2026-11-20T14:19:45.000Z",
      "etag": "\"2197505f0de684a3eec3fcf68f253e97\"",
      "last_modified": "Fri, 20 Nov 2026 13:53:59 GMT",
      "revision": "sha256-dd93eb2741d05a80f41ffb94b5a1c1ccf33d2866d73292940251fd72584eb4bc",
      "sha256": "<of the body>",
      "providers": 43,
      "models": 1698
    },
    "sync": { "last_attempt_at": "2026-11-20T14:19:45.000Z", "last_attempt_ok": true, "last_error": null },
    "counts": { "entries_with_block": 570, "sole_entries": 0, "sole_providers": 0, "left_out_models": 481, "unmatched_models": 647 }
  },
  "exclusions": ["… 18 items, as today"],
  "issues": [ { "level": "notice", "code": "pi-provider-undecided", "target": "radius", "message": "pi lists a provider \"radius\" (39 models) that the catalog does not have and data/authored/pi-aliases.yaml does not name. Nothing of it is published." }, "… one per undecided provider" ],
  "license": {
    "data": "MIT",
    "upstream": "models.dev, MIT License, Copyright (c) 2025 models.dev",
    "notice": "Baseline imported from https://models.dev. providers.dev is not affiliated with or endorsed by models.dev.",
    "pi": "pi (https://github.com/earendil-works/pi), MIT License, <the copyright line of pi's LICENSE file>",
    "pi_notice": "The pi block of an entry, and every entry and provider with origin pi, are imported from https://pi.dev/api/models. providers.dev is not affiliated with or endorsed by pi."
  }
}
```

When the last pi import failed: `"sync": { "last_attempt_at": "…", "last_attempt_ok": false, "last_error":
"pi.dev answered HTTP 503" }` under `pi`, `snapshot` still the last good one, and the top-level `sync` unchanged.
On a fresh clone before the first import: `"snapshot": null`, the three `sync` keys `null`, every count 0.

---

## e. A difference

A difference is worked out once, when the data is built (`piDifferences` in `src/core/pi.ts`), between the pi
block and **the entry's own fields as published**, that is after every override: `limit` and `cost` of the entry,
never `providers_dev.pricing` (which on a subscription entry is another entry's price).

| `field` | pi's value | compared with (`entry_field`) | unit |
|---|---|---|---|
| `context_window` | `contextWindow` | `limit.context` | tokens |
| `max_tokens` | `maxTokens` | `limit.output` | tokens |
| `cost.input` | `cost.input` | `cost.text.input.price` | US dollars per 1,000,000 tokens |
| `cost.output` | `cost.output` | `cost.text.output.price` | the same |
| `cost.cache_read` | `cost.cacheRead` | `cost.text.input.cache.read` | the same |
| `cost.cache_write` | `cost.cacheWrite` | `cost.text.input.cache.write`, **only where it is one number** | the same |
| `cost.tiers` | `cost.tiers` | the entry's tiers by size of request (below) | the same |

Rules:

1. **Both must state a value.** No difference is listed where the entry has no value for the field (the block
   shows pi's value, that is all), where a limit is 0 on either side (in `limit`, 0 is "none stated"), or where
   **pi's price is 0** (0 is also pi's "no price recorded", section 0). A price of 0 on the entry's side is a
   listed zero price and is compared.
2. **Limits** are whole numbers of tokens and differ when they are not equal. No tolerance.
3. **Prices** are both in US dollars per million tokens; an entry price whose side has a `unit`
   (`cost.text.input.unit`, `cost.text.output.unit`: a price per character) is not compared. Two prices are equal
   when they are equal after rounding each to 6 decimals. The values listed are the unrounded ones.
4. **A cache-write price keyed by lifetime** (`{ "5m": 5, "1h": 8 }`) is not compared: pi states one price and
   the feed does not say for which lifetime.
5. **Tiers.** The entry's tiers are read from `cost.text.input.overrides` and `cost.text.output.overrides`. An
   override is a tier when its `when` has the one key `context`, with the one comparison `gt` or `gte` on a number;
   its threshold is that number for `gt`, that number less 1 for `gte`. Every other override (service tier, time of
   day, a composite) and every multiplier is not a tier and is not compared. For each threshold, ascending:
   `{ input_tokens_above, input: the input override's price, output: the output override's price, cache_read: the
   input override's cache.read, cache_write: its cache.write where one number }`, `null` where the entry states
   none; where two overrides of one side have the same threshold, the one listed last counts. pi's tiers are
   `cost.tiers` sorted by `inputTokensAbove`. The two lists agree when they have the same thresholds and, tier by
   tier, every price that both state (rule 1) is equal (rule 3). Where they do not agree, including one side
   having tiers and the other none, **one** item is listed, `field: "cost.tiers"`, with `pi_tiers` and
   `published_tiers` in full and `pi` and `published` null. Base prices are compared on their own, tiers or not.
6. **What is listed:** one item per differing field, in the order of the table, each with the two values. Nothing
   else: no percentage, no verdict on who is right. `differences: []` means agreement wherever both state a value.
7. **An entry from pi alone** goes through the same rule. Its fields are pi's, so the list is empty until an
   override changes `limit` or `cost`; then the override's value is the published one and pi's differs from it.

---

## f. Which feed fields are published

Only what the feed states, in the pi block (`piBlock` in `src/core/pi.ts`). Keys of the block are snake_case;
`compat` and `thinking_level_map` keep pi's own key names, because they are pi's vocabulary and the set grows.

| feed field | in the block | note |
|---|---|---|
| `provider`, `id` | `provider`, `model`, and `ref` = `provider/id` | pi's spelling, also where the entry's is another |
| `name` | `name` | |
| `type` | `type` | as stated (`chat` on all 1,698 today) |
| `api` | `api` | as stated; an open string |
| `baseUrl` | `base_url` | **published**: it is where a request goes, which is "how pi calls the model"; it is a public address, with its placeholders as written. `""` (48 azure models) is `null` |
| `reasoning` | `reasoning` | |
| `input` | `input` | pi's words (`text`, `image`), not models.dev's media types |
| `contextWindow`, `maxTokens` | `context_window`, `max_tokens` | |
| `cost` | `cost`: `input`, `output`, `cache_read`, `cache_write`, `tiers[]` with `input_tokens_above` | numbers as stated, 0 included; `tiers: []` where the feed has none |
| `thinkingLevelMap` | `thinking_level_map` | **published as stated**, `null` where absent: per level the value pi sends, `null` for a level pi marks as unsupported. A level not named follows pi's default, which is not reproduced |
| `compat` | `compat` | **published as stated**, every flag with its name and value, `null` where absent. No default is filled in |
| `promptCache` | `prompt_cache: { short_s, long_s }` | **published in the block only**, `null` where absent. It is not read into `providers_dev.cache.lifetime`, `cache.documented` or `capabilities.cache`, not even on an entry from pi: it is the lifetime pi's own cache timer reckons with, the feed does not say which way of caching it is for, and the lifetime record's sources stay models.dev and providers.dev |
| `inputLimits.maxRequestBytes`, `inputLimits.images.maxPerRequest`, `inputLimits.images.maxPerMessage` | `input_limits.max_request_bytes`, `.max_images_per_request`, `.max_images_per_message` | **published**, each `null` where not stated: they are limits of the provider |
| `inputLimits.images.resize` | not published | pi's own setting for shrinking an image before it sends it (the same four numbers on all 1,290 models that have it), not a fact about the provider |
| `headers` | **not published** | request headers pi sends are not a fact about the model. They stay in `data/pi/` only. `tests/pi-source.test.ts` holds that no published object has a `headers` key under `pi` |
| `lab` (`radius`) | not published | a display name ("Anthropic"), not an id: it cannot serve as `family` or `canonical_id`. The report shows it as a hint for `inherits` |
| `enabled` (`radius`) | not published; **read** | a switch of pi's gateway. A model with `enabled: false` is skipped as if not listed (section c). All 39 are `true` today |
| `providers` (`radius`) | not published | which upstream pi's gateway routes the model to and with whose credential: the gateway's own routing, which can change without the model changing |
| `free` (one `radius` model) | not published | pi's own mark; the prices are in `cost` |
| any other key | not published | a key the feed adds later stays in `data/pi/` until this table gives it a place |

pi's per-request-format defaults (what a flag is when the catalog does not state it, what a 1-hour cache write
costs) live in pi's code and are not reproduced anywhere.

---

## g. Entries that come from pi alone

### Which pi models become entries

A pi model that matches nothing (section c, rule 2) is published as an entry of its own when:

- its provider is **new** (`providers.<id>.new` in the alias file): every model of it, without a line of its own,
  also a model pi adds later. There is no entry it could repeat;
- or its provider is **shared** or **paired**, and its model line says `only_pi: true`.

Otherwise it is unmatched and in the report. This is the order that keeps a model from appearing twice under two
spellings: a provider id is decided first (most "new" ids are a provider the catalog has, section 0), and a model
of a provider both catalogs have is published only once a person has read the report and written the line.

### How the entry is built (`piEntry` in `src/core/pi.ts`)

In the models.dev v2 structure, like every entry. A field is filled only where pi states it **and** it means the
same thing in the same words as the models.dev field:

| entry field | from pi | |
|---|---|---|
| `id` | `id` | the entry is at `<provider>/<id>`, the provider being pi's id for a new provider and the catalog's for a shared or paired one |
| `name` | `name` | |
| `type` | `type` | |
| `limit.context` | `contextWindow` | left out where 0 |
| `limit.output` | `maxTokens` | left out where 0 |
| `capabilities.reasoning.supported` | `reasoning` | the only capability pi states as models.dev does |
| `cost.text.input.price`, `cost.text.output.price` | `cost.input`, `cost.output` | **`cost` is left out altogether where both are 0**: pi's 0 is not copied into a field where 0 means "listed at no charge" |
| `cost.text.input.cache.read`, `.write` | `cost.cacheRead`, `cost.cacheWrite` | each left out where 0 |
| `cost.text.input.overrides[]`, `cost.text.output.overrides[]` | `cost.tiers[]` | one override per tier and side, `when: { context: { gt: <inputTokensAbove> } }`, with `price` (and on the input side `cache.read`, `cache.write`, each left out where 0): the shape models.dev writes a size tier in (320 of the 328 size tiers on the entries pi matches use `gt`, 8 `gte`), and the same meaning (the whole request, section 0) |

Left out, so unknown, on an entry from pi: `modalities` (pi says `image`, models.dev `image/png`: other words),
`capabilities.cache` and every other capability, `api` (models.dev's record of endpoints; pi's request format is in
the block), `status`, `limit.input`. `description`, `family`, `canonical_id`, `release_date`, `open_weights`,
`knowledge` and `last_updated` come only through `inherits`, below.

`providers_dev` of the entry: `origin: "pi"`; `access` from the provider; `provenance`, `evidence`, `inherited`,
`verified` as for any entry; `pi` the block with `match: "sole"`. Everything else is worked out by the code that
works it out for every entry, from the fields above, with these three places told that the source is pi:

- `limitSource` (step 6 of `resolve()`): `{ source: "pi", date: <the day of pi's fetched_at> }` for an entry with
  origin `pi` that has no correction of the field.
- `sourcesOf`: `{ kind: "documented", url: PI_URL, date: <that day>, note }` with the note
  `The cost pi's catalog records for this entry.` for prices and
  `What pi's catalog states for this entry; corrections are recorded in providers_dev.provenance.` for capabilities.
- `cacheEvidence`: nothing is put first (today's models.dev item is for origin `upstream` only).

`lifetimeSource` needs no case: an entry from pi documents no lifetime unless an override gives it
`capabilities.cache`, and then the source is providers.dev, as today. A subscription entry from pi (for example a
model pi lists at `openai-codex` that models.dev does not) follows the one rule for subscription entries: its
`pricing` is the API list price of the lab's entry for its canonical model where it has one, else `not_applicable`.

### Identity, and why it is needed

pi states no family and no release date. The catalog rules read exactly these (`family` for the version rules,
`release_date` for the release rules), and they leave out 41 % of models.dev today. An entry from pi with no
identity is seen by no rule: `radius/claude-opus-4-5` would be published although "Claude Opus versions before 5.5,
at every provider" are left out.

So an entry from pi takes its identity the way an entry we add does: `inherits: <provider/model>` on its model
line, applied by the existing `inherit()` of `resolve()` (the fields of `IDENTITY_FIELDS` the entry does not have
itself; `providers_dev.inherited` records them). The entry named is normally the lab's own entry of the model, or,
for a `:batch` variant, the same provider's entry without the suffix. It is looked up before the exclusions, so an
entry the rules leave out can be named. The catalog rules then apply to the entry from pi as to any other.

- `inherits: false`: a person has looked and no entry is this model (a router alias such as `radius/balanced`, a
  model models.dev does not list anywhere). No issue. Where the family or the release date is known all the same,
  an override sets it, with evidence, as for any entry.
- no `inherits` at all: the entry is published without identity, and the provider gets the notice
  `pi-identity-unknown`. This is the state of a model pi has just added to a new provider.
- `inherits` naming an entry that is not in the catalog: today's warning `inherit-target-missing`.

### Provider records for providers only pi has

The feed has no provider record, so the record is the alias file's `new` block: `id` (the pi provider id), `name`,
`doc` where given, no `env` (`env: []` in the summary), `models` from pi. `providers_dev`: `origin: "pi"`,
`access` and `access_basis` from the block, `access_reviewed: true`, `access_source: null`, `note`, `evidence` as
written, `provenance: []`. `data/authored/access.yaml` is not consulted for it (as for a provider we add).

### Where this happens in `resolve()`

```ts
export interface ResolveInput {
  // … as today
  /** The pi snapshot and the alias file. Left out = the dataset is built without pi data. */
  pi?: { catalog: PiCatalog; aliases?: PiAliases; date: string /* the day of meta.fetched_at, YYYY-MM-DD */ };
}
export interface ResolveResult { catalog: Catalog; issues: Issue[]; exclusions: Exclusion[]; pi: PiReport | null }
```

| step | today | added |
|---|---|---|
| 1 | the upstream baseline | |
| 2 | providers and models we add | |
| **2b** | | provider records for `new` pi providers; then every entry that comes from pi alone, built by `piEntry`, with `inherits` applied. Decided against the catalog as it stands here (models.dev and our additions) |
| 3 | models that exist only because we measured them | an id that an entry from pi already has is not created again: the measurement lands on the entry from pi |
| **3b** | | the match of every pi model (section c) against the catalog as it stands here, and the set of refs present before any exclusion. A pi model whose entry was built from it in 2b is `sole`, not `id`. Nothing is changed |
| 4, 4b, 4c | overrides, `select` rules, catalog rules | they apply to entries from pi as to any other |
| 5, 5b | measurements; the API list price of added subscription entries | |
| 6 | every record published with all of its keys | `pi`: the block with its differences on every entry a pi model reached and that is still in the catalog, `null` on every other. Provider records with origin `pi` are published like the others. The report is put together |

### How our overrides, additions and measurements apply

- **Overrides** (`data/authored/overrides/<provider>.yaml`): as for any entry: `set`, `exclude`, `pricing`,
  `request_controls`, `cache_retention`, and `select` rules. `provenance` records what pi stated under `upstream`.
  A whole-provider `exclude` works on a pi provider too. `providers_dev` cannot be set, so the pi block cannot be
  overridden; what is corrected is the entry's field.
- **Catalog rules**: as for any entry, through the identity above.
- **Measurements**: land on the entry (`routes.yaml` may name a pi provider). The entry keeps origin `pi`; as on
  an imported entry, a measurement never replaces `limit` (that happens only for origin `added`).
- **`inherits` of our additions** may name an entry from pi.
- An entry from pi is never the price reference of another entry: `labEntry` in `resolve()` leaves entries with
  origin `pi` out of its candidates, and `describe()` in `src/core/resources.ts` takes an entry whose
  `pi.match` is `sole` as the lab's own entry only where the lab has no other. Without this an entry from pi could
  change `reference_ref`, and through it the pricing, of entries published today.

### The collision rules

| what meets | what is published |
|---|---|
| **An addition of ours has the id of a pi provider** (`data/authored/providers/radius.yaml`) | Our provider is the provider (origin `added`, our name and access). pi's provider is then *shared*: pi models with the id of one of our entries give that entry a pi block (`match: "id"`, the entry stays `added`); the other pi models need `only_pi` like at any shared provider. A `new` block for the id is ignored, with the warning `pi-provider-collides`. |
| **An addition of ours has the id of an entry from pi** (same provider, same model id) | Ours is the entry (origin `added`), with pi's block (`match: "id"`). Step 2 comes before 2b, so nothing is created from pi. |
| **models.dev later lists the same model** (same provider id, same model id) | The entry follows models.dev from that build on: origin `upstream`, every field models.dev's, and it keeps its pi block, now with `match: "id"` and with differences where the two disagree. Its `only_pi` line raises the notice `pi-alias-redundant`. Overrides written for it keep applying; one that now says what models.dev says raises `redundant-override`, as today. |
| **models.dev later lists the same model under another spelling** | Nothing can know this without a person. Both are published until a `same_as` line is written; then the entry from pi is gone and its block is on the models.dev entry. The report's `alike` column is where it shows first. |
| **models.dev later lists a provider that was `new`** (same id) | The provider record is models.dev's (origin `upstream`); warning `pi-provider-collides`. pi models with equal ids get their blocks on models.dev's entries. The pi models that match nothing are **no longer published** until each has `only_pi` or `same_as`: on that day nobody has checked them against models.dev's spelling, and a duplicate is worse than a gap. |
| **models.dev later lists a provider that was `new`, under another id** | Two providers until a person turns `new` into `same_as`. The report's `same_host` column is where it shows. |
| **pi drops a model or a provider** | The block, the entry from pi or the provider is gone in the next build. A model line left without a pi model raises `pi-alias-orphan`. The 40 % guard of the import stops a feed that lost that much at once. |

---

## h. What the entry page must be able to show

Purpose only; the look is the frontend designer's (PIC-09). Everything comes from
`GET /api/v1/entries/{provider}/{model}` (`entry.providers_dev.pi`, `summary`, `provider`) and
`GET /api/v1/meta` (`pi`); the page works nothing out.

1. **How pi calls the model**, for a reader who wants to call it through an agent: the request format (`api`),
   the address (`base_url`), what pi sends as input (`input`), whether it reasons and at which levels
   (`reasoning`, `thinking_level_map`), the flags pi states (`compat`: the 1-hour cache request, the kind of cache
   markers, cache markers on tools, the kind of thinking, strict tools), the cache lifetimes pi reckons with
   (`prompt_cache`), the request limits (`input_limits`). What pi does not state shows as not stated, never as
   "no": a flag absent from `compat` is not `false`.
2. **Where pi differs from the reference**, at a glance: each item of `differences` with pi's value beside the
   published one, tiers included; and plainly "agrees" when the list is empty. pi's price of 0 is not shown as
   "free".
3. **Whose data it is**: that the block is pi's, imported and not checked by providers.dev; pi's own name for the
   model where it is spelled otherwise (`ref`, `match: "alias"`); when it was imported (`meta.pi.snapshot.fetched_at`)
   and, if so, that the last import failed (`meta.pi.sync`).
4. **On an entry with origin `pi`**: that the entry comes from pi's catalog and models.dev does not list it, in
   the place where the page says "models.dev" today. The source shown beside each fact (context window, output,
   prices) is pi, or providers.dev where an override corrected it; identity fields show where they are inherited
   from. On its provider's page: that the provider is listed by pi and its name and access are providers.dev's.
5. **On an entry pi does not list** (`pi: null`): nothing about pi, or one plain line; the designer's choice.

Lists (`/`, a provider's page, a model's page) can show `summary.pi` (request format, a mark for differences, a
mark for "from pi"); whether they do is the designer's.

---

## i. How the existing rules stay true

**"The published dataset is computed from scratch."** `resolve()` stays pure: its new inputs are the pi snapshot
and the alias file. Every block, every difference, every entry from pi and the report are worked out again in each
build; nothing is stored between builds or edited in place. Delete `data/pi/` and the dataset is today's, with
`pi: null` everywhere. Delete a line of the alias file and what it did is gone in the next build.
`dataset_version` covers the pi blocks, since they are in the catalog it hashes: new pi data gives a new version
and new ETags.

**"A sync can never overwrite our work."** `npm run sync` writes `data/pi/` and nothing under `data/authored/`.

**"For every entry published today, every field that exists today keeps its value."** Held by construction and by
a test and a script (section j, step 4):
- the pi block is a new key; no code that fills an existing key reads it;
- no new enum value can land on an entry published today: `origin: "pi"` and `source: "pi"` are set only on
  entries created in step 2b, and `summary.origin` of an existing entry does not count the block as a correction
  or an evaluation (`touched` in `src/core/entries.ts` is unchanged);
- entries from pi never become another entry's price reference or a model's reference entry while another exists
  (section g).

What does change, by its nature, once entries come from pi (PIC-08), exactly as when models.dev adds entries: a
provider's `entry_count`; a canonical model's `entry_count`, its minima and maxima and its `entries` when an entry
from pi inherits its `canonical_id`; `counts.providers`, `counts.entries` and perhaps `counts.models` of `/meta`;
the `entries` number of a catalog rule in `exclusions` when it leaves out an entry from pi; `/api/v1/facets`.

**The counts of `/meta`.** `counts.added_providers` and `counts.added_entries` stay "what providers.dev added by
hand" (origin `added`); entries from pi are counted in `pi.counts.sole_entries` and `sole_providers`, never there.
`counts.corrected_entries` and `counts.evaluated_entries` count an entry from pi when it has a correction or an
evaluation, like any entry. `counts.providers` and `counts.entries` are all of them.

**"Entries with providers.dev evidence."** Today the code reads "has evidence" as `summary.origin !== "upstream"`.
With a fourth value that would count every untouched entry from pi. Each such place becomes
`origin === "modified" || origin === "added"`: `buildIndex` in `src/core/entries.ts` (`evidence_entry_count` of a
provider), `facets` and `describe` in `src/core/resources.ts` (`evidence_entries`, `evidence_entry_count` of a
model). `summarize` gives `origin: "pi"` where the entry's origin is `pi` and it is not touched, `"modified"`
where it is touched. For every entry published today the result is the same as before.

**The catalog rules.** They apply after every override to every entry, entries from pi included, and read what
they read today. A pi model whose models.dev entry a rule leaves out is *left out*, not "pi only": it is matched
against the catalog before the exclusions, so the 481 (588 with the provider ids paired) do not come back. An
entry from pi is seen by the rules through its identity (section g); one without identity is published and
reported (`pi-identity-unknown`), which is today's rule for an entry with no family or no release date.

**"Imported values never get a verification date"; the stale mark.** pi's values are imported: the block has no
date of its own, `verified` of an entry does not move, and nothing of pi's is ever shown as stale. The age of the
pi data is `meta.pi.snapshot.fetched_at`, one for the whole dataset, like models.dev's.

**The evaluated mark, `modified`.** A pi block is not evidence and not an evaluation: an imported entry with a pi
block stays `origin: "upstream"` in its summary, `evaluated=true` does not match it, and it is not counted among
the entries with providers.dev evidence.

**"The site never shows anything that is not from the API."** Everything of section h is in the entry, the summary
or `/meta`. The report is not in the API and no page reads it.

**"One contract": every object of a kind has the same keys.** `providers_dev.pi` and `summary.pi` are on every
entry, `null` where there is none; the block has every key on every entry, `null` or `[]` where pi states nothing;
`meta.pi` is always there. `compat` and `thinking_level_map` are maps with pi's keys, as `request_settings` of an
evaluation is a map with the client's.

**"The API only grows."** Added: properties, components, enum values, allowed values of two parameters.
`structure/api-v1.json` grows; `structure/api-v1-1.0.0.json` is not touched; `info.version` 1.2.0.

**"The last import failed. This is the last good snapshot."** in the footer of every page
(`src/core/pages.ts`) reads `sync.last_attempt_ok` of `/meta`, whose meaning does not change: a pi failure never
shows there. It shows in `meta.pi.sync`.

**A snapshot the code cannot read.** `publish()` checks `data/pi/` against `PiFeed`. If it does not fit (an edit
by hand, or the code's schema moved on), the dataset is built **without** pi data, `meta.pi.snapshot` is `null`,
and the warning `pi-snapshot-unreadable` is raised. The build does not fail for pi.

**Licensing.** pi's licence text goes to `LICENSES/pi-MIT.txt` (copied from pi's repository, PIC-10), ships with
the dataset as `/data/LICENSE-pi.txt`, and `NOTICE.txt` gains a paragraph naming pi, its address, MIT, the import
time and "not affiliated with or endorsed by pi". The README sentence "the rest is models.dev's" becomes: every
`providers_dev.pi` block, and every entry and provider with origin `pi`, is pi's.

---

## j. The steps for the workers

Each step is one task, on a branch, reviewed before `main`. Rules for every step: never edit `data/upstream`,
`data/sources`, `data/pi`, `data/published` or `public/snapshots` by hand; the API may only grow;
`npm run check` passes at the end of each step. Tests are Vitest, in `tests/*.test.ts`, against stand-ins: no test
reaches the network. `tests/helpers.ts` gains `fixturePi(providers = 12, modelsEach = 30): PiCatalog` (provider
ids `provider-00`…, the ids of `fixtureUpstream`, so that equal ids match) and a `fetch` stand-in that answers
per address.

### Step 1 (PIC-03): the import

Files: `src/core/pi.ts` (the `PiModel`, `PiFeed`, `PiCatalog` of section b, nothing else yet),
`src/core/schema.ts` (`PiMeta`), `scripts/lib/sync.ts`, `scripts/sync.ts`, `.gitignore`.

`tests/sync-pi.test.ts`, each case on a temp data directory with a first good import of both sources behind it:

1. a first import writes `data/pi/meta.json` and one file per provider, models sorted by id, `headers` kept;
   `sync-status.json` has `pi.status: "updated"`;
2. an unchanged feed (304): `If-None-Match` carried the stored ETag; only `checked_at` of `meta.json` moved;
   every file under `providers/` is byte-for-byte the same; status `unchanged`;
3. the same body without a 304 (equal digest): `unchanged`, no file rewritten;
4. a changed feed: status `updated`, the summary counts added, removed and changed models;
5. `it.each` over **down (HTTP 503), not JSON, another structure (a model without `cost`; `contextWindow` a
   string), a model whose key and id disagree, a model whose `provider` is not its provider key, a provider key
   that is not a valid id (`../x`), empty (`{}`), too small, 40 % of the models lost, 40 % of the providers lost**:
   `pi.status: "failed"` with an error; every byte under `data/pi/` as before; `report.ok` **true**; the models.dev
   part of the same run `updated` and `data/upstream/` replaced; `last_attempt_ok: true` and no `last_error`;
6. models.dev fails and pi succeeds: `report.ok` false, `data/upstream/` as before, `data/pi/` replaced,
   `last_error` names models.dev only;
7. both fail: both folders as before, both recorded;
8. an ETag stored for another address is not sent;
9. `--force` sends no `If-None-Match` and rewrites an equal body;
10. `only: "pi"`: the models.dev and measurement addresses are never requested, and their five fields of
    `sync-status.json` are as before;
11. the lock: a second `sync` while one holds the lock throws `SyncBusyError` (the existing test still passes).

`tests/sync.test.ts` passes unchanged except where it lists the fields of a report.

### Step 2 (PIC-04): the workflow, the README, the first snapshot

Files: `.github/workflows/publish.yml` as in section b; README "How the data is put together" (the diagram gains
`data/pi/`) and "Syncing" (both sources, the table of section b in words, `--only=pi`).

The first snapshot: `npm run sync -- --only=pi` on the branch, then commit `data/pi/` and `data/sync-status.json`
as the command wrote them. No test; the review reads the workflow against section b and checks
`git status --porcelain data/upstream` is empty in that commit.

### Step 3 (PIC-05): the contract

Files: `src/core/schema.ts`, `src/core/entries.ts` (types), `src/core/pi.ts` (the types `PiBlock`, `PiCost`,
`PiCostTier`, `PiDifference`, `PiSummary`), `src/core/contract.ts`, `src/core/query.ts`, `src/core/openapi.ts`,
`structure/api-v1.json` by `npm run structure:update`.

Because every entry must have every key, this step cannot be "no behaviour at all": it also makes `resolve()` put
`pi: null` on every entry, `summarize()` `pi: null` on every summary, and `publish()` a `meta.pi` with
`snapshot: null`, the `sync` keys from `sync-status.json` and every count 0. No pi data is read yet.

Tests: `tests/api-structure.test.ts` passes with the new record and reports no break against 1.0.0;
`tests/contract.test.ts` and the tests that check every published object against the contract pass;
`tests/api.test.ts` gains: `origin=pi` is accepted by `/entries` and `/providers` and returns nothing yet; `/meta`
has `pi` with `snapshot: null`; `info.version` is `1.2.0`.

### Step 4 (PIC-06): the block, the differences, `/meta`

Files: `src/core/pi.ts` (`piBlock`, `piDifferences`, the tier reading of section e, matching by equal ids),
`src/core/resolve.ts` (steps 3b and 6; `ResolveInput.pi` without aliases), `src/core/entries.ts`
(`summary.pi`), `scripts/lib/publish.ts` (load `data/pi/`, check it, pass it, `meta.pi`, licence files),
`scripts/build-data.ts` (the pi line), `scripts/compare-published.ts` and the script `compare:published` in
`package.json`.

`tests/pi-source.test.ts`:

1. a matched entry carries the block with every key of section d; a pi model with no entry adds nothing and is
   counted `unmatched`; an entry pi does not list has `pi: null`;
2. a pi model whose entry an override excludes, and one whose entry a catalog rule leaves out, are `left_out`;
3. a difference in each compared field, one test per row of the table in section e, each with both values;
4. agreeing values give `differences: []`; so do prices that differ only beyond the sixth decimal;
5. no difference where the entry has no value, where pi's price is 0, where a limit is 0, where the entry's
   cache-write price is keyed by lifetime, where the entry's price has a `unit`;
6. tiers: equal tiers written with `gt` on one side and `gte` on the other (32000 and `gte: 32001`) agree; a price
   that differs only in a tier gives exactly one `cost.tiers` item with both lists; tiers on one side only give
   one; an override on service tier or time of day is not a tier;
7. `headers`, `inputLimits.images.resize`, `lab`, `enabled`, `providers`, `free` appear nowhere in the published
   catalog; a model with `enabled: false` is skipped;
8. a feed value that is absent is `null` in the block (`compat`, `thinking_level_map`, `prompt_cache`, each key of
   `input_limits`), `""` as `base_url` is `null`, and no flag is filled in that the feed does not state;
9. **nothing existing moves:** `resolve(fixture)` and `resolve(fixture + pi)` give, for every entry, deep-equal
   records once `providers_dev.pi` is taken off, and deep-equal summaries once `pi` is taken off; provider
   summaries, canonical models and exclusions are deep-equal as they are;
10. a missing pi snapshot (`publish()` on a data directory without `data/pi/`): the dataset builds, no entry has a
    block, `meta.pi.snapshot` is `null` and every count 0; a `data/pi/` that does not fit `PiFeed`: the same, with
    `pi-snapshot-unreadable`;
11. `meta.pi.counts` add up: `entries_with_block + left_out_models + unmatched_models` is the number of models in
    the snapshot (while no entry comes from pi), and `meta.pi.sync` follows `sync-status.json`.

**The whole-dataset comparison** (third acceptance criterion). `npm run compare:published -- <before> <after>`
takes two `data/published/` directories and:

- refuses to run unless `meta.upstream.sha256` is the same in both (the same models.dev snapshot);
- for every entry of `<before>`: the same provider and model id is in `<after>`; the full entry is deep-equal once
  `providers_dev.pi` is taken off the `<after>` one; the summary is deep-equal once `pi` is taken off;
- every provider summary of `<before>`, every canonical model (as `canonicalModels` of `src/core/resources.ts`
  gives it from the index), the
  evaluations and corrections files, and `meta` without `dataset_version`, `generated_at`, `pi`, `issues` whose
  code starts with `pi-`, and the two new `license` keys, are deep-equal;
- `<after>` has no entry and no provider that `<before>` does not have;
- prints the counts compared and the first 20 differences, and exits 1 on any.

How it is run for this step: build `main` (the commit the branch is cut from) with `npm run data` and copy
`data/published/` aside; build the branch with the same `data/upstream/`, `data/sources/` and `data/authored/`,
and with `data/pi/` present; compare. Its whole output goes into the task's result.

### Step 5 (PIC-07): the report and the pairings

Files: `src/core/pi.ts` (`PiAliases`, rules 1 to 3 of section c with `same_as`, the issues, `PiReport`),
`scripts/lib/publish.ts` (load the alias file, write `data/published/pi-report.json`),
`data/authored/pi-aliases.yaml` with the provider and model `same_as` lines that are certain. The table of
section 0 is where the worker starts; each line is checked as section c says before it is written. No `only_pi`
and no `new` yet.

`tests/pi-source.test.ts` gains:

12. a provider `same_as`: its models match the paired provider's entries by equal id, the block's `provider` and
    `ref` are pi's spelling, `match` is `id`;
13. a model `same_as`: `match: "alias"`; an equal id beats an alias that points at the same entry
    (`pi-alias-conflict`);
14. `pi-alias-orphan` for a `same_as` naming a missing provider or entry and for a line naming a pi model that is
    gone; `pi-provider-collides` for a `same_as` on a provider id the catalog has; `pi-alias-redundant`;
    `pi-provider-undecided`; none of them is level `error`, and the build succeeds with each;
15. a pi model that resembles an entry (`gpt-6.1-sol` and `gpt-6-1-sol`) is **not** matched; it is in
    `unmatched` with the entry's id under `alike`;
16. the report: `totals` add up to the models of the snapshot; `publish()` writes `pi-report.json` beside `site/`
    and nothing under `site/` names it; the file is not written without a pi snapshot;
17. a `pi-aliases.yaml` that does not fit the schema fails `publish()` with the file and path named, as any
    authored file does; two pi provider ids with one `same_as` are refused.

The comparison of step 4 is run again (pairings add blocks, nothing else) and its output is in the result, with
the report's `totals` before and after.

### Step 6 (PIC-08): entries that come from pi alone

Files: `src/core/pi.ts` (`piEntry`, `new`, `only_pi`, `inherits`), `src/core/resolve.ts` (step 2b; step 3 skipping
an id that exists; the three source places and `labEntry` of section g), `src/core/entries.ts` and
`src/core/resources.ts` (origin `pi`; the evidence counts of section i; `describe`), `src/core/query.ts` (already
allows `pi`), `data/authored/pi-aliases.yaml`.

In this order, each its own commit, each with the report's totals in the result:

1. **The providers only pi has**: a `new` block for each pi provider id that, after step 5, is still undecided and
   is no provider of the catalog; an `inherits` line for each of their models (a ref, or `false`).
2. **The models only pi lists at providers both have**: `only_pi: true` for every model the report leaves
   unmatched and a person has checked against the provider's entries, with `inherits`.

`tests/pi-source.test.ts` gains:

18. a pi-only provider: its record (origin `pi`, name, access, evidence from the `new` block, `env: []`), every
    model of it an entry, a model added to the fixture later is an entry without a line;
19. a pi-only model of a shared provider: not published without `only_pi`, published with it, at the catalog's
    provider id for a paired provider;
20. the entry: each row of the table in section g, `cost` left out when both prices are 0, a cache price of 0
    left out, tiers as `overrides` that `pricingOf` reads back into rules with a `request.context_tokens`
    condition; `limits.input_window` with `source: "pi"`; pricing evidence naming pi's address; the block with
    `match: "sole"` and `differences: []`; the entry is valid against `EntrySchema`, its summary against
    `EntrySummarySchema`;
21. identity: `inherits` gives family, release date and `canonical_id` and records them in `inherited`; a catalog
    rule then leaves the entry out (a version rule and a release rule), and it is `left_out`; `inherits: false`
    raises nothing; no line raises `pi-identity-unknown` once per provider;
22. the same model arriving from models.dev afterwards (the fixture gains the id): origin `upstream`, models.dev's
    fields, the block kept with `match: "id"`, `pi-alias-redundant`;
23. a `new` provider arriving from models.dev afterwards: the record is models.dev's, `pi-provider-collides`,
    equal ids get blocks, the rest is unmatched and not published;
24. an addition of ours with the id of a pi provider, and one with the id of an entry from pi: ours is published,
    with the block;
25. overrides on an entry from pi: a `set` on `limit.context` publishes our value, records pi's under
    `provenance[].upstream`, turns the input window's source to providers.dev and adds a `context_window`
    difference; `exclude: true` removes it; a measurement mapped to a pi provider lands on the entry from pi and
    leaves its origin and its `limit`;
26. counts: `added_entries` and `added_providers` do not move; `pi.counts.sole_entries` and `sole_providers` do;
    an untouched entry from pi has summary origin `pi` and is not in `evidence_entry_count`; a touched one is
    `modified` and is; `origin=pi` returns the untouched ones;
27. an entry from pi is never `reference_ref` of a subscription entry or of a model that has another entry at the
    lab's provider.

The comparison is run with `<before>` = the dataset of step 5: the script's last check (no new entry or provider)
is switched off with `--allow-new`, and it then also prints how many entries and providers are new and, for
providers and canonical models, lists the ones whose aggregates moved (expected, section i) instead of failing on
them. Every entry of `<before>` must still be equal, field for field.

### Step 7 (PIC-09, PIC-10): pages and text

PIC-09 is the frontend designer's, to section h. What is not a matter of look and must hold: `sourceOf` and
`sourcesHtml` in `src/core/render.ts`, `detail-view.ts` (the provider's origin label) and `catalog-view.ts` (the
"Source" filter and column) never call an entry or a provider with origin `pi` "models.dev" or "providers.dev";
`ORIGIN_LABEL` and `ORIGIN_TITLE` in `src/core/format.ts` gain `pi`. `tests/pages.test.ts`: an entry page with a
block, one without, one with a difference (each difference's two values are on the page), one with origin `pi`
(the page names pi as the source and does not name models.dev as the source of any fact); `tests/render.test.ts`:
nothing on those pages that is not in the API answers they were drawn from.

PIC-10: README (the opening list, "How the data is put together", "Syncing", "API", "Licensing"), the methodology,
about and licensing text, `LICENSES/pi-MIT.txt`, `NOTICE.txt` in `scripts/lib/publish.ts`.

---

## 11. Where the spec and the code do not fit

1. **"The providers providers.dev does not have (11)" are mostly providers it has.** Five to nine of the eleven
   are a catalog provider under another id (section 0). Published as the spec words it ("first the providers
   providers.dev does not have … all models"), `fireworks`, `together`, `vercel-ai-gateway` and the others would
   put about 400 models in the catalog twice. Here: a pi provider id the catalog does not have is published only
   once the alias file says `same_as` or `new` for it, and the provider record's name and access have to be
   authored anyway, because pi's feed has none.
2. **"1,128 pi models match nothing" counts 481 that models.dev lists.** They are entries the catalog rules leave
   out. Matching is therefore done before the exclusions, and `/meta` counts them apart (`left_out_models`).
3. **An entry from pi has no family and no release date**, and the catalog rules read nothing else. Without
   `inherits` (section g) the rules would not apply to entries from pi at all. The spec's PIC-08 does not name
   this; it adds an `inherits` line to each model there.
4. **"The additions to `v1` as a change to `src/core/openapi.ts`"**: the document is generated from
   `src/core/contract.ts`; the change is mostly there (section d).
5. **PIC-05 "No behaviour yet"** cannot hold as written: a key that every entry must have has to be emitted, as
   `null`, in the same step (section j, step 3).
6. **PIC-06 names `scripts/build-data.ts` and `src/core/resolve.ts`**; the work is in `scripts/lib/publish.ts`,
   `src/core/resolve.ts`, `src/core/entries.ts` and a new `src/core/pi.ts`.
7. **"A value the feed does not state is null or absent"** needs one more sentence for prices: the feed always
   states a number, and its 0 is not a statement (sections 0, e, g).
8. **`npm run sync -- --only=pi`** is not in the spec. Without it the first pi snapshot cannot be written into a
   branch without also moving `data/upstream/`.
9. **The run is marked failed when pi alone fails**, after it has built, committed and deployed. The spec says "a
   pi failure is reported"; this is how models.dev's is, and the other reading (a warning on a green run) lets a
   dead source go unnoticed. One line of the workflow to change if the owner prefers the warning.
10. **A new model at a `new` provider is published without identity** until someone writes its line (reported).
    The stricter alternative, nothing from pi is published without a line of its own, would make the catalog rules
    airtight and would end "automatically" for entries from pi. This document chose the first.
11. **The research's "312 providers"** are the providers with at least one entry; the dataset has 333 provider
    records. pi's "43 providers" include one with no models.
12. **Where the document lives.** The repository keeps its two design documents in `design/`
    (`design/safe-cache-lifetime.md`, `design/usable-input-window.md`); the task and the spec name
    `docs/design/pi-source.md`, which is where this file is. One `git mv` if the repository's place is preferred.
