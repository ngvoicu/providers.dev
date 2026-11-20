# pi's model catalog as a second imported source

Design for the spec `pi-catalog-source` (items PIC-01 and PIC-13). Written 2026-11-20 against `main` at `6b95938`
(models.dev snapshot `e06a33e`, 329 providers, 10,698 models) and the pi feed as served that day
(ETag `"2197505f0de684a3eec3fcf68f253e97"`, revision `sha256-dd93eb27…`, 43 provider keys, 1,698 models).

This document says what the software is. The spec says what work is done and in what order. Where a worker's
brief and this document disagree, this document is corrected first.

**pi** is a coding agent (`github.com/earendil-works/pi`, MIT). Its model catalog is served as JSON at
`https://pi.dev/api/models`. providers.dev is not affiliated with pi.

**Decided by the owner:**

- models.dev stays the reference; pi is an extra source beside it, imported automatically.
- What pi states for an entry is published on that entry, as a block of its own. Nothing of pi's is merged into
  an entry's existing fields.
- **No entry and no provider comes from pi alone.** A pi model that belongs to no entry is counted and listed in a
  report, nothing more (section g).
- A run in which only the pi import fails stays green, with a warning on the run.
- **Nothing on pi's side may ever stop the models.dev import, the build or the deploy.** This is the owner's first
  requirement, and section k, the fence, is how the software holds it: by its structure, not case by case.

Sections (a) to (j) keep the letters of the design task. Section 0 holds what was measured. Section k is the
fence around the pi part, written after the first build and its reviews; where an earlier section and section k
speak of the same thing, section k decides. Section 11 lists where the spec's first wording and the code did not
fit, for the record.

---

## 0. What was measured

All counts: the pi feed of 2026-11-20 against the dataset built from `main` `6b95938` (6,318 entries).

**The feed.** One JSON object keyed by provider id; each value an object keyed by model id. 43 provider keys,
one of them (`typesafe`) with no models. Every model has `id`, `name`, `api`, `provider`, `baseUrl`, `reasoning`,
`input`, `cost`, `contextWindow`, `maxTokens`, `type`; every `id` equals its key and every `provider` equals its
provider key. There is no provider record: no provider name, documentation link or environment variable.
The response carries `ETag`, `Last-Modified` and `x-pi-model-catalog-revision`.

**Matching by equal provider id and model id, nothing paired by hand.**

| pi models | count |
|---|---|
| equal ids with a published entry | 570 (566 imported, 4 added by providers.dev) |
| equal ids with a models.dev entry that the catalog rules leave out | 481 |
| no entry with these ids, in models.dev or in our additions | 647 |
| total | 1,698 |

So of the 1,128 pi models that match no *published* entry, 481 are listed by models.dev and left out by
`data/authored/catalog-rules.yaml` (released before 2026, Claude before 5.5, GPT before 6). Matching is therefore
done before the exclusions (section c).

**The provider ids.** Of the 11 pi provider ids the catalog does not have, eight are a provider the catalog has
under another id. Each pairing below rests on an address that both catalogs, or the provider's own documentation,
state; the pairings are the first content of the alias file (section c).

| pi provider id | catalog provider | what makes it certain | equal model ids |
|---|---|---|---|
| `fireworks` | `fireworks-ai` | both catalogs give the base URL `https://api.fireworks.ai/inference/v1` | 27 of 27 |
| `together` | `togetherai` | pi's base URL `https://api.together.ai/v1` is the one Together AI's documentation gives, and that documentation (`docs.together.ai`) is what models.dev's `togetherai` links to; both read the key from `TOGETHER_API_KEY` | 16 of 16 |
| `vercel-ai-gateway` | `vercel` | models.dev names `vercel` "Vercel AI Gateway" with base URL `https://ai-gateway.vercel.sh/v1`; pi's is `https://ai-gateway.vercel.sh` | 257 of 305 |
| `kimi-coding` | `kimi-code-plan-cn` | both give `https://api.kimi.com/coding/v1` (models.dev's `kimi-code-plan-global` is `api.kimi.ai`) | 6 of 6 |
| `zai-coding-cn` | `zhipuai-coding-plan` | both give `https://open.bigmodel.cn/api/coding/paas/v4` | 4 of 4 |
| `ant-ling` | `bailing` | both give `https://api.ant-ling.com/v1` | 0 of 3 (pi lists the 2.6 models, models.dev the 3.x ones) |
| `qwen-token-plan` | `alibaba-token-plan` | pi's host `token-plan.maas.qwencloudapi.com` is the host models.dev's own `alibaba-token-plan` record gives for two of its models (`qwen-image-3.0-pro`, `qwen-audio-3.0-asr-flash`) | 20 of 20 |
| `qwen-token-plan-cn` | `alibaba-token-plan-cn` | the same with `token-plan.maas.qianwenaiapi.com` | 20 of 20 |

Not paired, and so not in any entry:

- `qwen-token-plan-individual`, `qwen-token-plan-individual-cn`: in pi the same host and the same key variable as
  `qwen-token-plan(-cn)`, 13 of its 20 models, with the same prices on all 13. They would reach the entries the
  other id already reaches, and one entry carries one pi block.
- `radius`: pi's own gateway (`https://radius.pi.dev/v1`); the catalog has no such provider.

**With the eight pairings:**

| pi models | count |
|---|---|
| belong to a published entry (it carries a pi block) | 813 |
| belong to an entry the catalog rules leave out | 588 |
| belong to no entry | 297 |
| total | 1,698 |

The 297: `openrouter` 95 and `vercel-ai-gateway` 48 (nearly all `:batch` and `-batch` variants),
`cloudflare-ai-gateway` 63, `radius` 39, `azure` 15, the two `qwen-token-plan-individual` ids 13 each,
`openai-codex` 4, `ant-ling` 3, `zai` 2, `mistral` 1, `openai` 1.

**Differences, over the entries that carry a pi block by equal ids:** the input, output and cache-read price each
differ on 17, the context window on 28, the output limit on 19; one side has price tiers and the other none on 5.
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

The sync gains a third part beside `syncUpstream` and `syncMeasurements`. The part's own code is in
`scripts/lib/pi-sync.ts`; `scripts/lib/sync.ts` keeps the types below and the one call into the fence (section k):

```ts
// src/core/schema.ts
export const PI_URL = "https://pi.dev/api/models";

// scripts/lib/pi-sync.ts
/** An import smaller than this is treated as broken, whatever the previous snapshot held. */
const PI_MIN_PROVIDERS = 10;
const PI_MIN_MODELS = 300;
/** An import larger than this is treated as broken: it is not read to the end. */
export const PI_MAX_BYTES = 16 * 1024 * 1024;
/** The whole pi request, headers and body together, must be done within this. */
export const PI_DEADLINE_MS = 60_000;
/** An import that kept less than this share of the previous snapshot's providers or models is treated as broken. */
const PI_MIN_SHARE = 0.6;

export function storedPi(dataDir: string): StoredPi;
export function piProviderFile(id: string, models: Record<string, PiModel>): string;
export async function syncPi(options): Promise<{ status: "updated" | "unchanged"; summary?: string[]; revision?: string }>;

// scripts/lib/sync.ts

export interface SyncOptions { /* as today */ only?: "pi" }
export interface PartReport {
  /** "skipped": the report's word for a part that did not run (`only: "pi"`). Never stored, never published. */
  status: "updated" | "unchanged" | "failed" | "skipped";
  error?: string;
  summary?: string[];
}
/** What data/sync-status.json can hold for a part: never "skipped". */
export type StoredStatus = Exclude<PartReport["status"], "skipped">;
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
  upstream: StoredStatus;
  measurements: StoredStatus;
  // new
  pi?: { last_attempt_at: string; status: StoredStatus; error?: string };
}
```

`skipped` is the report's word for a part that did not run, and nothing else's: under `--only=pi` the report gives
`upstream` and `measurements` as `skipped`. It is never written to `data/sync-status.json` (whose part fields are
typed `StoredStatus`), `writeStepOutputs` writes no line for a skipped part, and nothing published reads it.

`sync()` runs the three parts in this order: models.dev, measurements, pi. One lock (`data/.sync.lock`) covers the
run, as today. models.dev and the measurements run inside the existing `part()` wrapper. The pi part runs behind
the fence (section k): everything pi does in the sync lives in `scripts/lib/pi-sync.ts` (`syncPi`, `storedPi`,
`loadPi`, `piSnapshotFault`, `piProviderFile`, the constants above except `PI_URL`), and `sync()` reaches it through
one call, `piOfSync`.

`scripts/lib/pi-sync.ts` imports no value from `scripts/lib/sync.ts`: only types. The share above, the reading of
the ETag (`response.headers.get("etag")`) and the summary of an import (`first import: …`, providers added and
removed, `models: +a added, -r removed, c changed`, in the words of the models.dev one) are pi's own there, the
summary with its lookups by own property (section k). `MIN_SHARE`, `etagOf` and `summarize` of `sync.ts` are
again private to it, as on `main`.

`storedPi` is the one answer to "is there a stored pi snapshot that can be used", for the sync and the build alike:
**none** only where the folder `data/pi/` does not exist; **usable** where it loads, its `meta.json` fits `PiMeta`,
it is whole (every provider file named by its id, every model's key its id and its provider the file's, the counts
those of `meta.json`), it fits `PiFeed`, and the copy checked against `PiFeed` holds every model of the files (the same count); **unusable**, with the reason, in every other case, a `data/pi/`
without a `meta.json` or with one that holds `null` included.

### What `syncPi` does, in order

1. Read the previous snapshot (`storedPi`, the build's answer too). A stored snapshot that cannot be used (it does
   not load, is not whole or does not fit `PiFeed`) counts as none: the import is then in every respect a first
   import. Send `If-None-Match: <stored etag>` when there is a previous snapshot,
   its `meta.source` is `PI_URL`, it has an ETag and `--force` was not given. Headers: `Accept: application/json`,
   `User-Agent: providers.dev sync`. Node's `fetch` receives a weak ETag from the feed (`W/"2197505f…"`, where a
   plain `curl` gets the strong one); it is stored and sent back as received, and the feed answers 304 to it.
   One deadline, `PI_DEADLINE_MS` (60 s), covers the request and the whole body: past it the request is aborted and
   the part fails with `pi.dev did not answer in full within 60 s`. The body is read from its stream and the part
   fails with `the pi feed is unexpectedly large: more than 16 MB` as soon as more than `PI_MAX_BYTES`
   (16 × 1024 × 1024; the feed is 1 MB) have arrived, without reading the rest.
2. `304` with a previous snapshot of the same source: rewrite `meta.json` with a new `checked_at`, return
   `unchanged`. Nothing else is written.
3. Any other status that is not 2xx: fail with `pi.dev answered HTTP <status>`.
4. The body is not JSON: fail with `pi.dev did not return JSON`.
5. Structure (`PiFeed` of `src/core/pi.ts`, below): fail with
   `the pi feed does not match the expected structure (<n> problems; first: …)`, the first five problems named, as
   the models.dev import words it.
6. Identity: every provider key matches `PROVIDER_ID` (`src/core/schema.ts`; it becomes a file name); every model's
   `id` equals its key; every model's `provider` equals its provider key. Otherwise fail, naming the key.
   And every model of the body is a model of the copy checked against `PiFeed`: where the copy holds fewer (zod's
   record drops the key `__proto__`), fail with `the pi feed has a model id the build cannot hold`, so that the
   last good snapshot stays. (Step F3.)
7. Size: fewer than `PI_MIN_PROVIDERS` provider keys or `PI_MIN_MODELS` models: fail with
   `the pi feed is unexpectedly small: <p> providers, <m> models`. This is the "empty" case.
8. Shrinkage, where there is a previous snapshot: fewer than 60 % of its providers or of its models: fail with
   `the pi feed shrank too much to trust: …`, as the models.dev import words it.
9. Digest: where the body's sha256 equals the previous one, same source, no `--force`: rewrite `meta.json` with a
   new `checked_at` and the new ETag, return `unchanged`.
10. Write `data/pi.tmp-<pid>/` in full, then `swapDir` it over `data/pi/`. What is written is the feed as it arrived
    (the parsed body); the copy checked against `PiFeed` is used only to validate, because the schema puts the keys
    of a model in its own order. Return `updated` with a summary in the
    same words as the models.dev one (`first import: …`, or providers added and removed and
    `models: +a added, -r removed, c changed`). **The swap is the last thing `syncPi` does:** the summary and
    everything else that can throw is worked out before it, so that a part that failed has not replaced the
    snapshot.

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
changes them. `pi.last_attempt_at` is the time the pi part ended. The `pi` record has one definition,
`PiSyncRecord` (`{ last_attempt_at: string, status: "updated" | "unchanged" | "failed", error?: string }`, strict),
and is written twice in a run, before the pi part and after it (section k, 2), so that it always speaks of this
attempt.

`scripts/sync.ts` prints one more line, `pi: <status>[ - <error>]`, with the summary lines under it. When pi alone
failed it prints `The pi import failed. The last good pi snapshot is unchanged and is still what gets published.`
and exits 0. When the environment variable `GITHUB_OUTPUT` is set, it appends three lines to that file,
`upstream=<status>`, `measurements=<status>`, `pi=<status>`, **before** it exits, whatever the exit code. The
writing is a function of `scripts/lib/sync.ts`, `writeStepOutputs(report: SyncReport, path: string): void`, which
`scripts/sync.ts` calls with `process.env.GITHUB_OUTPUT`.

`npm run sync -- --only=pi` runs the pi part alone: the other two do not run, their five fields in
`sync-status.json` stay as they were, and the exit code is 1 if the pi part failed. It exists so that the first pi
snapshot can be written into a branch without moving `data/upstream/`. `--force` applies to every part that runs.

### A fresh clone without a pi snapshot

`npm run build` works: there is no folder `data/pi/`, no entry gets a pi block, and `/api/v1/meta` says so
(`pi.snapshot: null`, every pi count 0), with no warning: this is the one state without pi data that is not a
fault. The build never stops for want of pi data. (It still stops, as today, for want of a models.dev snapshot.)

### The workflow (`.github/workflows/publish.yml`)

- The import step is renamed `Import models.dev, the measurements and pi`; the command is unchanged
  (`npm run sync -- ${{ inputs.force && '--force' || '' }}`); `continue-on-error: true` stays. The description of
  the `force` input becomes `Download again even if a source says nothing changed`.
- A new step **directly after the import step**:

  ```yaml
      - name: Warn about a failed pi import
        if: steps.sync.outputs.pi == 'failed'
        run: echo "::warning title=The pi import failed::The site is built and deployed with the last good pi snapshot; models.dev was imported as usual. See the 'Import' step for the reason."
  ```

  It puts a warning annotation on the run and succeeds. It stands before the build so that the warning is on the
  run whatever happens after it.
- `Keep the new snapshot` keeps its condition (`steps.sync.outcome == 'success'`, which is also true when pi alone
  failed). Its test becomes
  `git status --porcelain data/upstream/providers data/sources/observed.json data/pi/providers`, it adds
  `data/pi` to `git add`, and the commit message names what changed: `sync: models.dev <commit7>` when
  `data/upstream/providers` changed, `sync: pi <revision7>` when only `data/pi/providers` did (the seven characters
  after `sha256-` of `meta.revision`, else `snapshot`), `sync: models.dev <commit7>, pi <revision7>` for both, and
  `sync: measurements` when only the measurements file did. `data/pi` is added only where the folder exists. The
  step reads no file of pi's: `<revision7>` is the step output `pi_revision7` of the import step (section k, 3).
- A second warning step, **directly after the build step**, for a build that left pi data out or published it with no
  block (section k, 3).
- The last step, `Report a failed import`, is **unchanged**: its condition stays `steps.sync.outcome == 'failure'`,
  which a pi failure alone never makes true.

What a run looks like:

| | build, tests, snapshot commit, deploy | the run on GitHub | `/api/v1/meta` of that deploy |
|---|---|---|---|
| only the pi import fails | all run, with the last good pi snapshot | **green**, with the warning annotation | `pi.sync.last_attempt_ok: false`, `pi.sync.last_error` the reason; `sync.last_attempt_ok: true` |
| models.dev or the measurements fail | as today (no snapshot commit; build and deploy from the last good snapshot) | failed, as today | `sync.last_attempt_ok: false`, as today |
| both fail | as today | failed, and the warning annotation | both say so |

On a push to `main` the import step is skipped, its output is empty and nothing is reported.
`.github/workflows/check.yml` is unchanged: a pull request builds from the snapshots in the repository.

---

## c. Matching

Matching decides, for each pi model, which entry it speaks of. It is done once per build, in `resolve()`, from the
pi snapshot and one authored file. **Nothing is ever matched by similarity when the data is built.**

### The alias file, `data/authored/pi-aliases.yaml`

The adapter between pi's spelling and the catalog's. Authored by people, checked by the build like every file in
`data/authored/` (a file that is not valid YAML or does not fit the schema fails `npm run data`). The file may be
absent: then only equal ids match.

It can say two things, and nothing else:

- a pi **provider** id is this provider of the catalog (`same_as` on a provider);
- a pi **model** id is this entry of that provider (`same_as` on a model).

```ts
// src/core/pi.ts
const PiModelLine = z.strictObject({
  /** The model id of the entry, at the catalog's provider, that is this pi model under another spelling. */
  same_as: z.string().min(1),
  note: z.string().optional(),
});

const PiProviderLine = z.strictObject({
  /** The provider of the catalog that this pi provider id is. Left out where the catalog has the pi id itself. */
  same_as: z.string().regex(PROVIDER_ID).optional(),
  reason: z.string().min(1).optional(),            // required with same_as
  evidence: z.array(Evidence).min(1).optional(),   // required with same_as
  /** The day the model lines were checked against the report. Required when `models` has a line. */
  checked: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  models: z.record(z.string().min(1), PiModelLine).default({}),
}).superRefine(/* the three requirements named above; a line with neither same_as nor a model is refused */);

export const PiAliases = z.strictObject({ providers: z.record(z.string().regex(PROVIDER_ID), PiProviderLine).default({}) })
  .superRefine(/* two pi provider ids may not have the same same_as */);
export type PiAliases = z.infer<typeof PiAliases>;
```

When a line may be written:

- `same_as` on a provider: only where the two ids name the same service: the same base URL in both catalogs, or
  the provider's own documentation or models.dev's own record showing pi's address. Equal model ids alone are not
  enough.
- `same_as` on a model: only where the two ids name the same model at the same provider, the same deployment and
  price class. A `:batch` or `-batch` id is **not** the same as the id without it: it is another way to buy the
  model, with its own price. It gets no line and stays unmatched.

### The first content of the file

Written into the file as it stands here in step 5 (section j). Each pairing was read on 2026-11-20 in pi's feed and
in the models.dev snapshot `e06a33e`; section 0 has the counts.

```yaml
# data/authored/pi-aliases.yaml
# The adapter between pi's model catalog (https://pi.dev/api/models) and this catalog: which pi provider id is
# which provider here, and which pi model id is which entry. Only pairs that are certain. Nothing is matched by
# similarity when the data is built; a pi model with no pair and no equal id belongs to no entry and is listed in
# data/published/pi-report.json.
providers:
  fireworks:
    same_as: fireworks-ai
    reason: Both catalogs give the same base URL for the provider.
    evidence:
      - kind: listed
        url: https://pi.dev/api/models
        date: "2026-11-20"
        note: 'fireworks: baseUrl "https://api.fireworks.ai/inference/v1" (11 models) and "https://api.fireworks.ai/inference" (16).'
      - kind: listed
        url: https://models.dev/experimental/v2.0/api.json?include=openai-codex
        date: "2026-11-20"
        note: 'fireworks-ai ("Fireworks AI"): base_url "https://api.fireworks.ai/inference/v1". All 27 pi model ids are ids of it.'

  together:
    same_as: togetherai
    reason: >-
      pi's base URL is the one Together AI's own documentation gives, and that documentation is the one models.dev
      links for togetherai.
    evidence:
      - kind: documented
        url: https://docs.together.ai/docs/openai-api-compatibility
        date: "2026-11-20"
        note: 'The page gives the base URL "https://api.together.ai/v1", which is pi''s baseUrl for together.'
      - kind: listed
        url: https://models.dev/experimental/v2.0/api.json?include=openai-codex
        date: "2026-11-20"
        note: 'togetherai ("Together AI"): doc "https://docs.together.ai/docs/serverless-models", env TOGETHER_API_KEY, base_url "https://api.together.xyz/v1". All 16 pi model ids are ids of it.'

  vercel-ai-gateway:
    same_as: vercel
    reason: models.dev's vercel is the Vercel AI Gateway, on the host pi names.
    evidence:
      - kind: listed
        url: https://pi.dev/api/models
        date: "2026-11-20"
        note: 'vercel-ai-gateway: baseUrl "https://ai-gateway.vercel.sh" on all 305 models.'
      - kind: listed
        url: https://models.dev/experimental/v2.0/api.json?include=openai-codex
        date: "2026-11-20"
        note: 'vercel is named "Vercel AI Gateway", base_url "https://ai-gateway.vercel.sh/v1". 257 of the 305 pi model ids are ids of it.'

  kimi-coding:
    same_as: kimi-code-plan-cn
    reason: Both catalogs give the same base URL; models.dev's other Kimi coding plan is on another host.
    evidence:
      - kind: listed
        url: https://pi.dev/api/models
        date: "2026-11-20"
        note: 'kimi-coding: baseUrl "https://api.kimi.com/coding/v1".'
      - kind: listed
        url: https://models.dev/experimental/v2.0/api.json?include=openai-codex
        date: "2026-11-20"
        note: 'kimi-code-plan-cn ("Kimi For Coding (kimi.com)"): base_url "https://api.kimi.com/coding/v1"; kimi-code-plan-global is "https://api.kimi.ai/coding/v1". All 6 pi model ids are ids of it.'

  zai-coding-cn:
    same_as: zhipuai-coding-plan
    reason: Both catalogs give the same base URL for the provider.
    evidence:
      - kind: listed
        url: https://pi.dev/api/models
        date: "2026-11-20"
        note: 'zai-coding-cn: baseUrl "https://open.bigmodel.cn/api/coding/paas/v4".'
      - kind: listed
        url: https://models.dev/experimental/v2.0/api.json?include=openai-codex
        date: "2026-11-20"
        note: 'zhipuai-coding-plan ("Zhipu AI Coding Plan"): base_url "https://open.bigmodel.cn/api/coding/paas/v4". All 4 pi model ids are ids of it.'

  ant-ling:
    same_as: bailing
    reason: Both catalogs give the same base URL for the provider.
    evidence:
      - kind: listed
        url: https://pi.dev/api/models
        date: "2026-11-20"
        note: 'ant-ling: baseUrl "https://api.ant-ling.com/v1".'
      - kind: listed
        url: https://models.dev/experimental/v2.0/api.json?include=openai-codex
        date: "2026-11-20"
        note: 'bailing ("Bailing"): base_url "https://api.ant-ling.com/v1". No model id is in both: pi lists Ling-2.6-1T, Ling-2.6-flash and Ring-2.6-1T, models.dev the 3.x models.'

  qwen-token-plan:
    same_as: alibaba-token-plan
    reason: models.dev's own record of alibaba-token-plan names the host pi sends this provider's requests to.
    evidence:
      - kind: listed
        url: https://pi.dev/api/models
        date: "2026-11-20"
        note: 'qwen-token-plan: baseUrl "https://token-plan.maas.qwencloudapi.com/compatible-mode/v1".'
      - kind: listed
        url: https://models.dev/experimental/v2.0/api.json?include=openai-codex
        date: "2026-11-20"
        note: 'alibaba-token-plan ("Alibaba Token Plan"): base_url "https://token-plan.maas.qwencloudapi.com/api/v1" on qwen-image-3.0-pro and qwen-audio-3.0-asr-flash. All 20 pi model ids are ids of it.'

  qwen-token-plan-cn:
    same_as: alibaba-token-plan-cn
    reason: models.dev's own record of alibaba-token-plan-cn names the host pi sends this provider's requests to.
    evidence:
      - kind: listed
        url: https://pi.dev/api/models
        date: "2026-11-20"
        note: 'qwen-token-plan-cn: baseUrl "https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1".'
      - kind: listed
        url: https://models.dev/experimental/v2.0/api.json?include=openai-codex
        date: "2026-11-20"
        note: 'alibaba-token-plan-cn ("Alibaba Token Plan (China)"): base_url "https://token-plan.maas.qianwenaiapi.com/api/v1" on qwen-image-3.0-pro and qwen-audio-3.0-asr-flash. All 20 pi model ids are ids of it.'

# Not paired on purpose:
#   qwen-token-plan-individual, qwen-token-plan-individual-cn: in pi the same host and key as qwen-token-plan(-cn),
#     13 of its 20 models at the same prices. One entry carries one pi block.
#   radius: pi's own gateway. The catalog has no such provider.
```

A model line, for when step 5 or a later day finds one (the ids here only show the shape):

```yaml
  openrouter:                    # a pi provider id the catalog has itself: no same_as, only models
    checked: "2026-11-21"
    models:
      "vendor/model-v2":         # pi's model id
        same_as: "vendor/model-2"  # the id of the entry of openrouter that is this model
```

### The rule

"The catalog" below is the catalog as `resolve()` has it **before any exclusion**: the models.dev snapshot, our
additions and the entries that exist because we measured them (after step 3 of `resolve()`, before step 4).

1. **The provider.** For a pi provider id `P`:
   - the catalog has a provider `P`: that is its provider (the provider is *shared*);
   - else `providers.P.same_as` names a provider the catalog has: that one (*paired*);
   - else the catalog has no such provider (*absent*): none of its models belongs to an entry.
2. **The entry.** For a pi model `M` of a shared or paired provider `T`:
   - `T` has an entry with the id `M`: that entry. Equal model ids always come first;
   - else `providers.P.models.M.same_as` names an entry `T` has: that entry;
   - else the model belongs to no entry.
3. **One pi model per entry.** Where two pi models reach the same entry, the one whose provider id and model id
   are both the entry's keeps it; else the first by pi provider id and then pi model id in plain character order.
   The others belong to no entry.
4. **What a pi model then is**, exactly one of:
   - **matched**: its entry is in the published catalog. The entry carries the pi block (section d). The block's
     `match` is `id` where pi's provider id and model id are both the entry's, `alias` where the alias file paired
     the provider, the model or both.
   - **left out**: its entry was in the catalog before the exclusions and an override or a catalog rule left it
     out. Nothing of it is published.
   - **unmatched**: it belongs to no entry. Nothing of it is published; it is counted in `/meta` and listed in
     the report.

The three counts add up to the models in the snapshot, every build.

What the build reports as an issue (`/api/v1/meta`, the console, the *Our data* page). None is an error: no
change in pi's feed or in models.dev can make the build fail through this file. Without a pi snapshot the alias
file is checked against its schema and nothing else, and none of these is raised.

| code | level | when |
|---|---|---|
| `pi-provider-collides` | warning | a provider line has `same_as` for a pi provider id that the catalog has itself (models.dev or we added it since). The catalog's own provider is used and the `same_as` is ignored. |
| `pi-alias-orphan` | warning | a `same_as` names a provider or an entry the catalog does not have; or a line names a pi provider or a pi model the snapshot does not have. |
| `pi-alias-conflict` | warning | rule 3 took an entry away from a pi model. |
| `pi-alias-redundant` | notice | a model line is no longer needed: the provider now has an entry with the pi model's own id. |
| `pi-snapshot-unreadable` | warning | the fence turned pi's data or the record of the last pi import away (section k): once per part turned away, with the reason. The one sign that a dataset is without pi data through a fault. |
| `pi-no-blocks` | warning | the fence took pi's data and no entry has a pi block (section k): once, with the snapshot's models and the two other counts. The data is published as pi's code gave it. |

These are added to `Issue["code"]` in `src/core/schema.ts`. An unmatched pi model and an absent pi provider are
**not** issues: they are the report's.

### The report

`npm run data` writes `data/published/pi-report.json`: beside the published data, not under `site/`, so it is
never staged, served or part of the API (`scripts/lib/stage.ts` copies `data/published/site/` only), and not in
git (`data/published/` is ignored). `publish()` writes it into the temporary directory before the swap. Without a
readable pi snapshot the file is not written.

```ts
// src/core/pi.ts. resolve() returns it as `pi`; publish() writes it and takes the /meta counts from `totals`.
export interface PiReport {
  totals: { models: number; matched_id: number; matched_alias: number; left_out: number; unmatched: number };
  providers: {
    pi_provider: string;
    state: "shared" | "paired" | "absent";
    catalog_provider: string | null;
    models: number; matched: number; left_out: number; unmatched: number;
    /** A hint for a person: providers of the catalog with an entry whose api base_url has the host of this provider's baseUrl. */
    same_host: string[];
  }[];
  unmatched: {
    pi_provider: string; pi_model: string; name: string;
    why: "provider-absent" | "no-entry" | "alias-orphan" | "alias-conflict";
    /** A hint for a person: ids of the provider's entries that are equal to pi_model once both are lower-cased and every character that is not a letter or a digit is dropped. */
    alike: string[];
  }[];
  left_out: { pi_provider: string; pi_model: string; entry: string; by: string }[];  // by: a rule id, or "override"
}
```

The lists are sorted by pi provider id, then pi model id. `same_host` and `alike` are the only places where
anything like similarity is computed; they are read by the person who writes the alias file and by nothing else.
`scripts/build-data.ts` prints one line after the published line:
`pi: <n> entries with a pi block, <l> pi models left out, <u> unmatched`.

---

## d. The additions to `v1`

The OpenAPI document is generated: its component schemas come from `COMPONENTS` in `src/core/contract.ts`, its
types from `src/core/schema.ts` and `src/core/entries.ts`. `src/core/openapi.ts` itself only gets the version, one
sentence and one guide section.

**Version:** `info.version` becomes `1.2.0`.

Three additions, and no other: a key on every entry, a key on every entry summary, a key in `/meta` (with two
keys of `license`). Nothing that exists is renamed, retyped or removed; **no existing enumerated field gets a new
value, no parameter a new allowed value, and there is no new path or parameter.** Every key added is filled by
the build on every object.

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
  match: z.enum(["id", "alias"]).describe("How the entry and pi's model belong together. id = pi's provider id and model id are the entry's. alias = providers.dev paired the provider id, the model id or both by hand, because pi spells them otherwise."),
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

`EntrySummarySchema` gains `pi`, the block in short, or `null`. New component `PiSummary`. `Summary`
(`src/core/entries.ts`) gains `pi: PiSummary | null`.

```ts
export const PiSummarySchema = z.strictObject({
  ref: z.string().describe("providers_dev.pi.ref of the full entry."),
  api: z.string().describe("providers_dev.pi.api of the full entry."),
  match: z.enum(["id", "alias"]).describe("providers_dev.pi.match of the full entry."),
  difference_count: z.int().min(0).describe("How many items providers_dev.pi.differences of the full entry has."),
}).describe("The pi block of an entry in short.") satisfies z.ZodType<PiSummary>;
```

### 3. In `/api/v1/meta`: `pi`, and two keys of `license`

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
  }).nullable().describe("The pi import this dataset is built on. Null = it is built without pi data: no entry has a pi block."),
  sync: z.strictObject({ last_attempt_at: z.string().nullable(), last_attempt_ok: z.boolean().nullable(), last_error: z.string().nullable() })
    .describe("The last attempt to import pi's catalog. All null = no attempt is recorded. A failed attempt leaves the snapshot above as it was. `sync` beside `upstream` speaks of models.dev and the evaluations only."),
  counts: z.strictObject({
    entries_with_block: z.int().describe("Entries with a pi block."),
    left_out_models: z.int().describe("pi models whose entry providers.dev leaves out (exclusions)."),
    unmatched_models: z.int().describe("pi models that belong to no entry. Nothing of them is published."),
  }).describe("The three add up to snapshot.models."),
}).describe("pi's model catalog, the second imported source: where it came from, whether the last import worked, and how much of it is in this dataset."),
```

`Meta` (`src/core/schema.ts`) gains the same `pi`. It is always there: without a snapshot, `snapshot` is `null`
and the three counts are 0. `license` (an open object) gains
`pi: "pi (https://github.com/earendil-works/pi), MIT License, <the copyright line of pi's LICENSE file>"` and
`pi_notice: "The pi block of an entry (providers_dev.pi) is imported from https://pi.dev/api/models. providers.dev is not affiliated with or endorsed by pi."`.
`license.data`, `license.upstream` and `license.notice` keep their text. `counts` of `/meta` is untouched.

### 4. In `src/core/openapi.ts`

- `info.version: "1.2.0"`.
- `info.description` gains one sentence after the models.dev one: `A second catalog, pi's (MIT), is imported
  beside it: what it states for an entry is under providers_dev.pi.`
- `x-guide` gains a section `{ id: "pi", title: "pi's catalog" }` after `input-window`, with these paragraphs, in
  this order: (1) what the second source is, that models.dev stays the reference, that nothing of pi's is merged
  into `limit`, `cost` or `capabilities`, and that a model only pi lists is not an entry; (2) the pi block and
  its `match`; (3) only what the feed states: flags and levels not named follow pi's own defaults, which are not
  published; a price of 0 in the block is not a statement of no charge; (4) the differences, with the rule of
  section e in full; (5) `/meta.pi`. The words are the worker's; the facts are this document's. "Since 1.2.0" is
  said in the section.
- Nothing else. `ENDPOINTS` and `src/core/query.ts` are unchanged.

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

### Example 2: an entry paired through the alias file, differing only in its tiers

`GET /api/v1/entries/vercel/alibaba/qwen3.7-flash`, `data.entry.providers_dev.pi`, once the alias file pairs
`vercel-ai-gateway` with `vercel`. The entry's own `cost` has two size tiers, written
`"when": { "context": { "gt": 32000 } }` and `{ "gt": 256000 }`; pi's begin one token earlier.

```json
{
  "ref": "vercel-ai-gateway/alibaba/qwen3.7-flash",
  "provider": "vercel-ai-gateway",
  "model": "alibaba/qwen3.7-flash",
  "match": "alias",
  "name": "Qwen 3.7 Flash",
  "type": "chat",
  "api": "anthropic-messages",
  "base_url": "https://ai-gateway.vercel.sh",
  "reasoning": true,
  "input": ["text", "image"],
  "context_window": 991000,
  "max_tokens": 64000,
  "cost": {
    "input": 0.03, "output": 0.13, "cache_read": 0.006, "cache_write": 0.038,
    "tiers": [
      { "input_tokens_above": 31999, "input": 0.1, "output": 0.4, "cache_read": 0.02, "cache_write": 0.125 },
      { "input_tokens_above": 255999, "input": 0.2, "output": 0.8, "cache_read": 0.04, "cache_write": 0.25 }
    ]
  },
  "thinking_level_map": null,
  "compat": { "allowEmptySignature": true },
  "prompt_cache": null,
  "input_limits": { "max_request_bytes": null, "max_images_per_request": null, "max_images_per_message": null },
  "differences": [
    {
      "field": "cost.tiers", "entry_field": "cost.text", "unit": "usd_per_million_tokens", "pi": null, "published": null,
      "pi_tiers": [
        { "input_tokens_above": 31999, "input": 0.1, "output": 0.4, "cache_read": 0.02, "cache_write": 0.125 },
        { "input_tokens_above": 255999, "input": 0.2, "output": 0.8, "cache_read": 0.04, "cache_write": 0.25 }
      ],
      "published_tiers": [
        { "input_tokens_above": 32000, "input": 0.1, "output": 0.4, "cache_read": 0.02, "cache_write": 0.125 },
        { "input_tokens_above": 256000, "input": 0.2, "output": 0.8, "cache_read": 0.04, "cache_write": 0.25 }
      ]
    }
  ]
}
```

Its summary gains
`"pi": { "ref": "vercel-ai-gateway/alibaba/qwen3.7-flash", "api": "anthropic-messages", "match": "alias", "difference_count": 1 }`.

### Example 3: `/api/v1/meta`

`data`, as a build on the data of 2026-11-20 gives it with the alias file of section c (the state after step 5),
and a pi snapshot written that day at 14:19 UTC by `npm run sync -- --only=pi` (so the top-level `sync` still
shows the morning's run). Everything outside `pi` and the two new keys of `license` is as published today.
Without the alias file (the state after step 4) the three counts are 570, 481 and 647.

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
    "counts": { "entries_with_block": 813, "left_out_models": 588, "unmatched_models": 297 }
  },
  "exclusions": ["… 18 items, as today"],
  "issues": [],
  "license": {
    "data": "MIT",
    "upstream": "models.dev, MIT License, Copyright (c) 2025 models.dev",
    "notice": "Baseline imported from https://models.dev. providers.dev is not affiliated with or endorsed by models.dev.",
    "pi": "pi (https://github.com/earendil-works/pi), MIT License, <the copyright line of pi's LICENSE file>",
    "pi_notice": "The pi block of an entry (providers_dev.pi) is imported from https://pi.dev/api/models. providers.dev is not affiliated with or endorsed by pi."
  }
}
```

When the last pi import failed: `"sync": { "last_attempt_at": "…", "last_attempt_ok": false, "last_error":
"pi.dev answered HTTP 503" }` under `pi`, `snapshot` still the last good one, the blocks and counts those of that
snapshot, and the top-level `sync` unchanged. On a fresh clone before the first import: `"snapshot": null`, the
three `sync` keys `null`, every count 0.

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
3. **Prices** are both in US dollars per million tokens. An entry price is so when its `unit` (of its side, or of
   its tier) is absent or is models.dev's per-token unit `token`; one question decides it for a side, a tier and a
   plain price alike. A price in another unit (`character`, for instance) is not compared. Two prices are equal
   exactly when they are the same number; there is no tolerance. The values listed are the ones the catalogs state.
4. **A cache-write price keyed by lifetime** (`{ "5m": 5, "1h": 8 }`) is not compared: pi states one price and
   the feed does not say for which lifetime.
5. **Tiers.** The entry's tiers are read from `cost.text.input.overrides` and `cost.text.output.overrides`. An
   override is a tier when its `when` has the one key `context`, with the one comparison `gt: N` (N a whole number,
   0 or more; the threshold is N) or `gte: N` (N a whole number, 1 or more; the threshold is N less 1), so that a
   threshold is always a whole number of tokens, 0 or more. Every other override (service tier, time of day, a
   composite) and every multiplier is not a tier and is not compared. **The tiers are not compared at all, and no
   `cost.tiers` item is listed,** where they cannot be read as such: an override on the context alone that is not
   of that form (a fraction, a negative number, another comparison, two comparisons), a side or a tier priced in
   another unit than per million tokens (rule 3), or a negative price in a tier. For each threshold, ascending:
   `{ input_tokens_above, input: the input override's price, output: the output override's price, cache_read: the
   input override's cache.read, cache_write: its cache.write where one number }`, `null` where the entry states
   none; where two overrides of one side have the same threshold, the one listed last counts. pi's tiers are
   `cost.tiers` sorted by `inputTokensAbove`. The two lists agree when they have the same thresholds and, tier by
   tier, every price that both state (rule 1) is equal (rule 3). Where they do not agree, including one side
   having tiers and the other none, and thresholds that are one token apart (example 2), **one** item is listed,
   `field: "cost.tiers"`, with `pi_tiers` and `published_tiers` in full and `pi` and `published` null. Base prices
   are compared on their own, tiers or not.
6. **What is listed:** one item per differing field, in the order of the table, each with the two values. Nothing
   else: no percentage, no verdict on who is right. `differences: []` means agreement wherever both state a value.

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
| `promptCache` | `prompt_cache: { short_s, long_s }` | **published in the block only**, `null` where absent. It is not read into `providers_dev.cache.lifetime`, `cache.documented` or `capabilities.cache`: it is the lifetime pi's own cache timer reckons with, the feed does not say which way of caching it is for, and the lifetime record's sources stay models.dev and providers.dev |
| `inputLimits.maxRequestBytes`, `inputLimits.images.maxPerRequest`, `inputLimits.images.maxPerMessage` | `input_limits.max_request_bytes`, `.max_images_per_request`, `.max_images_per_message` | **published**, each `null` where not stated: they are limits of the provider |
| `inputLimits.images.resize` | not published | pi's own setting for shrinking an image before it sends it (the same four numbers on all 1,290 models that have it), not a fact about the provider |
| `headers` | **not published** | request headers pi sends are not a fact about the model. They stay in `data/pi/` only. `tests/pi-source.test.ts` holds that no published object has a `headers` key under `pi` |
| `lab`, `enabled`, `providers`, `free` (the `radius` provider) | not published | a display name, a switch of pi's gateway, the gateway's own routing and pi's own mark. `radius` is not in the catalog, so nothing of it is published in any case; the rule holds should the fields appear elsewhere |
| any other key | not published | a key the feed adds later stays in `data/pi/` until this table gives it a place |

pi's per-request-format defaults (what a flag is when the catalog does not state it, what a 1-hour cache write
costs) live in pi's code and are not reproduced anywhere.

---

## g. Not built: entries and providers that come from pi alone

Decided by the owner on 2026-11-20, after the measurements of section 0: few of pi's models are really new to the
catalog, each would need an authored line to keep it under the catalog rules, and they are where a model would
appear twice under two spellings.

So the build never creates an entry or a provider from pi's data:

- a pi model that belongs to no entry (297 with the pairings of section c) is counted in
  `meta.pi.counts.unmatched_models` and listed in `data/published/pi-report.json`, with the reason. Nothing else;
- a pi provider id the catalog does not have and the alias file does not pair (`radius`, the two
  `qwen-token-plan-individual` ids) is in the report with `state: "absent"`. It is not an issue;
- `providers_dev.origin` keeps its two values and their meaning; `counts`, the provider list and the model list of
  the API are not touched by pi;
- the alias file has no way to ask for such an entry (its schema is strict and has `same_as` only).

A model the catalog should have and models.dev does not list is added the way it is today, by hand, in
`data/authored/providers/<id>.yaml`, with evidence. If such an entry has the provider id and model id of a pi
model, it gets the pi block like any entry.

---

## h. What the entry page must be able to show

Purpose only; the look is the frontend designer's (PIC-09). Everything comes from
`GET /api/v1/entries/{provider}/{model}` (`entry.providers_dev.pi`, `summary`) and `GET /api/v1/meta` (`pi`); the
page works nothing out.

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
   provider and the model where it spells them otherwise (`ref`, `match: "alias"`); when it was imported
   (`meta.pi.snapshot.fetched_at`) and, if so, that the last import failed (`meta.pi.sync`).
4. **On an entry pi does not list** (`pi: null`): nothing about pi, or one plain line; the designer's choice.

Lists (`/`, a provider's page, a model's page) show, on a row whose entry pi lists, that pi lists it, and nothing about
differences: the owner settled it so. Only the entry's own page shows the differences. The row's pi.dev mark carries the
date of pi's import (`meta.pi.snapshot.fetched_at`), on a line of its own as the models.dev and providers.dev marks
carry theirs: the owner asked for it on 2026-11-20. `checked_at` is not that date: it moves on every check, while the
models.dev date beside it moves only when models.dev's data changed.

---

## i. How the existing rules stay true

**"The published dataset is computed from scratch."** `resolve()` stays pure, and knows nothing of pi: it builds
the whole dataset with `pi: null` on every entry. The pi part is worked out after it, in one place, from the pi
snapshot, the alias file and plain facts `resolve()` hands on, and is laid over the finished dataset (section k,
1). Every block, every difference and the report are worked out again in each build; nothing is stored between
builds or edited in place. Delete `data/pi/` and the dataset is today's, with `pi: null` everywhere. Delete a line
of the alias file and what it did is gone in the next build. `dataset_version` covers the pi blocks, since they
are in the catalog it hashes: new pi data gives a new version and new ETags.

The match of every pi model (section c) is worked out against the catalog as it stood after step 3 and before
step 4 of `resolve()`, which `resolve()` records as plain rows for that purpose; the differences are worked out
against the entries as published, after every override.

**"A sync can never overwrite our work."** `npm run sync` writes `data/pi/` and nothing under `data/authored/`.

**"For every entry published today, every field that exists today keeps its value."** By construction: the build
adds one key to an entry and one to its summary, and no code that fills an existing key reads the pi data. pi
creates no entry and no provider, so every list, count and aggregate of the API (a provider's `entry_count`, a
model's ranges, `counts` of `/meta`, the facets, the exclusions) is what it is today. Held by a test and by the
whole-dataset comparison (section j).

**The catalog rules.** They decide which entries are published, as today, and pi cannot bring one back: a pi
model is matched against the catalog before the exclusions, and where its entry is left out, nothing of the pi
model is published (`left_out_models`: 481 by equal ids, 588 with the pairings).

**"Imported values never get a verification date"; the stale mark.** pi's values are imported: the block has no
date of its own, `verified` of an entry does not move, and nothing of pi's is ever shown as stale. The age of the
pi data is `meta.pi.snapshot.fetched_at`, one for the whole dataset, like models.dev's.

**The evaluated mark, `modified`.** A pi block is not evidence and not an evaluation: `touched` in
`src/core/entries.ts` does not read it, so an imported entry with a pi block stays `origin: "upstream"` in its
summary, `evaluated=true` does not match it, and it is not counted among the entries with providers.dev evidence.

**"The site never shows anything that is not from the API."** Everything of section h is in the entry, the summary
or `/meta`. The report is not in the API and no page reads it.

**"One contract": every object of a kind has the same keys.** `providers_dev.pi` and `summary.pi` are on every
entry, `null` where there is none; the block has every key on every entry, `null` or `[]` where pi states nothing;
`meta.pi` is always there. `compat` and `thinking_level_map` are maps with pi's keys, as `request_settings` of an
evaluation is a map with the client's.

**"The API only grows."** Added: three properties and five components. `structure/api-v1.json` grows;
`structure/api-v1-1.0.0.json` is not touched; `info.version` 1.2.0.

**"The last import failed. This is the last good snapshot."** in the footer of every page
(`src/core/pages.ts`) reads `sync.last_attempt_ok` of `/meta`, whose meaning does not change: a pi failure never
shows there. It shows in `meta.pi.sync`.

**Nothing on pi's side stops the import, the build or the deploy.** Section k: a stored snapshot that cannot be
used, a fault in pi's own code, a result the contract refuses and a record of the last import that does not fit
all end the same way, in a dataset without that part of pi's and a warning that says why.

**Licensing.** pi's licence text goes to `LICENSES/pi-MIT.txt` (copied from pi's repository), ships with the
dataset as `/data/LICENSE-pi.txt`, and `NOTICE.txt` gains a paragraph naming pi, its address, MIT, the import time
and "not affiliated with or endorsed by pi". The README's licensing list gains: every `providers_dev.pi` block is
pi's.

---

## j. The steps for the workers

Six steps, each one task, on a branch, reviewed before `main`. Rules for every step: never edit `data/upstream`,
`data/sources`, `data/pi`, `data/published` or `public/snapshots` by hand; the API may only grow;
`npm run check` passes at the end of each step. Tests are Vitest, in `tests/*.test.ts`, against stand-ins: no test
reaches the network. `tests/helpers.ts` gains `fixturePi(providers = 12, modelsEach = 30): PiCatalog` (provider
ids `provider-00`… and the model ids of `fixtureUpstream`, so that equal ids match) and a `fetch` stand-in that
answers per address.

| step | spec item | what | the dataset afterwards |
|---|---|---|---|
| 1 | PIC-03 | the import | the same `dataset_version` |
| 2 | PIC-04 | the workflow, the README, the first snapshot | the same `dataset_version` |
| 3 | PIC-05 | the contract; `pi: null` everywhere | one new key, `null`, on every entry and summary; `meta.pi` |
| 4 | PIC-06 | the block, the differences, `/meta` | blocks on the entries with equal ids |
| 5 | PIC-07 | the alias file and the report | blocks on the paired providers' entries too |
| 6 | PIC-09, PIC-10 | pages and text | the same `dataset_version` as after step 5 |

### The whole-dataset comparison

One instrument for the third acceptance criterion, written in step 3 and run in steps 3, 4 and 5 and again by the
review: `scripts/compare-published.ts`, as `npm run compare:published -- <before> <after>`, on two
`data/published/` directories. It:

- refuses to run unless `meta.upstream.sha256` is the same in both, and `meta.measurements.sha256` too (the same
  models.dev snapshot and the same measurements);
- takes off, on both sides, what this work adds: `providers_dev.pi` of every entry, `pi` of every summary,
  `meta.pi`, `meta.license.pi` and `meta.license.pi_notice`, the issues whose code starts with `pi-`; and what a
  build always renews: `dataset_version` and `generated_at`;
- then requires that the two are **the same in everything**: the same providers and the same entries, none
  missing and none new; every full entry, every entry summary and every provider summary deep-equal; the
  canonical models (`canonicalModels` of `src/core/resources.ts` on the summaries) deep-equal; the `data` of the
  evaluations and corrections files deep-equal; `meta` deep-equal;
- prints the number of providers and entries compared, `entries with the key pi: <b> -> <a>`,
  `entries with a pi block: <b> -> <a>`, the number of differing objects and the first 20 with their paths, and
  exits 1 on any difference.

`<before>` is always built from the commit the step's branch is cut from, `<after>` from the step's last commit,
both with `npm run data` on the same `data/upstream/`, `data/sources/`, `data/authored/` (the alias file apart, in
step 5) and `data/pi/`. The script's whole output goes into the task's result. In steps 1, 2 and 6 nothing of the
dataset may change at all, and the check is simpler: `npm run data` prints the same `dataset_version` before and
after (it is the hash of the catalog and every summary).

The numbers below are those of the data of 2026-11-20; on another day they follow the snapshots, and what must
hold is "0 differences" and the stated relation between the counts.

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
11. the lock: a second `sync` while one holds the lock throws `SyncBusyError` (the existing test still passes);
12. `writeStepOutputs` on a report whose pi part failed appends `upstream=updated`, `measurements=unchanged` and
    `pi=failed` to the file it is given, and leaves what the file held.

`tests/sync.test.ts` passes unchanged except where it lists the fields of a report.

**The dataset:** `npm run data` before and after the step prints the same `dataset_version`.

### Step 2 (PIC-04): the workflow, the README, the first snapshot

Files: `.github/workflows/publish.yml` exactly as in section b; README "How the data is put together" (the
diagram gains `data/pi/`) and "Syncing" (both sources, the two tables of section b in words, `--only=pi`, the
green run with a warning).

The first snapshot: `npm run sync -- --only=pi` on the branch, then commit `data/pi/` and `data/sync-status.json`
as the command wrote them.

Tests: none of its own (a workflow file cannot be run by Vitest). What the task's result shows and the review
checks: `git status --porcelain data/upstream` is empty in the snapshot commit; the snapshot's `meta.json` has the
`sha256` of the body pi served; the workflow has the warning step directly after the import step with the
condition `steps.sync.outputs.pi == 'failed'`, and `Report a failed import` is byte-for-byte today's; the diff of
the workflow file, in full.

**The dataset:** the same `dataset_version` before and after (the build does not read `data/pi/` yet).

### Step 3 (PIC-05): the contract

Files: `src/core/pi.ts` (the types `PiBlock`, `PiCost`, `PiCostTier`, `PiDifference`, `PiSummary`),
`src/core/schema.ts` (`ModelExtension.pi`, `Meta.pi`, the five issue codes), `src/core/entries.ts`
(`Summary.pi`), `src/core/contract.ts` (section d, 1 to 3, with the five components in `COMPONENTS`),
`src/core/openapi.ts` (section d, 4), `structure/api-v1.json` by `npm run structure:update`,
`scripts/compare-published.ts` and the script `compare:published` in `package.json`.

Every entry must have every key, so this step also makes `resolve()` put `pi: null` on every entry,
`summarize()` `pi: null` on every summary, and `publish()` a `meta.pi` with `source`, `snapshot: null`, the `sync`
keys from `sync-status.json` and the three counts 0. No pi data is read yet.

Tests: `tests/api-structure.test.ts` passes with the new record and reports no break against 1.0.0;
`tests/contract.test.ts` and the tests that check every published object against the contract pass;
`tests/api.test.ts` gains: every entry of `/entries` and the full entry have the key `pi`, `null`; `/meta` has `pi`
with `snapshot: null` and counts 0; `info.version` is `1.2.0`; `origin` of `/entries` and `/providers` still
refuses a value outside today's list. A test of the comparison itself, `tests/compare-published.test.ts`: two
equal fixtures pass; a changed `limit.context`, a missing entry, a new entry and a changed provider summary each
fail and are named; a difference under `providers_dev.pi` alone passes; two different `upstream.sha256` are
refused.

**The comparison** (before: step 2's commit): 0 differences; `entries with the key pi: 0 -> 6318`;
`entries with a pi block: 0 -> 0`.

### Step 4 (PIC-06): the block, the differences, `/meta`

Files: `src/core/pi.ts` (`piBlock`, `piDifferences`, the tier reading of section e, matching by equal ids, the
counts), `src/core/resolve.ts` (section i; `ResolveInput.pi` without aliases), `src/core/entries.ts`
(`summary.pi` from the block), *superseded by section k: `resolve()` has no `pi` in its input or result and
`summarize()` writes `pi: null`; the fence lays the blocks and the short forms over the finished dataset*,
`scripts/lib/publish.ts` (load `data/pi/`, check it against `PiFeed`, pass it,
`meta.pi`, `license`, `LICENSE-pi.txt` and the `NOTICE.txt` paragraph), `LICENSES/pi-MIT.txt`,
`scripts/build-data.ts` (the pi line).

`tests/pi-source.test.ts`:

1. a matched entry carries the block with every key of section d and `match: "id"`; its summary the short form;
   a pi model with no entry adds nothing and is counted `unmatched`; an entry pi does not list has `pi: null`;
2. a pi model whose entry an override excludes, and one whose entry a catalog rule leaves out, are `left_out`, and
   no entry is published for them;
3. a difference in each compared field, one test per row of the table in section e, each with both values;
4. agreeing values give `differences: []`; prices that differ only beyond the sixth decimal differ;
5. no difference where the entry has no value, where pi's price is 0, where a limit is 0, where the entry's
   cache-write price is keyed by lifetime, where the entry's price has a `unit` other than `token`;
6. tiers: equal tiers written with `gt` on one side and `gte` on the other (32000 and `gte: 32001`) agree; a price
   that differs only in a tier gives exactly one `cost.tiers` item with both lists; thresholds one token apart
   give one; tiers on one side only give one; an override on service tier or time of day is not a tier;
7. a difference follows the published value: an override of `limit.context` to pi's number removes the
   `context_window` difference, one to another number lists the override's number as `published`;
8. `headers`, `inputLimits.images.resize`, `lab`, `enabled`, `providers`, `free` appear nowhere in the published
   catalog;
9. a feed value that is absent is `null` in the block (`compat`, `thinking_level_map`, `prompt_cache`, each key of
   `input_limits`), `""` as `base_url` is `null`, `tiers` absent is `[]`, and no flag is filled in that the feed
   does not state;
10. **nothing existing moves:** `resolve(fixture)` and `resolve(fixture + pi)` have the same providers and the
    same entries, and give, for every entry, deep-equal records once `providers_dev.pi` is taken off and deep-equal
    summaries once `pi` is taken off; exclusions are deep-equal as they are; no entry has another `origin`,
    `verified` or summary `origin` than without pi;
11. a missing pi snapshot (`publish()` on a data directory without `data/pi/`): the dataset builds, every entry
    has `pi: null`, `meta.pi.snapshot` is `null` and every count 0; a `data/pi/` that does not fit `PiFeed`: the
    same, with `pi-snapshot-unreadable`;
12. `meta.pi.counts`: the three add up to the models of the snapshot; `entries_with_block` is the number of
    entries whose `pi` is not `null`; `meta.pi.sync` follows `sync-status.json` (a failed pi part gives
    `last_attempt_ok: false` with its error, and leaves the top-level `sync` alone).

**The comparison** (before: step 3's commit): 0 differences; `entries with the key pi: 6318 -> 6318`;
`entries with a pi block: 0 -> 570`, equal to `meta.pi.counts.entries_with_block`; `/meta` shows
`left_out_models: 481`, `unmatched_models: 647`.

### Step 5 (PIC-07): the alias file and the report

Files: `src/core/pi.ts` (`PiAliases`, the rule of section c in full, the four alias issues, `PiReport`),
`src/core/resolve.ts` (`ResolveInput.pi.aliases`, `ResolveResult.pi`; *superseded by section k: the alias file
goes to `piPart` through the fence, and the report is `piPart`'s*), `scripts/lib/publish.ts` (load the alias
file, write `data/published/pi-report.json`), `data/authored/pi-aliases.yaml` with **the first content of
section c as it stands there**, and the README's "Authoring" (a short part on the file).

Then, from the report: a model `same_as` line for each unmatched pi model that is certainly an entry of its
provider under another spelling (section c says when it is). The worker lists in the result every line added
beyond the first content, with what makes it certain; a `:batch` or `-batch` id gets none.

`tests/pi-source.test.ts` gains:

13. a provider `same_as`: its models reach the paired provider's entries by equal model id; the block's
    `provider` and `ref` are pi's spelling and `match` is `alias`;
14. a model `same_as`: `match: "alias"`; a pi model with the entry's own id keeps the entry against an alias that
    points at it (`pi-alias-conflict`, the other is `unmatched` with `why: "alias-conflict"`);
15. `pi-alias-orphan` for a `same_as` naming a missing provider or entry and for a line naming a pi provider or
    model that is gone; `pi-provider-collides` for a `same_as` on a provider id the catalog has;
    `pi-alias-redundant`; none of them is level `error`, and the build succeeds with each;
16. nothing by similarity: a pi model that resembles an entry (`gpt-6.1-sol` and `gpt-6-1-sol`) is **not**
    matched; it is in `unmatched` with the entry's id under `alike`;
17. a pi provider the catalog does not have and the file does not pair: no provider and no entry is published
    for it, no issue is raised, its models are `unmatched` with `why: "provider-absent"`;
18. the report: `totals` add up to the models of the snapshot and to `meta.pi.counts`; `publish()` writes
    `pi-report.json` beside `site/`, and nothing under `site/` names it; the file is not written without a pi
    snapshot;
19. a `pi-aliases.yaml` that does not fit the schema fails `publish()` with the file and path named, as any
    authored file does: an unknown key (`only_pi`, `new`, `inherits`), a `same_as` provider without evidence, two
    pi provider ids with one `same_as`;
20. the file in the repository parses against `PiAliases` (a test that reads `data/authored/pi-aliases.yaml`).

**The comparison** (before: step 4's commit, so without the alias file): 0 differences;
`entries with a pi block: 570 -> 813` with the first content alone, the 243 new blocks all on entries of the
paired providers (`vercel` 152, `fireworks-ai` 27, `alibaba-token-plan` 20, `alibaba-token-plan-cn` 20,
`togetherai` 15, `kimi-code-plan-cn` 6, `zhipuai-coding-plan` 3, `bailing` 0); `/meta` shows `left_out_models: 588`,
`unmatched_models: 297`. Each model line added beyond the first content moves one model from unmatched to a
block or to left out; the result gives the three counts before and after those lines.

### Step 6 (PIC-09, PIC-10): pages and text

PIC-09 is the frontend designer's, to section h, in `src/core/render.ts` and the styles. `tests/pages.test.ts`:
an entry page with a block (the request format, the address and each stated flag are on the page), one without
(`pi: null`), one with differences (both values of each are on the page), one whose block has `match: "alias"`
(pi's own spelling is on the page), one where pi's cache-write price is 0 (the page does not say "free");
`tests/render.test.ts`: every value on those pages is in the API answers they were drawn from, and a flag absent
from `compat` is not shown as `false`.

PIC-10: README (the opening list, "API" with 1.2.0 and what it added, "Licensing"), the methodology, about and
licensing text in `src/pages/reference-content/docs/`.

**The dataset:** the same `dataset_version` as after step 5: this step changes pages and words, no data.

### For the review and the release

The review (PIC-11) builds `main` as it was before step 1 and the branch after step 6, on the same
`data/upstream/` and `data/sources/`, and runs the comparison once across everything: 0 differences,
`entries with the key pi: 0 -> all`, `entries with a pi block: 0 -> meta.pi.counts.entries_with_block`. That one
run is the third acceptance criterion.

The fence (section k) was designed after these six steps were built. Its own steps, with what must be shown after
each, are in section k, 6; where a test or a file named in the steps above is replaced there, section k decides.

---

## k. The fence

**The requirement:** nothing on pi's side may ever stop the models.dev import, the build or the deploy.

**Why it was not met by adding guards.** As first built, pi's code was called from four places of the build
(`resolve()` for the match, the blocks and the report; `summarize()` for the short form; `publish()` for the stored
snapshot and for `meta.pi`) and two of the sync, each with a guard of its own, and the fallback built the dataset
a second time through the same pi code. Each review found a way past one guard.

**The structure that meets it.** Three rules, and everything below follows from them:

1. **The dataset is complete without pi before any pi code runs.** `resolve()` and `summarize()` know nothing of
   pi and write `pi: null` themselves. Turning pi away is then *doing nothing*: there is no fallback path, no
   second build and no code that produces "no pi data".
2. **pi's code runs in one guarded place in the build and one in the sync.** It is handed copies and plain rows,
   never the catalog; what it returns is turned into plain data and checked against the contract there, once.
3. **Outside the fence only that checked, plain data is used.** No other module may import a value from pi's
   modules, and a test holds that.

### The modules

| module | what it is | who may import a value from it |
|---|---|---|
| `src/core/pi.ts` | pi's pure code: the feed's schema, the match, the block, the differences, the report, and one entry point, `piPart` | `scripts/lib/pi-sync.ts`, `scripts/lib/pi-fence.ts` |
| `scripts/lib/pi-sync.ts` | pi's code that touches files and the network: `storedPi`, `syncPi` and what they need (section b) | `scripts/lib/pi-fence.ts` |
| `scripts/lib/pi-fence.ts` | the fence: `piOfBuild`, `piOfSync`, and nothing else exported but their types | `scripts/lib/publish.ts` (`piOfBuild`), `scripts/lib/sync.ts` (`piOfSync`) |
| `scripts/lib/fenced.ts` | the guard: `fenced`, `fencedAsync`, `reasonOf`. It knows nothing of pi and imports nothing of pi's | anyone; today `scripts/lib/pi-fence.ts` |

**Nothing leads back across the fence.** pi's two modules import no value from `scripts/lib/sync.ts`,
`scripts/lib/publish.ts`, `scripts/lib/pi-fence.ts` or `scripts/lib/fenced.ts`: the modules that reach pi's code
through the fence are never reached from it. What pi's code needs of the reference's (a share, a three-line
helper, the wording of a summary) it has of its own. This is not tidiness. With a cycle
(`sync.ts` → `pi-fence.ts` → `pi-sync.ts` → `sync.ts`) one module binds to another before a test's wrapper stands
around it, and a test of the fence can then pass, or fail, by the order in which the modules happened to load.

`import type` from pi's modules is free everywhere (the contract, the pages and the tests name pi's types). What
code outside the fence needs as a value leaves pi's modules: `PiAliases` with its two line schemas, and `PI_URL`,
move to `src/core/schema.ts`, beside the other authored files' schemas and `PiMeta`. `PiSyncRecord`, the one
definition of the `pi` key of the status file, is there too, beside `PiMeta`: the sync writes the record and the
fence reads it, and with it in `sync.ts` the fence imported a value from the module that imports the fence. No
cycle is left at the fence: `pi-fence.ts` imports no value from `sync.ts` (only the type `RanPart`).

### The guard

One function, used for every call into pi's code, with an `async` twin for the sync. It lives in a module of its
own, `scripts/lib/fenced.ts`, because it is not pi's code and not the fence's two doors: it is exported there and
tested directly (`tests/fenced.test.ts`), while `scripts/lib/pi-fence.ts` exports the two doors and nothing else.

```ts
type Fenced<T> = { ok: true; value: T } | { ok: false; why: string };
/** Run pi's code and take its result only as plain data that fits `schema`. Never throws. */
function fenced<T>(compute: () => T, schema: z.ZodType<T>): Fenced<T>;
async function fencedAsync<T>(compute: () => Promise<T>, schema: z.ZodType<T>): Promise<Fenced<T>>;
```

In order, all inside one `try`: call `compute`; make the result plain with `JSON.parse(JSON.stringify(result))`
(a getter, a prototype, an `undefined`, a function or a cycle does not survive it, and key order does); check the
plain copy with `schema.safeParse`; return **the plain copy**, not zod's output, whose keys the schema would
reorder. Anything thrown at any of these, of any shape, and any misfit, gives `{ ok: false, why }`.

`why` is made by one total function, `reasonOf(error: unknown): string`, that cannot throw itself: the `message`
of an `Error` where that is a string, the first issue's path and message for a misfit (and for a `ZodError` that
pi's own code throws: its message is a dump of many lines), else `a fault without a description`; then every control character becomes a space and the text is cut to 300
characters. So what crosses the fence as a reason is always one short line of text.

### 1. The build

**`resolve()`** (`src/core/resolve.ts`) imports nothing from pi. `ResolveInput.pi` and `ResolveResult.pi` go; step
3b's match and the calls in step 6 go. It gains two plain results, recorded where step 3b was (after step 3,
before step 4) and at the end:

```ts
/** One entry as it stood before any exclusion: plain facts for a part of the build that comes after resolve(). */
export interface EntryBefore {
  provider: string;
  model: string;
  /** The `base_url` of each endpoint of the entry's `api` that has one as a string, in the order of its keys. */
  base_urls: string[];
}
/** The catalog as it stood then. A provider without an entry is in `providers` and has no row in `entries`. */
export interface CatalogBefore {
  providers: string[];        // every provider id, in the catalog's order
  entries: EntryBefore[];     // in the catalog's order: providers, then their models
}
export interface ResolveResult {
  catalog: Catalog; issues: Issue[]; exclusions: Exclusion[];
  before: CatalogBefore;
  ruledOut: { ref: string; rule: string }[];   // every entry a catalog rule left out, with the rule's id
}
```

`providers` is there so that the match keeps its meaning: a pi provider id is *shared* or *paired* where the
catalog has that provider, with or without entries (a provider we add can list no model of its own), and is never
*absent* because a provider happens to be empty.

Step 6 writes the literal `pi: null` as the last key of every entry's `providers_dev`, and `summarize()`
(`src/core/entries.ts`) the literal `pi: null` as the last key of every summary. These two literals and
`noPiMeta()` are the fixed values of "no pi data":

```ts
// src/core/schema.ts
export const noPiMeta = (): Meta["pi"] => ({
  source: PI_URL,
  snapshot: null,
  sync: { last_attempt_at: null, last_attempt_ok: null, last_error: null },
  counts: { entries_with_block: 0, left_out_models: 0, unmatched_models: 0 },
});
```

**pi's one entry point** (`src/core/pi.ts`), which holds what `resolve()` did with `matchPi`, `piBlock` and
`piReport`. `piSummary` goes: the fence writes the short form from the checked block.

```ts
export interface PiPartInput {
  pi: PiCatalog;
  aliases: PiAliases | undefined;
  before: CatalogBefore;
  ruledOut: { ref: string; rule: string }[];
  /** A copy of `limit` and `cost` of the entry as published; undefined where the ref is not published. */
  entryOf: (ref: string) => { limit: unknown; cost: unknown } | undefined;
}
export interface PiPart {
  /** One per pi model whose entry is published. `ref` is the entry's, provider/model of the catalog. */
  blocks: { ref: string; block: PiBlock }[];
  report: PiReport;
  /** The alias issues of section c. */
  issues: Issue[];
}
export function piPart(input: PiPartInput): PiPart;
```

`matchPi` takes `before` in place of the catalog. A pi model is *matched* where `entryOf` knows its entry's ref,
*left out* where it does not, by `ruledOut`'s rule for that ref or else `"override"`.

**Lookups by own property.** In pi's two modules no object is indexed by a key that comes from the feed, the alias
file or the catalog, except through a `Map` or through one helper,
`own(record, key)` = `Object.hasOwn(record, key) ? record[key] : undefined`; and an object keyed by such ids is
built with `Object.fromEntries`, never by assignment. Today's places, all in `matchPi` and `piReport` unless
named: `pi[piProvider]`, `pi[piProvider][piModel]`, `lines[piProvider]`, `line.models[piModel]`,
`catalog[piProvider]`, `catalog[line.same_as]`, `models[piModel]`, `entries[piModel]`,
`entries[modelLine.same_as]`, `pi[provider.pi_provider]`; `catalog[provider.id] = …` in `loadPi`; and the pi
part's own copy of the import summary (`before[id]`, `old[modelId]`, `models[modelId]`), which it no longer shares
with models.dev's. All of them are changed in step F2: those of `src/core/pi.ts` and `loadPi` because the build reads through them,
and the summary because step F2 gives `pi-sync.ts` its own (it no longer imports models.dev's).

**The fence of the build:**

```ts
// scripts/lib/pi-fence.ts
export interface PiOfBuildInput {
  dataDir: string;
  /** data/sync-status.json as publish() parsed it; undefined where there is none. */
  status: unknown;
  aliases: PiAliases | undefined;
  catalog: Catalog;
  before: CatalogBefore;
  ruledOut: { ref: string; rule: string }[];
}
export interface PiOfBuild {
  /** The entry's ref -> its block and the block in short. Empty = no pi data. */
  entries: Map<string, { block: PiBlock; summary: PiSummary }>;
  /** `meta.pi`, whole. */
  meta: Meta["pi"];
  /** The alias issues of a dataset with pi data, then the fence's own: pi-no-blocks, and one pi-snapshot-unreadable per part turned away. */
  issues: Issue[];
  /** The text of data/published/pi-report.json; null = no pi data. */
  report: string | null;
  state: "published" | "published_without_blocks" | "none" | "turned_away";
}
/** Everything the build publishes of pi. Never throws. */
export function piOfBuild(input: PiOfBuildInput): PiOfBuild;
```

It has two parts, each through `fenced`, each all or nothing, neither depending on the other:

- **The data.** First the fence asks, with code of its own, whether the folder `data/pi/` exists. Where it does
  not, no pi code is called and the data is `null`: so the one state without pi data and without a warning does
  not rest on pi's code. Where it does, `compute`: `storedPi(dataDir)`; unless its answer is *usable*, throw (its
  reason where it is *unusable*; that it gave no usable answer otherwise, *none* for a folder that exists
  included); then call `piPart`, with `structuredClone`s of the alias file, of `before` and of `ruledOut`, and an
  `entryOf` that looks the ref up in a `Map` the fence made from `catalog` and returns `structuredClone`s of `limit`
  and `cost`; so pi's code is handed copies only, never an object the build goes on to use; return
  `{ snapshot, counts, blocks, issues, report }`, where `snapshot` is `meta.pi.snapshot` made from the stored
  `meta.json` (keys in the contract's order, an absent one `null`), `counts` the three of `meta.pi.counts` from the
  report's totals, and `report` the report as text (`JSON.stringify(report, null, 1)` and a newline).
  `schema`, nullable: `snapshot` is that of `MetaSchema.shape.pi` without its `null` (a dataset with pi data has a snapshot) and
`counts` is that of `MetaSchema.shape.pi`; `blocks` an array of
  `{ ref: string, block: PiBlockSchema }`; `issues` an array of strict
  `{ level: "warning" | "notice", code: one of the four pi-alias and pi-provider codes, target: string, message: string }`
  (so pi's code cannot hand the build an error); `report` a string.
  After the check the fence, with code of its own, requires four things of the plain result, and turns the data
  away, with the reason, where one does not hold:
  1. every `ref` of `blocks` is an entry of `catalog`;
  2. no `ref` occurs twice;
  3. `counts.entries_with_block` is the number of `blocks`
     (reason: `<n> blocks, and meta.pi says <m> entries have one`);
  4. the three of `counts` add up to `snapshot.models`
     (reason: `the counts add up to <n>, the snapshot has <m> models`).

  The first two say that the blocks can be laid on the catalog. The last two are the contract's own sentences
  about pi's numbers ("Entries with a pi block"; "The three add up to snapshot.models"), which a schema cannot
  say: with them the fence holds the whole contract of pi's part, and a part that contradicts itself (a snapshot
  of 1,698 models published with counts of 0, 0 and 1) is turned away and seen, not published. They are not rules
  about what pi says of the world: no price, no id and no match is looked at.
  Then the fence writes each summary: `{ ref: block.ref, api: block.api, match: block.match, difference_count:
  block.differences.length }`.

  The fence does **not** check what `storedPi` hands it before it hands it to `piPart`: that is pi's code giving
  to pi's code, inside the guard, and `storedPi` has checked it against `PiFeed` and `PiMeta` itself. What the
  fence checks is what leaves pi's code for the dataset, and that is why check 4 ties the two halves of the part
  together: the snapshot comes from `storedPi`, the counts and the blocks from `piPart`.

- **The record.** `compute`: where `status` is not an object with an own key `pi`, return the three `null`s; else
  `PiSyncRecord.parse(status.pi)` and return
  `{ last_attempt_at, last_attempt_ok: status !== "failed", last_error: error ?? null }`. `schema`:
  `MetaSchema.shape.pi.shape.sync`.

What comes out:

| the data | the record | `entries`, `report` | `meta` | `issues` gains | `state` |
|---|---|---|---|---|---|
| fits | fits | the blocks; the report | snapshot and counts of the data, the record | pi's alias issues | `published` |
| fits, no block | fits | empty; the report | snapshot and counts of the data, the record | pi's alias issues, then the warning pi-no-blocks, target data/pi | published_without_blocks |
| `null` (no `data/pi/`) | fits | empty; `null` | `noPiMeta()` with the record | nothing | `none` |
| turned away | fits | empty; `null` | `noPiMeta()` with the record | one warning, target `data/pi` | `turned_away` |
| any of the four | turned away | as its row says | as its row says, `sync` the three `null`s | one warning more, target `data/sync-status.json` | `turned_away` |

The two warnings, code `pi-snapshot-unreadable`, level `warning`:
`pi's data is left out of this dataset (<why>). No entry has a pi block.` and
`The record of the last pi import is left out of this dataset (<why>). It is published as no attempt recorded.`
A third, of `publish()` (step 7 below), target `data/published/pi-report.json`:
`pi's report could not be written (<why>). The dataset is published with pi's data as usual; only data/published/pi-report.json is missing.`

**`publish()`** (`scripts/lib/publish.ts`), in this order:

1. load everything as today; the alias file with the other authored files (`PiAliases` from `schema.ts`);
2. `resolve()`, once; an error-level issue or an empty catalog ends the build here, as on `main`, before anything
   of pi's is touched;
3. read `data/sync-status.json` where `main` reads it; `const pi = piOfBuild({ … })`;
4. for every entry of the catalog whose ref is in `pi.entries`: `ext(entry).pi = block` (the key is there already);
5. `buildIndex`, both times followed by: for every summary whose ref is in `pi.entries`: `summary.pi = summary`
   of that entry; the version is hashed from the catalog and the summaries after these two steps, as today;
6. `meta.pi = pi.meta`; `issues = [...resolve's, ...pi.issues]`;
7. where `pi.report` is not `null`, write it as `pi-report.json` into the temporary folder of the new snapshot,
   **through `fenced()`**, before anything else is written there: the report is pi's file, so its write goes through
   the guard like everything of pi's. It is no call into pi's code (the report is already plain text the fence
   returned), so the rule of the modules is untouched; and it is the one use of the guard in `publish.ts`, for this
   write of pi's own file and for nothing else. Where the write fails, the file is left out and the third warning
   above (the reason through `reasonOf`) joins `issues`; the build goes on and publishes as usual, and `meta.json` is
   written once, with it. The state stays what the fence made it: the step output says what became of pi's data
   in the published dataset, and with the blocks and `meta.pi` there that is `published`; the report is a private
   file outside the API, and its failure is said where every other pi warning is said;
8. write the snapshot.

`assemble(pi)` and its second call, `piMisfit`, `readPi`, `piUnreadable` and `piSync` are deleted from
`publish.ts`: there is one build, the check is the fence's, and nothing in `publish.ts` knows how pi's data is
read. `PublishReport` gains `pi?: PiOfBuild["state"]`: it is absent on every return that comes before
`piOfBuild` runs (no models.dev snapshot, an authored file that does not fit, an error-level issue, an empty
catalog), because pi was not looked at then, which is not the same as *none*.

### 2. The sync

```ts
// scripts/lib/pi-fence.ts
export interface PiOfSync {
  /** status "updated" or "unchanged" with pi's summary lines, or "failed" with a one-line error: a part that ran. */
  report: RanPart;   // PartReport without "skipped" (scripts/lib/sync.ts)
  /** For the commit message: 7 hexadecimal characters of the stored snapshot's revision, else "snapshot". */
  revision7: string;
}
/** The whole pi part of the sync. Never rejects. */
export async function piOfSync(options: Parameters<typeof syncPi>[0]): Promise<PiOfSync>;   // syncPi's own parameter type: SyncOptions with dataDir, fetch and now required
```

`piOfSync` is `fencedAsync(() => syncPi({ ...options }), schema)` and nothing more: `syncPi` returns
`{ status: "updated" | "unchanged", summary?: string[], revision?: string }` (the revision of the snapshot now
stored) and `schema` is exactly that, strict. A failure of any shape, the deadline and the size cap included, is
`report: { status: "failed", error: why }`. `revision7` is `/^sha256-([0-9a-f]{7})/` of `revision`, else
`snapshot`.

**pi's code gets an options object of its own.** As in the build, where pi's code is handed copies, `piOfSync`
hands `syncPi` a copy of the caller's options, not the caller's object: nothing pi's code assigns on it (its clock,
its `fetch`, its folder) reaches `sync()`, whose status write after the pi part uses `sync()`'s own clock. (The
second review made pi replace `now` with a clock returning an invalid date; `sync()`'s last write then threw outside
the guard.)

`piOfSync` exists from step F2 on, as exactly that one line, returning `{ report }`; `sync()` calls it from F2 on
in both places where it called `syncPi` (the full run and `--only=pi`), and no longer imports `syncPi`. Step F3
adds `revision` to what `syncPi` returns and `revision7` to what `piOfSync` returns, and the rest of this
section. So from F2 on there is no call into pi's code from outside the fence, and the rule of the modules and
test 3 hold whole, with no exception to remove later.

**`sync()`** (`scripts/lib/sync.ts`) after models.dev and the measurements have run and their five fields are
worked out:

1. write `data/sync-status.json` with the five fields and
   `pi: { last_attempt_at: <now>, status: "failed", error: "The pi part did not finish." }`;
2. `const pi = await piOfSync(options)`;
3. write the file again with `pi: { last_attempt_at: <now>, status: pi.report.status }`, and `error` where the
   report has one.

The record is a literal of three checked strings, written by the shared writer; no pi code and no schema runs
between the pi part and the file. Because of step 1, the five fields of models.dev never wait on pi, and a process
that dies inside the pi part leaves a record that says the attempt did not finish, never the previous attempt's
success. Under `--only=pi` the five fields, and nothing else, are kept from the file as it was; a file that does
not parse counts there as absent, and `sync()` logs that it did. `SyncReport` gains `piRevision7: string`.

`scripts/sync.ts` is unchanged but for one output line: `writeStepOutputs` also writes
`pi_revision7=<revision7>` where the pi part ran.

### 3. Being seen

- **In the data.** Every time the fence turns a part away, `/api/v1/meta` lists the warning with its reason, and
  the build prints it; so too where only the private report could not be written (step 7 of `publish()`), which
  leaves the step output `published` and the workflow unchanged. And where the data fits and has no block: after its
  four checks the fence, with code of its own, counts the blocks of the part it has taken, and where there is none it
  adds one warning, code `pi-no-blocks`, level `warning`, target `data/pi`: `pi's snapshot has <n> models and no
  entry has a pi block (left out: <l>, unmatched: <u>). pi's data is published as pi's code gave it.` Nothing is
  turned away for it: `meta.pi` has the snapshot and the counts, the report is written, pi's alias issues are
  listed, and the state is `published_without_blocks`. There is no silent case: without a warning, no entry has a
  pi block only where the folder `data/pi/` does not exist, and a dataset has no record only where the status file
  or its `pi` key does not exist. The fence itself looks whether the folder is there, and `storedPi` is changed to
  agree (section b): a `data/pi/` that is there and cannot be used, in any way, is *unusable*, never *none*.
- **Two codes, both the fence's own.** `pi-snapshot-unreadable` says that something of pi's was left out: the data,
  the record or the report, with the reason. `pi-no-blocks` says that pi's data was taken whole and no entry has a
  block; it says nothing of the record, which has its own warning. Neither can come from pi's code: the data's schema
  takes the four alias and provider codes from `piPart` and no other, so a part that hands in one of the fence's
  codes is a misfit and is turned away. `pi-no-blocks` joins `Issue["code"]` in `src/core/schema.ts`. `code` of an
  issue is an open string in the contract: the contract and `structure/api-v1.json` do not change.
- **On the run.** `scripts/build-data.ts` appends `pi=<published|published_without_blocks|none|turned_away>` to `GITHUB_OUTPUT` where that
  variable is set (`writeBuildOutputs(report, path)` in `scripts/lib/publish.ts`), and no line where the report
  has no `pi`. In the workflow the build step
  gets `id: build`, and directly after it:

  ```yaml
      - name: Warn about pi data missing from the build
        if: steps.build.outputs.pi == 'turned_away' || steps.build.outputs.pi == 'published_without_blocks'
        run: echo "::warning title=pi data missing from the build::The dataset is built and deployed without pi's data, with pi's data but no pi block on any entry, or without the record of the last pi import. /api/v1/meta lists which and why, under issues (pi-snapshot-unreadable, pi-no-blocks). The models.dev part is as usual."
  ```

  The text is fixed: nothing that came from pi is printed as a workflow command.
- **The commit step reads no file of pi's.** In `Keep the new snapshot`, the line that reads
  `./data/pi/meta.json` with `node -p` goes; the step gets `env: PI_REVISION7: ${{ steps.sync.outputs.pi_revision7 }}`
  and uses `revision7="${PI_REVISION7:-snapshot}"`.

### 4. What the fence does not do, and what stays outside it

It does not repair, does not drop single blocks (a part is taken whole or not at all), and turns nothing away for
what pi says of the world: which prices differ, which ids match and what a feed must look like are pi's code's and
the import's. Its checks of its own are four (1, "The fence of the build"): each block's ref is a published entry,
once; and pi's part agrees with itself in the two sentences the contract states of its numbers. Beside them it says
one thing of a part it has taken, and that one is about the world: a part with no block at all is published whole,
with the `pi-no-blocks` warning (3). The fence does not call such a part wrong. A catalog that shares no model with
pi's gives the same part, rightly; the warning is there because a fault is by far the likelier cause, and it rests
on the fence's own count of the blocks, not on anything pi's code says of itself.

It does not check pi's code's results on their way to pi's code, and it cannot tell a part that fits the contract
and agrees with itself from a right one. A fault in pi's own code that gives a coherent, wrong part is published as
pi's part. One such part is seen: the one with no block (a matcher that matches nothing: no block, every model
counted unmatched) carries the warning. Every other is published with no warning: a matcher that matches one model
in a thousand, a block with a wrong name. The build does not stop and the reference is untouched, which is what the
fence promises; that pi's part is right is held by pi's own tests (`tests/pi-source.test.ts`), and what it holds is
always in `/api/v1/meta` (`pi.counts`) and in the line the build prints.

Outside the fence, on purpose:

- **`data/authored/pi-aliases.yaml` against its schema.** It is an authored file: one that does not fit fails the
  build, as every authored file does, and a pull request's check catches it. What its lines *do* is inside.
- **`data/sync-status.json` as a file.** A file that does not parse stops the build today on `main`, wherever the
  damaged byte is, and it stays so: pi cannot cause it (the sync writes the file whole, from a plain literal, by
  an atomic rename, and a full sync replaces a damaged one), and what the build should say of models.dev's last
  import when the file is unreadable is a question about the reference, not about pi. The `pi` key of a file that
  does parse is inside the fence.
- **The pages.** They draw checked, published data when a request comes; a fault there is not the import, the
  build or the deploy.
- **`LICENSES/pi-MIT.txt`**, a file of this repository, read by `writeSnapshot` like models.dev's.
- **What no guard can catch:** a computation that does not end, or one that exhausts memory. They are bounded
  where pi's side sets the size: the deadline and the size cap of the import (section b). The build's pi input is
  a stored snapshot that passed them. And a promise pi's sync code leaves without a handler: `pi-sync.ts` awaits
  every promise it creates inside `syncPi`.
- **Tests on the built data.** `npm run check` stands between the build and the deploy, so a test may assert of
  the real `data/published/` only what the fence guarantees: that it fits the contract. No test asserts a count,
  a block or a difference of the real pi data.

### 5. The tests that prove it

`tests/pi-fence.test.ts` holds the fault tables and replaces `tests/pi-net.test.ts`; `tests/fenced.test.ts` holds
the guard's direct tests (what F1 wrote: control characters, 300 characters, hostile throws, getters, cycles).
Each fixture build is made with a fixed `now`, three times: **healthy** (with pi), **without** (`data/pi/`
absent) and with a fault.

1. **The table of faults, generated from what the fence calls.**

   *Which functions.* The **boundary functions**: the exports of pi's two modules that `pi-fence.ts` calls, today
   `storedPi` and `piPart` for the build and `syncPi` for the sync. The set is found, not listed: `vi.mock` wraps
   every exported function of `src/core/pi.ts` and `scripts/lib/pi-sync.ts` in a wrapper that counts its calls. A
   call inside pi's own modules uses the module's local name and never passes a wrapper, so the wrappers that are
   called are exactly the functions the fence calls. The set is taken over a healthy build, a build without
   `data/pi/`, a healthy first import, a 304 and a failed import, and the test fails unless it equals the names
   `pi-fence.ts` imports as values from the two modules, read from its source. So a function the fence calls
   later gets its rows without an edit; and an import the fence never calls, or a call that no longer passes its
   wrapper, fails the test.

   *Why the other exports have no rows.* A fault put into `matchPi` or `loadPi` this way cannot reach the build:
   its row would pass without testing anything, and a table of such rows would look like more proof than it is.
   Nothing is lost by leaving them out. Whatever goes wrong inside pi's code can leave it in two ways only, as
   something a boundary function throws or as what it returns, because pi's code holds no reference to anything
   that is published (rule 2); and the rows put both at the boundary, the return at every depth. pi's code is
   **not** changed to call itself through its own exports for the sake of the table.

   *The faults, for each boundary function.* Every row asserts that its fault fired (the wrapper says so).
   - without running the true function: it throws an `Error`; it throws an object whose `message` is a number and
     whose `toString` throws; it throws an `Error` whose message has line breaks, control characters and 1,000
     characters; it returns `undefined`; it returns `{}`;
   - after running the true function, it returns the true result with: **its first key made a getter that
     throws** (`blocks` of `piPart`'s, `state` of `storedPi`'s: a key the fence reads; on a key it never reads the
     fault would test nothing); **its first key made the result itself**; **one key deleted**; **one value
     replaced by a value its schema refuses**: a number, or a string where a number fits there, whichever of the
     two the schema refuses at that place (a nullable number takes `null` and a number, so it gets a string).
   - *Which keys and values.* The table mutates **what the fence reads**:
     - at the top level of the result, every key its schema requires;
     - inside `blocks[0]` and `issues[0]`, where the result has them, every key and every value at every depth,
       with two exceptions, both open maps. Inside `compat` no key is deleted and no value replaced (a map of any
       JSON: nothing there is a misfit). Inside `thinking_level_map` no key is deleted (a map with pi's own keys:
       a level less still fits), and every value is replaced (it takes a string or `null`: a number is a misfit);
     - inside `report.totals`, the four keys the fence makes `counts` of: `matched_id`, `matched_alias`,
       `left_out`, `unmatched`. Not `models`: the fence never reads it, and the report crosses the fence as the
       text of a private file, `data/published/pi-report.json`, which is not in the API. What is wrong only there
       is wrong in pi's own report.
     A result without keys gets the first five faults only. The fixture is such that the first block has a tier,
     a difference, `compat`, a thinking level map and prompt cache lifetimes, and that the build raises one alias
     issue.

   *The builds of this table* use a status file with no `pi` key, the healthy and the without build too, so that
   `meta.pi.sync` is the same in all three.

   *What must hold after every row.* Each fault above is a throw, a misfit, or a part that no longer agrees with
   itself (`storedPi`'s `catalog` replaced: the counts no longer add up to the snapshot's models), so each row
   must end turned away. A row that ends `published` is a finding: it is reported, not excepted in the test.
   - `publish()` returns `ok: true` and does not throw, and its `pi` is `turned_away`;
   - every answer of the published dataset fits the contract (the check `tests/api.test.ts` makes of a snapshot);
   - models.dev's part is untouched: the comparison of section j between the healthy build and this one finds 0
     differing objects;
   - the dataset is the *without* build's, byte for byte: every file under `published/` is that build's, except
     `site/data/meta.json`, which differs from it in nothing but one more item of `issues`, the
     `pi-snapshot-unreadable` warning for `data/pi`, with a reason of one line and at most 300 characters; and
     `pi-report.json` is absent.

   *What the fence does not promise, shown by two rows.* `piPart` returns its true result with the `name` of the
   first block changed to another string; and `piPart` returns its true result with one level deleted from the
   first block's `thinking_level_map`. Each fits the contract and agrees with itself, so it is published as pi's
   part: the state is `published`, the first three points above hold, and the files differ from the healthy
   build's only where that block and the version are. The fence keeps pi from stopping the build and from
   touching the reference; whether pi's part is right is for pi's own tests (`tests/pi-source.test.ts`).

   *The record's part, the same way.* The healthy build here has a valid record. The `pi` key of the status file
   is replaced by each of: a string, a number, `null`, an array, the record with each key deleted, with each
   value of a wrong type, with an unknown key. After each: the first three points above; `pi` is `turned_away`;
   the files are the healthy build's except `meta.json`, whose `pi.sync` is the three `null`s and whose `issues`
   has the warning for `data/sync-status.json`.

   *The private report's write.* Every write of a file named `pi-report.json` throws, as a disk would. `publish()`
   gives `ok: true` and `pi` is `published` (so is the step output); every answer fits the contract; 0 differing
   objects against the healthy build; the files are the healthy build's except `meta.json`, which gains only the
   warning for `data/published/pi-report.json`; `pi-report.json` is absent. Control: with no `data/pi/` and the
   same fault armed, nothing is written and nothing warns.
2. **The sync, by the same table.** The boundary function is `syncPi`, with the faults of test 1 (the keys its
   schema requires: `status`). And through the one thing that reaches its inside, the `fetch` it is given: one
   that rejects with each of the thrown shapes, one whose body never ends (the deadline shortened as the existing
   deadline test does), one whose body is over the size cap. After each: `sync()` resolves; `report.ok` and the
   five fields of the status file are those of a run with a healthy pi part; `data/upstream/` and `data/sources/`
   are byte for byte that run's; the `pi` record is `failed`, with this attempt's time and an error of one line;
   `writeStepOutputs` writes `pi=failed`; and `data/pi/` is a snapshot `storedPi` calls usable, byte for byte
   **what it was** where the true `syncPi` did not run or did not get to its swap, and what a healthy run leaves
   where the fault came after it. It is never anything else. One row more: `syncPi` assigns each of its options
   (`dataDir`, `fetch`, `now`, `log`, `force`, `only`) on the object it is handed, a clock returning an invalid date
   among them, and then runs: the run ends as a healthy run, with the pi part's own outcome (here `failed`,
   `Invalid time value`) recorded by `sync()`'s clock. And once, with a pi part held open: while it is
   pending, the status file on disk already has this run's five fields and the record
   `The pi part did not finish.`
3. **Nothing calls pi's code outside the fence, and nothing leads back.** `tests/pi-fence-imports.test.ts` reads
   every `.ts` and `.astro` file under `src/`, `scripts/` and `worker/` and fails:
   - where an `import`, a dynamic `import()` or an `export … from` names `src/core/pi.ts` or
     `scripts/lib/pi-sync.ts` from any file but the ones the table of modules allows, unless it is of the form
     `import type …`. An import that names values, and one whose names are all inline `type`
     (`import { type A } from`), both count as a value import: under `verbatimModuleSyntax` the second still loads
     the module;
   - where `src/core/pi.ts` or `scripts/lib/pi-sync.ts` imports a value from `scripts/lib/sync.ts`,
     `scripts/lib/publish.ts`, `scripts/lib/pi-fence.ts` or `scripts/lib/fenced.ts`;
   - where `scripts/lib/pi-fence.ts` imports a value from `scripts/lib/sync.ts` (no cycle at the fence);
   - where `scripts/lib/fenced.ts` imports anything of pi's at all;
   - where `scripts/lib/pi-fence.ts` exports anything but `piOfBuild`, `piOfSync` and types;
   - where `piOfBuild(` or `piOfSync(` is called from more than the one file each.
   The whole rule holds from step F2 on, with no exception.
4. **The dataset is complete without pi.** `resolve()` on the fixture, with no pi anywhere, gives `pi: null` on
   every entry, `buildIndex` `pi: null` on every summary, and both fit the contract; `noPiMeta()` fits
   `MetaSchema.shape.pi`.
5. **Own properties.** For each name of `Object.getOwnPropertyNames(Object.prototype)` (`constructor`, `toString`,
   `__proto__`, `hasOwnProperty` and the rest) used as a pi provider id where the id's grammar allows it, as a pi
   model id, as a provider key and a model key of the alias file and as a `same_as`: the build publishes the
   healthy dataset's blocks for every other entry, and no block, no match and no fault for that name. Two cases
   of `__proto__`, which zod's record drops. As a model key of the alias file: the provider line carries a second,
   ordinary model line, because a line left with no model would fail the alias file's own schema, which is outside
   the fence on purpose. As a pi model id in the stored snapshot: `storedPi` calls the snapshot unusable (section
   b), so the data is turned away with the warning, the reference untouched; that row asserts this and not the
   healthy blocks.
6. **Being seen.** A `data/pi/` that is an empty folder, one without `meta.json`, one whose `meta.json` holds
   `null`, one without `providers/`: each gives the warning and `state: "turned_away"`; no `data/pi/` gives none
   and `state: "none"`. One case more: `piPart` returns its true result with `blocks` emptied, `matched_id` and
   `matched_alias` set to 0 and their sum added to `unmatched`. After it:
   - `pi` is `published_without_blocks`;
   - `meta.json` has the healthy build's `pi.snapshot`, the changed counts and one `pi-no-blocks` warning for
     `data/pi`;
   - `pi-report.json` is written, and 0 objects differ in the reference.

   This row shows why the rule is the fence's: pi's code said nothing and the alarm fired. `writeBuildOutputs`
   writes the four states. `tests/workflow.test.ts`: the warning step stands
   directly after the build step with its condition; `Keep the new snapshot` names no path under `data/pi/` but in
   `git status` and `git add`, and commits `sync: pi dd93eb2` from the step output and `sync: pi snapshot`
   without one.

`tests/pi-source.test.ts` keeps its cases; where it called `resolve()` with pi it calls `piPart` or builds through
`publish()`. The real-data test of `tests/pi-net.test.ts` ("lets the committed data through") is not kept: the
contract test of the real snapshot in `tests/api.test.ts` is the one test on the built data.

The check "every answer of a published dataset fits the contract" is one function, `contractProblems` in
`tests/helpers.ts`, used by `tests/api.test.ts` and by the tables. The test of `tests/api.test.ts` that compares
each summary with `summarize()` of its entry ("one dataset for the website and the API") expects `pi` to be the
entry's block in short, the four fields as the fence writes them, since `summarize()` itself writes `pi: null`.

### 6. The worker's steps

One task each, in this order, on `pi-source`. **After every step, on the committed data, the result shows:**

- with `generated_at` fixed (`publish()`'s `now`), all 740 files of `data/published/`, the private
  `pi-report.json` included, have the SHA-256 of the same build at `adf67cd`; `dataset_version` is
  `32f1de2adc92a2a8`; 813 entries have a block;
- with `data/pi/` absent, in a copy of the data folder, all 739 files have the SHA-256 of the same build at
  `adf67cd`, version `35bd94461a6b0269`;
- `npm run compare:published` against a build of `6b95938`: 0 differing objects;
- `npm run check` passes.

| step | what | files | what else must be shown |
|---|---|---|---|
| F1 | **Move, change nothing.** pi's sync code into `scripts/lib/pi-sync.ts`; `PiAliases` and `PI_URL` into `src/core/schema.ts`; the guard and its tests written. *Done at `d3605ec`.* | `scripts/lib/sync.ts`, `pi-sync.ts`, `pi-fence.ts`, `src/core/pi.ts`, `schema.ts`, the imports of the tests | the diff moves code and edits imports, nothing else; the replays of step F3 give the stored files of `adf67cd` |
| F2 | **The build behind the fence, and the sync through it.** The guard to its own module: `fenced`, `fencedAsync`, `reasonOf` in `scripts/lib/fenced.ts`, their direct tests in `tests/fenced.test.ts`, unchanged. `resolve()` without pi, with `before` and `ruledOut`; the two literals and `noPiMeta()`; `piPart`; lookups by own property in `src/core/pi.ts` and `scripts/lib/pi-sync.ts`; `storedPi`'s *none* only for a folder that does not exist; `piOfBuild` with its four checks; `publish()` as in 1, with `PublishReport.pi`; `assemble`, `piMisfit`, `readPi`, `piUnreadable`, `piSync`, `piSummary` deleted. `piOfSync` as one line, called by `sync()` in place of `syncPi`; `pi-sync.ts` without a value import from `sync.ts` (its own share, ETag reading and summary) *Done at `ffea5ee`.* | `scripts/lib/fenced.ts`, `pi-fence.ts`, `pi-sync.ts`, `sync.ts`, `publish.ts`, `src/core/resolve.ts`, `entries.ts`, `pi.ts`, `schema.ts` | tests 1 (the build's and the record's tables), 3 whole, 4, 5 and the folder cases of 6; the boundary functions the test found (`storedPi`, `piPart`, `syncPi`); the number of rows generated, that every fault fired and every row ended turned away, the two rows of "does not promise" apart; the five replays of F3 give the stored files of `adf67cd` |
| F3 | **The rest of the sync.** The record written before and after; the swap last; the size cap; `revision` from `syncPi` and `revision7`, `pi_revision7` *Done at `84e7b49`.* | `scripts/lib/pi-sync.ts`, `pi-fence.ts`, `sync.ts`, `scripts/sync.ts` | test 2; five offline replays (a first 200, a changed 200, a 304, an equal-body 200, a 503) leave every stored file under `data/`, `sync-status.json` included, byte for byte as the same replays at `adf67cd` |
| F4 | **Being seen on the run.** `writeBuildOutputs`; the workflow's second warning step and the commit step without `node -p` on pi's file *Done at `110dca6`.* | `scripts/lib/publish.ts`, `scripts/build-data.ts`, `.github/workflows/publish.yml` | the rest of test 6; the diff of the workflow in full |
| F5 | **Words.** README ("Syncing": the two warnings, the record written twice, the size cap), `AGENTS.md` if it names the moved functions *Done at `8c01d3d`.* | `README.md`, `AGENTS.md` | nothing but the four lines above |

F1 comes first so that the rule of the modules can be stated and tested from F2 on. If a step cannot keep the
bytes of `adf67cd` on the committed data, it stops there and the reason goes to the chief: the fence changes
where pi's code runs, not what it computes.

---

## 11. Where the spec's first wording and the code did not fit

Kept for the record; items 1 to 3 led to the owner's second decision and are settled by it.

1. **"The providers providers.dev does not have (11)" are mostly providers it has.** Eight of the eleven are a
   catalog provider under another id (section 0). They are paired in the alias file; none is published as a new
   provider.
2. **"1,128 pi models match nothing" counted 481 that models.dev lists** and the catalog rules leave out.
   Matching is done before the exclusions, and `/meta` counts them apart (`left_out_models`).
3. **An entry from pi alone would have had no family and no release date**, which is all the catalog rules read.
   With no such entries, the question is gone.
4. **"The additions to `v1` as a change to `src/core/openapi.ts`"**: the document is generated from
   `src/core/contract.ts`; the change is mostly there (section d).
5. **"No behaviour yet" in the contract step** cannot hold as first written: a key that every entry must have has
   to be emitted, as `null`, in the same step (step 3).
6. **The dataset step** is in `scripts/lib/publish.ts`, `src/core/resolve.ts`, `src/core/entries.ts` and a new
   `src/core/pi.ts`, not in `scripts/build-data.ts`.
7. **"A value the feed does not state is null or absent"** needed one more sentence for prices: the feed always
   states a number, and its 0 is not a statement (sections 0 and e).
8. **`npm run sync -- --only=pi`** was not in the spec. Without it the first pi snapshot cannot be written into a
   branch without also moving `data/upstream/`.
9. **The research's "312 providers"** are the providers with at least one entry; the dataset has 333 provider
   records. pi's "43 providers" include one with no models.
