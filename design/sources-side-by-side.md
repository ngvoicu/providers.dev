# One safe value from four sources, and a warning where they disagree

Design for the spec item SBS-01. Written 2026-11-21 against `main` at `ec012af` (API 1.3.0) and pi-cache-keeper
0.6.1. It continues `design/safe-cache-lifetime.md`, `design/usable-input-window.md`, `design/pi-source.md` and
`design/pi-merged.md`, and replaces the rule of each of them for the safe value and for what the entry page shows of
the sources; section 14 lists their sentences that change. Section k of `design/pi-source.md`, the fence, still
decides where pi's code runs; section 4 here says what one sentence of its promise becomes.

This document says what the software is. The spec says what work is done and in what order.

Amended on 2026-11-22 with the owner's answers to its first version: which measurement counts (2.3), what a
measured statement names (5.1), and the one window of the page (section 8). The counts of section 3 are redone with
them, on the same dataset.

**Decided by the owner (2026-11-21):**

1. One order of sources for every safe value: (1) what providers.dev measured; (2) providers.dev's own statements,
   the corrections in `data/authored/overrides/` and the values of the providers it adds, each with its evidence;
   (3) models.dev; (4) pi.dev.
2. The website shows one value per quantity, the safe value, and never says whether it was measured or documented.
   Where the sources that state a value do not agree, it shows a warning sign whose tooltip lists each source's
   value.
3. A source that states nothing does not disagree; a measured lower bound does not contradict a larger stated value;
   prices agree only when exactly equal.
4. A price is taken whole from one source, never mixed.
5. The API keeps every source: the safe value as the main field and each source's own value beside it.
6. Changed in API v1, no v2. pi-cache-keeper reads only safe values: both cache lifetimes, the input window, the
   maximum output, prices with their tiers.

**Decided by the owner on the first version of this design (2026-11-22), and built into it since:**

7. Which measurement counts is the most direct one that exists for the entry: on an API-key entry, requests sent
   straight to the provider and no other; on a login, the vendor's own client first, then a proxy. Within that
   kind, the lowest. It replaces "the lowest across evaluations and clients" (2.3).
8. A measured statement names the measurement it is: the client and its kind, the date, the evaluation (5.1).
9. The page has one window, labelled "Context window", and it shows the safe input window; where the entry's total
   context is larger, a short note says so under it. The API is as designed: `input_window` is the safe quantity
   (section 8).
10. A value without a warning shows no source and no date; a value only pi states is shown unmarked; every other
    point of section 13 as designed.

**What this design answers, in short:**

- **Five safe quantities**: input window, maximum output, short and long cache lifetime, price. One rule for all:
  the first source in the order that states a value gives it (section 2).
- **One new object**, `safe`, on every entry and every summary: per quantity the safe value, its source, whether the
  sources agree, and the statement of every source that makes one. Worked out once, in `src/core/safe.ts`. The
  existing safe fields (`input_window.tokens`, `cache_lifetime.*.safe_s`, `pricing`, `max_output` of a summary)
  carry the same values, copied from it (section 5).
- **pi as the last source without giving up the fence**: the dataset is settled from three sources before any pi
  code runs; pi's checked numbers are then laid over it by the reference's own code, and can only fill a value no
  other source states (section 4).
- **The page**: one table per topic, one row per quantity, the safe value, a warning sign where `agreement` is
  `differ`. pi's lines under values, the source tags and the "documented, not contradicted" words go (section 8).
- **5 published safe values fall, 4 rise, 3 become unknown, 8 unknown ones are filled from pi, and 102 of 6,309
  entries carry a warning** (section 3).
- **API 1.4.0**: additions, and fields that keep their type and change their rule (section 6).

---

## 1. What was counted

All counts: the dataset live on 2026-11-21, `dataset_version` `0b47455c15b331fa`, built from `main` `ec012af`:
models.dev snapshot `99ba9ec`, pi revision `sha256-dd93eb27…`, measurements of 2026-11-18; 333 providers, 6,309
entries, 810 of them with a pi block; 186 cache evaluations and 36 limit evaluations on 134 entries.

**The safe values today**, by the rules of the two earlier designs:

| | documented, models.dev | documented, providers.dev | measured | unknown |
|---|---:|---:|---:|---:|
| input window | 5,931 | 0 | 23 | 355 |
| cache lifetime, short | 284 | 17 | 106 | 5,902 |
| cache lifetime, long | 180 | 0 | 7 | 6,122 |

A measured value exists on 36 input windows, 133 short and 14 long lifetimes.

**Who measured.** The measurements file names eight routes and six clients. By route and client, cache evaluations
then limit evaluations:

| route | requests straight to the provider | the vendor's own CLI | through CLIProxyAPI, plain or with a coding agent |
|---|---:|---:|---:|
| `anthropic-api` | 8, 0 | | 2, 0 |
| `openai-api` | 9, 0 | | 3, 0 |
| `openrouter` | 88, 4 | | 9, 9 |
| `claude-subscription` | | | 8, 4 |
| `codex-subscription` | | 2, 0 (Codex CLI) | 10, 4 |
| `devin` | | 12, 0 (Devin CLI) | 23, 12 |
| `meta-subscription` | | 1, 0 (Muse Code) | 10, 3 |
| `antigravity` | | | 1, 0 |

Every evaluation of an API-key route is on an entry whose access is `api`, every one of a login on an entry whose
access is `subscription`.

**What providers.dev states of its own today.** The 26 override files hold 37 rules: 7 leave an entry out, 21
declare a request control and touch no value, 9 set a field. All 9 are about `capabilities.cache`: 24 entries get
`implicit: true` (no safe quantity), 17 entries a lifetime (12 on Amazon Bedrock, 30 minutes; 5 on ZenMux, 5
minutes), and on 3 DeepInfra entries the lifetimes models.dev lists are published as unknown on purpose. No override
sets a limit or a price. The 29 entries of the four providers providers.dev adds state no limit, lifetime or price in
their files: their limits are measured and their prices are the API entry's.

**pi.** pi states a context window above 0 on all 810 entries, a maximum output on all 810, a price on 715 (678 of
them not subscriptions), tiers on 160, cache lifetimes on 4. Values only pi states: 5 context windows and 5 maximum
outputs (the five entries of `design/pi-merged.md`, section 3); no price.

The scripts of this count are not in the repository; step D1 reproduces every table of this document from the
built data (section 12).

---

## 2. The rule

### 2.1 The quantities

| key | what it is | unit |
|---|---|---|
| `input_window` | the most input one request can carry on the entry | tokens |
| `max_output` | the most tokens one response can hold | tokens |
| `cache_short` | seconds a cached prompt can be relied on, where the request asks for no lifetime or the shortest one | seconds |
| `cache_long` | the same where the request asks for a longer lifetime | seconds |
| `price` | the list price per token, whole: base prices, cache prices, tiers and every conditional rate | US dollars |

Nothing else is a safe quantity. `limit.context` and `limit.input` are what two of the sources state *for* the input
window; they stay in the entry's `limit`, as imported and corrected. A page shows the context only as the note
under the window, where it is larger (section 8).
Cache modes, retention and request controls have one source each and keep their own records.

### 2.2 The sources, in order

| # | `source` | what it is |
|---|---|---|
| 1 | `measured` | providers.dev's own evaluations of the entry: `providers_dev.limits.measured`, `providers_dev.cache.evaluations` |
| 2 | `providers.dev` | what providers.dev states with evidence: a correction of the imported entry, or a value in the file of an entry it adds |
| 3 | `models.dev` | the entry as imported |
| 4 | `pi.dev` | pi's catalog, where it lists the entry |

### 2.3 What each source states

A source either states a value for a quantity or states nothing. `null` and an absent field always state nothing.

**`measured`**

Which evaluations give the measured statement is decided first, and the same way for every quantity: **the most
direct measurement that exists**.

Every client of the measurements file has a **kind**:

| kind | what it is | today's clients |
|---|---|---|
| `direct` | plain requests sent straight to the provider | `direct` |
| `own_client` | the vendor's own client | `codex-cli`, `devin-cli`, `muse-code`; the coming `claude-code` |
| `proxy` | requests through a proxy, plain or made by a coding agent | `cliproxyapi`, `pi+cliproxyapi` |

Which kinds count depends on how the entry is reached, `providers_dev.access` of the entry:

| the entry | the kinds that count, in order |
|---|---|
| an API-key entry (`api`; `unknown` is read the same way) | `direct`, and no other |
| a login (`subscription`) | `own_client`; where none measured it, `direct`; where none either, `proxy` |

**For each quantity, and for each lifetime profile on its own, the measured statement comes from the first kind in
the entry's order that has an evaluation that gives the quantity a value; within that kind, from the lowest.** The
evaluations of every other kind stay published where they are, as evidence, and feed nothing. An API-key entry
measured only through a proxy has no measured statement. `direct` on a login is in the order so that the rule is
complete; no such evaluation exists today.

| quantity | the statement, over the evaluations of the kind that counts |
|---|---|
| input window | the lowest value of the counted limit evaluations, read as in `design/usable-input-window.md` 3.3: a window the route names (exact), or the largest input accepted below a refusal, or read to the end (`at_least`, with the refusal as `below`) |
| maximum output | the lowest `output` above 0. Exact. `output_accepted` is a size that was asked for and states nothing |
| cache lifetimes | the lowest strict value of the profile's counted evaluations, read as in `design/safe-cache-lifetime.md` section 3: the oldest age through which every check hit; the youngest age with a miss among them is its `below`. 0 is a statement: no age at which every check hit. Never marked `at_least`: the time a cache was seen to hold is the value a client needs |
| price | never. providers.dev does not measure prices |

**The statement names the measurement that gives it**: the evaluation with the lowest value (among equals the
newest, then the first by id; for a limit, the first in the order of `measurements`), with its client, the client's
label and kind, its date, its id where it has one (a limit evaluation has none) and the address of its raw result.

**Where a client's kind comes from.** groundtruth will declare it per client in `observed.json`. Until it does,
`data/authored/measurement-labels.yaml` carries it: each client there gets a required `kind` (`direct`,
`own-client` or `proxy`). One function of the build, `clientKind`, gives the kind of a client: the measurements
file's where it states one, else the labels file's. Where both state one and they differ, the measurements file's
counts and the build reports a warning (`client-kind-differs`). A client with no kind from either is published as
today (`other`, with the `unmapped-client` warning), has `client_kind: null`, and its evaluations feed nothing. The
import must accept the new field before groundtruth publishes it (section 13, new point 4).

**`models.dev` and `providers.dev`** are read from the entry twice, with one reading (below): once **as imported**,
before any override, and once **as published**, after every override.

- `models.dev` states what the reading of the imported entry gives. It states nothing on an entry providers.dev adds.
- `providers.dev`, on an imported entry: nothing where the two readings are equal; else the published reading. Where
  the published reading gives no value and the imported one gave one, providers.dev **withholds** the value: it
  publishes it as unknown on purpose (`null` or `"$delete"` in an override), and that is its statement.
- `providers.dev`, on an entry it adds: the published reading, where it gives a value. A `cost` the entry inherits
  from another entry is not its own statement (2.4, a subscription entry).

The reading, per quantity:

| quantity | states a value | states nothing |
|---|---|---|
| input window | `limit.input` above 0 (scope `input`); else `limit.context` above 0 that is not named in `limits.from_measurement` (scope `window`) | 0, absent; a value written from a measurement is the measurement's |
| maximum output | `limit.output` above 0, not named in `limits.from_measurement` | 0, absent |
| cache lifetimes | the lowest documented lifetime of the profile, as `documentedItems` reads `capabilities.cache`; 0 for both profiles where caching is documented as unsupported | caching documented without a lifetime; a lifetime text that does not convert |
| price | `cost` gives at least one rule of the normalized pricing. A listed 0 is a price | no `cost`, or none that normalizes |

**`pi.dev`**, read from the entry's checked pi block, items of `values` by `field`:

| quantity | states a value | states nothing |
|---|---|---|
| input window | `context_window`: `pi` above 0 (scope `window`) | 0, `null` |
| maximum output | `max_tokens`: `pi` above 0 | 0, `null` |
| cache lifetimes | `prompt_cache.short`, `prompt_cache.long`: `pi` a number, 0 included | `null` |
| price | `cost.input` or `cost.output` above 0. Its parts: the four prices, each where above 0, and `pi_tiers` | both 0; **and on every entry whose access is `subscription`** |

pi's `standing` is not read: only its numbers are. `supportsLongCacheRetention` is not a lifetime and is not read.

**Each statement carries a date**: `measured`, the date of the evaluation it names; `providers.dev`, the newest
evidence date of the corrections that touch the fields read (the paths the two earlier designs name: `limit`,
`limit.input`, `limit.context`; `limit`, `limit.output`; `capabilities`, `capabilities.cache` and below; `cost` and
below, and an authored `pricing` declaration), or of the added entry's evidence; `models.dev`, the import date;
`pi.dev`, the day of pi's snapshot (`meta.pi.snapshot.fetched_at`). A `providers.dev` statement also carries
`evidence_url`: the URL of the evidence item that gives its date, the first listed among equals.

### 2.4 The safe value

**The safe value of a quantity is the statement of the first source, in the order, that makes one.** No source
makes one: unknown (`null`). The first is providers.dev withholding: unknown, and no later source fills it.

Two things follow and are meant:

- A measured lower bound is the safe value, with `at_least: true`, also where a later source states more.
- A measured value is the safe value also where it is above what a later source states. Today:
  `openrouter/xiaomi/mimo-v2.6-flash` and `-pro`, where the route names 1,050,000 and both catalogs say 1,048,576
  (published so already); no lifetime.

**One refinement, for the input window.** A statement is either a cap on the input (`scope: "input"`) or a window
that input and output share (`scope: "window"`). Where the first statement is a window and a later source states a
cap that is not above it, the cap is the safe value, with its own source. The case it was written for:
`openrouter/openai/gpt-6.1-sol` and `gpt-6.1-terra`, where the route named a window of 1,050,000 and models.dev
states an input of 922,000; without it a measured total would publish an input window 128,000 tokens above the
documented cap. Both were measured through the proxy, so by 2.3 neither has a measured statement today and the
refinement applies to no entry; it stays for the day one is measured directly.

**The price is taken whole.** The safe price is the price of the first of `providers.dev`, `models.dev`, `pi.dev`
that states one; every rule of `pricing` is that source's. A part one source lacks is never filled from another:
`openrouter/minimax/minimax-m2.7` keeps models.dev's price without a cache-read price, though pi states one.
providers.dev's price, where it corrects one, is the whole published price (models.dev's with the correction
applied), and models.dev's own, uncorrected, stands beside it as models.dev's statement.

**A subscription entry** is not paid per token. Its price stays the API list price of the entry it refers to
(`billing: "reference"`), as today: the statements of `providers.dev` and `models.dev` are those of that API entry,
and pi states nothing (its price for a login is a list price too). pi's price never becomes a reference price.
Where there is no API entry to refer to, the price is unknown, as today.

### 2.5 Agreement

`agreement` of a quantity, from its statements: `none` (no source states anything), `single` (one does), `agree`
(two or more, and no pair contradicts), `differ` (at least one pair contradicts). The page's warning is `differ`
and nothing else.

Which pairs contradict:

| pair | contradicts when |
|---|---|
| two stated numbers (maximum output, cache lifetimes) | they are not equal |
| two stated input windows of the same scope | they are not equal |
| a cap and a window | the cap is above the window. A cap inside the window is what a window allows |
| a measured input window and a stated one | a counted evaluation of the kind that counts (2.3) contradicts the stated value by the test of `design/usable-input-window.md` 4.2, unchanged (`windowContradicts`): it names a window below it; names another window than a stated window; refused an input at or below 99 % of it; accepted one at or above 101 % of it. An accepted input below the stated value contradicts nothing: the walk stopped there |
| a measured lifetime `m` (first miss `f`) and a stated one `S` | `S < m` (every check still hit after the stated lifetime), or `f` is not null and `S ≥ f` (a check missed at an age the stated lifetime covers). A lifetime checked only up to `m` with no miss up to `S` contradicts nothing |
| providers.dev withholding and a later stated value | always: that is what withholding says. A measurement does not contradict a withheld value |
| two prices | per part (2.6) |

The test for lifetimes replaces "fewer than half of the checks hit" of `design/safe-cache-lifetime.md` 4.1. That
test decided whether the documented lifetime stayed the safe value; it decides nothing now, and one miss already
lowers the safe value. The warning has to say why the page shows 25 minutes where the catalog lists 30. `m` and `f`
are those of the measured statement: only the evaluations of the kind that counts.

### 2.6 The parts of a price

Two prices are compared on the parts every source can state, each in US dollars per million tokens, read by the
reference's own code from the normalized `pricing` rules (`priceParts` in `src/core/policies.ts`):

| part | read from |
|---|---|
| `input`, `output`, `cache_read`, `cache_write` | the base rule of `text.input`, `text.output`, `text.cache_read`, `text.cache_write`: `when: null`, `set`, USD, per 1,000,000 tokens (as `price_in` is read today). `null` where there is none: a write price keyed by lifetime has no base rule and is not compared |
| `tiers` | the rules of those four meters whose `when` is one predicate on `request.context_tokens`, `gt N` (threshold N) or `gte N` (threshold N less 1): one tier per threshold, ascending. `null`, not compared, where such a rule is in another unit or its threshold is not a whole number of 0 or more |
| `other` | everything else of the price. Compared only between `providers.dev` and `models.dev`, as rules deep-equal |

A part contradicts where two sources both state it and the numbers are not equal; pi's 0 states nothing. Tiers
contradict by rule 5 of `design/pi-source.md` section e: other thresholds, or a price both state in a tier that is
not equal; a source that states a price and no tier states an empty list. `differs` of the price lists the parts
that contradict.

This reading gives exactly pi's own verdicts on today's data: over the 770 entries that are not subscriptions and
have a price and a pi block, and their five parts (3,850 comparisons), it finds a contradiction on the same 103
parts where `pi.values` says `differs`, and on no other.

---

## 3. What changes, in numbers

**The safe values by source, after:**

| quantity | `measured` | `providers.dev` | `models.dev` | `pi.dev` | withheld | unknown |
|---|---:|---:|---:|---:|---:|---:|
| input window | 27 | 0 | 5,927 | 3 | 0 | 352 |
| maximum output | 3 | 0 | 5,712 | 5 | 0 | 589 |
| cache lifetime, short | 128 | 17 | 259 | 0 | 3 | 5,902 |
| cache lifetime, long | 13 | 0 | 174 | 0 | 3 | 6,119 |
| price | n/a | 0 | 6,107 | 0 | 0 | 202 |

**Which kind gives the measured statement** (2.3): the input window, `direct` on 4 entries and `proxy` on 23, all
logins; the short lifetime, `direct` on 97, `own_client` on 14, `proxy` on 17; the long lifetime, `direct` on 6,
`proxy` on 7; the maximum output, `proxy` on 3 logins.

**Measured, and not counted.** Fifteen values of OpenRouter entries were measured only through the proxy and have
no measured statement until they are measured directly:

- input window, 9: `anthropic/claude-haiku-5.5`, `anthropic/claude-opus-5.5`, `anthropic/claude-sonnet-5.5`,
  `deepseek/deepseek-v4.1-flash`, `google/gemini-4-argon`, `meta/muse-wonder`, `moonshotai/kimi-k3.1-pro`,
  `openai/gpt-6.1-sol`, `openai/gpt-6.1-terra`. models.dev states each, so every number stays;
- short lifetime, 5: `deepseek/deepseek-v4.1-flash`, `meta/muse-spark-1.3`, `z-ai/glm-5.3-flash` (unknown now, below)
  and `openai/gpt-6-astra`, `openai/gpt-6-luna` (models.dev's 1,800 stays);
- long lifetime, 1: `anthropic/claude-haiku-5.5` (models.dev's 3,600 stays).

**Five published safe values fall**, each to what was measured:

| entry | quantity | today | after | the measurement |
|---|---|---:|---:|---|
| `openrouter/anthropic/claude-opus-5.5` | long | 3,600 | 1,800 | direct, 2026-11-04: held at 30 minutes, missed at 65, nothing checked between |
| `openrouter/openai/gpt-6.2-astra` | short | 1,800 | 1,500 | direct, 2026-11-18: a miss at 30 minutes |
| `openrouter/~openai/gpt-sol-latest` | short | 1,800 | 150 | direct, 2026-11-18: a miss at 5 minutes |
| `openai-codex/gpt-6.1-sol` | input window | 922,000 | at least 921,500 | through the proxy, 2026-11-17 (no own client measured the limit): accepted 921,500, refused 922,300 |
| `openai-codex/gpt-6.1-terra` | input window | 922,000 | at least 920,870 | through the proxy, 2026-11-08: accepted 920,870, refused 921,886 |

**Four rise**, all short lifetimes on logins, from 0 to what the vendor's own client held:

| entry | today | after | the vendor's client | plain requests through the proxy | a coding agent through the proxy |
|---|---:|---:|---|---|---|
| `devin/glm-5-3` | 0 | 7,200 | Devin CLI, 2026-11-08: no miss up to 2 hours | missed at 2.5 minutes | held 5 minutes |
| `devin/grok-4-7` | 0 | 900 | Devin CLI, 2026-11-08: missed at 30 minutes | missed at 2.5 minutes | missed at once |
| `openai-codex/gpt-6.1-sol` | 0 | 300 | Codex CLI, 2026-11-07: missed at 15 minutes | missed at 2.5 minutes | held 30 minutes |
| `openai-codex/gpt-6.1-terra` | 0 | 1,800 | Codex CLI, 2026-11-07: missed at 60 minutes | missed at 2.5 minutes | held 15 minutes |

**Three become unknown**, short lifetimes of OpenRouter entries that nothing documents and only the proxy measured:
`openrouter/deepseek/deepseek-v4.1-flash` (150 today), `openrouter/meta/muse-spark-1.3` (0) and
`openrouter/z-ai/glm-5.3-flash` (0).

**Eight unknown values are filled from pi**, the only source that states them:

| entry | input window | maximum output |
|---|---:|---:|
| `openai-codex/gpt-6-astra` | (measured: at least 921,500) | 128,000 |
| `openai-codex/gpt-6-luna` | (measured: at least 921,500) | 128,000 |
| `openai-codex/gpt-6.2-astra` | 272,000 | 128,000 |
| `openai-codex/gpt-6.2-sol` | 500,000 | 128,000 |
| `vercel/spacexai/grok-voice-3.0` | 4,096 | 4,096 |

No price changes. On 30 more values the number stays and its source becomes `measured` (2 input windows, 23 short
and 5 long lifetimes): `basis` goes from `documented` to `measured` on 4 input windows, 25 short and 6 long profiles
in all, and from `measured` to `none` on the 3 that become unknown.

One of the five falls **without a warning**: `openrouter/anthropic/claude-opus-5.5`, long, shows 30 minutes where
models.dev lists an hour. Nothing was checked between 30 and 65 minutes, so the measurement contradicts nobody
(decision 3 of the owner); the page shows the lower number and no sign.

Against the first version of this design (the lowest across all clients): `anthropic/claude-opus-5-5` long stays
3,600, measured directly on 2026-11-17 through the hour; `openrouter/anthropic/claude-haiku-5.5` long stays 3,600
and `openrouter/google/gemini-4-argon` short stays 300.

**Agreement:**

| quantity | `agree` | `differ` | `single` | `none` |
|---|---:|---:|---:|---:|
| input window | 781 | 26 | 5,150 | 352 |
| maximum output | 780 | 25 | 4,915 | 589 |
| cache lifetime, short | 23 | 9 | 375 | 5,902 |
| cache lifetime, long | 6 | 3 | 181 | 6,119 |
| price | 615 | 63 | 5,429 | 202 |

**102 entries carry at least one warning** (85 on one quantity, 10 on two, 7 on three). What the warnings are:

- input window, 26, in three sets that overlap: on 22 entries pi states less than models.dev (the seven
  `openai/gpt-6…` API entries, 272,000 against an input of 922,000; two `deepseek` entries, 1,000,000 against
  1,048,576; OpenRouter entries); on 8 a measurement contradicts pi (the four measured `openai-codex` logins,
  272,000 or 500,000 against at least 920,870; four OpenRouter entries measured directly); on 2 of those it
  contradicts models.dev too (`openrouter/xiaomi/mimo-v2.6-*`);
- maximum output, 25: models.dev and pi, the same 25 entries where `pi.values` says `differs`;
- short lifetime, 9: the 6 OpenRouter entries where a direct check missed inside the lifetime models.dev lists, and
  the 3 DeepInfra entries where providers.dev withholds the lifetimes models.dev lists;
- long lifetime, 3: the same 3 DeepInfra entries;
- price, 63: input on 21, output on 21, cache read on 20, tiers on 41.

**A build without pi's data** publishes the 3 input windows and 5 maximum outputs as unknown and warns on 11
entries instead of 102.

**The records beside the safe value follow the same choice** (5.2): `measured_s` changes on 6 profiles (the four
that rise, `anthropic/claude-opus-5-5` long from 600 to 3,600, `openrouter/google/gemini-4-argon` short from 150
to 300) and becomes `null` on the 6 profiles measured only through the proxy; `measured_tokens` becomes `null` on
the 9 input windows. `documented_status` goes to `contradicted` on 2 short profiles
(`openrouter/openai/gpt-6.2-astra`, `openrouter/~openai/gpt-sol-latest`) and to `null`, nothing measured that
counts, on 3 lifetime profiles and 9 input windows.

---

## 4. pi as the last source, and the fence

The fence's three rules stay as `design/pi-source.md` section k has them. What makes that possible is the order of
the build:

1. **`resolve()` settles every safe value from the three sources of the reference** (measured, providers.dev,
   models.dev) and writes `pi: null`. The dataset is complete without pi before any pi code runs: rule 1, word for
   word.
2. **`piOfBuild()`** runs pi's code as today. After its four checks the fence does one more thing, with the
   reference's code and through the guard: it reads from every checked block what pi states (`piStatements`,
   section 5), as plain data that fits a schema. A throw or a misfit turns the data part away, whole, like every
   other fault. `PiOfBuild.entries` carries, per entry, the block, the summary and these statements.
3. **`publish()`** lays each block on its entry, as today, and then lays pi's statements over the entry's safe
   values with `layPi` (`src/core/safe.ts`), the reference's own pure code: it adds pi's item to `sources`, and
   settles the quantity again with the one rule. Then the summaries are made, once, as today.

What `layPi` can do to an entry is small and can be stated exactly. For each quantity:

- pi's item is appended to `sources`, last;
- `agreement` moves one way: `none` to `single`, `single` to `agree` or `differ`, `agree` to `agree` or `differ`;
  `differ` stays;
- **the safe value changes only where it was unknown with no source** (no statement at all): it becomes pi's, with
  `source: "pi.dev"`. A value any other source states, and a value providers.dev withholds, is never touched.

There is no second build path: a build without pi's data does not call `layPi`, and turning pi away is still doing
nothing. `withoutPi(safe)` is the inverse of `layPi`, and `withoutPi(layPi(x)) = x` is a test on every entry.

**One sentence of the fence's promise changes.** "The models.dev part of the dataset is the same with or without
pi's data" becomes: **no value that a measurement, providers.dev or models.dev states is different with or without
pi's data.** With pi's data an entry differs from the same entry without it in exactly this: its pi block; pi's item
in `safe.*.sources`; `agreement`, `differs` and `differing`; and, where no other source states the value, the safe
value itself and the fields that copy it, with `source: "pi.dev"`.

**What the fence still does not promise** is wider by one case, and bounded: a pi part that is well-formed, agrees
with itself and is wrong can now publish a wrong number as a safe value where no other source states one (8 values
today), marked `pi.dev` in the API, and a wrong warning sign anywhere pi is listed. It can never change a value
another source states. The owner has decided that such a value is shown unmarked on the page (section 13).

**A build without pi's data** (no `data/pi/`, or the part turned away) publishes the dataset of step 1: those safe
values are `null`, no `sources` has a pi item, and the warnings that need pi are not there. It is said where it is
said today (`meta.pi.snapshot: null`, the `pi-snapshot-unreadable` issue, the warning on the run). Because 8
published values now depend on it, the README's sentence on the warning "pi data missing from the build" gains:
"the safe values only pi states are published as unknown".

**The whole-dataset comparison** (`scripts/lib/compare-published.ts`) takes pi off both sides with `withoutPi` and
the copy step (`mirror`, section 5) besides removing the block, and then requires what it requires today.

---

## 5. The API shape

### 5.1 `safe`

One object, on every entry as `providers_dev.safe` and on every summary as `safe` (the same object, as
`input_window` and `cache_lifetime` are today).

```ts
// src/core/safe.ts — the reference's own code. Pure: no file, no network, no clock. Imports nothing of pi's but types.
export const VALUE_SOURCES = ["measured", "providers.dev", "models.dev", "pi.dev"] as const;
export type ValueSource = (typeof VALUE_SOURCES)[number];
export const SAFE_QUANTITIES = ["input_window", "max_output", "cache_short", "cache_long", "price"] as const;
export type SafeQuantity = (typeof SAFE_QUANTITIES)[number];
export type Agreement = "agree" | "differ" | "single" | "none";
/** How a measurement's client reaches the provider (2.3). The measurements file writes `own-client`. */
export type ClientKind = "direct" | "own_client" | "proxy";

/** What one source states of one quantity. */
export interface SourceValue {
  source: ValueSource;
  /** The number it states. Null exactly when `withheld`. */
  value: number | null;
  /** providers.dev publishes the value as unknown on purpose. False on every other source. */
  withheld: boolean;
  /** A measured lower bound: the real value is this or more. */
  at_least: boolean;
  /** Measured: the smallest value seen to fail (an input refused, an age with a miss). Null = none seen, and on every other source. */
  below: number | null;
  /** Input window only: a cap on the input, or a window input and output share. Null on every other quantity. */
  scope: "input" | "window" | null;
  date: string | null;
  /** providers.dev: the evidence it rests on. Measured: the raw result of the evaluation it names. Null on the two catalogs. */
  evidence_url: string | null;
  /** Measured: the public id of the client the evaluation went through. Null on every other source. */
  client: string | null;
  /** Measured: that client's public label. */
  client_label: string | null;
  /** Measured: that client's kind (2.3). */
  client_kind: ClientKind | null;
  /** Measured: the id of the cache evaluation that gives the value. Null for a limit evaluation, which has none, and on every other source. */
  evaluation_id: string | null;
}

/** The safe value of one quantity and every statement it was chosen from. */
export interface SafeValue {
  value: number | null;
  unit: "tokens" | "seconds";
  at_least: boolean;
  scope: "input" | "window" | null;
  /**
   * Input window only: the window the input shares with the answer, where the entry states one above `value`
   * (its published `limit.context`, not a measured one). Null where it states none or none larger, and on every
   * other quantity.
   */
  window_tokens: number | null;
  source: ValueSource | null;
  date: string | null;
  agreement: Agreement;
  /** One item per source that states something, in the order of the sources. Empty = none does. */
  sources: SourceValue[];
}

export interface PriceTier { input_tokens_above: number; input: number | null; output: number | null; cache_read: number | null; cache_write: number | null }
export const PRICE_PARTS = ["input", "output", "cache_read", "cache_write", "tiers", "other"] as const;
export type PricePart = (typeof PRICE_PARTS)[number];

/** What one source states of the price, in the parts sources are compared on (US dollars per million tokens). */
export interface PriceStatement {
  source: Exclude<ValueSource, "measured">;
  withheld: boolean;
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cache_write: number | null;
  /** Null = its tiers cannot be read as tiers, or withheld. Empty = it states a price and no tier. */
  tiers: PriceTier[] | null;
  date: string | null;
  evidence_url: string | null;
}

/** Whose price `pricing` is, and every source's price beside it. The price itself is `pricing`, whole. */
export interface SafePrice {
  source: Exclude<ValueSource, "measured"> | null;
  date: string | null;
  agreement: Agreement;
  /** The parts on which two sources contradict each other, in the order of PRICE_PARTS. Empty unless `differ`. */
  differs: PricePart[];
  sources: PriceStatement[];
}

export interface SafeValues {
  input_window: SafeValue;
  max_output: SafeValue;
  cache_short: SafeValue;
  cache_long: SafeValue;
  price: SafePrice;
  /** The quantities whose agreement is `differ`, in the order of SAFE_QUANTITIES. Empty = no warning on the entry. */
  differing: SafeQuantity[];
}
```

`sources` lists only the sources that state something: on most entries one item per quantity. By estimate a summary
grows by about 1.5 KB (3.4 KB on average today) and the index of summaries from about 22 MB to about 30 MB before
compression; step D1 shows the real sizes of `index.json` and `index.json.gz` before and after.

**What always holds** (the contract test and `tests/safe.test.ts` hold it on every entry):

1. `sources` has at most one item per source, in the order of `VALUE_SOURCES`, and only sources that state
   something; no `measured` item on the price.
2. `source` names an item of `sources`, and `value`, `at_least`, `scope` and `date` are that item's. `source` is
   `null` exactly when `sources` is empty.
3. `source` is the first item's, except by the refinement of 2.4 (the first item a window, `source` a later cap not
   above it).
4. `value` is `null` exactly when `source` is `null` or its item is `withheld`.
5. `agreement` is `none`, `single`, or `agree` or `differ` by 2.5, from `sources` alone and, for a measured input
   window, the items of `measurements` that are `chosen` (5.2).
6. `source` is `pi.dev` only where pi's item is the only one.
7. `differs` is empty unless the price's `agreement` is `differ`; `differing` lists exactly the quantities whose
   `agreement` is `differ`.
8. `providers_dev.pricing` is the price of `safe.price.source`, whole; `rules: null` where that is `null`.
9. A `measured` item has a `client`, a `client_label` and a `client_kind`, and that kind is the first of the entry's
   order (2.3) that has an evaluation giving the quantity a value; every other item has the four keys `null`.
10. `window_tokens` is `null` or above `value`, and `null` on every quantity but the input window. 448 entries have
    one today: every entry where models.dev states an input below its context.

### 5.2 The existing fields carry the same values

The safe value is published once and copied, by one function (`mirror`), into the fields that have carried it.
Nothing else writes them.

| existing field | becomes |
|---|---|
| `limits.input_window.tokens`, `.scope`, `.date` | `safe.input_window.value`, `.scope`, `.date` |
| `limits.input_window.bound` | `at_least` where `safe.input_window.at_least`, else `limit`; `null` with no value |
| `limits.input_window.basis`; `cache.lifetime.{short,long}.basis` | `measured` where `source` is `measured`; `documented` where it is any other source; `none` where the value is `null` |
| `limits.input_window.source`; `cache.lifetime.{short,long}.source` | `providers.dev` where `source` is `measured` (as today) or `providers.dev`; else the source's name, **`pi.dev` now among them**; `null` where the value is `null` |
| `cache.lifetime.{short,long}.safe_s`, `.date` | `safe.cache_short.value`, `safe.cache_long.value`, and their `date` |
| `documented_status` (input window, both profiles) | where a value is documented and one is measured by a kind that counts: `contradicted` where the measured item and the documented value contradict by 2.5, else `not_contradicted`. It no longer says which of the two is the safe value |
| `limits.input_window.measured_tokens`, `measured_bound`, `measured_kind`, `measured_refused`, `measured_date`, `clients`, `evaluations` | those of the measured statement: over the evaluations of the kind that counts (2.3), where they were over every client. `null` and 0 where no kind that counts measured it |
| `cache.lifetime.{short,long}.measured_s`, `clients`, `evaluations`, `checks`, `hits`, `checks_inside`, `hits_inside`, `tested_from_s`, `first_miss_s` | the same |
| `providers_dev.pricing`; `pricing`, `price_in`, `price_out`, `price_from` of a summary | the price of `safe.price.source`, whole. Where that is `pi.dev`: pi's four prices and tiers as rules of the same shape (`pricingOfPi` in `src/core/policies.ts`), `coverage: "partial"`, one evidence item of kind `listed` with pi's address and date |
| `max_output` of a summary | `safe.max_output.value` |

Unchanged, key for key: `documented_tokens`, `documented_field`, `documented_source`, `documented_date`;
`documented_s`; the entry's own `limit`, `cost` and `capabilities`; `context` and `input` of a summary;
`measured_input_accepted`, `measured_input_refused`, `measured_limit_count` and `evaluation_count` of a summary,
which count every evaluation; `providers_dev.pi`, whole.

**The lists keep every client, and say which ones count.** `measurements` of the input window and the measured
items of `lifetimes` hold every counted evaluation of every client, as today (pi's lifetime is not an item of
`lifetimes`: the list holds what providers.dev and models.dev document and what was measured). Four records gain
`client_kind` (`ClientKind`, or `null` for a client without one): a cache evaluation, a limit evaluation, an item
of `measurements`, an item of `lifetimes` (`null` on a documented item). The last two also gain `chosen`: `true`
where the item is of the kind that gives the measured statement of its quantity and profile, `false` on every
other and on a documented item. A page marks evidence that does not count from `chosen`, and applies no rule.

`inputWindow` (`src/core/limits.ts`) and `cacheLifetime` (`src/core/cache.ts`) keep making their records and stop
choosing a safe value: the keys of the first six rows above are written by `mirror`. Both take the kind that
counts from one function, `countingKind(access, kinds)` in `src/core/safe.ts`, so that the records and `safe` cannot
choose differently.

### 5.3 The code, in one place

`src/core/safe.ts` holds the rule and nothing else does:

| function | what it is |
|---|---|
| `countingKind(access, kinds): ClientKind \| null` | 2.3: the first kind of the entry's order among the kinds that gave the quantity a value |
| `safeValues(facts): SafeValues` | the statements of the three reference sources (2.3) and the rule (2.4, 2.5, 2.6), for one entry. Called by `resolve()` in step 6, for every entry |
| `piStatements(block, date): PiStatements` | what pi states, from a checked block (2.3). Total: any block the contract accepts gives a result. Called by the fence |
| `layPi(safe, statements, access): SafeValues` | section 4. Called by `publish()` for every entry with a block, followed by `mirror` |
| `withoutPi(safe): SafeValues` | its inverse |
| `mirror(extension)` | 5.2 |

```ts
export interface PiStatements {
  /** The day of pi's snapshot. */
  date: string | null;
  input_window: number | null;
  max_output: number | null;
  cache_short: number | null;
  cache_long: number | null;
  /** Null = pi states no price (neither input nor output above 0). A part of 0 is null. */
  price: { input: number | null; output: number | null; cache_read: number | null; cache_write: number | null; tiers: PriceTier[] } | null;
}
```

`clientKind` (2.3) lives in `resolve.ts`, where a client gets its public id and label today, and the labels file's
schema (`MeasurementLabels` in `src/core/schema.ts`) gains the required `kind`. `resolve()` reads the imported
entry before it applies the overrides and keeps that reading for step 6;
`priceParts` and `pricingOfPi` live in `src/core/policies.ts` beside `pricingOf`. `src/core/pi.ts` and
`scripts/lib/pi-sync.ts` do not change: pi's code compares what it compares today, and `pi.values` keeps its
meaning (where pi stands beside the entry's own *fields*).

### 5.4 Three examples

`GET /api/v1/entries/anthropic/claude-opus-5-5`, `data.entry.providers_dev.safe.cache_long`. The two runs through
CLIProxyAPI of 2026-11-04 are in `lifetimes` with `chosen: false` and feed nothing:

```json
{
  "value": 3600, "unit": "seconds", "at_least": false, "scope": null, "window_tokens": null,
  "source": "measured", "date": "2026-11-17", "agreement": "agree",
  "sources": [
    { "source": "measured", "value": 3600, "withheld": false, "at_least": false, "below": 3900, "scope": null, "date": "2026-11-17",
      "evidence_url": "https://github.com/ngvoicu/groundtruth/blob/main/results/direct-2026-11-17/an-opus-1h-2026-11-17T12-22-44.json",
      "client": "direct", "client_label": "Requests sent straight to the provider", "client_kind": "direct", "evaluation_id": "direct-2026-11-17/an-opus-1h" },
    { "source": "models.dev", "value": 3600, "withheld": false, "at_least": false, "below": null, "scope": null, "date": "2026-11-21",
      "evidence_url": null, "client": null, "client_label": null, "client_kind": null, "evaluation_id": null },
    { "source": "pi.dev", "value": 3600, "withheld": false, "at_least": false, "below": null, "scope": null, "date": "2026-11-20",
      "evidence_url": null, "client": null, "client_label": null, "client_kind": null, "evaluation_id": null }
  ]
}
```

`GET /api/v1/entries/openai-codex/gpt-6.1-sol`, `…safe.input_window`. A login whose limit no own client measured,
so the proxy's evaluation counts; the last four keys of the two catalogs' items, all `null`, are left out here:

```json
{
  "value": 921500, "unit": "tokens", "at_least": true, "scope": "input", "window_tokens": 1050000,
  "source": "measured", "date": "2026-11-17", "agreement": "differ",
  "sources": [
    { "source": "measured", "value": 921500, "withheld": false, "at_least": true, "below": 922300, "scope": "input", "date": "2026-11-17",
      "evidence_url": "https://github.com/ngvoicu/groundtruth/blob/main/results/logins-2026-11-17/limits-codex.jsonl",
      "client": "cliproxyapi", "client_label": "Requests sent through CLIProxyAPI", "client_kind": "proxy", "evaluation_id": null },
    { "source": "models.dev", "value": 922000, "withheld": false, "at_least": false, "below": null, "scope": "input", "date": "2026-11-21", "evidence_url": null },
    { "source": "pi.dev", "value": 500000, "withheld": false, "at_least": false, "below": null, "scope": "window", "date": "2026-11-20", "evidence_url": null }
  ]
}
```

The measurement and models.dev agree (922,000 lies between the accepted and the refused size); pi's 500,000 is
contradicted by an accepted input of 921,500.

`GET /api/v1/entries/deepinfra/moonshotai/Kimi-K3`, `…safe.cache_short`, the same four keys left out:

```json
{
  "value": null, "unit": "seconds", "at_least": false, "scope": null, "window_tokens": null,
  "source": "providers.dev", "date": "2026-11-17", "agreement": "differ",
  "sources": [
    { "source": "providers.dev", "value": null, "withheld": true, "at_least": false, "below": null, "scope": null, "date": "2026-11-17", "evidence_url": "https://docs.deepinfra.com/chat/prompt-cache-retention" },
    { "source": "models.dev", "value": 300, "withheld": false, "at_least": false, "below": null, "scope": null, "date": "2026-11-21", "evidence_url": null }
  ]
}
```

### 5.5 The list of entries

`/api/v1/entries` gains, since the lists of the website show safe values and sort by what they show:

- the sort key `input_window`: by `safe.input_window.value`, `null` last in either order;
- the parameter `min_input_window` (integer): entries whose safe input window is at least this; unknown does not
  match;
- the parameter `disagree` (boolean): `true` keeps the entries whose `safe.differing` is not empty, `false` the
  others.

`sort=max_output` and `min_output` read `max_output` of the summary and so follow the safe value (section 6).
`sort=context` and `min_context` stay on `limit.context`.

---

## 6. What changes for a client of 1.3.0

**Version: 1.4.0.** Properties, components, an enumerated value, a sort key and two parameters are added. Nothing
is removed, renamed or retyped; no property becomes nullable or absent. (`measured_s`, `measured_tokens` and the
keys beside them are nullable already.)

**Added**

| what | where |
|---|---|
| `safe` | `providers_dev` of every entry; every entry summary |
| components `SafeValues`, `SafeValue`, `SourceValue`, `SafePrice`, `PriceStatement`, `PriceTier` | the OpenAPI document |
| the value `pi.dev` of `source` | `InputWindow.source`, `SafeLifetime.source` |
| `client_kind` | every cache evaluation, limit evaluation, item of `input_window.measurements` and item of `cache_lifetime.lifetimes` |
| `chosen` | every item of `input_window.measurements` and of `cache_lifetime.lifetimes` |
| `sort=input_window`; `min_input_window`; `disagree` | `GET /api/v1/entries` |

**Changed in meaning, same type.** The safe value follows the rule of section 2, where it was "the documented
value unless a measurement clearly contradicts it", and "measured" is the most direct measurement, where it was the
lowest across every client:

| field (entry and summary) | what a client sees |
|---|---|
| `input_window.tokens`, `bound`, `scope`, `basis`, `source`, `date` | the measured value wherever a measurement that counts exists, a lower bound included; pi's where no other source states one. Today: 2 values become measured lower bounds just under the documented figure, 3 unknown ones get pi's, and on 2 more entries the number stays and `basis` becomes `measured` |
| `cache_lifetime.{short,long}.safe_s`, `basis`, `source`, `date` | the measured lifetime wherever a measurement that counts exists. "Never above `documented_s`" no longer holds as a rule. Today: 3 values fall, 4 rise from 0, 3 become unknown, and `basis` becomes `measured` on 28 more profiles with the same number |
| `date` of a measured value, in both records | the date of the evaluation that gives the value, where it was the newest evaluation counted |
| `measured_tokens` and the other `measured_*` keys, `clients`, `evaluations` of the input window; `measured_s`, `clients`, `evaluations`, `checks`, `hits`, `checks_inside`, `hits_inside`, `tested_from_s`, `first_miss_s` of a lifetime profile | over the evaluations of the kind that counts, where they were over every client. Today: `measured_s` changes on 6 profiles and becomes `null` on 6; `measured_tokens` becomes `null` on 9 entries. `measurements` and `lifetimes` still list every client, each item with `client_kind` and `chosen` |
| `basis: "documented"` | "stated by a source, not measured": providers.dev, models.dev or, now, pi.dev. `source` says which |
| `documented_status` | still whether the measurement contradicts the documented value; no longer which of the two is the safe value. For a lifetime the test is that of 2.5. Today 2 profiles go from `not_contradicted` to `contradicted`, and 3 profiles and 9 input windows to `null`: only a proxy measured them |
| `pricing`, `price_in`, `price_out` | the safe price. Equal to today's on every entry; pi's whole price where no other source states one, which is the case on no entry today |
| `max_output` of a summary | the safe maximum output, where it was `limit.output` as published. Today: 0 becomes `null` on 456 entries (a limit of 0 states nothing), and 5 entries get pi's figure. `limit.output` of the full entry is unchanged |
| `sort=cache_short`, `sort=cache_long`, `sort=max_output`, `sort=price_in`, `sort=price_out`, `lifetime_basis`, `min_output` | follow the fields they read |
| `input_window_min`, `input_window_max`, `input_window_reference` of a model | follow the entries' input windows |

**Unchanged:** every other field, every path, `providers_dev.pi` (its `values` and `differences` included), `limit`,
`cost`, `/api/v1/meta`, `/api.json` in its shape.

**The changelog text** (README, "One contract", and the guide of the OpenAPI document):

> 1.4.0 added `safe` to every entry (`providers_dev.safe`) and every summary: for the input window, the maximum
> output, the short and the long cache lifetime and the price, the safe value, the source it is from
> (`measured`, `providers.dev`, `models.dev`, `pi.dev`, in that order: the first that states a value gives it),
> whether the sources agree, and what each source states, with its date. It added the components `SafeValues`,
> `SafeValue`, `SourceValue`, `SafePrice`, `PriceStatement` and `PriceTier`, the value `pi.dev` of `source` in the
> input window and lifetime records, the sort key `input_window` and the parameters `min_input_window` and
> `disagree`, and `client_kind` and `chosen` on evaluations and measured items. With it the rule of the safe value
> changed: `input_window.tokens` and `cache_lifetime.*.safe_s` are the measured value wherever providers.dev
> measured one, where before they were the documented value unless a measurement clearly contradicted it. The
> measurement that counts is the most direct one: on an API-key entry requests sent straight to the provider, on a
> login the vendor's own client and, where there is none, a proxy; the `measured_*` keys and `measured_s` follow it.
> `pricing` is the price of one source, whole; `max_output` of a summary is the safe maximum output;
> `documented_status` says whether the measurement contradicts the documented value and no longer which of the two
> is the safe value.

---

## 7. The OpenAPI document

The shape is described once, in `src/core/contract.ts`, and the OpenAPI document and the field tables of
`/docs/api/` are generated from it, as today.

- `SourceValueSchema`, `SafeValueSchema`, `PriceTierSchema`, `PriceStatementSchema`, `SafePriceSchema` and
  `SafeValuesSchema` are strict objects with the keys of 5.1, each `satisfies` its type, and join `COMPONENTS`.
  `SafeValueSchema` is one component used four times; the quantity's meaning is in the description of its key in
  `SafeValuesSchema`. The descriptions carry the sentences of sections 2.3 to 2.6 in short: what a source states,
  the order, the refinement, when two statements contradict.
- `EntryExtensionSchema` gains `safe: SafeValuesSchema` after `limits`; `EntrySummarySchema` gains `safe` after
  `input_window`. `limitSource` and `lifetimeSource` gain `pi.dev`.
- `CacheEvaluationSchema`, `MeasuredLimitSchema`, `InputWindowMeasurementSchema` and `CacheLifetimeItemSchema` gain
  `client_kind` (the enum of `ClientKind`, nullable) as their last key; the last two gain `chosen` (boolean) after
  it.
- The descriptions of the fields of section 6 are rewritten to say what they are now; each of them names the key of
  `safe` it copies. No description says "unless an evaluation contradicts it" any more.
- `src/core/openapi.ts`: `info.version` `"1.4.0"`; the sentence that counts the steps gains "then 1.4.0"; the guide
  gets one section, **Safe values**, with the rule of section 2 in full, and the paragraphs of the guide on the
  cache lifetime record and on the input window keep what they say of the records and point to it for the rule.
- `src/core/query.ts`: `SORT_KEYS` gains `input_window`; `PARAMS` gains `min_input_window` and `disagree`.
- `structure/api-v1.json` by `npm run structure:update` in the same commit; `structure/api-v1-1.0.0.json` is not
  touched.

---

## 8. The pages

Purpose and data only; the look is the frontend designer's. Everything comes from
`GET /api/v1/entries/{provider}/{model}` (`entry`, `summary`) and the lists' own requests.

**Three rules for every page:**

1. **A quantity is shown as its safe value and nothing else**: `value` of its key of `safe`, formatted; "at least"
   where `at_least`; "Unknown" where `value` is `null`. No basis, no source name, no date and no second figure in
   the cell, with one exception: the note under the context window, below.
2. **The warning is `agreement: "differ"` and nothing else.** The page compares no numbers. Its tooltip prints
   `sources` of that quantity, item by item, in the API's order.
3. **A page works nothing out**, as before: which rows warn is `differing`, which price rows warn is `differs`.

**The words.** They are proposed here; the final words are the designer's and the owner's.

| what | words |
|---|---|
| the warning's name, also for a screen reader | Not all sources agree |
| the row and the tile of `safe.input_window`; the lists' column | Context window |
| the note under it, where `window_tokens` is not `null` | `window_tokens`, formatted: "1,050,000 including the answer" |
| a source in the tooltip | `Measured`, `providers.dev`, `models.dev`, `pi.dev` |
| a tooltip line | the source, its value formatted as the cell's, its date: `models.dev: 922,000 tokens · 2026-11-21` |
| a measured line | it names the measurement, from `client_kind` and `client_label`: `Measured, direct: 1 hour · 2026-11-17`; `Measured, OpenAI's Codex CLI: 5 minutes · 2026-11-07`; `Measured, through CLIProxyAPI: at least 921,500 tokens · 2026-11-17`. It links to `evidence_url`, the raw result |
| a withheld value | `providers.dev: unknown`, linked to `evidence_url` |
| `providers.dev` with a value | linked to `evidence_url` |
| a lifetime of 0 | None, whatever the source |
| no value | Unknown |

The tooltip must be reachable without a mouse and on a touch screen: a `title` attribute alone is not enough.

**The entry page, topic by topic:**

| topic | rows | each row shows | under the table |
|---|---|---|---|
| Limits | Context window; Maximum output | `safe.input_window`, with the note from its `window_tokens`; `safe.max_output` | the limit evaluations, as today's table "Measured" |
| Price | the base charges of `summary.pricing`, as today (Input, Output, Reasoning output, Cache read, Cache write and each charge the price has beyond them); then the conditional rates, as today | the rate. The warning on the rows Input, Output, Cache read and Cache write where `safe.price.differs` has `input`, `output`, `cache_read`, `cache_write`; on the conditional rates where it has `tiers` or `other`. The tooltip prints that part of every item of `safe.price.sources`; for `tiers`, each source's list | request controls, as today |
| Prompt caching | Cache lifetime, short; Cache lifetime, long | `safe.cache_short`, `safe.cache_long` | per profile the measured items with their results by age and their evaluations, as today, those that feed the value (`chosen`) first and the others marked as not counted; then Cache modes and Retention, as today |

**One window.** The row is labelled "Context window" and shows the safe input window: the most a conversation can
be, 922,000 on `openai/gpt-6.2-astra`. Where the entry states a larger window that the answer shares
(`window_tokens`, 1,050,000 there), a short note under the value says so. There is no row "Input window" and no
second window figure. The page does not compare the two numbers: the note is there exactly where the API publishes
`window_tokens`. In the API the quantity keeps its name, `input_window`.

A price is printed with every digit the API states (`usdUnrounded`), in a row and in a tooltip. On a subscription
entry the line "API list prices of …" stays: it says whose price the table is.

**What becomes of today's parts of the entry page:**

| today | becomes |
|---|---|
| the five tiles | tiles of the safe values, with the same warning. The tiles "Input window" and "Context window" become one, "Context window", showing the safe input window and the note |
| "Input window" table (documented, measured, status rows) and the table "Documented" (Context window, Largest input, Maximum output, each with its source) | the Limits table. `limit.input` is not shown, and `limit.context` only as the note: they are statements about the input window, and the tooltip prints them where sources differ |
| the basis tags, "Documented …, contradicted", "Measured …" under a value | gone |
| pi's lines under values ("pi agrees", "pi says X", "pi states X", "pi lists X, not compared"), pi's tier table | gone. pi's figure is in the tooltip where it contradicts another source; where pi alone states the value, it is the value |
| the documented rows of the lifetimes table, with source and date | gone; the measured items and evaluations stay as the evidence under the two rows |
| "Source: models.dev …" under the price table | gone |
| the head's source marks | stay, as the sources of the entry with their dates. The count "N differ" beside pi.dev goes: the warnings are on the values |
| "How pi calls the model" | stays as it is: what only pi returns |
| Provenance (corrections with their evidence, inherited fields), Data | stay. A correction's link is here on every entry it touches, also where no warning shows |

**The lists** (home page, a provider's page, a model's page): each cell prints the safe value of its quantity from
`summary.safe` (input window, maximum output, price in and out, the two lifetimes), with the warning where that
quantity is in `safe.differing`. The basis under a number goes. The two columns "Input window" and "Context"
become one, "Context window", showing the safe input window; it sorts by `input_window`, and the filter "Minimum
context window" reads `min_input_window`. Whether a list cell carries the note is the designer's. The column
"Source" keeps the entry's sources and dates, without pi's count.

**The methodology** gets one section in place of today's rules for the two safe values and of pi's standings: the
five quantities, the four sources and their order, which measurement counts (the most direct one, by kind of
client and kind of entry), what counts as a statement, the refinement, when two sources contradict, what the
warning means, and that "Context window" on a page is the input window.

---

## 9. pi-cache-keeper

The extension reads summaries of `/api/v1/entries`. Unchanged, 0.6.1 already receives the new safe values through
the fields it reads today, the ones that are pi's own included. Three changes:

1. **`factsOf` reads `safe`**: `safe.input_window.value` and `.at_least` (for `window`, `windowAtLeast`),
   `safe.max_output.value`, `safe.cache_short.value`, `safe.cache_long.value`, and `pricing` through `costOf`
   as today: `pricing` is the safe price, whole, with its tiers and its write price per lifetime. Where an answer
   has no `safe` object, it reads the fields it reads today.
2. **A safe value whose `source` is `pi.dev` is not taken** (for the price: `safe.price.source`). It is pi's own
   catalog value, as of providers.dev's last import. Written into `models.json` it would pin that copy over the
   value pi itself ships, and keep it when pi corrects it.
3. **The saved data is read again once.** `DataStore` gains `reading?: number`; `fetchDataset` treats saved facts
   as incomplete unless `reading` is the extension's current number (2), and the store is saved with it. The
   store's `version` stays 1, so `written`, which says which overrides are the extension's own, is kept.

`costOf`, `mergeFacts`, `desiredOverride`, `planOverrides` and the rules of what is written (the window replaces,
or only raises where "at least"; a lifetime, an output limit and a price fill what pi lacks) do not change.

**What its users see differently**, all from the data of section 3:

- a shorter keep-warm period on OpenRouter's Claude Opus with the long lifetime (30 minutes for 60) and on two
  OpenRouter entries with the short one;
- no lifetime any more on three OpenRouter entries that only the proxy measured: one had 150 seconds, two had "no
  safe lifetime";
- on the ChatGPT-plan login, GPT-6.1 Sol and Terra get a short lifetime of 5 and 30 minutes where they had "no
  safe lifetime", and on Devin two models get 2 hours and 15 minutes: the vendor's own client held that long. A
  pi user is not on the vendor's client (section 13, new point 3);
- on the same login a window "at least 921,500" and "at least 920,870" for 922,000, which raises pi's window as
  before.

`/cache-keeper` prints the same line. Release: **0.8.0**, after the site is live (0.7.0 is another release, a stop
command and notices).

---

## 10. The notes left from the last review

| note | here |
|---|---|
| a cache price printed rounded ($0.0833 for 0.083333; 48 such prices) | fixed: every price of an entry page is printed unrounded (section 8) |
| Vercel Grok Voice's limits of 0 shown as "0 tokens" | fixed by the rule: a limit of 0 states nothing; the rows show pi's 4,096, the one statement |
| "pi lists $10, not compared" under "$10" on subscription entries | fixed: pi's lines are gone, and pi states no price on a subscription entry |
| the flag label "Tools added or removed" | fixed in `src/core/pi-words.ts`: `supportsMidConvoToolAdditions` "Tools added after the conversation has started", `supportsMidConvoToolChanges` "Tools changed after the conversation has started" |
| a coherent but contradictory `agrees` | not fixed in the fence, and no longer shown: the warning and the tooltip come from pi's numbers, read by the reference's code, and no page prints a `standing`. Such a block stays possible inside `providers_dev.pi`, as section k says of every well-formed wrong part: the fence does not judge what pi says of the world. `tests/safe.test.ts` (case 12) holds pi's verdicts and the reference's reading equal on the fixtures |
| the price-tier table's "This entry" row taken from pi's copy of the entry's tiers | fixed: the table is gone, and the tiers of models.dev in the tooltip are the reference's own reading (2.6) |

---

## 11. Tests and proofs

### `tests/safe.test.ts` (new), the rule

1. One case per source being the first to state, for a number quantity and for the price; nothing stated gives
   `value: null`, `source: null`, `agreement: "none"`.
2. A limit of 0, an absent field and `null` state nothing, for models.dev and for pi; a lifetime of 0 and a listed
   price of 0 are statements; pi's price of 0 is none.
3. Measured, which evaluations count (2.3), for a window, an output and a lifetime: on an API-key entry a `direct`
   evaluation gives the statement and a `proxy` one beside it changes nothing; an API-key entry with only `proxy`
   or `own_client` evaluations has no measured statement and its safe value is the next source's; on a login
   `own_client` wins over `proxy` whichever is lower, `proxy` gives the statement where no `own_client` evaluation
   gives the quantity a value, and the choice is made per quantity and per profile; within the kind, the lowest
   of several evaluations and clients; access `unknown` is read as `api`; a client without a kind feeds nothing.
   The statement names the evaluation: client, label, kind, date, id, raw result; among equal values the newest.
   A bracket gives `at_least` and `below`; a lower bound under a larger stated value is the safe value and `agree`.
4. The refinement: a named window above a stated cap gives the cap, `source: "models.dev"`, `agree`; a named window
   below a stated cap gives the window, `differ`.
5. Agreement, one case per row of 2.5, both ways; for a lifetime: `S < m`, `S ≥ f`, `m ≤ S < f`, `f` null.
6. Withheld: an override of `null` and one of `"$delete"` give `value: null`, `source: "providers.dev"`, `differ`
   beside models.dev's value, and pi does not fill it; with a measurement, the measurement is the safe value.
7. providers.dev: a correction that changes the reading states; one that does not (another field, a redundant one)
   states nothing; an added entry's own value states; `evidence_url` and `date` are the newest evidence's.
8. Price: whole from one source (a part pi alone states is in no rule of `pricing`); a correction of one price gives
   `source: "providers.dev"` with models.dev's uncorrected price beside it and `differs` naming the part; a
   subscription entry carries the API entry's statements and none of pi's; `pricingOfPi` gives rules that
   `priceParts` reads back as pi's numbers.
9. The ten sentences of 5.1 and the copies of 5.2, over every entry of the fixture build; `chosen` is `true` on
   exactly the items of the kind `countingKind` gives, and the `measured_*` keys and `measured_s` are those of the
   measured item of `safe`.
10. `layPi`: on every entry, `withoutPi(layPi(x, s)) = x`; a value another source states is deep-equal before and
    after; `agreement` moves only as section 4 says; a block without statements changes nothing.
11. `piStatements` is total: for every block the fault tables of `tests/pi-fence.test.ts` publish, it returns and
    fits its schema.
12. The two readings agree: on the fixtures, for `max_tokens` and the five price parts, the reference finds a
    contradiction between pi and the entry exactly where `pi.values` says `differs`.

### The fence (`tests/pi-fence.test.ts`)

The tables keep their rows. Added: a fault inside `piStatements` (thrown, and a misfit) ends turned away, with 0
objects differing from the build without pi; the "does not promise" rows gain one: a block with a wrong number on a
value no other source states is published, `source` `pi.dev`, and no value another source states differs. The
healthy build differs from the build without pi in exactly the keys section 4 names.

### The contract, the structure, the query

`tests/contract.test.ts` and the check of the built snapshot pass with `safe` on every entry and summary;
`tests/api-structure.test.ts` passes with the new record and no break against 1.0.0; `tests/api.test.ts`:
`info.version` is `1.4.0`, `sort=input_window`, `min_input_window` and `disagree` do what 5.5 says. The labels file
without a `kind` on a client fails the build like every authored file that does not fit; a measurements file that
states a kind is read, with and without the labels file agreeing (`tests/resolve.test.ts`, `tests/sync.test.ts`).

### The pages (`tests/pages.test.ts`, `tests/render.test.ts`)

One entry page for each of: every quantity `single`; a `differ` on each of the five quantities; a withheld value; a
value from pi alone; `at_least`; a subscription entry; a dataset without pi's data; an entry with `window_tokens`
and one without; an entry with evaluations that are not `chosen`. The window's row is labelled "Context window",
shows `safe.input_window.value`, and carries the note exactly where `window_tokens` is not `null`; a measured
tooltip line names the client. For each: every figure on the
page, tooltips included, is in the API answers it was drawn from; a warning is there exactly where the API says
`differ`; no cell names a source or a basis; no pi line is left; a price is unrounded. `rowHtml` of every summary
shows the safe values and the warnings of `safe.differing`.

### pi-cache-keeper

`factsOf` on summaries with `safe`: each quantity; `pi.dev` not taken, for a number and for the price; `at_least`;
an answer without `safe` read as before; a store without `reading` is fetched again and keeps `written`.

### The proofs on the built data

- **The intended changes and no other.** Two builds on the same `data/`, `main` and the branch. With `safe` taken
  off and the fields of 5.2 and 6 set aside, 0 objects differ. The fields set aside are listed by path with counts,
  and the counts are those of sections 3 and 6: 5 safe values lower, 4 higher, 3 unknown and 8 filled, each with
  its entry, 456 `max_output` from 0 to `null`, `basis` to `measured` on 4, 25 and 6, `documented_status` to
  `contradicted` on 2 and to `null` on 12, `measured_s` changed on 6 profiles and `null` on 6, `measured_tokens`
  `null` on 9.
- **Without pi.** With `data/pi/` absent, in a copy of the data folder: the branch's build equals its build with
  pi after `withoutPi` on both, 0 differing objects; 8 values are `null` that pi fills; 11 entries have a warning.
- **The tables of sections 1 and 3**, reproduced from the built data.
- No test asserts a count of the real data (section k, 4): the tables are shown in the task's result.

---

## 12. The steps

Each is one task on the branch, `npm run check` green at its end, reviewed before `main`. No data folder is edited
by hand and the API only grows.

| step | who | what | must hold afterwards |
|---|---|---|---|
| D1 | a worker | the rule without pi: the kind of every client (`kind` in `data/authored/measurement-labels.yaml`, `clientKind`, the import accepting a kind in the measurements file, `client_kind` and `chosen`), `src/core/safe.ts` (`countingKind`, `safeValues`, `mirror`), the two readings in `resolve.ts`, `limits.ts` and `cache.ts` no longer choosing, `priceParts`, the summary, the query, the contract, the OpenAPI document at 1.4.0, the structure record, `tests/safe.test.ts` cases 1 to 9 | every `sources` without a pi item; the proof "the intended changes" less pi's 8 values; the tables of sections 1 and 3 as they are without pi (11 warnings); the sizes of the index before and after |
| D2 | a worker | pi as the last source: `piStatements`, the fence's statements, `layPi`, `withoutPi`, `pricingOfPi`, the comparison script, cases 10 to 12 and the fence rows; `README.md`, `AGENTS.md` and the sentences of section 14 | the three proofs of section 11 in full, with the script's whole output; the fence tables: rows before and after, every fault fired |
| P1 | the frontend designer | the entry page, the lists, the tooltip, the words, the methodology, `pi-words.ts` | the same `dataset_version` before and after; the page tests; a screenshot of `anthropic/claude-opus-5-5` (a proxy evaluation not counted), `openai/gpt-6.2-astra` (the note under the context window), `openai-codex/gpt-6.1-sol`, `openai-codex/gpt-6.2-astra`, `deepinfra/moonshotai/Kimi-K3`, `deepseek/deepseek-v4-pro`, an entry with differing tiers, a subscription entry, and the home page, each with a tooltip open |
| K1 | a worker | pi-cache-keeper 0.8.0 (section 9), on top of its 0.7.0, its README and changelog | its tests; a run against the branch's API served locally |
| R1 | the reviewer | site and extension, on one build | the proofs redone; the pages against the API |
| L1 | the chief | the site to `main`, which deploys; the live API answers 1.4.0 with `safe`; then the extension's release | `total` of `/api/v1/entries?disagree=true` is the number of entries with a warning in that day's build |

D1 and D2 are not deployed apart: the pages of `main` read the copied fields and keep working on the branch, but
the release is one.

---

## 13. What is decided, and what is new to decide

**Decided by the owner on 2026-11-22**, and designed so above:

| point of the first version | decided |
|---|---|
| 1. several clients give the lowest measured value | **replaced**: the most direct measurement that exists (2.3) |
| 2. one window on the site | **changed**: one window, labelled "Context window", showing the input window, with a note where the total is larger (section 8) |
| 3. no source and no date on a value without a warning | yes |
| 4. values only pi states are shown unmarked | yes |
| 5. a withheld value warns | as designed |
| 6. a lifetime warns on one missed check inside what a source states | as designed: 6 measured warnings today |
| 7. `documented_status` of a lifetime follows that test | as designed: 2 profiles change |
| 8. `max_output` of a summary becomes the safe value | as designed |
| 9. the parameter `disagree` | as designed; a filter for it on the home page is the designer's and the owner's |
| 10. the versions | API 1.4.0; pi-cache-keeper **0.8.0** |
| 11. the words of section 8 and the two flag labels | the designer's and the owner's |

**New, from the three changes.** Each is designed one way above; the other way is said with what it costs.

1. **The note's number is a published key, `safe.input_window.window_tokens`.** The owner's note appears "where the
   total context differs", and a page compares nothing. So the API says where: the entry's `limit.context`, where
   it is above the safe input window (448 entries). It is one nullable key on the new object; `input_window` stays
   the safe quantity and `limit.context` stays where it is. The other way keeps the API without it and lets the
   page compare `context` of the summary with the value: a second thing a page works out, beside stale dates, to
   be written into `AGENTS.md`.
2. **Whether an entry is an API-key entry or a login is its `providers_dev.access`**; `unknown` is read as an
   API key. Every evaluation of today agrees with it (section 1). The other way: groundtruth declares it per
   route, and the site then needs a second fact that can contradict the entry's own access.
3. **On a login the vendor's client decides, also where it held longer than every other client.** Four short
   lifetimes rise from 0 (section 3). On `openai-codex/gpt-6.1-terra` the published 30 minutes is what Codex CLI
   held; a coding agent through the proxy held 15, and plain requests through it missed at 2.5 minutes. A reader
   who is not on the vendor's client, a pi user among them, finds the other clients in `lifetimes`, not in the
   safe value. This is the rule as decided; it is said here because pi-cache-keeper reads only the safe value.
4. **The order with groundtruth.** Today the import reads `clients` of `observed.json` as a map of texts. A kind
   that arrives by turning those texts into objects makes a site that does not have D1 yet refuse the file: it
   keeps the last good measurements and the `Publish` run fails. A kind in a key of its own is tolerated already.
   So: groundtruth adds a new key, or publishes after D1 is live. D1's reader accepts both forms. Until the file
   has the field, the labels file's `kind` decides, and afterwards it stays as the fallback for a client the file
   does not classify.
5. **Fifteen measured values wait for a direct measurement** (section 3): 9 input windows, 5 short and 1 long
   lifetime of OpenRouter entries. Three of them are unknown until then. Nothing to decide; a list for
   groundtruth.
6. **`date` of a measured safe value is the date of the evaluation that gives it**, where it was the newest
   evaluation counted. It follows from naming the measurement (decision 8).

**Where the owner's wish is not met as said:**

- "Safe is what we measured" holds with one refinement: a window the route names does not replace a documented cap
  on the input inside it (no entry today, since the two it was written for were measured through the proxy).
- "We never say measured or documented" holds on the pages. The API says the source of every value: the tooltip
  prints it, and pi-cache-keeper needs it.
- "Cache keeper always reads the safe value" holds except for a safe value that is pi's own (section 9, point 2).
- "The API is unchanged here" holds but for the one key of point 1 above.
- pi as the last fallback costs one sentence of the fence's promise (section 4). The simpler way, pi never a safe
  value, keeps that sentence and leaves 8 values unknown; `design/pi-merged.md` section 5 argued for it, on the
  ground that pi's figure for a login is a client's window.

---

## 14. The sentences of earlier documents that change

Applied in step D2. Each earlier design gets one paragraph at its top that says which of its sections this document
replaces; its text is not rewritten.

1. **`design/safe-cache-lifetime.md`**: section 4.1 (the rule and "contradicted"), decisions 11 and 12, and
   section 9 (what a page prints) are replaced by sections 2 and 8 here; decision 2 and the last sentence of 3.3
   ("the lowest across clients") by 2.3 here: the lowest within the kind that counts. Sections 2, 3 and 5 stay
   otherwise: the record, the strict value of one evaluation, the documented items.
2. **`design/usable-input-window.md`**: section 4.1 (the value), decision 3 as a rule for the value, section 3.4
   and decision 6 ("the lowest client decides"), and section 10 are replaced. Sections 3.1 to 3.3 and 4.2 stay:
   what an evaluation gives, and the test, now the test of agreement.
3. **`design/pi-merged.md`**: section 5 ("pi's data does not contribute to the safe values") and section 7 (pi's
   lines on the page) are replaced. Sections 2, 3 and 8 stay: `values`, and that pi's value is never written into
   `limit` or `cost`.
4. **`design/pi-source.md`, section k**: the sentence of the promise named in section 4 here; `PiOfBuild.entries`
   carries `statements`; the README's sentence on a build without pi's data.
5. **`AGENTS.md`**:
   - "An entry page states values and their sources" becomes: an entry page states the safe value of each quantity,
     in the same tables and rows on every entry, and a warning where its sources contradict each other; it names no
     source in a cell.
   - "Wording: the two sources are named `models.dev` and `providers.dev`" becomes the four names of section 8.
   - "Each source carries its own date" stays for the head of a page and holds in the tooltip.
   - The two paragraphs on `cacheLifetime` and `inputWindow` become one: the safe value of every quantity is
     worked out once, in `safeValues` (`src/core/safe.ts`), by one order of sources, and copied by `mirror`; a page
     prints `safe` and applies no rule.
   - "pi's values stand third … never written into … a safe value" becomes: pi's values stand last; they are never
     written into a field of the entry, and a safe value is pi's only where no other source states one, laid on by
     `layPi` after the fence.
   - "A measurement never replaces a documented value on an upstream entry" stays: `limit`, `cost` and
     `capabilities` are untouched.
   - "A measurement names the client it went through" gains: every client has a kind (`direct`, `own-client`,
     `proxy`), from the measurements file or `data/authored/measurement-labels.yaml`, where a new client must be
     added with its kind; which kind feeds a safe value is decided once, in `countingKind`.
   - New: a page labels the safe input window "Context window"; the API's name for it stays `input_window`.
6. **`README.md`**: the paragraphs of "API" on the lifetime record and the input window record, the opening
   sentence on where a measured value takes the place of a documented one, "One contract" (1.4.0, the text of
   section 6), and the paragraph on `measurement-labels.yaml` (a client's `kind`).
