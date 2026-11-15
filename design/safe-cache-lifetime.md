# One cache record per entry: every lifetime, and the safe value

Design, 2026-11-15. Not built yet. This file says what is to be built; `AGENTS.md` and `README.md` stay the rules of
the data and the contract, and section 11 lists what changes in them.

It follows the owner's ten decisions of 2026-11-15. The tenth: the API itself publishes one merged cache record per
entry, documented and measured lifetimes together in one list, and the safe value with them. A page prints that
record as it is.

Numbers and examples are from the dataset built on 2026-11-15: `dataset_version` `75e382a282ae7f0e`, models.dev
import of 2026-11-15 (commit `c18a3cf`), `observed.json` sha256 `574f0f56…`, 10,521 entries, 78 published cache
evaluations on 46 entries.

## 1. What is published

Every entry gets one record, `providers_dev.cache.lifetime`, and every summary the same object as `cache_lifetime`:

- `short` and `long` (the retention profiles): the safe value of each. `safe_s` is how many seconds a cached prompt
  can be relied on; `basis` says whether it is `measured` (providers.dev evaluations), `documented` (where nothing
  was measured) or `none` (nothing is known; `safe_s` is `null`).
- `lifetimes`: one list of every lifetime known for the entry. Each item is a lifetime in seconds with its profile,
  its basis (`documented` or `measured`), its source (`models.dev` or `providers.dev`) and its date. A documented
  item also has the text as documented and the way of caching it is documented for. A measured item is one client,
  with its hits and checks and its results at each age.

`safe_s: 0` is a measured value: no age was found at which every check hit. `safe_s: null` is "not known". They are
never the same thing.

The record is worked out once, in the data build, from the documented caching and the published evaluations. It
replaces three views the API has today: the documented lifetimes (`documented.modes.*.ttl`, `cache_ttl_s`,
`cache_ttl_by_mode_s`) and the results added up over all clients (`results`, `cache_results`). Section 6 says what
is folded in, what stays and what goes, and where every fact published today is found afterwards.

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

/** The safe lifetime of an entry for one retention profile. */
export interface SafeLifetime {
  safe_s: number | null;
  basis: "measured" | "documented" | "none";
  source: LifetimeSource | null;
  date: string | null;
  clients: number;
  evaluations: number;
  checks: number;
  hits: number;
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

| Key | Type | Meaning |
|---|---|---|
| `safe_s` | integer ≥ 0, or null | Seconds a cached prompt can be relied on. `measured`: the lowest `lifetime_s` of the profile's measured items. `documented`: the lowest of its documented items. 0 = measured, and no age was found at which every check hit. Null = not known. |
| `basis` | `measured` \| `documented` \| `none` | Where `safe_s` comes from. `none` exactly when `safe_s` is null. |
| `source` | `providers.dev` \| `models.dev` \| null | Who the value is from. `measured` is always `providers.dev`. `documented`: the source of the item the value is taken from. Null with `none`. |
| `date` | `YYYY-MM-DD` or null | `measured`: the newest evaluation counted. `documented`: the date of the item the value is taken from. Null with `none`, and where the source has no date. |
| `clients` | integer ≥ 0 | How many clients were measured. 0 = not measured. |
| `evaluations` | integer ≥ 0 | How many evaluations were counted. 0 = not measured. |
| `checks` | integer ≥ 0 | Re-sends made in them, the control included. |
| `hits` | integer ≥ 0 | How many of those were served from the cache. |
| `tested_from_s` | integer ≥ 0, or null | The youngest age, after the control, that any counted evaluation checked. No age below it was checked. Null = not measured, or no timed check was made. |
| `first_miss_s` | integer ≥ 0, or null | The youngest age at which any check of a counted evaluation missed. 0 = the immediate re-send missed. Null = not measured, or no check missed: then `safe_s` is the oldest age tested and the cache may live longer. |

### 2.3 `CacheLifetimeItem` (`lifetime.lifetimes[]`), key by key

One shape for both kinds, so that a page prints the list in one loop. A key that does not apply to a kind is null,
0 or `[]`, as the table says.

| Key | On a documented item | On a measured item |
|---|---|---|
| `retention_profile` | `short` for the shortest lifetime the entry documents, `long` for every other (5.1) | The profile of its evaluations |
| `basis` | `documented` | `measured` |
| `source` | `models.dev`, or `providers.dev` where the lifetime is a providers.dev correction or the entry is one providers.dev added (5.3) | `providers.dev` |
| `date` | The import date for `models.dev`; the newest evidence date for `providers.dev`; null where there is none | The newest of its evaluations |
| `lifetime_s` | The documented lifetime in seconds | The oldest tested age through which every check of this client hit. 0 = none. |
| `mode` | `implicit` or `explicit`: the way of caching the lifetime is documented for | null |
| `documented_as` | The lifetime as the source writes it, for example `5m` | null |
| `client`, `client_label` | null | The public client id and label, as on `evaluations[]` |
| `parameter`, `value` | null | The request field that asked for the lifetime and the value sent, as on `evaluations[]`; both null = no lifetime was asked for |
| `evaluations` | 0 | How many evaluations the item is made from (≥ 1) |
| `evaluation_ids` | `[]` | Their ids, sorted, as in `evaluations[].id` |
| `checks`, `hits` | 0, 0 | Re-sends made in them and how many were served from the cache, the control included |
| `tested_from_s` | null | The youngest timed age any of them checked; null = none made a timed check |
| `first_miss_s` | null | The youngest age at which any of them missed; null = no miss |
| `results` | null | Their results added up by exact age, the control first: `CacheResult[]`, the type the API has today |

What one item is:

- **Documented:** one lifetime of one way of caching. There is one item for each text in
  `capabilities.cache.<mode>.ttl` that is a duration (5.2), so an entry that documents `5m` and `1h` for explicit
  caching has two, and one that documents the same lifetime for both ways has one for each.
- **Measured:** one client with one retention setting: the counted evaluations of the entry with the same
  `retention_profile`, `parameter`, `value` and `client`.

### 2.4 Order

1. By profile: `short`, then `long`.
2. In a profile: the documented items, then the measured ones.
3. Documented: by `lifetime_s` ascending, then `implicit` before `explicit`.
4. Measured: the setting that asked for no lifetime first, then by the seconds of `value`, then by `value` as text
   (the order of today's summary lines); then by `client`, ascending.

### 2.5 The record in full

`openai/gpt-6.1-sol` (example 3 of section 10): two lifetimes documented, one client measured.

```json
"lifetime": {
  "short": { "safe_s": 1800, "basis": "measured", "source": "providers.dev", "date": "2026-11-11",
             "clients": 1, "evaluations": 1, "checks": 16, "hits": 10, "tested_from_s": 300, "first_miss_s": 2400 },
  "long":  { "safe_s": 43200, "basis": "documented", "source": "models.dev", "date": "2026-11-15",
             "clients": 0, "evaluations": 0, "checks": 0, "hits": 0, "tested_from_s": null, "first_miss_s": null },
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

The record of an entry nothing is known about (9,800 entries):

```json
"lifetime": {
  "short": { "safe_s": null, "basis": "none", "source": null, "date": null,
             "clients": 0, "evaluations": 0, "checks": 0, "hits": 0, "tested_from_s": null, "first_miss_s": null },
  "long":  { "safe_s": null, "basis": "none", "source": null, "date": null,
             "clients": 0, "evaluations": 0, "checks": 0, "hits": 0, "tested_from_s": null, "first_miss_s": null },
  "lifetimes": []
}
```

Today the list would hold 1,133 documented items and 75 measured ones.

### 2.6 What always holds

A test checks these on every entry (task 2). "Of P" means the items with `retention_profile` P.

1. `basis` of P is `none` ⇔ `safe_s` is null ⇔ `source` is null ⇔ there is no item of P.
2. `basis` of P is `measured` ⇔ there is a measured item of P. Then `safe_s` is the lowest `lifetime_s` of the
   measured items of P; `evaluations`, `checks` and `hits` are the sums of theirs; `clients` is the number of
   different `client` among them; `date` is the newest of theirs; `tested_from_s` and `first_miss_s` are the lowest
   of theirs that are not null.
3. `basis` of P is `documented` ⇔ P has items and all are documented. Then `safe_s` is the lowest `lifetime_s` of
   them, `source` and `date` are those of the first item with that `lifetime_s`, and the counts are 0, 0, 0, 0,
   null, null.
4. Where `first_miss_s` is not null it is above `safe_s` (or `lifetime_s`), or both are 0.
5. On a measured item: `results` is the results of the evaluations named in `evaluation_ids`, added up by age;
   `checks` and `hits` are the sums over `results`; the walk of 3.2 over `results` gives `lifetime_s` or more, and
   exactly `lifetime_s` where `evaluations` is 1.
6. Every evaluation of the entry that counts (3.1) is named in exactly one item.

## 3. The derivation of a measured value

The input is the entry's published evaluations, `providers_dev.cache.evaluations`, nothing else. So a reader can
redo every value from the API answer alone.

### 3.1 Which evaluations count

`resolve.ts` already decides which runs become evaluations: a run with `latest` and without `lacks`, placed on an
entry by its `models_dev` field or by `data/authored/routes.yaml`. That stays. Of an entry's evaluations, one counts
when it has at least one timed result, or its control missed (`hits < checks`). It counts for the profile that is
its `retention_profile` (as published: the declared profile of the setting, else `profileOf`).

An evaluation with no result, or with only a control that hit, says that a prompt is cached and nothing about how
long. It does not count and is in no item; it stays in `evaluations`. If no evaluation of the entry counts for a
profile, the profile is not measured and section 5 applies.

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

- A hit is a full hit: 2 of 3 is a miss. The owner's rule is "every check hit".
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
- The profile's value is the lowest `lifetime_s` of its measured items (decision 2). That is the same as the lowest
  value over all counted evaluations of the profile, and the profile's other numbers are made as above over all of
  them.

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

### 3.5 The cases the brief names

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
5 minutes was checked. The value is claimed from `tested_from_s` through `safe_s`; below `tested_from_s` it rests on
the control and on a cache entry not appearing later than it was written. That is not always so:
`devin/deepseek-v4-pro` missed 3 of 3 at 2.5 minutes and hit 3 of 3 at 5. A run that first checked at 5 minutes and
missed there has `safe = 0`, `first_miss = 300`, `tested_from = 300`: nothing was shown to be safe, and the two ages
say where the knowledge ends. Since 14 November 2026 groundtruth refuses a run that does not start with a control
and 2.5 minutes, so new evaluations all have `tested_from = 150`; of the 78 published today, 40 start at 5 minutes,
28 at 2.5, 4 at 10, 2 at 2, 1 at 1 minute, 1 at 4 hours and 2 made no timed check.

**Ages tested by one run and not another.** No age is carried from one evaluation to another. Each evaluation is
walked on its own ages; the minimum is taken over the values. An evaluation that tested few ages and never missed
caps the value at its oldest age: it showed nothing beyond it.

**An age with very few checks.** Every result counts, whatever its number of checks: one check that hit carries the
value to its age, one that missed ends it. There is no floor. A miss is never discounted for being a small sample,
which is the safe direction; a hit on a small sample is weak, and `checks`, `hits`, `clients` and `date` are
published for the consumer to judge. A floor would discard data without making any remaining value safer: 26 of the
78 evaluations have an age with only 2 checks (22 of them on Devin), and 9 of the 50 measured entry-profiles rest on
such evaluations alone. Whether to set a floor is open question 5.

**Several long settings on one entry.** `long` is one profile, also where an entry has evaluations with two longer
lifetimes (`1h` and `24h`, say). Each setting has its own measured items, with `parameter` and `value`, and the
lowest `lifetime_s` of them all is the profile's value. No entry has two today.

### 3.6 `all_warm_through_s` is not reused

The value is derived from the published checks. groundtruth's `all_warm_through_s` is not read.

1. Decision 7 and the rule in `AGENTS.md`: what a page shows comes from the API. A value made from
   `evaluations[].results` can be redone by anyone holding the API answer; one copied from a field the API does not
   publish cannot.
2. `all_warm_through_s` is `null` both for "the youngest age had a miss" and for "no timed check was made". The API
   has to tell "no safe lifetime" from "not known" (section 4), and only the checks do.
3. It ignores the control. A run whose immediate re-send missed and whose first age then hit would get a value
   there; here it gets 0.
4. It is optional in the file's schema, and the site already carries the checks.

The two are compared in the build instead (task 2): for a published run that has `all_warm_through_s` and whose
control did not miss, the derived `safe` must equal it, with `null` read as 0. A difference is reported as an issue
(`lifetime-differs`, a warning, with the run id); the derived value is published all the same. Today all 78 agree.

## 4. "No safe lifetime" against "not known"

| What is known | `safe_s` | `basis` | `first_miss_s` | `tested_from_s` |
|---|---|---|---|---|
| A client's immediate re-send missed: no cache was seen | 0 | `measured` | 0 | the youngest timed age, or null |
| A client missed at its youngest tested age | 0 | `measured` | that age | that age |
| Every client hit through some age | that age, above 0 | `measured` | the first miss, or null | the youngest timed age |
| Nothing measured, a lifetime is documented | the lifetime | `documented` | null | null |
| Nothing measured, nothing documented | null | `none` | null | null |

- 0 is always measured. It is published as the number 0, not as null, so a consumer that reads only `safe_s` does
  the right thing: it does not wait on a cache.
- Null is always "not known". An entry nobody measured never gets 0.
- "Never hit" and "missed at its youngest age" are both 0; `first_miss_s` tells them apart (0 against the age), and
  the item's `results` has the counts.
- The same holds on each measured item, so a client that never hit is told from a client nobody tested: the first
  has an item with `lifetime_s: 0`, the second has no item.

## 5. The documented items and the fallback

### 5.1 The source fields and the profiles

The documented caching of an entry: models.dev's `capabilities.cache` after providers.dev's corrections, as
`documentedCache` in `src/core/cache.ts` reads it. For each way of caching that is supported, each text of its `ttl`
list that is a duration (5.2) is one documented item, with `mode`, `documented_as` and `lifetime_s`.

The profile of a documented item:

- `short`: its `lifetime_s` is the shortest lifetime the entry documents, over both ways of caching.
- `long`: every other.

This is the rule that already puts an evaluation in a profile (`profileOf`: no lifetime asked, or the shortest
documented one, is short; any other is long), so a documented lifetime and an evaluation of the same setting land in
the same profile.

The fallback (decision 4): where a profile has no measured item, its `safe_s` is the lowest `lifetime_s` of its
documented items. For `short` that is the shortest lifetime documented; for `long`, the shortest of the longer ones.
Where a profile is measured, its documented items stay in the list beside the measured ones and `safe_s` is the
measured value.

Today (the documented lifetimes of an entry, in seconds, over all entries): 300 and 3,600 on 431 entries, 300 alone
on 142, 1,800 alone on 67, 86,400 alone on 31, 1,800 and 43,200 on 13, 7,200 alone on 3, none on 9,834. An entry
with one documented lifetime has it as `short` and nothing documented for `long`. One entry (`openai/gpt-6-cyber`)
documents the same two lifetimes for both ways of caching and has four documented items.

### 5.2 Text to seconds

Only `durationSeconds` (`src/core/cache.ts`): a whole number and one unit of `ms`, `s`, `m`, `h`, `d` (`"5m"` → 300,
`"1h"` → 3600). Every lifetime in today's catalog has that form (`5m`, `30m`, `1h`, `2h`, `12h`, `24h`).

Anything else (a range such as `5m-10m`, words) is not converted and is no item: a number is not made up from it.
Today such a string is dropped silently by `cacheFacts`; from task 2 the build reports it (`unparsed-lifetime`, a
notice, target `provider/model#capabilities.cache.<mode>.ttl`), so that the format is seen the day models.dev uses
it. The text itself stays readable in `capabilities.cache`, which is published as imported. If ranges appear, the
rule to add is "the lower bound", as a change to this design.

### 5.3 The source and date of a documented item

For an item of mode `<mode>`, with `P` = `capabilities.cache.<mode>.ttl`:

1. If the entry's `providers_dev.provenance` has a correction whose `path` is `P`, starts with `P.`, or is one of
   `capabilities`, `capabilities.cache`, `capabilities.cache.<mode>`: `source` is `providers.dev` and `date` is the
   newest evidence date of those corrections.
2. Else, if the entry's `origin` is `added`: `source` is `providers.dev` and `date` is the newest date of the
   entry's evidence that is not of kind `listed`, or null.
3. Else: `source` is `models.dev` and `date` is the import date (`upstreamDate` of `resolve`), or null where the
   build has none.

This is how `resolve.ts` already names the source of the cache capabilities (`cacheEvidence`, `sourcesOf`). Today
every documented item is case 3: no correction touches a `ttl`, and no added entry documents one.

### 5.4 Caching documented, no lifetime documented

2,543 entries document implicit caching as supported; 2,482 of them give no implicit lifetime, and 2,276 no lifetime
at all. With no evaluation their record is `safe_s: null`, `basis: "none"` (decision 5): that a provider caches says
nothing about how long. In all, 2,341 entries document caching and get null for `short`. A consumer tells them from
entries nothing is known about with the fields that say so today and stay: `cache`, `cache_mode_support` and
`providers_dev.cache.documented`.

135 entries document that they do not cache (`cache: "no"`). By decisions 4 and 5 as written they also get null:
there is no documented lifetime. Whether "does not cache" should be an item of 0 seconds is open question 2.

## 6. What becomes of today's fields

"Merged, not distinct": a lifetime is published in one place, the list. A field stays only where it says something
the list does not.

### 6.1 In `providers_dev.cache`

| Today | After | Why |
|---|---|---|
| `documented.support`, `documented.modes.<mode>.support` | **Stay** | Whether and how the entry caches (supported, unsupported, unknown). Not a lifetime. The filters `cache` and `cache_mode` and the rule "cache mode support comes from `providers_dev.cache.documented`" rest on it. |
| `documented.modes.<mode>.min_tokens`, `max_breakpoints`, `targets` | **Stay** | Documented facts about a way of caching that are not lifetimes. |
| `documented.modes.<mode>.ttl` | **Folded, then goes** | Each text is the `documented_as` of a documented item, with its `mode`, seconds, profile, source and date. |
| `retention` | **Stays** | What a request can send: the field, the accepted values, the default, which value gives which profile, the conditions, the evidence. The list says how long a cache lasts, not how to ask for it. |
| `results` | **Folded, then goes** | Its lines per retention setting become the measured items: `retention_profile`, `parameter`, `value`, `evaluations`, `evaluation_ids`, the newest date and the results by age, now per client. The sums over all clients are not made any more (open question 3). |
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
| `cache_ttl_s` | **Folded, then goes** | The `lifetime_s` of the documented items. |
| `cache_ttl_by_mode_s` | **Folded, then goes** | The same, by their `mode`. |
| `cache_results` | **Folded, then goes** | As `results` above. |
| `cache_lifetime` | **New** | The merged record, the same object as on the entry. |

### 6.3 What is left alone, and why it is not a second view

- `capabilities.cache` in the imported part of the entry still has models.dev's `ttl` lists. It is models.dev's
  record in models.dev's shape, which `AGENTS.md` and the README promise to keep, and what makes `/api.json` a
  superset of their export. providers.dev does not restate lifetimes anywhere else of its own.
- `request_controls`: an option of the `cache.retention` control can carry `attributes.retention_s`, the lifetime
  that sending the option's value asks for. It is the label of a request value, in the record that says how to ask,
  not a statement about the entry's cache, and it has no item. On the 636 options that carry it today it equals the
  documented lifetime of the option's profile in every case, and the build keeps it so (task 2): a difference is
  reported (`retention-lifetime-differs`, a notice) and a person corrects one of the two with an override. An option
  without `retention_s` states no lifetime: Meta's `"24h"` "asks for up to 24 hours. It is not a lifetime the cache
  is sure to have", so no 86,400 comes from its name. Whether these should be items too is open question 4.
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

1. The sums over all clients of a setting are no longer published (open question 3).
2. `documented.modes.<mode>.ttl` tells "no list" (`null`) from "an empty list" (`[]`); both are "no documented
   item" afterwards. The imported `capabilities.cache` still shows which it was. No entry has an empty list today.
3. An evaluation that does not count (no result, or only a control that hit) is in a summary line today and in no
   item afterwards. It stays in `evaluations`. No published evaluation is of that kind today.

### 6.5 The order of the change

The old fields are read by the pages (`src/core/render.ts`, `format.ts`). So they go in a task of their own, after
the pages print the merged record (section 11, tasks 5 and 6). Between task 2 and task 6 the API carries the merged
record and the old fields side by side, with the old ones unchanged in value. That is a state for the time before
the API is public, not one to publish: task 6 comes before the launch.

## 7. The `known` lifetimes of groundtruth

`observed.json` has three: CLIProxyAPI on a Claude login asks Anthropic for the 1-hour cache (3,600 s, every model
of the route); CLIProxyAPI with a Claude API key gets Anthropic's default (300 s); the same with the
`claude-code-cli` fingerprint profile set gets 3,600 s. `resolve.ts` does not read them.

This design leaves them out of the record and out of the tasks of section 11. They need the owner's decision (open
question 1). The reasoning:

1. They are not measurements and not the provider's documentation of the entry. The decisions name two bases for an
   item and this is a third: what follows from how one client builds its requests.
2. They belong to a client, one of them to a setting of that client (`when`). The entry's value is the lowest across
   clients *tested*; a lifetime nobody tested cannot enter that minimum without changing what "safe" means.
3. They carry no retention profile. "CLIProxyAPI asks for the 1-hour cache" is what a request gets without asking
   (short) and a longer lifetime (long) at once. Putting it in one would be the site's invention; the profile has to
   come from groundtruth.
4. Two of the three repeat what the documented items already give every `anthropic/*` entry (300 short, 3,600
   long). The third is the only new information: the three `claude-subscription/*` entries, which have no evaluation
   and no documented lifetime and so get null.

The merged list is the place for them if the owner wants them: an item with `basis: "known"`, the client, `ttl_s` as
`lifetime_s` and groundtruth's `source`, never entering `safe_s`. That adds a third value to an item's `basis` and
needs a `profile` on each `known` item in groundtruth.

## 8. Where it is computed and how it reaches every answer

```
data/sources/observed.json ─┐
data/upstream/, authored/  ─┴─▶ resolve() step 6, per entry
                                  documented  = documentedCache(model)             (as today)
                                  evaluations = the entry's CacheEvaluation[]      (as today)
                                  lifetime    = cacheLifetime(documented, evaluations, sourceOf)   ◀── new
                                  providers_dev.cache = { documented, retention, lifetime, … , evaluations }
                                        │
        buildIndex() / summarize() ─────┤  summary.cache_lifetime = providers_dev.cache.lifetime   ◀── new
                                        ▼
        data/published/  (catalog.json, api.json, entries/, index.json)  ──▶  every API answer, every page
```

Three pure functions in `src/core/cache.ts`, beside `summarizeCache`. No file, no network, no clock; the file still
runs in the browser.

- `evaluationLifetime(evaluation: CacheEvaluation): { safe_s: number; first_miss_s: number | null; tested_from_s: number | null } | null`
  is section 3.2; null = the evaluation does not count (3.1).
- `documentedItems(documented: CacheDocumentation, sourceOf: (mode: CacheMode) => { source: LifetimeSource; date: string | null }): CacheLifetimeItem[]`
  is section 5. `sourceOf` is 5.3; `resolve` passes it, because only `resolve` knows the corrections and the import
  date.
- `cacheLifetime(documented, evaluations: readonly CacheEvaluation[], sourceOf): CacheLifetimeRecord` makes the
  measured items (3.3), puts the list in order (2.4) and works out the two profiles (2.6).

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

Size: `index.json` is 26 MB and the catalog 36 MB before gzip today. The empty record is about 400 bytes per entry,
some 4 MB in each; today's 1,208 items add about half a megabyte, and task 6 removes the old fields. The assets served are the
gzip files (0.7 MB and 1.4 MB today, against a limit of 25 MiB); the new records are nearly all the same and
compress to very little.

## 9. What a page prints

The merged record is the API's shape, and a page prints it as it is:

- per profile, `lifetime.<profile>`: `safe_s` with `basis`, `source` and `date`;
- the list, one item under another, each with the same fields: `retention_profile`, `lifetime_s`, `basis`,
  `source`, `date`; on a documented item `mode` and `documented_as`; on a measured item `client_label`, the setting
  (`parameter`, `value`), `hits` of `checks`, and `results` where the page shows the ages.

Every lifetime is in seconds, so `"5m"` is converted once, in the build. Documented and measured lifetimes are items
of one list, so a page has one loop and no second block. Which value is in force is `basis` and `safe_s`, so a page
compares nothing and takes no minimum. Each item names `models.dev` or `providers.dev` and has its own date, as
`AGENTS.md` and the licence notes require. A profile with no item prints "Unknown".

How the items are laid out (the two profiles as columns, the clients as rows, the ages as today's cells) is the
designer's.

## 10. Worked examples

Each from the published evaluations of 2026-11-15; `c` is the control, then `age: hits/checks`. To see an
evaluation: `/api/v1/entries/<ref>`, `data.entry.providers_dev.cache.evaluations`.

**1. `openai-codex/gpt-6.1-sol`, short: three clients → 300.**

| Evaluation | Client | Results | `lifetime_s` | `first_miss_s` | `tested_from_s` | `hits` of `checks` |
|---|---|---|---|---|---|---|
| `cpa-codex-long-2026-11-06/X1` | `cliproxyapi` | c 1/1 · 300: 3/3 · 900: 2/3 · … | 300 | 900 | 300 | 23 of 34 |
| `harness-2026-11-07/H1` | `codex-cli` | c 1/1 · 300: 3/3 · 900: 2/3 · … | 300 | 900 | 300 | 19 of 31 |
| `harness-2026-11-07/H2` | `agent+cliproxyapi` | c 1/1 · 300: 3/3 · 900: 3/3 · 1800: 3/3 · 3600: 2/3 · … | 1,800 | 3,600 | 300 | 21 of 31 |

Three measured items. `short.safe_s` = min(300, 300, 1,800) = **300**, measured, 3 clients, 3 evaluations, 63 hits
of 96 checks, `first_miss_s` 900, `tested_from_s` 300, date 2026-11-07. Long: no item → null. The chief's reading
(300, 300, 1,800 → 300) is the same.

**2. `meta/muse-wonder-1.0`, short: one client never hit → 0. Long: one age tested.**

| Evaluation | Client | Results | `lifetime_s` | `first_miss_s` | `tested_from_s` | `hits` of `checks` |
|---|---|---|---|---|---|---|
| `cpa-latest-2026-11-06/L4` | `cliproxyapi` | c 1/1 · 150: 3/3 · 300: 3/3 · 600: 3/3 · 900: 2/3 · … | 600 | 900 | 150 | 15 of 22 |
| `harness-2026-11-07/H5` | `muse-code` | c 0/1 · 150 to 7200: 0/3 each | 0 | 0 | 150 | 0 of 22 |
| `harness-2026-11-07/H6` | `agent+cliproxyapi` | c 1/1 · 150, 300, 600, 900, 1800, 3600, 7200: 3/3 each | 7,200 | null | 150 | 22 of 22 |

Short: `safe_s` = min(600, 0, 7,200) = **0**, measured, 3 clients, 37 hits of 66 checks, `first_miss_s` 0, date
2026-11-07. The three items carry 600, 0 and 7,200. The chief's reading is the same.

Long: one measured item, `parameter` `prompt_cache_retention`, `value` `24h`, from `meta-24h-2026-11-10/M2`,
`agent+cliproxyapi`: c 1/1 · 14400: 3/3 · 43200: 0/3 · 86400: 0/3 → **14,400**, `first_miss_s` 43,200,
`tested_from_s` 14,400, 4 hits of 10 checks. No age under 4 hours was checked, and `tested_from_s` says so. No
documented item: the entry documents no lifetime.

**3. `openai/gpt-6.1-sol`: a single client, documented items beside it.** The record of 2.5.

Short: `gpt6-2026-11-11/G5`, `cliproxyapi`: c 1/1 · 300: 3/3 · 900: 3/3 · 1800: 3/3 · 2400: 0/3 · 3600: 0/3 →
**1,800**, measured, 1 client, 10 hits of 16 checks, `first_miss_s` 2,400, date 2026-11-11. The documented item
(`30m`, 1,800, explicit, `models.dev`, 2026-11-15) is in the list before it. Long: not measured; one documented item
(`12h`, 43,200) → **43,200**, documented, `models.dev`, 2026-11-15.

**4. `meta/muse-ember-1.0`: the long profile, from a run that continues another.**

Long: `meta-24h-2026-11-10/M1`, `agent+cliproxyapi`. It continues `ember-2026-11-10/E2`, which is not published;
its results hold both: c 1/1 · 300, 1800, 3600, 7200, 14400: 3/3 each · 28800: 0/3 · 43200: 0/3 · 86400: 0/3 →
**14,400**, `first_miss_s` 28,800, `tested_from_s` 300, 16 hits of 25 checks. Short: `ember-2026-11-10/E1`: c 1/1 ·
300: 2/2 · 1800: 1/2 · 3600: 0/2 · 7200: 1/2 → **300**, `first_miss_s` 1,800, 5 hits of 9 checks.

**5. `anthropic/claude-opus-5-5`: two runs of one client in one item; one profile documented, the other measured.**

Long (`cache_control.ttl=1h`), both `cliproxyapi`, 2026-11-04:

| Evaluation | Sent with | Results | `safe` | `first_miss` |
|---|---|---|---|---|
| `cpa-8.0.53/K1-beta` | `beta=extended-cache-ttl-2025-04-11` | c 1/1 · 600: 3/3 · 1800: 2/3 · 3900: 0/3 | 600 | 1,800 |
| `cpa-8.0.53/K1-nobeta` | no beta header | c 1/1 · 600: 3/3 · 1800: 3/3 · 3900: 0/3 | 1,800 | 3,900 |

One measured item of two evaluations: `lifetime_s` = min(600, 1,800) = **600**, `first_miss_s` 1,800,
`tested_from_s` 600, 13 hits of 20 checks; its `results` are the sums, c 2/2 · 600: 6/6 · 1800: 5/6 · 3900: 0/6,
and the walk over them also gives 600. `long.safe_s` = **600**, measured. The documented item (`1h`, 3,600,
`models.dev`) is in the list before it. Short: not measured; documented item `5m` → **300**, documented,
`models.dev`, 2026-11-15.

**6. `anthropic/claude-sonnet-5-5`: documented only.** No evaluation. `explicit.ttl` is `["5m", "1h"]`: two
documented items. Short **300**, long **3,600**, both documented, `models.dev`, 2026-11-15.

**7. Neither.** `claude-subscription/claude-opus-5-5`: no evaluation, no documented caching. `google/gemini-4-argon`:
implicit caching documented as supported, no lifetime. Both: short and long **null**, basis `none`, `lifetimes: []`.

**8. `openrouter/google/gemini-3.8-flash`: measured 0 where 300 is documented.** `openrouter-direct/R5`, `direct`,
2026-11-04: c 1/1 · 150: 0/3 · 300: 0/3 → short **0**, measured, `first_miss_s` 150, 1 hit of 7 checks. The
documented item (`5m`, 300, `models.dev`) is in the list before it. Long: null.

**9. `devin/kimi-k3`: only a control, and it missed.** `cpa-8.0.53/D6`, `cliproxyapi`: c 0/1, no timed check. It
counts, because the control missed → short **0**, measured, `first_miss_s` 0, `tested_from_s` null, 0 hits of 1
check.

**10. `devin/deepseek-v4-pro`: a miss at the youngest age, hits after it.** `cpa-8.0.53/D9`, `cliproxyapi`: c 1/1 ·
150: 0/3 · 300: 3/3 · 450: 1/3 · 600: 0/3 · 900: 0/3 → short **0**, `first_miss_s` 150, `tested_from_s` 150, 5 hits
of 16 checks.

**11. `devin/nemotron-3-5-super`: two request shapes per client.**

| Evaluation | Client | Sent with | Results | `safe` | `first_miss` |
|---|---|---|---|---|---|
| `devin-harness-2026-11-08/D11c` | `devin-cli` | `reasoning=none` | c 1/1 · 300 to 7200: 2/2 each | 7,200 | null |
| `devin-cache-investigation-2026-11-09/N1c` | `devin-cli` | `reasoning=medium` | c 0/1 · 120: 0/2 | 0 | 0 |
| `devin-harness-2026-11-08/D11p` | `agent+cliproxyapi` | `reasoning=low` | c 0/1 · 300 to 7200: 0/2 each | 0 | 0 |
| `devin-cache-investigation-2026-11-09/N1p` | `agent+cliproxyapi` | `reasoning=none` | c 1/1 · 120: 2/2 | 120 | null |

Two measured items of two evaluations each, both `lifetime_s` 0 (14 checks, `tested_from_s` 120). Short **0**, 2
clients, 4 evaluations, 28 checks, date 2026-11-09. With reasoning on, this model's prompt is not cached; a consumer
cannot be told to rely on it.

Over the whole dataset:

| Profile | Measured | of them 0 | Documented | Null |
|---|---|---|---|---|
| short | 44 | 14 | 677 | 9,800 |
| long | 6 | 0 | 441 | 10,074 |

Measured short values: 0 on 14 entries, 150 on 7, 300 on 8, 450 on 2, 1,800 on 11, 3,600 on 1, 7,200 on 1.

### Checking a build by hand

After `npm run data`:

```
jq '.openai.models."gpt-6.1-sol".providers_dev.cache.lifetime' data/published/site/api.json
jq '.entries[] | select(.ref == "meta/muse-wonder-1.0") | .cache_lifetime' data/published/site/data/index.json
jq '[.entries[] | .cache_lifetime.short.basis] | group_by(.) | map({(.[0]): length}) | add' data/published/site/data/index.json
jq '[.entries[] | .cache_lifetime.lifetimes[] | .basis] | group_by(.) | map({(.[0]): length}) | add' data/published/site/data/index.json
```

On the dataset of 2026-11-15 the third gives `{"documented": 677, "measured": 44, "none": 9800}` (with `long`:
`{"documented": 441, "measured": 6, "none": 10074}`) and the fourth `{"documented": 1133, "measured": 75}`.

## 11. The work, as tasks

Each task leaves `npm run build && npm run check` passing. Tasks 1 to 4 add the merged record and change no
existing value. Task 5 is the designer's. Task 6 removes what was folded in.

**Task 1. The derivation, as pure functions.** Nothing calls them yet.

- `src/core/cache.ts`: the types of 2.1; `evaluationLifetime`, `documentedItems`, `cacheLifetime` (section 8); a
  function that returns the record of an entry nothing is known about, for the tests and helpers.
- `tests/cache-lifetime.test.ts` (new), with results written out in the test, not read from `data/`:
  - `evaluationLifetime`: every row of the tables in section 10 (`X1`, `H2`, `H5`, `H6`, `M2`, `K1-beta`, `R5`,
    `D6`, `D9`, `N1p`); no result → null; only a control that hit → null; no control and a first age that hit; 2 of
    3 is a miss; a full hit after a miss does not raise the value; results given out of order.
  - `documentedItems`: each set of lifetimes of 5.1; the same lifetimes for both ways of caching (four items); a
    way that is supported without `ttl`; `unsupported`; a string that is not a duration is no item; the profile of
    each item; `sourceOf` is asked per mode.
  - `cacheLifetime`: examples 1, 2, 3, 5, 6, 7, 8 and 11 in full, compared with the whole record; the order of 2.4;
    the rules of 2.6; two settings in one profile make two items; an evaluation that does not count is in no item;
    two evaluations of one client with different ages (the minimum, with `results` added up).

**Task 2. On every entry.** The full entry, the catalog and `/api.json` have `providers_dev.cache.lifetime`.

- `src/core/cache.ts`: `lifetime` in `EntryCache`.
- `src/core/resolve.ts`: step 6 builds `sourceOf` (5.3) and calls `cacheLifetime`; the three reports
  (`lifetime-differs` 3.6, `unparsed-lifetime` 5.2, `retention-lifetime-differs` 6.3).
- `src/core/schema.ts`: the three codes in `Issue["code"]`.
- `src/core/contract.ts`: the three schemas, `lifetime` in `EntryCacheSchema`, the three components.
- `tests/helpers.ts`: `NO_CACHE` gets the empty record.
- `tests/resolve.test.ts`: the measured entry of the fixture has a measured item and the right two profiles; an
  entry nobody evaluated has the empty record; a documented-only entry has `models.dev` and the import date; a
  correction to a `ttl` makes the item `providers.dev` with the evidence date; an entry providers.dev added that
  documents a lifetime; a run with `lacks` or without `latest` is in no item; each of the three reports, and none of
  them on the unchanged fixture; `verified`, `origin` and every existing key of `cache` are as before.
- `tests/api.test.ts`, "the contract": `same(...)` for `cache.lifetime`, its two profiles and every item; the rules
  of 2.6 on every entry of the fixture and of the real snapshot; the models.dev part of an exported entry is equal
  to the import.

**Task 3. On every summary.**

- `src/core/entries.ts`: `cache_lifetime` in `Summary` and `summarize`.
- `src/core/contract.ts`: `cache_lifetime` in `EntrySummarySchema`.
- `tests/helpers.ts`: `summaryOf`.
- `tests/api.test.ts`: `cache_lifetime` of a summary equals `providers_dev.cache.lifetime` of the entry on the
  entry, provider, model and catalog routes (beside the test for pricing and controls); every existing key of a
  summary has the value it had.

**Task 4. The contract in words.**

- `src/core/openapi.ts`: a guide section "Cache lifetimes" (the merged list and what an item is; what `safe_s`, 0
  and null mean; the three bases; the minimum across clients; how an item's `results` relate to its `lifetime_s`;
  that it is what evaluations found on their dates, not a guarantee); `version` 1.3.0.
- `README.md`, "One contract": one paragraph, and `entry.cache_lifetime.short.safe_s` in the TypeScript example.
- `AGENTS.md`, under Rules: the cache record is worked out once in `cacheLifetime`; a lifetime is published in the
  list and nowhere else of providers.dev's own; a page prints the profiles and the items as they are, converts no
  lifetime, takes no minimum and picks no source; 0 is measured and null is unknown. The rule "Do not generate
  narrative lifetime verdicts" stays: this is a published number with a published rule, not a sentence a page makes.
- `tests/api.test.ts`: the OpenAPI document has the three components and the guide section.

**Task 5. The pages print the merged record.** The designer's, after tasks 1 to 4. `src/core/render.ts` and
`format.ts` stop reading `cache_ttl_s`, `cache_ttl_by_mode_s`, `cache_results`, `cache.results` and
`documented.modes.<mode>.ttl`; the catalog's two cache columns and the entry page's two blocks become one
presentation; the methodology says once how the value is made. Not designed here.

**Task 6. Retire what was folded in.** After task 5, before the API is public, and after open question 3.

- `src/core/cache.ts`: `ttl` out of the published `CacheModeDocumentation`; `results` out of `EntryCache`;
  `cache_ttl_s` and `cache_ttl_by_mode_s` out of `CacheFacts`; `CacheSummaryRow` and `summarizeCache` go. The `ttl`
  texts are still read inside the build (`profileOf`, the `select` rules of `resolve.ts` step 4b, `documentedItems`):
  that reading moves to the entry's `capabilities.cache`, or to a build-only type.
- `src/core/cache-contract.ts`, `contract.ts`: the same keys and `CacheSummaryRowSchema` out of the schemas and
  `COMPONENTS`; `cache_results` out of `EntrySummarySchema`.
- `src/core/entries.ts`, `resolve.ts`, `resources.ts`, `scripts/lib/publish.ts`: what made or passed them.
- `src/core/openapi.ts` (guide section "Cache evaluations" rewritten, `version` 2.0.0), `README.md` ("Cache
  evaluations are published as … `cache_results`"), `AGENTS.md` ("Cache summaries use …" now names the items'
  `results`).
- Tests: `tests/helpers.ts`, `render.test.ts`, `api.test.ts` (`cache_ttl_s` in "tells unsupported caching from
  unknown caching"), `resolve.test.ts`; a test that for every entry of the real snapshot each `ttl` text of
  `capabilities.cache` that is a duration is the `documented_as` of exactly one item of that `mode`, and each
  result of each counted evaluation is in the `results` of exactly one item.

**Not in these tasks.** The `known` lifetimes (open question 1); a filter or sort on the value (open question 7).

## 12. Open questions for the owner

**1. Do groundtruth's `known` lifetimes belong in the list?**
(a) No: they stay out, as designed. (b) Yes, as an item per client with its own basis `known`, never in `safe_s`;
needs a `profile` on each `known` item in groundtruth. (c) Yes, and they give the entry its value where nothing is
measured or documented.
Recommended: (a) now, (b) when groundtruth can say the profile. Not (c): the value would rest on one client's
behaviour that nobody tested. The only entries that would gain are the three of `claude-subscription`.

**2. An entry that documents "does not cache" (135 entries): null, or 0?**
(a) Null, basis `none`, no item, as designed: decisions 4 and 5 as written; the consumer reads `cache: "no"`.
(b) A documented item of 0 seconds in each profile, so `safe_s: 0`, basis `documented`.
Recommended: (b). "The provider says it does not cache" is known, not invented, and 0 is the number a consumer
needs. It is one branch in `documentedItems` and changes 135 records.

**3. The results added up over all clients (`results`, `cache_results`): gone, or kept beside the list?**
(a) Gone, as designed: the per-age results are on each measured item, per client. (b) Kept as they are, a second
view beside the list. (c) Kept inside the record, as `results` on `lifetime.<profile>`.
Recommended: (a). A line that adds the checks of three clients shows a cache that none of them has
(`devin/claude-opus-5-5` reads as warm to 25 minutes in the sum while two of its three clients were cold at 30 and
tested nothing between), and it is the pooling that decision 2 rules out for the value. The cost: the catalog's
one heat line per setting becomes one per client, or the safe value alone; that is the designer's to lay out.

**4. `retention_s` on the options of the `cache.retention` control: left where it is, or items too?**
(a) Left, as designed: it says which lifetime a request value asks for, and the build checks that it agrees with the
documented item. (b) Also an item, `documented`, `providers.dev`, with the date of the provider's page: 636 more
items, each beside a `models.dev` item of the same seconds.
Recommended: (a). (b) would show one documented lifetime twice on 318 entries. Its one gain is the second source.

**5. A floor on the number of checks per age?**
(a) None, as designed: every check counts and the counts are published. (b) An age needs at least 2, or 3, checks
for its hits to carry the value; a miss always counts.
Recommended: (a). With a floor of 3, the 26 evaluations that have ages with 2 checks (22 of them on Devin) would
carry little or no value. Better to measure again with 3 than to hide what was seen.

**6. Does a measured value grow old?**
(a) No, as designed: `date` is published and a page marks old evidence as it does elsewhere (90 days). (b) After N
days the entry falls back to the documented value.
Recommended: (a). A fallback would raise the value on its own with no new evidence (0 measured becoming 300
documented).

**7. A filter and a sort on the value in `/api/v1/entries`?** For example `cache_lifetime_basis=measured`,
`min_cache_safe_s=300`, `sort=cache_safe`.
Recommended: decide with the page design. The first consumer reads one entry and needs none.

## 13. What the data or the contract makes awkward in the ten decisions

**The contract**

1. **Decision 10 and "one structure".** The contract wants the same keys on every object of a kind, and null for
   "not known". One list of documented and measured items therefore has one shape, and on each item the keys of the
   other kind are null, 0 or `[]`, meaning "does not apply", not "not known". The contract has that reading already
   (`Provenance.value`: "null unless op is set"), but an item is the first object where half the keys are of that
   sort. `basis` says which half to read. Two shapes told apart by `basis` would be tighter types and break "the
   same keys".
2. **Decision 10 and the first brief's "nothing existing changes value".** Tasks 1 to 4 keep it. Task 6 removes
   `documented.modes.*.ttl`, `results`, `cache_ttl_s`, `cache_ttl_by_mode_s` and `cache_results`: that is the
   decision, and it is why task 6 has to come before the API is public.
3. **A documented view remains that this project cannot fold in.** `capabilities.cache` keeps models.dev's `ttl`
   lists in every entry and in `/api.json`. Folding it in would break the promise that the imported part keeps
   models.dev's shape. So a reader of the export sees the lifetimes twice: as models.dev wrote them, and in the
   list. Where providers.dev corrected a `ttl`, `capabilities.cache` shows the corrected text, as for every other
   correction, and the item says `providers.dev`.
4. **`retention` and `request_controls` say the same thing twice already.** `retention` is the older, flat form of
   the `cache.retention` control. Both stay: neither is a lifetime, and merging them is not part of these decisions.
5. **Rules in `AGENTS.md` and the README that name the old fields** ("Cache summaries use the API's exact ages, hit
   percentages and counts, with separate short/long settings", "`cache_results` of a summary … one line per
   retention setting") are rewritten in task 6. Their substance holds: exact ages, counts and percentages, short and
   long apart, now per client.

**The data**

6. **Decision 2 on routes that miss now and then.** "Every check hit" is all or nothing.
   `openrouter/deepseek/deepseek-v4.1-flash` hit 12 of 13 at 5 minutes and 3 of 3 at 30 and 40 minutes; its value is
   150. 14 of the 44 measured short values are 0 and 7 are 150. More checks can only lower a value, so the entries
   measured hardest look worst. The item's `results` has the rates beside it.
7. **The value is always an age that was tested.** Anthropic's 1-hour cache was checked at 10, 30 and 65 minutes,
   so its measured long value is 1,800 where 3,600 is documented (`openrouter/anthropic/claude-haiku-5.5`,
   `…/claude-opus-5.5`). `first_miss_s` (3,900) shows the gap. The cure is a check near the documented lifetime in
   groundtruth, not a rule here.
8. **Measured wins also where it is far below the documentation.** `anthropic/claude-opus-5-5` long: 600 against
   3,600, from one miss in 3 at 30 minutes with the beta header. `openrouter/google/gemini-3.8-flash` short: 0
   against 300. `openrouter/google/gemini-4-argon` short: 150 against 300. No entry has a measured value above its
   documented one today. Both are in the list.
9. **Decision 2 counts a client that cannot cache by design.** Muse Code "caches its own system prompt but never
   the conversation", and that makes `meta/muse-wonder-1.0` 0 while a coding agent held 2 hours. It is the owner's
   example and stays so; the items are what a consumer of another client reads.
10. **Decisions 2 and 6 together: the profiles of one entry are not comparable.** `meta/muse-spark-1.3` has short
    450 (plain requests, 4 November) and long 300 (a coding agent, 10 November, checked at 5 minutes and then at 1
    hour). Long below short is two ladders and two clients, not a shorter cache.
11. **One entry, two bases.** `anthropic/claude-opus-5-5`: short is documented (300, `models.dev`), long is measured
    (600, `providers.dev`). Each profile names its own basis and source.
12. **Decision 1 is mostly null.** 9,800 of 10,521 entries get null for short and 10,074 for long. 2,341 of the
    9,800 document caching without a lifetime.
13. **Decision 8 holds in the derivation, and one provider needs a look.** The value is per entry, and no value is
    carried from an API entry to the subscription entry of the same model, or back. But the runs of the route
    `meta-subscription` ("Muse Code subscription key on Meta's Model API") land on models.dev's `meta/*` entries,
    and `meta` is classified `api` by the default rule, not reviewed. So the values of `meta/muse-wonder-1.0`,
    `muse-ember-1.0` and `muse-spark-1.3` are measured with a subscription key and published on entries that say
    API. That is how the evaluations are placed today, before this design; it is a question for
    `data/authored/access.yaml` or `routes.yaml`, not for the value.
