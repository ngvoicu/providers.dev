# One cache record per entry: every lifetime, and the safe value

Design, 2026-11-15, final after the owner's answers of that day (section 12). Not built yet. This file says what is
to be built, in full: a worker implements from it. `AGENTS.md` and `README.md` stay the rules of the data and the
contract, and section 11 lists what changes in them.

Numbers and examples are from the dataset built on 2026-11-15 from commit `e6cd269`: `dataset_version`
`c58159b6ef7f9dfa`, models.dev import of 2026-11-15 (commit `c18a3cf`), `observed.json` sha256 `956fa11a…`
(groundtruth `60423f2`), 332 providers, 10,524 entries, 78 published cache evaluations on 46 entries.

## 1. What is published

Every entry gets one record, `providers_dev.cache.lifetime`, and every summary the same object as `cache_lifetime`:

- `lifetimes`: one list of every lifetime known for the entry. Each item is a lifetime in seconds with its profile
  (`short` or `long`), its basis (`documented` or `measured`), its source (`models.dev` or `providers.dev`) and its
  date. A documented item also has the text as documented and the way of caching it is documented for. A measured
  item is one client, with its hits and checks and its results at each age.
- `short` and `long`: the safe value of each profile, `safe_s`, in seconds, with its `basis`, and beside it the
  documented lifetime (`documented_s`) and the measured one (`measured_s`) it was chosen from.

The safe value, in one paragraph (section 4 has it exactly):

- Where the provider documents a lifetime, that is the safe value, unless a measurement clearly contradicts it:
  at a tested age inside the documented lifetime, fewer than half of an evaluation's checks hit. Then the safe value
  is the measured one.
- Where nothing is documented, the safe value is the measured one: the oldest age through which every check hit, the
  lowest across clients.
- Where the provider documents that it does not cache, the safe value is 0, documented.
- Where nothing is known, it is `null`.

So `safe_s: 0` is either documented ("does not cache") or measured (no age at which every check hit), told apart by
`basis` and `source`; `safe_s: null` is "not known". The safe value is never above the documented lifetime.

The record is worked out once, in the data build, from the documented caching and the published evaluations. It
replaces three views the API has today: the documented lifetimes (`documented.modes.*.ttl`, `cache_ttl_s`,
`cache_ttl_by_mode_s`) and the results added up over all clients (`results`, `cache_results`). Those are deleted in
this work, and the pages print the merged record (section 6, tasks 5 and 6).

The imported part of an entry is not touched: `capabilities.cache` keeps models.dev's shape, and `/api.json` stays a
superset of their export.

## 2. The merged record

### 2.1 Types

In `src/core/cache.ts`:

```ts
export type LifetimeSource = "providers.dev" | "models.dev";

/** One lifetime of an entry: documented by a source, or measured for one client. */
export interface CacheLifetimeItem {
  retention_profile: RetentionProfile;
  basis: "measured" | "documented";
  source: LifetimeSource;
  date: string | null;
  lifetime_s: number;
  // what a documented item has; null on a measured one
  mode: CacheMode | null;
  documented_as: string | null;
  // what a measured item has; null, 0 or [] on a documented one
  client: string | null;
  client_label: string | null;
  parameter: string | null;
  value: string | null;
  evaluations: number;
  evaluation_ids: string[];
  checks: number;
  hits: number;
  tested_from_s: number | null;
  first_miss_s: number | null;
  results: CacheResult[] | null;
}

/** The safe lifetime of an entry for one retention profile, and what it was chosen from. */
export interface SafeLifetime {
  safe_s: number | null;
  basis: "measured" | "documented" | "none";
  source: LifetimeSource | null;
  date: string | null;
  documented_s: number | null;
  measured_s: number | null;
  clients: number;
  evaluations: number;
  checks: number;
  hits: number;
  checks_inside: number | null;
  hits_inside: number | null;
  tested_from_s: number | null;
  first_miss_s: number | null;
}

/** `providers_dev.cache.lifetime` of an entry and `cache_lifetime` of a summary. */
export interface CacheLifetimeRecord {
  short: SafeLifetime;
  long: SafeLifetime;
  lifetimes: CacheLifetimeItem[];
}
```

`EntryCache` gets the key `lifetime: CacheLifetimeRecord`, after `retention`. `Summary` gets
`cache_lifetime: CacheLifetimeRecord`, after `cache_retention`. It is the same object in both places.

### 2.2 `SafeLifetime` (`lifetime.short`, `lifetime.long`), key by key

"Of the profile" means the items of the list with this `retention_profile`.

| Key | Type | Meaning |
|---|---|---|
| `safe_s` | integer ≥ 0, or null | Seconds a cached prompt can be relied on, by the rule of section 4. It is `documented_s` or `measured_s`, and `basis` says which. Null = not known. |
| `basis` | `measured` \| `documented` \| `none` | `documented`: `safe_s` is `documented_s`. `measured`: `safe_s` is `measured_s`. `none` exactly when `safe_s` is null. |
| `source` | `providers.dev` \| `models.dev` \| null | Who the value is from. `measured`: always `providers.dev`. `documented`: the source of the documented item it is taken from. Null with `none`. |
| `date` | `YYYY-MM-DD` or null | `measured`: the newest evaluation counted. `documented`: the date of the documented item it is taken from. Null with `none`, and where the source has no date. |
| `documented_s` | integer ≥ 0, or null | The documented lifetime of the profile: the lowest `lifetime_s` of its documented items. 0 = the provider documents that it does not cache. Null = none is documented. |
| `measured_s` | integer ≥ 0, or null | The measured lifetime of the profile: the lowest `lifetime_s` of its measured items, which is the oldest age through which every check hit in every client. 0 = no such age. Null = not measured. |
| `clients` | integer ≥ 0 | How many clients were measured. 0 = not measured. |
| `evaluations` | integer ≥ 0 | How many evaluations were counted. 0 = not measured. |
| `checks` | integer ≥ 0 | Re-sends made in them, the control included. |
| `hits` | integer ≥ 0 | How many of those were served from the cache. |
| `checks_inside` | integer ≥ 0, or null | Of `checks`, those at an age up to and including `documented_s`, the control included. Null where the profile is not both documented and measured. |
| `hits_inside` | integer ≥ 0, or null | How many of `checks_inside` were served from the cache. Null with `checks_inside`. |
| `tested_from_s` | integer ≥ 0, or null | The youngest age, after the control, that any counted evaluation checked. No age below it was checked. Null = not measured, or no timed check was made. |
| `first_miss_s` | integer ≥ 0, or null | The youngest age at which any check of a counted evaluation missed. 0 = the immediate re-send missed. Null = not measured, or no check missed. |

The eight keys from `clients` to `first_miss_s` describe the measurement of the profile whatever the `basis`: a
profile whose safe value is the documented one still shows what was measured.

Which case applied is read from three keys:

| Case | `basis` | `documented_s` | `measured_s` | Beside it |
|---|---|---|---|---|
| Documented, not measured | `documented` | a number | null | |
| Documented, measured, not contradicted | `documented` | a number | a number | `hits_inside` of `checks_inside` agree |
| Measured, because the documentation was contradicted | `measured` | a number | a number, = `safe_s` | `hits_inside` of `checks_inside` |
| Measured, nothing documented | `measured` | null | a number, = `safe_s` | |
| Nothing known | `none` | null | null | |

### 2.3 `CacheLifetimeItem` (`lifetime.lifetimes[]`), key by key

One shape for both kinds, so that a page prints the list in one loop. A key that does not apply to a kind is null,
0 or `[]`, as the table says.

| Key | On a documented item | On a measured item |
|---|---|---|
| `retention_profile` | `short` for the shortest lifetime the entry documents, `long` for every other (5.1) | The profile of its evaluations |
| `basis` | `documented` | `measured` |
| `source` | `models.dev`, or `providers.dev` where the lifetime is a providers.dev correction or the entry is one providers.dev added (5.4) | `providers.dev` |
| `date` | The import date for `models.dev`; the newest evidence date for `providers.dev`; null where there is none | The newest of its evaluations |
| `lifetime_s` | The documented lifetime in seconds; 0 on the item that says the entry does not cache (5.2) | The oldest tested age through which every check of this client hit. 0 = none. |
| `mode` | `implicit` or `explicit`: the way of caching the lifetime is documented for; null on the "does not cache" item | null |
| `documented_as` | The lifetime as the source writes it, for example `5m`; null on the "does not cache" item | null |
| `client`, `client_label` | null | The public client id and label, as on `evaluations[]` |
| `parameter`, `value` | null | The request field that asked for the lifetime and the value sent, as on `evaluations[]`; both null = no lifetime was asked for |
| `evaluations` | 0 | How many evaluations the item is made from (≥ 1) |
| `evaluation_ids` | `[]` | Their ids, sorted, as in `evaluations[].id` |
| `checks`, `hits` | 0, 0 | Re-sends made in them and how many were served from the cache, the control included |
| `tested_from_s` | null | The youngest timed age any of them checked; null = none made a timed check |
| `first_miss_s` | null | The youngest age at which any of them missed; null = no miss |
| `results` | null | Their results added up by exact age, the control first: `CacheResult[]`, the type the API has today |

What one item is:

- **Documented:** one lifetime of one way of caching: one item for each text in `capabilities.cache.<mode>.ttl` that
  is a duration (5.3). An entry that documents `5m` and `1h` for explicit caching has two; one that documents the
  same lifetime for both ways has one for each. An entry documented as not caching has two items of 0 seconds, one
  per profile (5.2).
- **Measured:** one client with one retention setting: the counted evaluations of the entry with the same
  `retention_profile`, `parameter`, `value` and `client`. Its `lifetime_s` is the strict measured value of section
  3, whatever the profile's safe value turns out to be.

### 2.4 Order

1. By profile: `short`, then `long`.
2. In a profile: the documented items, then the measured ones.
3. Documented: by `lifetime_s` ascending, then `implicit` before `explicit`.
4. Measured: the setting that asked for no lifetime first, then by the seconds of `value`, then by `value` as text
   (the order of today's summary lines); then by `client`, ascending.

### 2.5 The record in full

`openai/gpt-6.1-sol` (example 3 of section 10): two lifetimes documented, one client measured, the documentation
not contradicted.

```json
"lifetime": {
  "short": { "safe_s": 1800, "basis": "documented", "source": "models.dev", "date": "2026-11-15",
             "documented_s": 1800, "measured_s": 1800,
             "clients": 1, "evaluations": 1, "checks": 16, "hits": 10, "checks_inside": 10, "hits_inside": 10,
             "tested_from_s": 300, "first_miss_s": 2400 },
  "long":  { "safe_s": 43200, "basis": "documented", "source": "models.dev", "date": "2026-11-15",
             "documented_s": 43200, "measured_s": null,
             "clients": 0, "evaluations": 0, "checks": 0, "hits": 0, "checks_inside": null, "hits_inside": null,
             "tested_from_s": null, "first_miss_s": null },
  "lifetimes": [
    { "retention_profile": "short", "basis": "documented", "source": "models.dev", "date": "2026-11-15",
      "lifetime_s": 1800, "mode": "explicit", "documented_as": "30m",
      "client": null, "client_label": null, "parameter": null, "value": null,
      "evaluations": 0, "evaluation_ids": [], "checks": 0, "hits": 0,
      "tested_from_s": null, "first_miss_s": null, "results": null },
    { "retention_profile": "short", "basis": "measured", "source": "providers.dev", "date": "2026-11-11",
      "lifetime_s": 1800, "mode": null, "documented_as": null,
      "client": "cliproxyapi", "client_label": "Requests sent through CLIProxyAPI", "parameter": null, "value": null,
      "evaluations": 1, "evaluation_ids": ["gpt6-2026-11-11/G5"], "checks": 16, "hits": 10,
      "tested_from_s": 300, "first_miss_s": 2400,
      "results": [
        { "kind": "control", "age_s": 0, "hits": 1, "checks": 1, "hit_rate_pct": 100 },
        { "kind": "timed", "age_s": 300, "hits": 3, "checks": 3, "hit_rate_pct": 100 },
        { "kind": "timed", "age_s": 900, "hits": 3, "checks": 3, "hit_rate_pct": 100 },
        { "kind": "timed", "age_s": 1800, "hits": 3, "checks": 3, "hit_rate_pct": 100 },
        { "kind": "timed", "age_s": 2400, "hits": 0, "checks": 3, "hit_rate_pct": 0 },
        { "kind": "timed", "age_s": 3600, "hits": 0, "checks": 3, "hit_rate_pct": 0 }
      ] },
    { "retention_profile": "long", "basis": "documented", "source": "models.dev", "date": "2026-11-15",
      "lifetime_s": 43200, "mode": "explicit", "documented_as": "12h",
      "client": null, "client_label": null, "parameter": null, "value": null,
      "evaluations": 0, "evaluation_ids": [], "checks": 0, "hits": 0,
      "tested_from_s": null, "first_miss_s": null, "results": null }
  ]
}
```

The other cases, each as `lifetime.short` (the lines starting with `//` are notes, not part of the answer):

```jsonc
// measured, the documentation contradicted: openrouter/google/gemini-3.8-flash (example 8)
{ "safe_s": 0, "basis": "measured", "source": "providers.dev", "date": "2026-11-04",
  "documented_s": 300, "measured_s": 0,
  "clients": 1, "evaluations": 1, "checks": 7, "hits": 1, "checks_inside": 7, "hits_inside": 1,
  "tested_from_s": 150, "first_miss_s": 150 }

// measured, nothing documented: openai-codex/gpt-6.1-sol (example 1)
{ "safe_s": 300, "basis": "measured", "source": "providers.dev", "date": "2026-11-07",
  "documented_s": null, "measured_s": 300,
  "clients": 3, "evaluations": 3, "checks": 96, "hits": 63, "checks_inside": null, "hits_inside": null,
  "tested_from_s": 300, "first_miss_s": 900 }

// documented as not caching: alibaba/qwen-mt-plus (example 13)
{ "safe_s": 0, "basis": "documented", "source": "models.dev", "date": "2026-11-15",
  "documented_s": 0, "measured_s": null,
  "clients": 0, "evaluations": 0, "checks": 0, "hits": 0, "checks_inside": null, "hits_inside": null,
  "tested_from_s": null, "first_miss_s": null }

// nothing known: 9,668 entries
{ "safe_s": null, "basis": "none", "source": null, "date": null,
  "documented_s": null, "measured_s": null,
  "clients": 0, "evaluations": 0, "checks": 0, "hits": 0, "checks_inside": null, "hits_inside": null,
  "tested_from_s": null, "first_miss_s": null }
```

The "does not cache" item, as on `alibaba/qwen-mt-plus` (one for `short`, the same for `long`):

```json
{ "retention_profile": "short", "basis": "documented", "source": "models.dev", "date": "2026-11-15",
  "lifetime_s": 0, "mode": null, "documented_as": null,
  "client": null, "client_label": null, "parameter": null, "value": null,
  "evaluations": 0, "evaluation_ids": [], "checks": 0, "hits": 0,
  "tested_from_s": null, "first_miss_s": null, "results": null }
```

Today the list would hold 1,403 documented items (1,133 lifetimes, and 270 on the 135 entries that do not cache)
and 75 measured ones.

### 2.6 What always holds

A test checks these on every entry (task 2). P is a profile; "of P" means the items with `retention_profile` P.

1. `documented_s` of P is the lowest `lifetime_s` of the documented items of P, or null where there is none.
2. `measured_s` of P is the lowest `lifetime_s` of the measured items of P, or null where there is none. Where there
   are measured items, `evaluations`, `checks` and `hits` are the sums of theirs; `clients` is the number of
   different `client` among them; `tested_from_s` and `first_miss_s` are the lowest of theirs that are not null.
   Where there are none, these are 0, 0, 0, 0, null, null.
3. `basis` is `none` ⇔ `safe_s` is null ⇔ `source` is null ⇔ `documented_s` and `measured_s` are both null ⇔ there
   is no item of P.
4. `basis` is `documented` ⇒ `documented_s` is not null and `safe_s` = `documented_s`; `source` and `date` are those
   of the first documented item of P with that `lifetime_s`.
5. `basis` is `measured` ⇒ `measured_s` is not null and `safe_s` = `measured_s`; `source` is `providers.dev` and
   `date` is the newest `date` of the measured items of P.
6. Where `documented_s` is not null, `safe_s` ≤ `documented_s`.
7. Where `documented_s` is not null and `measured_s` is null, `basis` is `documented`. Where `documented_s` is null
   and `measured_s` is not, `basis` is `measured`.
8. `checks_inside` and `hits_inside` are not null ⇔ `documented_s` and `measured_s` are both not null. Then
   `hits_inside` ≤ `checks_inside` ≤ `checks`.
9. Where `first_miss_s` is not null it is above `measured_s` (on an item: `lifetime_s`), or both are 0.
10. On a measured item: `results` is the results of the evaluations named in `evaluation_ids`, added up by age;
    `checks` and `hits` are the sums over `results`; the walk of 3.2 over `results` gives `lifetime_s` or more, and
    exactly `lifetime_s` where `evaluations` is 1.
11. Every evaluation of the entry that counts (3.1) is named in exactly one item.
12. A documented item with `lifetime_s` 0, `mode` null and `documented_as` null is there, once per profile, exactly
    when `documented.support` is `unsupported`.

## 3. The derivation of a measured value

This section makes `lifetime_s` of every measured item and `measured_s` of a profile. It is strict: any miss ends
the value. Which of `measured_s` and `documented_s` becomes `safe_s` is section 4.

The input is the entry's published evaluations, `providers_dev.cache.evaluations`, nothing else. So a reader can
redo every value from the API answer alone.

### 3.1 Which evaluations count

`resolve.ts` already decides which runs become evaluations: a run with `latest` and without `lacks`, placed on an
entry by its `models_dev` field or by `data/authored/routes.yaml`. That stays. Of an entry's evaluations, one counts
when it has at least one timed result, or its control missed (`hits < checks`). It counts for the profile that is
its `retention_profile` (as published: the declared profile of the setting, else `profileOf`).

An evaluation with no result, or with only a control that hit, says that a prompt is cached and nothing about how
long. It does not count and is in no item; it stays in `evaluations`. If no evaluation of the entry counts for a
profile, the profile is not measured.

A run with `requires` counts like any other. A run with `lacks` is not published and does not count. A run that is
not `latest` is not published and does not count.

### 3.2 One evaluation

Take the evaluation's results in this order: the control (age 0) if it has one, then the timed results by `age_s`,
ascending. Walk them:

```
safe = 0, first_miss = null
for each result, in that order:
    if result.hits == result.checks:  safe = result.age_s
    else:                             first_miss = result.age_s; stop
tested_from = age_s of the youngest timed result, or null if there is none
```

- A hit is a full hit: 2 of 3 is a miss.
- The walk stops at the first miss. An older age where every check hit again does not raise the value: a cache that
  misses at 5 minutes cannot be relied on at 30.
- The control is the check at age 0. A control that missed gives `safe = 0`, `first_miss = 0`, whatever came after.

### 3.3 One item, the profile

The value of a set of evaluations is the lowest of their values:

```
lifetime_s    = min(safe)
first_miss_s  = min(first_miss that are not null), else null
tested_from_s = min(tested_from that are not null), else null
evaluations   = how many;  date = the newest;  evaluation_ids = sorted
results       = their results added up by exact age (addResults, as today);  checks, hits = the sums over results
```

- A measured item is the set of counted evaluations with one profile, one `parameter` and `value`, and one public
  `client` id.
- The profile's `measured_s` is the lowest `lifetime_s` of its measured items (decision 2). That is the same as the
  lowest value over all counted evaluations of the profile, and the profile's other measurement numbers are made as
  above over all of them.

### 3.4 A measured item and the results by age

The per-age results the API publishes today are of two kinds: each evaluation's own (`evaluations[].results`) and
the sums over every client of a retention setting (`results`, `cache_results`). In the merged record:

- A measured item carries `results`: the sums over *its* evaluations, so one client and one setting. Same type,
  same making (`addResults`), same exact ages; the ages listed in `/api/v1/meta` (`cache_ages_s`) still say which
  ones a table has columns for.
- `lifetime_s` is read from the evaluations one by one (3.2) and the lowest is taken (3.3). On an item with one
  evaluation, which is 72 of the 75 items today, the walk over the item's `results` gives exactly `lifetime_s`. On
  an item with several, the walk over the sums can give more, never less; on the three such items today it gives
  the same.
- `evaluation_ids` names the evaluations, and `evaluations[]` has each one's own results, route, date, request
  settings and raw file.
- The sums over all clients of a setting are not made any more (section 6): adding the checks of different clients
  is what decision 2 does not do.

### 3.5 The cases of the first brief

**Several runs of one client on one entry and profile.** Their values are combined by the minimum, never by reading
a value off their added checks. Reason: groundtruth has already combined what belongs together. Two runs with the
same route, client, model and options are one `latest` run (the newer replaces the older) or one run that
`continues` the other (its checks hold both). So two published evaluations of one client always differ in what the
requests were sent with (the reasoning level, a beta header, the prompt size) or in the route. They are two request
shapes, and the value has to hold for a consumer whose shape is not known, which is the owner's reasoning for the
minimum across clients, one level down. Reading the value off added checks would also let a run that only tested 2
minutes vouch for a run that first tested at 5 and missed.

**A run that continues another.** Nothing special. groundtruth writes the continuing run's `checks` as its own plus
those of the run it continues, and the earlier run is not `latest` (same route, client, model and options), so it is
not published. Three published evaluations are of this kind today (`meta-24h-2026-11-10/M1`,
`openrouter-flash-2026-11-12/F6`, `…/F4`); each is walked like any other.

**Late checks left out.** groundtruth leaves a check out when it ran more than 30 seconds or 10 % of its age too
late, before `observed.json` is written. Such a check is in no result, so it neither supports a value nor ends one.
An age all of whose checks were late has no result and counts as not tested. `late_excluded` stays on the
evaluation, as today. One evaluation has one today (`cpa-8.0.53/D1`, 150 s: 2 of 3 checks left).

**The youngest tested age.** A run that first checked at 5 minutes and hit has `safe = 300` or more: the oldest age
through which every check hit. What it does not show is published beside it: `tested_from_s: 300` says no age under
5 minutes was checked. The measured value is claimed from `tested_from_s` through `measured_s`; below
`tested_from_s` it rests on the control and on a cache entry not appearing later than it was written. That is not
always so: `devin/deepseek-v4-pro` missed 3 of 3 at 2.5 minutes and hit 3 of 3 at 5. A run that first checked at 5
minutes and missed there has `safe = 0`, `first_miss = 300`, `tested_from = 300`: nothing was shown to be safe, and
the two ages say where the knowledge ends. Since 14 November 2026 groundtruth refuses a run that does not start with
a control and 2.5 minutes, so new evaluations all have `tested_from = 150`; of the 78 published today, 40 start at 5
minutes, 28 at 2.5, 4 at 10, 2 at 2, 1 at 1 minute, 1 at 4 hours and 2 made no timed check.

**Ages tested by one run and not another.** No age is carried from one evaluation to another. Each evaluation is
walked on its own ages; the minimum is taken over the values. An evaluation that tested few ages and never missed
caps the measured value at its oldest age: it showed nothing beyond it.

**An age with very few checks.** Every result counts, whatever its number of checks: one check that hit carries the
measured value to its age, one that missed ends it. There is no floor (decided, section 12). A miss is never
discounted for being a small sample; a hit on a small sample is weak, and `checks`, `hits`, `clients` and `date` are
published for the consumer to judge. 26 of the 78 evaluations have an age with only 2 checks (22 of them on Devin),
and 9 of the 50 measured entry-profiles rest on such evaluations alone.

**Several long settings on one entry.** `long` is one profile, also where an entry has evaluations with two longer
lifetimes (`1h` and `24h`, say). Each setting has its own measured items, with `parameter` and `value`, and the
lowest `lifetime_s` of them all is the profile's `measured_s`. No entry has two today.

### 3.6 `all_warm_through_s` is not reused

The measured value is derived from the published checks. groundtruth's `all_warm_through_s` is not read.

1. Decision 7 and the rule in `AGENTS.md`: what a page shows comes from the API. A value made from
   `evaluations[].results` can be redone by anyone holding the API answer; one copied from a field the API does not
   publish cannot.
2. `all_warm_through_s` is `null` both for "the youngest age had a miss" and for "no timed check was made". The API
   has to tell "no safe lifetime" from "not known", and only the checks do.
3. It ignores the control. A run whose immediate re-send missed and whose first age then hit would get a value
   there; here it gets 0.
4. It is optional in the file's schema, and the site already carries the checks.

The two are compared in the build instead (task 2): for a published run that has `all_warm_through_s` and whose
control did not miss, the derived `safe` must equal it, with `null` read as 0. A difference is reported as an issue
(`lifetime-differs`, a warning, with the run id); the derived value is published all the same. Today all 78 agree.

## 4. The safe value

### 4.1 The rule

For one profile, with `documented_s` (5.1) and `measured_s` (3.3), each a number or null:

```
if documented_s is not null and the documentation is not contradicted:
    safe_s = documented_s,  basis = "documented",  source and date of the documented item
else if measured_s is not null:
    safe_s = measured_s,    basis = "measured",    source = "providers.dev", date = the newest evaluation
else:
    safe_s = null,          basis = "none",        source = null, date = null
```

**Contradicted.** The documentation of a profile is contradicted when `documented_s` is above 0 and at least one
counted evaluation of the profile (3.1) has a result for which both hold:

- its `age_s` is at most `documented_s`, and
- fewer than half of its checks hit: `2 × hits < checks`.

That is the whole test. How it reads in each case the decision names:

| Case | The rule |
|---|---|
| Per client or per evaluation | Per evaluation, each on its own results. One contradicting evaluation is enough, whatever the other evaluations and clients show: the lowest client decides (decision 2). The test is not made on an item's added-up results, because a request shape that never hits and one that always hits add up to exactly half. |
| The control | It is the result at age 0, inside every documented lifetime, and is tested like any other. |
| An age with a single check | Tested like any other: 0 of 1 is fewer than half and contradicts; 1 of 1 does not. Today only controls have a single check. |
| Exactly half | 1 of 2, 2 of 4, 3 of 6 do not contradict. 1 of 3 does. |
| The age equal to the documented lifetime | Inside. A cache documented for 5 minutes that is checked at 300 s is tested there. |
| An age above the documented lifetime | Not looked at. A miss there is what the documentation says. |
| A hit beyond the documented lifetime | Changes nothing. The safe value is never above the documented lifetime. |
| "Does not cache" (`documented_s` = 0) | Cannot be contradicted: nothing is below 0. The safe value stays 0, documented, with the measurement beside it. |
| A miss that is not below half | Ends the *measured* value (section 3) and does not contradict. `measured_s` then is below `documented_s`, and both are published. |

What follows from the rule:

- `safe_s` is never above `documented_s`. Not contradicted: they are equal. Contradicted: some evaluation missed at
  an age inside the documented lifetime, so its strict value, and with it `measured_s`, is below that age.
- Where the documentation is contradicted, `measured_s` is not null, so the second branch always applies.
- A documented lifetime that no evaluation checked at any age inside it cannot be contradicted.
- "Not contradicted" is not "confirmed". `hits_inside` of `checks_inside` and the items' `results` say how much
  agrees and up to which age.

`checks_inside` and `hits_inside`, where the profile is both documented and measured: over all counted evaluations
of the profile, the checks and the hits of the results with `age_s` ≤ `documented_s`, the control included.

### 4.2 0 against "not known"

| What is known | `safe_s` | `basis` | `source` | `documented_s` | `measured_s` |
|---|---|---|---|---|---|
| The provider documents that it does not cache | 0 | `documented` | `models.dev`, or `providers.dev` for a correction | 0 | null, or what was measured |
| Nothing documented; a client's immediate re-send missed, or it missed at its youngest tested age | 0 | `measured` | `providers.dev` | null | 0 |
| A lifetime documented and contradicted; the lowest client never held | 0 | `measured` | `providers.dev` | the lifetime | 0 |
| Nothing documented, nothing measured | null | `none` | null | null | null |

- 0 is published as the number 0, not as null, so a consumer that reads only `safe_s` does the right thing: it does
  not wait on a cache.
- A documented 0 and a measured 0 are told apart by `basis` and `source`, and by which of `documented_s` and
  `measured_s` is 0.
- Null is always "not known". An entry nobody measured and nobody documented never gets 0.
- Among measured zeros, "never hit" and "missed at its youngest age" differ in `first_miss_s` (0 against the age),
  and the item's `results` has the counts.
- On the items: a client that never hit has an item with `lifetime_s: 0`; a client nobody tested has no item.

### 4.3 Every entry with a documented lifetime and a measurement for the same profile

All thirteen, on the dataset of this document. "Inside" is `hits_inside` of `checks_inside`; the lowest rate is the
result nearest to contradicting.

| Entry | Profile | `documented_s` | `measured_s` | Inside | Lowest rate inside | `safe_s` |
|---|---|---|---|---|---|---|
| `anthropic/claude-opus-5-5` | long | 3,600 | 600 | 13 of 14 | 2 of 3 at 1,800 | **3,600** documented |
| `openai/gpt-6-astra` | short | 1,800 | 1,800 | 10 of 10 | all hit | **1,800** documented |
| `openai/gpt-6-luna` | short | 1,800 | 1,800 | 10 of 10 | all hit | **1,800** documented |
| `openai/gpt-6.1-sol` | short | 1,800 | 1,800 | 10 of 10 | all hit | **1,800** documented |
| `openrouter/anthropic/claude-haiku-5.5` | short | 300 | 300 | 14 of 14 | all hit | **300** documented |
| `openrouter/anthropic/claude-haiku-5.5` | long | 3,600 | 1,800 | 7 of 7 | all hit; oldest age inside is 1,800 | **3,600** documented |
| `openrouter/anthropic/claude-opus-5.5` | long | 3,600 | 1,800 | 7 of 7 | all hit; oldest age inside is 1,800 | **3,600** documented |
| `openrouter/google/gemini-3.8-flash` | short | 300 | 0 | 1 of 7 | 0 of 3 at 150 and at 300 | **0** measured (contradicted) |
| `openrouter/google/gemini-4-argon` | short | 300 | 150 | 11 of 12 | **1 of 2 at 300** (borderline) | **300** documented |
| `openrouter/openai/gpt-6-astra` | short | 1,800 | 1,800 | 10 of 10 | all hit | **1,800** documented |
| `openrouter/openai/gpt-6-luna` | short | 1,800 | 1,800 | 10 of 10 | all hit | **1,800** documented |
| `openrouter/openai/gpt-6.1-sol` | short | 1,800 | 1,800 | 25 of 25 | all hit | **1,800** documented |
| `openrouter/openai/gpt-6.1-terra` | short | 1,800 | 1,800 | 25 of 25 | all hit | **1,800** documented |

The evaluations behind the four rows where the two values differ:

- `anthropic/claude-opus-5-5` long, `cliproxyapi`, 2026-11-04: `K1-beta` c 1/1 · 600: 3/3 · 1800: 2/3 · 3900: 0/3;
  `K1-nobeta` c 1/1 · 600: 3/3 · 1800: 3/3 · 3900: 0/3. 2 of 3 is not below half; 3,900 is outside.
- `openrouter/anthropic/claude-haiku-5.5` long, `cpa-8.0.53-or/P2`: c 1/1 · 600: 3/3 · 1800: 3/3 · 3900: 0/3.
  `openrouter/anthropic/claude-opus-5.5` long, `openrouter-direct/R1h`: c 1/1 · 600: 3/3 · 1800: 3/3 · 3900: 0/2.
  No miss inside the hour; no age between 30 and 60 minutes was checked.
- `openrouter/google/gemini-3.8-flash` short, `openrouter-direct/R5`: c 1/1 · 150: 0/3 · 300: 0/3. Contradicted at
  150.
- `openrouter/google/gemini-4-argon` short: `cpa-latest-2026-11-06/L1b`, `cliproxyapi`: c 1/1 · 150: 2/2 ·
  300: 1/2 · 600: 0/2 · 900: 0/2; `openrouter-direct/R4`, `direct`: c 1/1 · 150: 3/3 · 300: 3/3 · 450: 0/3 ·
  600: 0/3.

The borderline cases and which way the rule takes them:

1. **Exactly half, at exactly the documented age.** `openrouter/google/gemini-4-argon`: through CLIProxyAPI, 1 of 2
   hit at 300 s, where 5 minutes are documented; straight to OpenRouter, 3 of 3. Half is not "fewer than half", so
   the documentation stands: **300, documented**, with `measured_s` 150 beside it. Under "half or fewer" it would be
   150, measured. If the documented age itself did not count as inside, the result at 300 would not be looked at
   and it would be 300 under either wording. This is the one entry where the wording of the test decides.
2. **An age with one check.** None of the thirteen has a missed single check: every control here is 1 of 1. By the
   rule a control of 0 of 1 on a documented entry would contradict and give 0 measured. The eight controls that
   missed today are all on Devin entries, which document nothing.
3. **Nearest above half.** `anthropic/claude-opus-5-5`: 2 of 3 at 30 minutes. With 3 checks an age contradicts at 1
   of 3 and not at 2 of 3; with 2 checks only at 0 of 2.

## 5. The documented items

### 5.1 The source fields and the profiles

The documented caching of an entry: models.dev's `capabilities.cache` after providers.dev's corrections, as
`documentedCache` in `src/core/cache.ts` reads it. For each way of caching that is supported, each text of its `ttl`
list that is a duration (5.3) is one documented item, with `mode`, `documented_as` and `lifetime_s`.

The profile of a documented item:

- `short`: its `lifetime_s` is the shortest lifetime the entry documents, over both ways of caching.
- `long`: every other.

This is the rule that already puts an evaluation in a profile (`profileOf`: no lifetime asked, or the shortest
documented one, is short; any other is long), so a documented lifetime and an evaluation of the same setting land in
the same profile.

`documented_s` of a profile is the lowest `lifetime_s` of its documented items: for `short` the shortest lifetime
documented, for `long` the shortest of the longer ones. Section 4 says when it is the safe value.

Today (the documented lifetimes of an entry, in seconds, over all entries): 300 and 3,600 on 431 entries, 300 alone
on 142, 1,800 alone on 67, 86,400 alone on 31, 1,800 and 43,200 on 13, 7,200 alone on 3, none on 9,837. An entry
with one documented lifetime has it as `short` and nothing documented for `long`. One entry (`openai/gpt-6-cyber`)
documents the same two lifetimes for both ways of caching and has four documented items.

### 5.2 "Does not cache"

Where `providers_dev.cache.documented.support` is `unsupported` (models.dev has `cache: false`, or both ways of
caching are `false`), the entry gets two documented items, one with `retention_profile` `short` and one with `long`:
`lifetime_s` 0, `mode` null, `documented_as` null, source and date by 5.4. So `documented_s` is 0 for both profiles
and, by section 4, `safe_s` is 0 with basis `documented`.

135 entries today, all with `cache: false` from models.dev and none of them measured. An entry where one way of
caching is unsupported and the other is not stated has `support: unknown` and gets no such item.

### 5.3 Text to seconds

Only `durationSeconds` (`src/core/cache.ts`): a whole number and one unit of `ms`, `s`, `m`, `h`, `d` (`"5m"` → 300,
`"1h"` → 3600). Every lifetime in today's catalog has that form (`5m`, `30m`, `1h`, `2h`, `12h`, `24h`).

Anything else (a range such as `5m-10m`, words) is not converted and is no item: a number is not made up from it.
Today such a string is dropped silently by `cacheFacts`; from task 2 the build reports it (`unparsed-lifetime`, a
notice, target `provider/model#capabilities.cache.<mode>.ttl`), so that the format is seen the day models.dev uses
it. The text itself stays readable in `capabilities.cache`, which is published as imported. If ranges appear, the
rule to add is "the lower bound", as a change to this design.

### 5.4 The source and date of a documented item

For an item of mode `<mode>`, with `P` = `capabilities.cache.<mode>.ttl`:

1. If the entry's `providers_dev.provenance` has a correction whose `path` is `P`, starts with `P.`, or is one of
   `capabilities`, `capabilities.cache`, `capabilities.cache.<mode>`: `source` is `providers.dev` and `date` is the
   newest evidence date of those corrections.
2. Else, if the entry's `origin` is `added`: `source` is `providers.dev` and `date` is the newest date of the
   entry's evidence that is not of kind `listed`, or null.
3. Else: `source` is `models.dev` and `date` is the import date (`upstreamDate` of `resolve`), or null where the
   build has none.

For a "does not cache" item the same, with the corrections whose `path` is `capabilities`, `capabilities.cache`, or
starts with `capabilities.cache.`.

This is how `resolve.ts` already names the source of the cache capabilities (`cacheEvidence`, `sourcesOf`). Today
every documented item is case 3: no correction touches a `ttl` or a `cache: false`, and no added entry documents
caching.

### 5.5 Caching documented, no lifetime documented

2,543 entries document implicit caching as supported; 2,482 of them give no implicit lifetime, and 2,276 no lifetime
at all. With no evaluation their record is `safe_s: null`, `basis: "none"` (decision 5): that a provider caches says
nothing about how long. In all, 2,344 entries document caching and get null for `short`. A consumer tells them from
entries nothing is known about with the fields that say so today and stay: `cache`, `cache_mode_support` and
`providers_dev.cache.documented`.

An entry providers.dev added takes no cache behaviour from the entry it names, so it has no documented item unless
its own file states one. The `meta-subscription/*` entries are of that kind: their values are measured, and nothing
is documented beside them.

## 6. What becomes of today's fields

"Merged, not distinct": a lifetime is published in one place, the list. A field stays only where it says something
the list does not. The owner: "delete them and make it nice and change the website". Nothing is kept for old
readers; the API is not public.

### 6.1 In `providers_dev.cache`

| Today | After | Why |
|---|---|---|
| `documented.support`, `documented.modes.<mode>.support` | **Stay** | Whether and how the entry caches (supported, unsupported, unknown). Not a lifetime. The filters `cache` and `cache_mode` and the rule "cache mode support comes from `providers_dev.cache.documented`" rest on it. |
| `documented.modes.<mode>.min_tokens`, `max_breakpoints`, `targets` | **Stay** | Documented facts about a way of caching that are not lifetimes. |
| `documented.modes.<mode>.ttl` | **Folded, then deleted** | Each text is the `documented_as` of a documented item, with its `mode`, seconds, profile, source and date. |
| `retention` | **Stays** | What a request can send: the field, the accepted values, the default, which value gives which profile, the conditions, the evidence. The list says how long a cache lasts, not how to ask for it. |
| `results` | **Folded, then deleted** | Its lines per retention setting become the measured items: `retention_profile`, `parameter`, `value`, `evaluations`, `evaluation_ids`, the newest date and the results by age, now per client. The sums over all clients are not made any more. |
| `evaluations` | **Stay**, unchanged | The raw record: route, client, date, request settings, each evaluation's own results, `late_excluded`, note, the raw file. The items point to them by id. |
| `lifetime` | **New** | The merged record. |

After the work `providers_dev.cache` has four keys: `documented` (whether and how), `retention` (how to ask),
`lifetime` (how long, by every source, and the safe value), `evaluations` (the raw measurements).

### 6.2 In the summary

| Today | After | Why |
|---|---|---|
| `cache`, `cache_modes`, `cache_mode_support` | **Stay** | Support, not lifetimes; the filters use them. |
| `cache_retention` | **Stays** | `retention.support`. |
| `evaluation_count` | **Stays** | The filter `evaluated` uses it; it also counts evaluations that are in no item (3.1). |
| `cache_ttl_s` | **Folded, then deleted** | The `lifetime_s` of the documented items. |
| `cache_ttl_by_mode_s` | **Folded, then deleted** | The same, by their `mode`. |
| `cache_results` | **Folded, then deleted** | As `results` above. |
| `cache_lifetime` | **New** | The merged record, the same object as on the entry. |

### 6.3 What is left alone, and why it is not a second view

- `capabilities.cache` in the imported part of the entry still has models.dev's `ttl` lists. It is models.dev's
  record in models.dev's shape, which `AGENTS.md` and the README promise to keep, and what makes `/api.json` a
  superset of their export. providers.dev does not restate lifetimes anywhere else of its own.
- `request_controls`: an option of the `cache.retention` control can carry `attributes.retention_s`, the lifetime
  that sending the option's value asks for. It is the label of a request value, in the record that says how to ask,
  not a statement about the entry's cache, and it has no item (decided, section 12). On the 636 options that carry
  it today, on 318 entries, it equals the documented lifetime of the option's profile in every case, and the build
  keeps it so (task 2): a difference is reported (`retention-lifetime-differs`, a notice) and a person corrects one
  of the two with an override. An option without `retention_s` states no lifetime: on Meta's seven API entries
  `"24h"` "asks for up to 24 hours. It is not a lifetime the cache is sure to have", so no 86,400 comes from its
  name.
- `/api/v1/evaluations/cache` and `/api/v1/meta` are not touched.

### 6.4 Nothing is lost

Where each fact published today is read after the old fields are gone:

| Fact today | Where it is afterwards |
|---|---|
| A documented lifetime, as text and by way of caching (`documented.modes.<mode>.ttl`) | `lifetime.lifetimes[]`, documented items: `documented_as`, `mode`; also `capabilities.cache.<mode>.ttl`, as imported |
| The same in seconds (`cache_ttl_s`, `cache_ttl_by_mode_s`) | `lifetime_s` of those items, by `mode` |
| Support, minimum size, markers, targets (`documented`, `cache`, `cache_modes`, `cache_mode_support`) | Unchanged |
| The request parameter and its values (`retention`, `cache_retention`, `request_controls`) | Unchanged |
| A summary line's setting: `retention_profile`, `parameter`, `value` | The same keys on each measured item |
| A summary line's `evaluations`, `evaluation_ids`, `last_date` | `evaluations`, `evaluation_ids`, `date` of each measured item; the totals of a profile on `lifetime.<profile>` |
| A summary line's results by age (hits, checks, percent) | `results` of each measured item, per client. The sum over clients is the sum of those; it is not published as a line. |
| "This setting was not evaluated" (`results: null`, `evaluations: 0`) | `lifetime.<profile>.evaluations` is 0 and the profile has no measured item |
| Every evaluation with its own results (`evaluations[]`, `/api/v1/evaluations/cache`) | Unchanged |

Three things change in what can be read, all small:

1. The sums over all clients of a setting are no longer published.
2. `documented.modes.<mode>.ttl` tells "no list" (`null`) from "an empty list" (`[]`); both are "no documented
   item" afterwards. The imported `capabilities.cache` still shows which it was. No entry has an empty list today.
3. An evaluation that does not count (no result, or only a control that hit) is in a summary line today and in no
   item afterwards. It stays in `evaluations`. No published evaluation is of that kind today.

### 6.5 The order of the change

The old fields are read by the pages (`src/core/render.ts`, `format.ts`). So tasks 1 to 4 add the merged record,
task 5 moves the pages to it, and task 6 deletes the old fields, one straight after the other. Between task 2 and
task 6 the API carries both, with the old ones unchanged in value; that state is not published.

## 7. The `known` lifetimes of groundtruth

`observed.json` has three: CLIProxyAPI on a Claude login asks Anthropic for the 1-hour cache (3,600 s, every model
of the route); CLIProxyAPI with a Claude API key gets Anthropic's default (300 s); the same with the
`claude-code-cli` fingerprint profile set gets 3,600 s. `resolve.ts` does not read them.

They stay out of the record (decided for now, section 12). The reasoning:

1. They are not measurements and not the provider's documentation of the entry. The decisions name two bases for an
   item and this is a third: what follows from how one client builds its requests.
2. They belong to a client, one of them to a setting of that client (`when`). A lifetime nobody tested cannot enter
   the measured value, and it is not the provider's statement, so it cannot be `documented_s` either.
3. They carry no retention profile. "CLIProxyAPI asks for the 1-hour cache" is what a request gets without asking
   (short) and a longer lifetime (long) at once. Putting it in one would be the site's invention; the profile has to
   come from groundtruth.
4. Two of the three repeat what the documented items already give every `anthropic/*` entry (300 short, 3,600
   long). The third is the only new information: the three `claude-subscription/*` entries, which have no evaluation
   and no documented lifetime and so get null.

If they are wanted later, the list is the place: an item with `basis: "known"`, the client, `ttl_s` as `lifetime_s`
and groundtruth's `source`, never entering `safe_s`. That adds a third value to an item's `basis` and needs a
`profile` on each `known` item in groundtruth.

## 8. Where it is computed and how it reaches every answer

```
data/sources/observed.json ─┐
data/upstream/, authored/  ─┴─▶ resolve() step 6, per entry
                                  documented  = documentedCache(model)             (as today)
                                  evaluations = the entry's CacheEvaluation[]      (as today)
                                  lifetime    = cacheLifetime(documented, evaluations, sourceOf)   ◀── new
                                  providers_dev.cache = { documented, retention, lifetime, evaluations }
                                        │
        buildIndex() / summarize() ─────┤  summary.cache_lifetime = providers_dev.cache.lifetime   ◀── new
                                        ▼
        data/published/  (catalog.json, api.json, entries/, index.json)  ──▶  every API answer, every page
```

Four pure functions in `src/core/cache.ts`, beside `summarizeCache`. No file, no network, no clock; the file still
runs in the browser.

- `evaluationLifetime(evaluation: CacheEvaluation): { safe_s: number; first_miss_s: number | null; tested_from_s: number | null } | null`
  is section 3.2; null = the evaluation does not count (3.1).
- `contradicts(evaluation: CacheEvaluation, documentedS: number): boolean` is the test of 4.1 for one evaluation:
  false where `documentedS` is 0.
- `documentedItems(documented: CacheDocumentation, sourceOf: (mode: CacheMode | null) => { source: LifetimeSource; date: string | null }): CacheLifetimeItem[]`
  is section 5. `sourceOf` is 5.4 (`null` = the "does not cache" item); `resolve` passes it, because only `resolve`
  knows the corrections and the import date.
- `cacheLifetime(documented, evaluations: readonly CacheEvaluation[], sourceOf): CacheLifetimeRecord` makes the
  measured items (3.3), puts the list in order (2.4) and works out the two profiles (4.1, 2.2).

How it reaches each answer:

| Where | How | Change |
|---|---|---|
| `providers_dev.cache.lifetime` of a full entry | `resolve.ts` step 6 adds the key to the `EntryCache` it builds | `resolve.ts`, `cache.ts` |
| `cache_lifetime` of a summary | `summarize` in `src/core/entries.ts` copies it from the entry | `entries.ts` |
| `/api/v1/entries`, `/entries/{provider}/{model}`, `/providers/{id}`, `/models/{lab}/{model}`, `/catalog` | They pass summaries and entries on as published | none in `api.ts` |
| `/api.json` | The catalog as published; the key is under `providers_dev.cache` of every model, and the models.dev fields are as imported | none |
| `/api/v1/openapi.json`, the tables of `/docs/api/` | Generated from `src/core/contract.ts` | `contract.ts`: three schemas, two keys, three components |

In `contract.ts`: `CacheLifetimeItemSchema`, `SafeLifetimeSchema` and `CacheLifetimeRecordSchema` (strict objects,
each `satisfies` its type, described with the meanings of 2.2 and 2.3), `lifetime` in `EntryCacheSchema`,
`cache_lifetime` in `EntrySummarySchema`, and the components `CacheLifetime`, `SafeLifetime` and
`CacheLifetimeItem` in `COMPONENTS`.

Versions: `dataset_version` changes with each task that changes the data, because it is a hash of the catalog and
the summaries, and with it every ETag. `schema_version` stays 1 and `api_version` stays `v1`: the API is not public
yet. The `version` of the OpenAPI document goes to 1.3.0 with task 4 and to 2.0.0 with task 6, which removes fields.

Size: `index.json` is 26 MB and the catalog 36 MB before gzip today. The record of an entry nothing is known about
is about 500 bytes, some 5 MB in each file; today's 1,478 items add about half a megabyte, and task 6 removes the
old fields. The assets served are the gzip files (0.7 MB and 1.4 MB today, against a limit of 25 MiB); the new
records are nearly all the same and compress to very little.

## 9. What a page prints

The merged record is the API's shape, and a page prints it as it is:

- per profile, `lifetime.<profile>`: `safe_s` with `basis`, `source` and `date`; beside it `documented_s` and
  `measured_s`, each where it is not null, and `hits_inside` of `checks_inside` where they are not null;
- the list, one item under another, each with the same fields: `retention_profile`, `lifetime_s`, `basis`,
  `source`, `date`; on a documented item `mode` and `documented_as`; on a measured item `client_label`, the setting
  (`parameter`, `value`), `hits` of `checks`, and `results` where the page shows the ages.

Every lifetime is in seconds, so `"5m"` is converted once, in the build. Documented and measured lifetimes are items
of one list, so a page has one loop and no second block. Which value is the safe one is `basis` and `safe_s`, so a
page compares nothing, takes no minimum and applies no rule. Each item names `models.dev` or `providers.dev` and has
its own date, as `AGENTS.md` and the licence notes require. A profile with no item prints "Unknown"; 0 prints as
"None", with its basis.

A cell of the results by age shows the hit percentage rounded to a whole number; the exact `hit_rate_pct`, the hits
and the checks are in the API and in the hover text (decided separately, section 12).

How the items are laid out (the two profiles as columns, the clients as rows, the ages as today's cells) is the
designer's.

## 10. Worked examples

Each from the published evaluations of the dataset `c58159b6ef7f9dfa`; `c` is the control, then `age: hits/checks`.
To see an evaluation: `/api/v1/entries/<ref>`, `data.entry.providers_dev.cache.evaluations`.

**1. `openai-codex/gpt-6.1-sol`, short: three clients, nothing documented → 300 measured.**

| Evaluation | Client | Results | `lifetime_s` | `first_miss_s` | `tested_from_s` | `hits` of `checks` |
|---|---|---|---|---|---|---|
| `cpa-codex-long-2026-11-06/X1` | `cliproxyapi` | c 1/1 · 300: 3/3 · 900: 2/3 · … | 300 | 900 | 300 | 23 of 34 |
| `harness-2026-11-07/H1` | `codex-cli` | c 1/1 · 300: 3/3 · 900: 2/3 · … | 300 | 900 | 300 | 19 of 31 |
| `harness-2026-11-07/H2` | `agent+cliproxyapi` | c 1/1 · 300: 3/3 · 900: 3/3 · 1800: 3/3 · 3600: 2/3 · … | 1,800 | 3,600 | 300 | 21 of 31 |

Three measured items. `measured_s` = min(300, 300, 1,800) = 300; `documented_s` is null, so `safe_s` = **300**,
measured, 3 clients, 3 evaluations, 63 hits of 96 checks, `first_miss_s` 900, `tested_from_s` 300, date 2026-11-07.
Long: no item → null.

**2. `meta-subscription/muse-wonder-1.0`, short: one client never hit → 0 measured. Long: one age tested.**

The entry is one providers.dev added for the Muse Code subscription key (commit `e6cd269`); until then these
evaluations were on `meta/muse-wonder-1.0`. Nothing is documented on it.

| Evaluation | Client | Results | `lifetime_s` | `first_miss_s` | `tested_from_s` | `hits` of `checks` |
|---|---|---|---|---|---|---|
| `cpa-latest-2026-11-06/L4` | `cliproxyapi` | c 1/1 · 150: 3/3 · 300: 3/3 · 600: 3/3 · 900: 2/3 · … | 600 | 900 | 150 | 15 of 22 |
| `harness-2026-11-07/H5` | `muse-code` | c 0/1 · 150 to 7200: 0/3 each | 0 | 0 | 150 | 0 of 22 |
| `harness-2026-11-07/H6` | `agent+cliproxyapi` | c 1/1 · 150, 300, 600, 900, 1800, 3600, 7200: 3/3 each | 7,200 | null | 150 | 22 of 22 |

Short: `measured_s` = min(600, 0, 7,200) = 0, `documented_s` null → `safe_s` = **0**, measured, 3 clients, 37 hits
of 66 checks, `first_miss_s` 0, date 2026-11-07. The three items carry 600, 0 and 7,200.

Long: one measured item, `parameter` `prompt_cache_retention`, `value` `24h`, from `meta-24h-2026-11-10/M2`,
`agent+cliproxyapi`: c 1/1 · 14400: 3/3 · 43200: 0/3 · 86400: 0/3 → **14,400**, measured, `first_miss_s` 43,200,
`tested_from_s` 14,400, 4 hits of 10 checks. No age under 4 hours was checked, and `tested_from_s` says so.

**3. `openai/gpt-6.1-sol`: documented and measured agree.** The record of 2.5.

Short: documented item `30m` → `documented_s` 1,800. `gpt6-2026-11-11/G5`, `cliproxyapi`: c 1/1 · 300: 3/3 ·
900: 3/3 · 1800: 3/3 · 2400: 0/3 · 3600: 0/3 → `measured_s` 1,800. Inside 1,800: c, 300, 900, 1800, 10 hits of 10
checks; no result below half → not contradicted → `safe_s` = **1,800**, documented, `models.dev`, 2026-11-15. The
misses at 2,400 and 3,600 are outside. Long: documented item `12h`, not measured → **43,200**, documented.

**4. `meta-subscription/muse-ember-1.0`: the long profile, from a run that continues another.**

Long: `meta-24h-2026-11-10/M1`, `agent+cliproxyapi`. It continues `ember-2026-11-10/E2`, which is not published;
its results hold both: c 1/1 · 300, 1800, 3600, 7200, 14400: 3/3 each · 28800: 0/3 · 43200: 0/3 · 86400: 0/3 →
**14,400**, measured, `first_miss_s` 28,800, `tested_from_s` 300, 16 hits of 25 checks. Short:
`ember-2026-11-10/E1`: c 1/1 · 300: 2/2 · 1800: 1/2 · 3600: 0/2 · 7200: 1/2 → **300**, measured, `first_miss_s`
1,800, 5 hits of 9 checks. Nothing documented.

**5. `anthropic/claude-opus-5-5`: a miss that does not contradict; two runs of one client in one item.**

Long (`cache_control.ttl=1h`), both `cliproxyapi`, 2026-11-04; documented item `1h` → `documented_s` 3,600:

| Evaluation | Sent with | Results | `safe` | `first_miss` | Below half inside 3,600? |
|---|---|---|---|---|---|
| `cpa-8.0.53/K1-beta` | `beta=extended-cache-ttl-2025-04-11` | c 1/1 · 600: 3/3 · 1800: 2/3 · 3900: 0/3 | 600 | 1,800 | no: 2 of 3 |
| `cpa-8.0.53/K1-nobeta` | no beta header | c 1/1 · 600: 3/3 · 1800: 3/3 · 3900: 0/3 | 1,800 | 3,900 | no |

One measured item of two evaluations: `lifetime_s` = min(600, 1,800) = 600, `first_miss_s` 1,800, `tested_from_s`
600, 13 hits of 20 checks; its `results` are the sums, c 2/2 · 600: 6/6 · 1800: 5/6 · 3900: 0/6. `measured_s` 600.
Inside 3,600: 13 hits of 14 checks; 3,900 is outside. Not contradicted → `long.safe_s` = **3,600**, documented,
`models.dev`, 2026-11-15, with `measured_s` 600 beside it. Short: documented item `5m`, not measured → **300**,
documented.

**6. `anthropic/claude-sonnet-5-5`: documented only.** No evaluation. `explicit.ttl` is `["5m", "1h"]`: two
documented items. Short **300**, long **3,600**, both documented, `models.dev`, 2026-11-15; `measured_s` null.

**7. Neither.** `claude-subscription/claude-opus-5-5`: no evaluation, no documented caching. `google/gemini-4-argon`:
implicit caching documented as supported, no lifetime. `meta/muse-wonder-1.0`: caching documented, no lifetime, and
no evaluation since the Muse Code runs moved. All: short and long **null**, basis `none`, `lifetimes: []`.

**8. `openrouter/google/gemini-3.8-flash`: the documentation contradicted.** Documented item `5m` → `documented_s`
300. `openrouter-direct/R5`, `direct`, 2026-11-04: c 1/1 · 150: 0/3 · 300: 0/3 → `measured_s` 0, `first_miss_s`
150. At 150, inside 300, 0 of 3 hit: contradicted → short **0**, measured, `providers.dev`, 2026-11-04, 1 hit of 7
checks, all 7 inside. The documented item stays in the list. Long: null.

**9. `openrouter/google/gemini-4-argon`: exactly half does not contradict.** Documented item `5m` → `documented_s`
300. Two measured items: `cliproxyapi` (`cpa-latest-2026-11-06/L1b`: c 1/1 · 150: 2/2 · 300: 1/2 · 600: 0/2 ·
900: 0/2 → 150) and `direct` (`openrouter-direct/R4`: c 1/1 · 150: 3/3 · 300: 3/3 · 450: 0/3 · 600: 0/3 → 300).
`measured_s` 150. Inside 300: 11 hits of 12 checks; the lowest is 1 of 2 at 300, which is half, not fewer → short
**300**, documented, with `measured_s` 150 beside it. Long: null.

**10. `devin/kimi-k3`: only a control, and it missed.** `cpa-8.0.53/D6`, `cliproxyapi`: c 0/1, no timed check. It
counts, because the control missed → short **0**, measured, `first_miss_s` 0, `tested_from_s` null, 0 hits of 1
check. Nothing documented.

**11. `devin/deepseek-v4-pro`: a miss at the youngest age, hits after it.** `cpa-8.0.53/D9`, `cliproxyapi`: c 1/1 ·
150: 0/3 · 300: 3/3 · 450: 1/3 · 600: 0/3 · 900: 0/3 → short **0**, measured, `first_miss_s` 150, `tested_from_s`
150, 5 hits of 16 checks.

**12. `devin/nemotron-3-5-super`: two request shapes per client.**

| Evaluation | Client | Sent with | Results | `safe` | `first_miss` |
|---|---|---|---|---|---|
| `devin-harness-2026-11-08/D11c` | `devin-cli` | `reasoning=none` | c 1/1 · 300 to 7200: 2/2 each | 7,200 | null |
| `devin-cache-investigation-2026-11-09/N1c` | `devin-cli` | `reasoning=medium` | c 0/1 · 120: 0/2 | 0 | 0 |
| `devin-harness-2026-11-08/D11p` | `agent+cliproxyapi` | `reasoning=low` | c 0/1 · 300 to 7200: 0/2 each | 0 | 0 |
| `devin-cache-investigation-2026-11-09/N1p` | `agent+cliproxyapi` | `reasoning=none` | c 1/1 · 120: 2/2 | 120 | null |

Two measured items of two evaluations each, both `lifetime_s` 0 (14 checks, `tested_from_s` 120). Short **0**,
measured, 2 clients, 4 evaluations, 28 checks, date 2026-11-09. With reasoning on, this model's prompt is not
cached; a consumer cannot be told to rely on it.

**13. `alibaba/qwen-mt-plus`: documented as not caching.** `capabilities.cache` is `false`; no evaluation. Two
documented items of 0 seconds. Short and long **0**, documented, `models.dev`, 2026-11-15; `measured_s` null.

### The counts

Over all 10,524 entries, by `basis`:

| Profile | `documented` | of them 0 | `measured` | of them 0 | `none` |
|---|---|---|---|---|---|
| short | 821 | 135 | 35 | 14 | 9,668 |
| long | 579 | 135 | 3 | 0 | 9,942 |

By case:

| Profile | Documented, not measured | Documented, measured, not contradicted | Measured, documentation contradicted | Measured, nothing documented | Nothing known |
|---|---|---|---|---|---|
| short | 812 | 9 | 1 | 34 | 9,668 |
| long | 576 | 3 | 0 | 3 | 9,942 |

`safe_s` of the 35 measured short profiles: 0 on 14 entries, 150 on 6, 300 on 7, 450 on 2, 1,800 on 4, 3,600 on 1,
7,200 on 1. Of the 3 measured long ones: 300 on 1, 14,400 on 2.

`measured_s`, on the 44 entries measured for short: 0 on 14, 150 on 7, 300 on 8, 450 on 2, 1,800 on 11, 3,600 on 1,
7,200 on 1. On the 6 measured for long: 300, 600, 1,800, 1,800, 14,400, 14,400.

Of the 9,668 entries with nothing known for short, 2,344 document caching without a lifetime and 7,324 document
nothing.

### Checking a build by hand

After `npm run data`:

```
jq '.openai.models."gpt-6.1-sol".providers_dev.cache.lifetime' data/published/site/api.json
jq '.entries[] | select(.ref == "meta-subscription/muse-wonder-1.0") | .cache_lifetime' data/published/site/data/index.json
jq '[.entries[] | .cache_lifetime.short.basis] | group_by(.) | map({(.[0]): length}) | add' data/published/site/data/index.json
jq '[.entries[] | .cache_lifetime.lifetimes[] | .basis] | group_by(.) | map({(.[0]): length}) | add' data/published/site/data/index.json
jq -r '.entries[] | . as $e | ("short","long") | . as $p | $e.cache_lifetime[$p] | select(.documented_s != null and .measured_s != null) | [$e.ref, $p, .documented_s, .measured_s, .hits_inside, .checks_inside, .safe_s, .basis] | @tsv' data/published/site/data/index.json
```

On the dataset of this document the third gives `{"documented": 821, "measured": 35, "none": 9668}` (with `long`:
`{"documented": 579, "measured": 3, "none": 9942}`), the fourth `{"documented": 1403, "measured": 75}`, and the
fifth the thirteen rows of 4.3.

## 11. The work, as tasks

Six tasks, one straight after the other. Each leaves `npm run build && npm run check` passing. Tasks 1 to 4 add the
merged record and change no existing value. Task 5 moves the pages to it. Task 6 deletes what was folded in.

**Task 1. The derivation, as pure functions.** Nothing calls them yet.

- `src/core/cache.ts`: the types of 2.1; `evaluationLifetime`, `contradicts`, `documentedItems`, `cacheLifetime`
  (section 8); a function that returns the record of an entry nothing is known about, for the tests and helpers.
- `tests/cache-lifetime.test.ts` (new), with results written out in the test, not read from `data/`:
  - `evaluationLifetime`: every row of the tables in section 10 (`X1`, `H2`, `H5`, `H6`, `M2`, `K1-beta`, `R5`,
    `L1b`, `D6`, `D9`, `N1p`); no result → null; only a control that hit → null; no control and a first age that
    hit; 2 of 3 is a miss; a full hit after a miss does not raise the value; results given out of order.
  - `contradicts`: `K1-beta` against 3,600 → false (2 of 3); `R5` against 300 → true; `L1b` against 300 → false
    (1 of 2 at 300); 1 of 3 inside → true; 0 of 2 at an age just above the lifetime → false; a control of 0 of 1 →
    true; a control of 1 of 1 and nothing else inside → false; any evaluation against 0 → false.
  - `documentedItems`: each set of lifetimes of 5.1; the same lifetimes for both ways of caching (four items); a
    way that is supported without `ttl`; `unsupported` (two items of 0, `mode` and `documented_as` null); one way
    unsupported and the other not stated (no item); a string that is not a duration is no item; the profile of each
    item; `sourceOf` is asked per mode, and with null for the "does not cache" item.
  - `cacheLifetime`: examples 1, 2, 3, 5, 6, 7, 8, 9, 12 and 13 in full, compared with the whole record; the order
    of 2.4; the rules of 2.6; two settings in one profile make two items; an evaluation that does not count is in no
    item; two evaluations of one client with different ages (the minimum, with `results` added up); two evaluations
    of one client, one hitting 3 of 3 and one 0 of 3 at the same age inside a documented lifetime → contradicted,
    though the item's sum is half; hits beyond a documented lifetime do not raise `safe_s`; an entry documented as
    not caching with an evaluation that hits stays 0, documented, with `measured_s` beside it.

**Task 2. On every entry.** The full entry, the catalog and `/api.json` have `providers_dev.cache.lifetime`.

- `src/core/cache.ts`: `lifetime` in `EntryCache`.
- `src/core/resolve.ts`: step 6 builds `sourceOf` (5.4) and calls `cacheLifetime`; the three reports
  (`lifetime-differs` 3.6, `unparsed-lifetime` 5.3, `retention-lifetime-differs` 6.3).
- `src/core/schema.ts`: the three codes in `Issue["code"]`.
- `src/core/contract.ts`: the three schemas, `lifetime` in `EntryCacheSchema`, the three components.
- `tests/helpers.ts`: `NO_CACHE` gets the empty record.
- `tests/resolve.test.ts`: the measured entry of the fixture has a measured item and the right two profiles; an
  entry nobody evaluated has the empty record; a documented-only entry has `models.dev` and the import date; an
  entry with `cache: false` has the two items of 0; a correction to a `ttl` makes the item `providers.dev` with the
  evidence date; an entry providers.dev added that documents a lifetime; an added entry that names an upstream entry
  takes no documented item from it; a run with `lacks` or without `latest` is in no item; each of the three reports,
  and none of them on the unchanged fixture; `verified`, `origin` and every existing key of `cache` are as before.
- `tests/api.test.ts`, "the contract": `same(...)` for `cache.lifetime`, its two profiles and every item; the rules
  of 2.6 on every entry of the fixture and of the real snapshot; on the real snapshot, `basis` is `documented` on
  every profile whose `documented_s` is not null and whose evaluations do not contradict it, redone from
  `evaluations[]`; the models.dev part of an exported entry is equal to the import.

**Task 3. On every summary.**

- `src/core/entries.ts`: `cache_lifetime` in `Summary` and `summarize`.
- `src/core/contract.ts`: `cache_lifetime` in `EntrySummarySchema`.
- `tests/helpers.ts`: `summaryOf`.
- `tests/api.test.ts`: `cache_lifetime` of a summary equals `providers_dev.cache.lifetime` of the entry on the
  entry, provider, model and catalog routes (beside the test for pricing and controls); every existing key of a
  summary has the value it had.

**Task 4. The contract in words.**

- `src/core/openapi.ts`: a guide section "Cache lifetimes": the merged list and what an item is; the rule of the
  safe value (documented unless contradicted, else measured, else null) and the test for "contradicted"; what 0
  means with each basis, and null; `documented_s`, `measured_s` and the four cases; the minimum across clients; how
  an item's `results` relate to its `lifetime_s`; that it is what the documentation says and what evaluations found
  on their dates, not a guarantee. `version` 1.3.0.
- `README.md`, "One contract": one paragraph, and `entry.cache_lifetime.short.safe_s` in the TypeScript example.
- `AGENTS.md`, under Rules: the cache record is worked out once in `cacheLifetime`; a lifetime is published in the
  list and nowhere else of providers.dev's own; a page prints the profiles and the items as they are, converts no
  lifetime, takes no minimum, applies no rule and picks no source; 0 is documented or measured and null is unknown.
  The rule "A measurement never replaces a documented value on an upstream entry" holds: the documented item stays,
  and so does `capabilities.cache`. The rule "Do not generate narrative lifetime verdicts" stays: this is a
  published number with a published rule, not a sentence a page makes.
- `tests/api.test.ts`: the OpenAPI document has the three components and the guide section.

**Task 5. The pages print the merged record.** The look is the designer's (the two cache columns of the catalog and
the two blocks of the entry page become one presentation, section 9); the build is this task.

- `src/core/render.ts`, `format.ts`, and whatever of `src/client/` and the stylesheets the design needs: every cache
  value on a page comes from `cache_lifetime` (lists) or `providers_dev.cache.lifetime` (entry page), with
  `documented`, `retention` and `evaluations` for what they still say. After this task no renderer reads
  `cache_ttl_s`, `cache_ttl_by_mode_s`, `cache_results`, `cache.results` or `documented.modes.<mode>.ttl`.
- A cell of results by age: the percentage rounded to a whole number; the exact percentage, hits and checks in the
  hover text.
- `src/pages/reference-content/docs/methodology.astro`: once, how the safe value is made (sections 3 and 4 in the
  site's words), and the paragraph "A measured value never replaces a documented one" brought in line with it.
- `tests/render.test.ts`, `tests/pages.test.ts`: the new presentation; a test that the renderers do not read the
  five old fields (a summary and an entry with those keys removed render the same).

**Task 6. Delete what was folded in.**

- `src/core/cache.ts`: `ttl` out of the published `CacheModeDocumentation`; `results` out of `EntryCache`;
  `cache_ttl_s` and `cache_ttl_by_mode_s` out of `CacheFacts`; `CacheSummaryRow` and `summarizeCache` go. The `ttl`
  texts are still read inside the build (`profileOf`, the `select` rules of `resolve.ts` step 4b, `documentedItems`):
  that reading moves to the entry's `capabilities.cache`, or to a build-only type.
- `src/core/cache-contract.ts`, `contract.ts`: the same keys and `CacheSummaryRowSchema` out of the schemas and
  `COMPONENTS`; `cache_results` out of `EntrySummarySchema`.
- `src/core/entries.ts`, `resolve.ts`, `resources.ts`, `scripts/lib/publish.ts`: what made or passed them.
- `src/core/openapi.ts`: the guide section "Cache evaluations" rewritten for the items' `results`; `version` 2.0.0.
- `README.md`: "Cache evaluations are published as … `cache_results`" rewritten for the merged record.
- `AGENTS.md`: the rule "Cache summaries use the API's exact ages, hit percentages and counts, with separate
  short/long settings on every page" becomes: results by age use the API's exact ages and counts, short and long
  apart, per client; a cell shows the hit percentage rounded to a whole number, and the exact percentage is in the
  API and in the hover text.
- Tests: `tests/helpers.ts`, `render.test.ts`, `api.test.ts` (`cache_ttl_s` in "tells unsupported caching from
  unknown caching"), `resolve.test.ts`; a test that for every entry of the real snapshot each `ttl` text of
  `capabilities.cache` that is a duration is the `documented_as` of exactly one item of that `mode`, and each
  result of each counted evaluation is in the `results` of exactly one item.

**Not in these tasks.** The `known` lifetimes; a filter or sort on the value.

## 12. What was decided

All on 2026-11-15. "The owner" decided; "the chief" is the project's chief, who put the question to the owner.

| # | Decision | By |
|---|---|---|
| 1 | A safe value is published for everything: the record is on every entry. | The owner |
| 2 | Measured: the oldest age up to which every check hit, the lowest across clients. Since decision 11 this is `measured_s` and the items' `lifetime_s`; it is the safe value where nothing is documented or the documentation is contradicted. | The owner |
| 3 | The same number per client is published beside it. | The owner |
| 4 | Replaced by decision 11. It was: the documented lifetime only where nothing was measured. | The owner |
| 5 | Where nothing is known: null. A safe value is never invented. | The owner |
| 6 | Per entry and per retention profile, short and long. | The owner |
| 7 | The value is worked out once in the data build and published; a page prints it and computes nothing. | The owner |
| 8 | Subscription and API access stay separate entries; the value is per entry. | The owner |
| 9 | Documented and measured values are shown together, in the same manner, each naming its source and date. | The owner |
| 10 | The API itself publishes one merged cache record per entry: one list, and the safe value with it. | The owner, against the chief's recommendation of three separate records |
| 11 | Where the provider documents a lifetime, that is the safe value, unless a measurement clearly contradicts it; then the measured one. Where nothing is documented, the measured one. The safe value is never above the documented lifetime. | The chief, on the owner's answer. The owner first said "strict", then "maybe should be B"; B was the chief's recommendation and is taken as decided. |
| 12 | "Clearly contradicts": at a tested age inside the documented lifetime, fewer than half the checks hit. | The chief, as put to the owner. The exact test of 4.1 (per evaluation, the control and single checks included, exactly half not contradicting, the documented age itself inside) is this design's and **open until the owner has seen 4.3**. |
| 13 | An entry documented as not caching has a safe value of 0, with basis `documented`. | The owner ("does not cache should not show like not measured; maybe 0"), as recommended |
| 14 | The results added up over all clients are gone; results by age are per client. | The owner |
| 15 | The old fields are deleted and the website changed, in this work: tasks 5 and 6. | The owner ("delete them and make it nice and change the website") |
| 16 | groundtruth's `known` lifetimes stay out of the record for now. | As recommended; shown to the owner, no objection |
| 17 | `retention_s` on the options of the `cache.retention` control is left where it is and is no item. | As recommended; shown to the owner, no objection |
| 18 | No floor on the number of checks per age. | As recommended; shown to the owner, no objection |
| 19 | A measured value does not expire; its date is published. | As recommended; shown to the owner, no objection |
| 20 | A filter and a sort on the value in `/api/v1/entries`: **open**, to be decided with the page design. | Deferred |
| 21 | A cell of results by age shows a rounded hit percentage; the API and the hover text are exact. | Decided separately, outside this design |
| 22 | The Muse Code subscription runs land on a subscription provider, `meta-subscription`, not on Meta's API entries. | The owner; done in `e6cd269` (groundtruth `60423f2`) |

Open: 12 (the exact test, pending the owner's look at the borderline cases) and 20.

## 13. What the data or the contract makes awkward

**The safe-value rule (decisions 11 and 12)**

1. **It changes nothing where nothing is documented.** `openrouter/deepseek/deepseek-v4.1-flash` was one of the
   cases put to the owner: 12 of 13 at 5 minutes, and a value of 150. It documents no lifetime, so its safe value is
   still the strict measured one, 150. 34 of the 35 short profiles with a measured safe value are of this kind, and
   13 of the 14 zeros. The rule touches only the thirteen profiles of 4.3.
2. **"Safe" now means two things.** With basis `measured`: every check hit up to that age. With basis `documented`:
   the provider says so and no evaluation clearly contradicts it. On four profiles the published safe value is above
   what the strictest client showed: `anthropic/claude-opus-5-5` long (3,600 against 600),
   `openrouter/anthropic/claude-haiku-5.5` and `…/claude-opus-5.5` long (3,600 against 1,800),
   `openrouter/google/gemini-4-argon` short (300 against 150). A consumer that wants the strict number reads
   `measured_s`.
3. **Not contradicted is not confirmed.** On the three Anthropic long profiles the oldest check inside the hour is
   at 30 minutes; the next is at 65 and cold. Nothing measured says the cache holds to 60. `hits_inside` of
   `checks_inside` shows how much agrees, not how far.
4. **The threshold is coarse on small samples.** With 3 checks an age contradicts at 1 of 3 and not at 2 of 3; with
   2 checks only at 0 of 2. One sample decides `openrouter/google/gemini-4-argon` (1 of 2 at the documented age:
   documented 300; 0 of 2 would have been measured 150).
5. **A single missed control contradicts.** By the rule, 0 of 1 at age 0 on a documented entry gives 0 measured, on
   one sample. No such evaluation exists today. The other reading, "one check cannot contradict", would leave a
   route that shows no cache at all in the plain probe (which stops after a missed control) unable ever to
   contradict its documentation.
6. **The documentation trusted is models.dev's, also for a reseller.** The 1 hour of
   `openrouter/anthropic/claude-*` is what models.dev lists for OpenRouter. Where it is wrong, the cure is a
   correction in `data/authored/overrides/`, which makes the item `providers.dev`; the rule then follows it.
7. **A measurement can never raise the value.** A cache that outlives its documented lifetime, or an entry
   documented as not caching that is seen to cache, keeps the documented value. Again the cure is a correction.

**"Does not cache" (decision 13)**

8. The 135 entries get two items that are not lifetimes of a way of caching: `mode` and `documented_as` are null on
   them. They are told from a duration of 0 by those two nulls and from a measured 0 by `basis`. None is measured
   today.

**The Meta move (decision 22)**

9. The three `meta/*` API entries now have no evaluation: null for both profiles, though Meta's page documents the
   `prompt_cache_retention` field for them. The measured lifetimes are on `meta-subscription/*`, where no retention
   parameter is declared (`retention.support` is `unknown`: no declaration is copied to another access method), yet
   the long items there carry `parameter: prompt_cache_retention`, `value: 24h`, as sent. That is the existing rule
   ("a requested setting or a cache hit alone does not confirm parameter support") and reads oddly on a page.
10. No example lost a documented value by the move: `meta/*` documents no lifetime, so nothing was shown beside the
    measured values before either. What changed is the entry ids, the access (`subscription`), and that `meta/*`
    moved from measured to "nothing known".

**The contract (decision 10)**

11. **One list, one shape.** The contract wants the same keys on every object of a kind, and null for "not known".
    On an item the keys of the other kind are null, 0 or `[]`, meaning "does not apply". The contract has that
    reading already (`Provenance.value`: "null unless op is set"), but an item is the first object where half the
    keys are of that sort. `basis` says which half to read.
12. **A documented view remains that this project cannot fold in.** `capabilities.cache` keeps models.dev's `ttl`
    lists in every entry and in `/api.json`; folding it in would break the promise that the imported part keeps
    models.dev's shape. A reader of the export sees the lifetimes twice: as models.dev wrote them, and in the list.
13. **`retention` and `request_controls` say the same thing twice already.** `retention` is the older, flat form of
    the `cache.retention` control. Both stay: neither is a lifetime, and merging them is not part of these
    decisions.
14. **"A measurement never replaces a documented value"** (`AGENTS.md`, the methodology) holds for the data: the
    documented item and `capabilities.cache` stay. But on one profile today a measured value is the safe value
    where a documented one exists (`openrouter/google/gemini-3.8-flash`), so the methodology's sentence needs the
    wording of task 5.

**The data, as before**

15. **The strict measured value on routes that miss now and then.** "Every check hit" is all or nothing, and more
    checks can only lower it. It now decides `safe_s` only where nothing is documented (item 1).
16. **A measured value is always an age that was tested.** `first_miss_s` shows the gap to the next age.
17. **A client that cannot cache by design counts.** Muse Code "caches its own system prompt but never the
    conversation", and that makes `meta-subscription/muse-wonder-1.0` 0 while a coding agent held 2 hours. It is
    the owner's example; the items are what a consumer of another client reads.
18. **The profiles of one entry are not comparable.** `meta-subscription/muse-spark-1.3` has short 450 (plain
    requests, 4 November) and long 300 (a coding agent, 10 November, checked at 5 minutes and then at 1 hour). Long
    below short is two ladders and two clients, not a shorter cache.
19. **Decision 1 is mostly null.** 9,668 of 10,524 entries get null for short and 9,942 for long. 2,344 of the
    9,668 document caching without a lifetime.
