# The input window: how much input a request can carry on an entry

Design, 2026-11-16 (task LWL-01). Nothing here is built. The owner's decisions it starts from are in section 1;
the questions it left open were decided on 2026-11-16, as recommended, and are in section 13; the design is written
to those decisions. `AGENTS.md` and `README.md` stay the rules of the data and the contract;
`design/safe-cache-lifetime.md` is the pattern this follows: a value worked out once in the data build, published
with its basis, printed by the pages.

Numbers and examples are from the dataset the local preview served on 2026-11-16: `dataset_version`
`44f1435184e4b01c`, built from commit `49b1dd9`, models.dev import of 2026-11-15 (commit `c18a3cf`), `observed.json`
sha256 `4ce313b6…` (groundtruth `798c409`): 332 providers, 6,105 entries, 17 limit evaluations on 17 entries.

## 1. What is published

Every entry gets one record, `providers_dev.limits.input_window`, and every summary the same object as
`input_window`. Its first key, `tokens`, is the answer to "how much input can a request carry on this entry": the
number a client should take as its input budget on this provider and access method. It is `null` where that is not
known. The rest of the record says what the number rests on.

The rule, in one paragraph (section 4 has it exactly):

- Where an input limit or a context window is documented for the entry, that is the value, unless a measurement on
  the entry clearly contradicts it. Then the value is the measured one.
- Where nothing is documented, the value is the measured one: the window the route itself names, or else the largest
  input it was seen to accept, which is a lower bound and is published as one (`bound: "at_least"`).
- Where several clients were measured, the lowest decides.
- Where nothing is known, it is `null`. A window of 0 on an image or audio model is "none stated", so `null`.

The owner's decisions this starts from (2026-11-16, through the chief):

| # | Decision |
|---|---|
| O1 | providers.dev publishes the window a client should use on a route: on every entry, `null` where it is not known, never invented. |
| O2 | A login entry's values are measured on the login, not copied from the API entry. |
| O3 | He expects 922,000 for the GPT-6 models on the ChatGPT-plan login. Section 8 says what the rule gives for each of the four, and why two of them get 915,011. |
| O4 | As for cache lifetimes: the documented value is the published one unless a measurement contradicts it; otherwise the strict measured value; nothing known is `null`. |

Additive only. No field that exists today changes its value or its meaning: `limit` of an imported entry stays
models.dev's, `limit.context` and `limit.output` of an added entry stay what a measurement stated, and
`limits.measured`, `limits.from_measurement` and the six limit keys of a summary stay as they are. The record is one
new key in `providers_dev.limits` and one new key in the summary; a limit evaluation gets one new key, `input_read`
(section 3.3).

### The name

The brief calls it the "usable input window". The methodology page already uses "usable context" for something
else, and says it is not published: the window less the system prompt and tools of the client in use. This value is
not that: it is what the route accepts, counted as the provider counts, the client's own prompt included. So the key
is `input_window` and the pages say "Input window" (decision 5 of section 13).

## 2. The record

### 2.1 Types

In a new file, `src/core/limits.ts`:

```ts
export type LimitSource = "providers.dev" | "models.dev";

/** One counted limit evaluation, read for the input window. */
export interface InputWindowMeasurement {
  client: string;
  client_label: string;
  route: string;
  route_label: string;
  date: string | null;
  tokens: number;
  bound: "limit" | "at_least";
  kind: "window" | "bracket" | "accepted";
  accepted: number | null;
  refused: number | null;
  named: number | null;
  read: number | null;
  source: string;
}

/** `providers_dev.limits.input_window` of an entry and `input_window` of a summary. */
export interface InputWindow {
  tokens: number | null;
  basis: "documented" | "measured" | "none";
  bound: "limit" | "at_least" | null;
  scope: "input" | "window" | null;
  source: LimitSource | null;
  date: string | null;
  documented_tokens: number | null;
  documented_field: "limit.input" | "limit.context" | null;
  documented_source: LimitSource | null;
  documented_date: string | null;
  documented_status: "contradicted" | "not_contradicted" | null;
  measured_tokens: number | null;
  measured_bound: "limit" | "at_least" | null;
  measured_kind: "window" | "bracket" | "accepted" | null;
  measured_refused: number | null;
  measured_date: string | null;
  clients: number;
  evaluations: number;
  measurements: InputWindowMeasurement[];
}
```

`ModelExtension.limits` becomes `{ measured, from_measurement, input_window }`. `Summary` gets
`input_window: InputWindow`, after `max_output`. It is the same object in both places.

### 2.2 `InputWindow`, key by key

All numbers are tokens, as the provider counts them.

| Key | Type | Meaning |
|---|---|---|
| `tokens` | integer > 0, or null | The most input a request can carry on this entry, by the rule of section 4. It is `documented_tokens` or `measured_tokens`, and `basis` says which. Null = not known. Never 0. |
| `basis` | `documented` \| `measured` \| `none` | `documented`: `tokens` is `documented_tokens`. `measured`: `tokens` is `measured_tokens`. `none` exactly when `tokens` is null. |
| `bound` | `limit` \| `at_least` \| null | `limit`: the value is the limit, as documented or as the route names it. `at_least`: the value is the largest input seen accepted; the real limit is this or more. Null with `none`. A documented value always has `limit`. |
| `scope` | `input` \| `window` \| null | What kind of figure the value is. `input`: a figure for the input alone (`limit.input`, or an input size a measurement saw accepted). `window`: a context window, input and output together (`limit.context`, or a window the route names): the response is counted against the same figure. Null with `none`. |
| `source` | `providers.dev` \| `models.dev` \| null | Who the value is from. `measured`: always `providers.dev`. `documented`: `documented_source`. Null with `none`. |
| `date` | `YYYY-MM-DD` or null | `measured`: `measured_date`. `documented`: `documented_date`. Null with `none`, and where the source has no date. |
| `documented_tokens` | integer > 0, or null | The documented input of the entry (section 3.1). Null = none is documented. |
| `documented_field` | `limit.input` \| `limit.context` \| null | The field of the entry it is read from. Null with `documented_tokens`. |
| `documented_source` | `providers.dev` \| `models.dev` \| null | `models.dev` for an imported value; `providers.dev` for a correction and for a value in an entry providers.dev added (section 3.2). |
| `documented_date` | `YYYY-MM-DD` or null | The import date for `models.dev`; the newest evidence date for `providers.dev`. |
| `documented_status` | `contradicted` \| `not_contradicted` \| null | What the rule found, set where a value is documented and at least one evaluation counts. `contradicted`: `tokens` is `measured_tokens`. `not_contradicted`: `tokens` is `documented_tokens` (not contradicted is not confirmed). Null in every other case. |
| `measured_tokens` | integer > 0, or null | The measured value of the entry: the lowest `tokens` of `measurements`. Null = no evaluation counts. |
| `measured_bound` | `limit` \| `at_least` \| null | The `bound` of the measurement that gives `measured_tokens`. |
| `measured_kind` | `window` \| `bracket` \| `accepted` \| null | Its `kind` (2.3). |
| `measured_refused` | integer > 0, or null | Its `refused` where its kind is `bracket`: the smallest input it saw refused. The limit is below this. Null otherwise. |
| `measured_date` | `YYYY-MM-DD` or null | Its `date`. |
| `clients` | integer ≥ 0 | How many different clients `measurements` has. 0 = not measured. |
| `evaluations` | integer ≥ 0 | How many items `measurements` has: the limit evaluations of the entry that count (3.3). |
| `measurements` | list | One item per counted evaluation, the one that gives `measured_tokens` first (2.4). `[]` = none. |

The five `measured_*` keys, `clients`, `evaluations` and `measurements` describe what was measured whatever the
`basis`: an entry whose value is the documented one still shows the measurement beside it.

Which case applied is read from these keys:

| Case | `basis` | `documented_tokens` | `measured_tokens` | `documented_status` |
|---|---|---|---|---|
| Documented, not measured | `documented` | a number | null | null |
| Documented, measured, not contradicted | `documented` | a number | a number | `not_contradicted` |
| Measured, because the documentation was contradicted | `measured` | a number | a number, = `tokens` | `contradicted` |
| Measured, nothing documented | `measured` | null | a number, = `tokens` | null |
| Nothing known | `none` | null | null | null |

### 2.3 `InputWindowMeasurement` (`measurements[]`), key by key

One item is one limit evaluation of the entry (`limits.measured[]`) that counts for the input window, with the value
it gives. An evaluation is one route, one client, one model (section 9, requirement 1).

| Key | Meaning |
|---|---|
| `client`, `client_label`, `route`, `route_label`, `date`, `source` | As on the evaluation in `limits.measured[]`: who sent the requests, on which access, when, and the raw result. |
| `tokens` | The value this evaluation gives (3.3). |
| `bound` | `limit` for kind `window`; `at_least` for `bracket` and `accepted`. |
| `kind` | `window`: the route's own answer named its context window. `bracket`: an input was accepted and a larger one refused; the value is the accepted one. `accepted`: an input was accepted, the reply showed it was read to the end, and nothing was refused or named. |
| `accepted` | `input_accepted` of the evaluation: the largest input seen accepted. Null = none recorded. |
| `refused` | `input_refused`: the smallest input seen refused. Null = none. |
| `named` | `context` of the evaluation: the window the route names. Null = it named none. |
| `read` | `input_read`: the largest input the reply showed was read to the end. Null = not checked. |

### 2.4 Order

`measurements` is ordered by `tokens` ascending; then `limit` before `at_least`; then by `client`, `route`, `date`
and `source` as text, in plain character order, null first, never by the locale. The first item is the one the five
`measured_*` keys describe. No part of the order depends on the order of the input.

### 2.5 The record in full

`openai-codex/gpt-6.1-sol` (example 1 of section 7): an input limit documented, one evaluation, not contradicted.

```json
"input_window": {
  "tokens": 922000, "basis": "documented", "bound": "limit", "scope": "input",
  "source": "models.dev", "date": "2026-11-15",
  "documented_tokens": 922000, "documented_field": "limit.input",
  "documented_source": "models.dev", "documented_date": "2026-11-15",
  "documented_status": "not_contradicted",
  "measured_tokens": 915011, "measured_bound": "at_least", "measured_kind": "bracket",
  "measured_refused": 922500, "measured_date": "2026-11-13",
  "clients": 1, "evaluations": 1,
  "measurements": [
    { "client": "cliproxyapi", "client_label": "Requests sent through CLIProxyAPI",
      "route": "codex-subscription", "route_label": "ChatGPT plan through the Codex login",
      "date": "2026-11-13", "tokens": 915011, "bound": "at_least", "kind": "bracket",
      "accepted": 915011, "refused": 922500, "named": null, "read": null,
      "source": "https://github.com/ngvoicu/groundtruth/blob/main/results/limits-2026-11-13/limits.jsonl" }
  ]
}
```

The other cases, without `measurements` (lines starting with `//` are notes):

```jsonc
// measured, a lower bound, nothing documented: openai-codex/gpt-6-astra (example 3)
{ "tokens": 915011, "basis": "measured", "bound": "at_least", "scope": "input",
  "source": "providers.dev", "date": "2026-11-11",
  "documented_tokens": null, "documented_field": null, "documented_source": null, "documented_date": null,
  "documented_status": null,
  "measured_tokens": 915011, "measured_bound": "at_least", "measured_kind": "bracket",
  "measured_refused": 922500, "measured_date": "2026-11-11", "clients": 1, "evaluations": 1 }

// measured, the window the route names: claude-subscription/claude-opus-5-5 (example 6)
{ "tokens": 1000000, "basis": "measured", "bound": "limit", "scope": "window",
  "source": "providers.dev", "date": "2026-11-08",
  "documented_tokens": null, "documented_field": null, "documented_source": null, "documented_date": null,
  "documented_status": null,
  "measured_tokens": 1000000, "measured_bound": "limit", "measured_kind": "window",
  "measured_refused": null, "measured_date": "2026-11-08", "clients": 1, "evaluations": 1 }

// documented as a window, not measured: anthropic/claude-opus-5-5 (example 9)
{ "tokens": 1000000, "basis": "documented", "bound": "limit", "scope": "window",
  "source": "models.dev", "date": "2026-11-15",
  "documented_tokens": 1000000, "documented_field": "limit.context",
  "documented_source": "models.dev", "documented_date": "2026-11-15",
  "documented_status": null,
  "measured_tokens": null, "measured_bound": null, "measured_kind": null,
  "measured_refused": null, "measured_date": null, "clients": 0, "evaluations": 0 }

// nothing known: 354 entries
{ "tokens": null, "basis": "none", "bound": null, "scope": null, "source": null, "date": null,
  "documented_tokens": null, "documented_field": null, "documented_source": null, "documented_date": null,
  "documented_status": null,
  "measured_tokens": null, "measured_bound": null, "measured_kind": null,
  "measured_refused": null, "measured_date": null, "clients": 0, "evaluations": 0, "measurements": [] }
```

### 2.6 What always holds

A test checks these on every entry (task 3).

1. `basis` is `none` ⇔ `tokens` is null ⇔ `bound`, `scope` and `source` are null ⇔ `documented_tokens` and
   `measured_tokens` are both null.
2. `basis` is `documented` ⇒ `tokens` = `documented_tokens`, `bound` is `limit`, `source` = `documented_source`,
   `date` = `documented_date`, and `scope` is `input` for `limit.input` and `window` for `limit.context`.
3. `basis` is `measured` ⇒ `tokens` = `measured_tokens`, `bound` = `measured_bound`, `source` is `providers.dev`,
   `date` = `measured_date`, and `scope` is `window` for kind `window` and `input` for the other two.
4. `documented_tokens` is null ⇔ `documented_field`, `documented_source` are null. It is what section 3.1 reads from
   the entry's own `limit` and `limits.from_measurement`.
5. `measured_tokens` is null ⇔ `measurements` is `[]` ⇔ `evaluations` is 0 ⇔ `clients` is 0 ⇔ the other four
   `measured_*` keys are null. Otherwise the five `measured_*` keys are `tokens`, `bound`, `kind`, `date` of
   `measurements[0]` and its `refused` where its kind is `bracket`.
6. Every item of `measurements` is what section 3.3 gives for exactly one evaluation of `limits.measured`, and every
   evaluation that counts has exactly one item.
7. `documented_status` is not null ⇔ `documented_tokens` and `measured_tokens` are both not null. Then it is
   `contradicted` ⇔ `basis` is `measured`, and `not_contradicted` ⇔ `basis` is `documented`; and it is what the test
   of 4.2, redone from `measurements`, finds.
8. Where `documented_tokens` is not null and `measured_tokens` is null, `basis` is `documented`. Where
   `documented_tokens` is null and `measured_tokens` is not, `basis` is `measured`.
9. On an item: `accepted` < `refused` where both are set; `accepted` ≤ `named` and `read` ≤ `accepted` where both
   are set; kind `window` ⇒ `tokens` = `named`; kind `bracket` ⇒ `tokens` = `accepted`; kind `accepted` ⇒
   `tokens` = `read`.

## 3. What the rule reads

### 3.1 The documented input of an entry

Read from the entry's own `limit`, as published (models.dev's value after providers.dev's corrections; on an entry
providers.dev added, what its provider file states):

```
if limit.input is a number above 0:                                   documented = limit.input,   field = limit.input
else if limit.context is a number above 0
        and "context" is not in limits.from_measurement:              documented = limit.context, field = limit.context
else:                                                                  documented = null
```

- **`limit.input`** is models.dev's "Maximum input tokens" (its README; `LimitV2` in its `schema-v2.ts` has three
  optional numbers, each 0 or more, and no other definition). 813 entries state one. On 371 it is below
  `limit.context`, on 438 equal to it, on 4 the context is 0. It is never above the context.
- **`limit.context`** is models.dev's "Maximum context window (tokens)": input and output together. Where no
  `limit.input` is stated, nothing documents a separate cap on the input, so the input can fill the window and the
  response comes out of it. That is `scope: "window"`, and a client that wants room for a reply takes it off itself.
  4,931 entries are read this way.
- **0 is not a value.** models.dev's schema allows 0 and gives it no meaning. In the data, `limit.context` is 0 on
  339 entries, all models without a token window: 120 image, 98 video, 60 speech, 48 transcription, 7 realtime, 4
  decision, 2 chat. It stands for "none stated", not for "accepts no input": publishing 0 would tell a client that
  the model takes nothing. So a 0 is skipped, in `limit.input` as in `limit.context`. Four of those entries state an
  input all the same (`limit.input` 4,500 on four listings of Qwen Image 3.0 Pro, the size of its text prompt) and
  get it; the other 335 get null. Unlike the cache record, where 0 means "documented as not caching", this record
  has no 0.
- **A value copied from a measurement is not documentation.** On an entry providers.dev added, `resolve` writes a
  measured window into `limit.context` and names it in `limits.from_measurement`. Such a value is read as a
  measurement (3.3), not here. Four entries today.
- **Nothing is read from another entry.** An added entry that names an API entry (`inherited.from`) takes no limit
  from it (decision O2, and the rule in `AGENTS.md`). Section 8 has the one place where this decides a number.
- A field that an override publishes as unknown (`null`) or removes (`"$delete"`) is absent, and the reading goes on
  to the next line.

### 3.2 The source and date of the documented value

For the field read, `F` (`limit.input` or `limit.context`):

1. If `providers_dev.provenance` has a correction whose `path` is `F` or `limit`: `providers.dev`, and the newest
   evidence date of those corrections.
2. Else, if the entry's `origin` is `added`: `providers.dev`, and the newest date of the entry's published evidence
   of any kind, or null. (A limit in a provider file is usually what the vendor's own list says, which is evidence of
   kind `listed`; the cache record leaves `listed` out because a model list says nothing about caching.) No added
   entry states a limit in its file today.
3. Else: `models.dev`, and the import date (`upstreamDate` of `resolve`), or null where the build has none.

### 3.3 What one limit evaluation gives

The input is the entry's published limit evaluations, `providers_dev.limits.measured`, nothing else, so a reader can
redo every value from the API answer alone. For that, an evaluation gets one more published key, `input_read`
(tokens, or null), beside the ones it has.

For one evaluation, with `n` = `context`, `a` = `input_accepted`, `r` = `input_refused`, `v` = `input_read`, each a
number or null:

```
if n is not null and (r is null or r > n):    kind = "window",   tokens = n, bound = "limit"
else if a is not null and r is not null:      kind = "bracket",  tokens = a, bound = "at_least"
else if v is not null and r is null:          kind = "accepted", tokens = v, bound = "at_least"
else:                                         the evaluation does not count
```

What each line means, and why:

- **`window`: the route named its window.** `context` on an evaluation is the number the route's own answer gives
  (requirement 4 of section 9): "prompt is too long: 1010190 tokens > 1000000 maximum", "exceeds the model's context
  window of 1048576 tokens". That is the route stating its limit, exactly, on the access measured, and it is what
  `resolve` already publishes as the measured `limit.context` of an added entry. It is a window: input and output
  together. The accepted input beside it (`accepted`) shows how near the window an input was seen to go; where there
  is none, only the name is known.
- **`bracket`: accepted below a refusal.** The limit is at least `a` and below `r`. The strict value is `a`, the
  largest input seen accepted, and it is published as a lower bound. A refusal at or below a named window
  (`r ≤ n`) is a cap on the input under the window, so this line applies and the name does not.
- **`accepted`: accepted, nothing refused.** A size that was answered shows only that the route did not refuse it.
  It does not show that the model read it: Devin's `swe-2` answered requests of 930,000 tokens and gave no answer
  to a request of 250,000 that needed both ends of its input (section 5). So an accepted size with no refusal and no
  named window gives a value only up to `input_read`, the largest input for which the reply showed it was read to
  the end. Without `input_read` such an evaluation does not count. A bracket needs no such check: the refusal shows
  the route measures the input and where it stops taking it.
- **Does not count:** a refusal with nothing accepted (nothing shows the refusal was about size; Devin's refusals
  say only "There is an issue with this request"); an accepted size with no refusal, no named window and no read
  check; an evaluation of the output alone. It stays in `limits.measured` and in `/api/v1/evaluations/limits`, is in
  no item of `measurements`, and the build reports it (`limit-not-counted`, a notice, section 6).

All 17 evaluations of today count: 13 of kind `window`, 4 of kind `bracket`, none of kind `accepted`.

### 3.4 Several evaluations on one entry

The measured value of the entry is the lowest value of its counted evaluations:

```
measured_tokens = min(tokens of measurements)        the other measured_* keys: those of that item (2.4)
```

As for cache lifetimes (decision 2 there): the value has to hold for a consumer whose client is not known, and a
client can have a window of its own. Codex's own client works with 272K and 500K windows on a login that accepts
about 922K. Each client's value is published in `measurements`, so a consumer of another client reads its own line.

What this costs, as it does for cache lifetimes: a second client that was walked less far lowers the value. An
`at_least` of 500,000 from a short walk beside a window of 1,000,000 named to another client gives 500,000. The cure
is in the measuring, not in the rule: a client is added to the file once it was walked to its end. No entry has two
evaluations today.

## 4. The rule

### 4.1 The value

With `documented_tokens` (3.1) and the measurements (3.3, 3.4):

```
if documented_tokens is not null and it is not contradicted:
    tokens = documented_tokens,  basis = "documented",  bound = "limit",
    scope by documented_field,   source and date of the documentation
else if measured_tokens is not null:
    tokens = measured_tokens,    basis = "measured",    bound = measured_bound,
    scope by measured_kind,      source = "providers.dev", date = measured_date
else:
    tokens = null,               basis = "none",        bound, scope, source, date = null

documented_status = "contradicted" or "not_contradicted" as the test of 4.2 found,
                    where documented_tokens and measured_tokens are both not null; else null
```

`inputWindow` applies the test once and sets `basis` and `documented_status` from that one result.

### 4.2 Contradicted

With `D` = `documented_tokens`. The documentation is contradicted when at least one counted evaluation shows the
limit clearly somewhere else. Any one of these, on any one item of `measurements`:

| # | What the evaluation shows | Test |
|---|---|---|
| a | The route names a window below the documented value | `named` is not null and `named < D` |
| b | The route names another window than the documented one | kind `window`, `documented_field` is `limit.context`, and `named ≠ D` |
| c | An input clearly below the documented value was refused | kind `bracket` and `100 × refused ≤ 99 × D` |
| d | An input clearly above the documented value was accepted | kind `bracket` or `accepted`, and `100 × tokens ≥ 101 × D` |

Why "clearly" has a margin in c and d, and none in a and b:

- A named window is the route's own number. Two exact numbers that differ, differ.
- A refused size is not. A provider counts the tokens of a request it answers and reports them; it reports nothing
  for one it refuses, so `refused` is the probe's own count. And routes add tokens of their own: Devin's answers
  count about 390 tokens more than the probe sent. A documented limit is a round figure that a route enforces a few
  hundred tokens under. With no margin, a finer walk would mark more and more correct documentation as contradicted,
  each by a few tokens, and replace a documented 922,000 by whatever size the walk stopped at.
- The margin is 1 % of the documented value: for 922,000, a refusal at or below 912,780, or an accepted input of
  931,220 or more. It was set so (decision 1 of section 13). The one evaluation that sits inside it is
  in section 8.

How the test reads in each case the brief names:

| Case | The rule |
|---|---|
| A refusal above the documented value | Does not contradict. It is what the documentation says. `openai-codex/gpt-6.1-sol`: refused at 922,500, documented 922,000. |
| A refusal at or just below it | Does not contradict inside the margin: the documented value stays, with the measurement beside it. |
| A refusal well below it | Contradicts (c). The value is the accepted size of the lowest client, `at_least`. |
| An accepted input below the documented value | Does not contradict, however far below: the walk stopped there. |
| An accepted input above it | Inside the margin: nothing. At 101 % or more: contradicts (d), and the value is the measured one, `at_least`. An accepted size counts here only as 3.3 lets it: below a refusal, or read to the end. |
| A limit named by an error | Exact (a, b). Below the documented value it always contradicts. Above a documented `limit.input` it does not: a window can be larger than the input cap inside it. `openrouter/openai/gpt-6.1-sol`: window 1,050,000 named, input 922,000 documented. |
| An accepted size with no refusal | A lower bound: `at_least`, kind `accepted`, and only up to `input_read` (3.3). It contradicts only by d. |
| Several clients | Per evaluation. One contradicting evaluation is enough, and the value is then the lowest client's (3.4). |
| An inconclusive measurement | Is no evaluation, or one that does not count (section 5). It contradicts nothing and gives nothing. |

What follows:

- Where the documentation is contradicted, `measured_tokens` is not null: every counted evaluation gives a value.
- "Not contradicted" is not "confirmed". A walk that stopped at 400,000 does not contradict 922,000. `measurements`
  says how far it went.
- Differently from cache lifetimes, a measurement can raise the value (d). There, a hit after the documented
  lifetime is luck. Here, an input accepted and read above the documented maximum means the maximum is wrong, and
  the case the owner started from is of this kind: a client told 500,000 on a login that takes 922,000 (decision 3).
  Nothing is raised today.

### 4.3 Every entry with a documented value and a counted evaluation

All ten, on the dataset of this document. All `not_contradicted`.

| Entry | `documented_tokens` | From | Measured | `tokens` |
|---|---|---|---|---|
| `openai-codex/gpt-6.1-sol` | 922,000 | `limit.input` | bracket: 915,011 accepted, 922,500 refused | **922,000** documented |
| `openrouter/openai/gpt-6.1-sol` | 922,000 | `limit.input` | window named: 1,050,000 | **922,000** documented |
| `openrouter/openai/gpt-6.1-terra` | 922,000 | `limit.input` | window named: 1,050,000 | **922,000** documented |
| `openrouter/anthropic/claude-haiku-5.5` | 1,000,000 | `limit.context` | window named: 1,000,000 | **1,000,000** documented |
| `openrouter/anthropic/claude-opus-5.5` | 1,000,000 | `limit.context` | window named: 1,000,000 | **1,000,000** documented |
| `openrouter/anthropic/claude-sonnet-5.5` | 1,000,000 | `limit.context` | window named: 1,000,000 | **1,000,000** documented |
| `openrouter/deepseek/deepseek-v4.1-flash` | 1,048,576 | `limit.context` | window named: 1,048,576 | **1,048,576** documented |
| `openrouter/google/gemini-4-argon` | 1,048,576 | `limit.context` | window named: 1,048,576 | **1,048,576** documented |
| `openrouter/meta/muse-wonder` | 1,048,576 | `limit.context` | window named: 1,048,576 | **1,048,576** documented |
| `openrouter/moonshotai/kimi-k3.1-pro` | 1,048,576 | `limit.context` | window named: 1,048,576 | **1,048,576** documented |

## 5. An inconclusive measurement publishes nothing

Devin's `swe-2` (`groundtruth/results/limits-2026-11-13/README.md`): Devin's list gives it 262,000; requests of up to
930,000 tokens were answered; a request that needed both ends of its input got no answer even at 250,000. Nothing
there says how much input the model uses.

- It is not in `observed.json`, and it should stay out (requirement 6 of section 9): a row with
  `input_accepted: 930000` would also put 930,000 into `measured_input_accepted` of the summary, which says "the
  real limit is at least this".
- If such a row is written all the same, the rule gives it nothing: no refusal, no named window, no `input_read`, so
  it does not count (3.3), and the build says so.
- `devin/swe-2` has nothing documented either, so its record is `tokens: null`, `basis: "none"`.

## 6. Where it is computed and how it reaches every answer

```
data/sources/observed.json ─┐
data/upstream/, authored/  ─┴─▶ resolve() step 5: limits.measured, limits.from_measurement   (as today, + input_read)
                                resolve() step 6, per entry
                                  input_window = inputWindow(model.limit, from_measurement, measured, sourceOf)
                                  providers_dev.limits = { measured, from_measurement, input_window }
                                        │
        buildIndex() / summarize() ─────┤  summary.input_window = providers_dev.limits.input_window
                                        ▼
        data/published/  (catalog.json, api.json, entries/, index.json)  ──▶  every API answer, every page
```

Three pure functions in `src/core/limits.ts`. No file, no network, no clock; the file also runs in the browser.

- `documentedInput(limit: unknown, fromMeasurement: readonly string[]): { tokens: number; field: "limit.input" | "limit.context" } | null`
  is section 3.1.
- `windowMeasurement(evaluation: MeasuredLimit): InputWindowMeasurement | null` is section 3.3; null = the evaluation
  does not count.
- `inputWindow(limit: unknown, fromMeasurement: readonly string[], measured: readonly MeasuredLimit[], sourceOf: (field: "limit.input" | "limit.context") => { source: LimitSource; date: string | null }): InputWindow`
  makes the items, puts them in order (2.4), applies the test of 4.2 once and fills the record. `sourceOf` is 3.2;
  `resolve` passes it, because only `resolve` knows the corrections and the import date.
- `emptyInputWindow(): InputWindow` is the record of an entry nothing is known about, for the tests and helpers.

The 1 % margin is two named constants in that file, used by the test of 4.2 and by nothing else.

How it reaches each answer:

| Where | How | Change |
|---|---|---|
| `providers_dev.limits.input_window` of a full entry | `resolve.ts` step 6 adds the key to `limits` | `resolve.ts`, `limits.ts`, `schema.ts` |
| `input_window` of a summary | `summarize` in `src/core/entries.ts` copies it from the entry | `entries.ts` |
| `/api/v1/entries`, `/entries/{provider}/{model}`, `/providers/{id}`, `/models/{lab}/{model}`, `/catalog`, `/api.json` | They pass summaries and entries on as published | none in `api.ts` |
| `input_read` of a limit evaluation, also in `/api/v1/evaluations/limits` | `resolve.ts` step 5 copies it from the row | `schema.ts`, `resolve.ts`, `contract.ts` |
| `/api/v1/openapi.json`, the tables of `/docs/api/` | Generated from `src/core/contract.ts`; the guide text is in `src/core/openapi.ts` | `contract.ts`, `openapi.ts` |

In `contract.ts`: `InputWindowMeasurementSchema` and `InputWindowSchema` (strict objects, each `satisfies` its type,
described with the meanings of 2.2 and 2.3), `input_window` in the `limits` object of `EntryExtensionSchema` and in
`EntrySummarySchema`, `input_read` in `MeasuredLimitSchema`, and the components `InputWindow` and
`InputWindowMeasurement` in `COMPONENTS`.

What the build reports:

| Code | Level | When |
|---|---|---|
| `limit-not-counted` | notice | A limit evaluation states something about the input (`input_accepted` or `input_refused`) and gives no value by 3.3. Target: `provider/model#limits`. An evaluation of the output alone is not reported. |

What is refused where the measurements file is read, by the sync and by the build, naming the row, the last good
copy staying (as a run with the same age twice is, decision 30 of the cache design): two `limits` rows with the same
route, client and model; a row whose `input_accepted` is not below its `input_refused`; one whose `input_accepted`
is above its `context`; one whose `input_read` is above its `input_accepted`, or set without it. Today's file passes
all four.

Versions: `dataset_version` changes with the data. `schema_version` stays 1 and `api_version` stays `v1`. The
`version` of the OpenAPI document goes from 2.0.0 to 2.1.0: keys are added, none removed.
(2026-11-16: the version restarted at 1.0.0 with the first public release; README.md, One contract.)

Size, before gzip: the record of an entry nothing is known about is 361 bytes, in the catalog and in the index, so
about 2.2 MB more in each of `catalog.json` (24.6 MB today) and `index.json` (18.2 MB). The assets served are the
gzip files (939 KB and 485 KB today); nearly every record is one of three shapes and compresses to very little.

## 7. Worked examples

Each from the dataset `44f1435184e4b01c`. To see one: `/api/v1/entries/<ref>`, `data.entry.limit` and
`data.entry.providers_dev.limits`. "Import" is the models.dev import of 2026-11-15.

**1. `openai-codex/gpt-6.1-sol`: documented, a bracket around it → 922,000 documented.**
Starts from: imported `limit` = context 1,050,000, input 922,000, output 128,000. One evaluation, CLIProxyAPI on the
ChatGPT-plan login, 2026-11-13: `input_accepted` 915,011, `input_refused` 922,500.
`documented_tokens` = 922,000 from `limit.input`. The evaluation is a bracket: 915,011, `at_least`. Test c: 100 ×
922,500 = 92,250,000 against 99 × 922,000 = 91,278,000: not at or below. Test d: 91,501,100 against 101 × 922,000 =
93,122,000: not at or above. Not contradicted → **922,000**, documented, `limit`, scope `input`, `models.dev`,
2026-11-15; `measured_tokens` 915,011 `at_least`, `measured_refused` 922,500 beside it. The record of 2.5.

**2. `openai-codex/gpt-6.1-terra`: documented, no evaluation in the file → 922,000 documented.**
Starts from: the same imported `limit`; `limits.measured` is empty. → **922,000**, documented, `documented_status`
null. A walk on this login exists and is not in the file: section 8.

**3. `openai-codex/gpt-6-astra`: nothing documented, a bracket → 915,011 measured, at least.**
Starts from: an entry providers.dev added from the measurement, with no `limit` (models.dev lists only Sol and
Terra for `openai-codex`); `inherited.from` is `openai/gpt-6-astra`. One evaluation, CLIProxyAPI, 2026-11-11:
`input_accepted` 915,011, `input_refused` 922,500.
`documented_tokens` null. Bracket → **915,011**, measured, `at_least`, scope `input`, `providers.dev`, 2026-11-11,
`measured_refused` 922,500. Section 8 says why not 922,000.

**4. `openai-codex/gpt-6-luna`:** the same numbers, the same evaluation date, the same result: **915,011**,
measured, `at_least`.

**5. `devin/gpt-6-1-sol`: nothing documented, a bracket → 915,390 measured, at least.**
Starts from: an added entry with no `limit`; one evaluation, CLIProxyAPI on the Devin subscription, 2026-11-08:
`input_accepted` 915,390, `input_refused` 925,000; its note says "Devin's own model list says 1,000,000".
→ **915,390**, measured, `at_least`, `measured_refused` 925,000. Devin's list is not a value of the entry, so there
is nothing to mark as contradicted; had the provider file stated `limit.context: 1000000` from that list, test a
would not apply (no window was named) and test c would: 100 × 925,000 ≤ 99 × 1,000,000, contradicted, and the
value would be the same 915,390.

**6. `claude-subscription/claude-opus-5-5`: the window the route names → 1,000,000 measured.**
Starts from: an added entry; `limit` = context 1,000,000, output 128,000, both named in `limits.from_measurement`.
One evaluation, CLIProxyAPI on the Claude login, 2026-11-08: `context` 1,000,000, `output` 128,000.
`limit.context` is a measured value, so `documented_tokens` is null. Kind `window` → **1,000,000**, measured,
`limit`, scope `window`, `providers.dev`, 2026-11-08. `accepted` is null on the item: the raw file has an input of
998,953 tokens accepted, and the row does not carry it (requirement 4 of section 9).

**7. `meta-subscription/muse-wonder-1.0`: a named window with an accepted input beside it → 1,048,576 measured.**
Starts from: an added entry; `limit` = context 1,048,576, from the measurement. One evaluation, CLIProxyAPI on the
Muse Code key, 2026-11-08: `context` 1,048,576, `input_accepted` 1,047,604, `output_accepted` 1,000,000, the note
"one window shared by input and output; no separate output cap was found".
Kind `window` → **1,048,576**, measured, `limit`, scope `window`; `accepted` 1,047,604 on the item.

**8. `openai/gpt-6.1-sol`: documented, not measured → 922,000 documented.**
Starts from: imported `limit` = context 1,050,000, input 922,000, output 128,000; no limit evaluation.
→ **922,000**, documented from `limit.input`, scope `input`, `models.dev`, 2026-11-15.

**9. `anthropic/claude-opus-5-5`: a window documented, no input limit → 1,000,000 documented.**
Starts from: imported `limit` = context 1,000,000, output 128,000; no limit evaluation.
→ **1,000,000**, documented from `limit.context`, scope `window`. The response comes out of the same million.

**10. `aihubmix/gpt-image-2`: an image model with a window of 0 → null.**
Starts from: imported `limit` = context 0, output 0. Both zeros are skipped → `tokens` **null**, `basis` `none`.
Beside it, `alibaba-token-plan/qwen-image-3.0-pro`: context 0, input 4,500, output 0 → **4,500**, documented from
`limit.input`.

**11. `devin/claude-opus-5-5`: nothing known → null.**
Starts from: an added entry with cache evaluations, no `limit` and no limit evaluation. → **null**, `none`.
`devin/swe-2` is the same (section 5).

**12. `openrouter/openai/gpt-6.1-sol`: an input limit documented, a larger window named → 922,000 documented.**
Starts from: imported `limit` = context 1,050,000, input 922,000, output 128,000. One evaluation, 2026-11-08:
`context` 1,050,000 ("This endpoint's maximum context length is 1050000 tokens").
Kind `window`, 1,050,000. Test a: 1,050,000 is not below 922,000. Test b does not apply: the documented value is a
`limit.input`. Not contradicted → **922,000**, documented, with `measured_tokens` 1,050,000 of kind `window`
beside it: the route's window, which says nothing about the cap on the input inside it.

### The counts

Over all 6,105 entries:

| `basis` | Entries | Of them |
|---|---|---|
| `documented` | 5,744 | 813 from `limit.input`, 4,931 from `limit.context`; 10 with a counted evaluation, all `not_contradicted` |
| `measured` | 7 | 4 with `bound` `limit` (a named window), 3 with `at_least` (a bracket) |
| `none` | 354 | 335 with a window of 0 and no input stated; 19 that providers.dev added, with no `limit` and no limit evaluation |

### Checking a build by hand

After `npm run data`:

```
jq '."openai-codex".models."gpt-6.1-sol".providers_dev.limits.input_window' data/published/site/api.json
jq '.entries[] | select(.ref == "openai-codex/gpt-6-astra") | .input_window' data/published/site/data/index.json
jq '[.entries[] | .input_window.basis] | group_by(.) | map({(.[0]): length}) | add' data/published/site/data/index.json
jq -r '.entries[] | select(.input_window.evaluations > 0) | [.ref, .input_window.tokens, .input_window.basis, .input_window.bound, .input_window.documented_status] | @tsv' data/published/site/data/index.json
```

On the dataset of this document the third gives `{"documented": 5744, "measured": 7, "none": 354}` and the fourth 17
rows: the ten of 4.3 and the seven measured entries.

## 8. The four GPT-6 models on the ChatGPT-plan login (decision O3)

| Entry | Documented on the entry | Measured on the login | Published |
|---|---|---|---|
| `openai-codex/gpt-6.1-sol` | 922,000 (`limit.input`, models.dev) | 915,011 accepted, 922,500 refused | **922,000**, documented, not contradicted |
| `openai-codex/gpt-6.1-terra` | 922,000 (`limit.input`, models.dev) | nothing in the file | **922,000**, documented |
| `openai-codex/gpt-6-astra` | nothing | 915,011 accepted, 922,500 refused | **915,011**, measured, at least |
| `openai-codex/gpt-6-luna` | nothing | 915,011 accepted, 922,500 refused | **915,011**, measured, at least |

**Astra and Luna get 915,011, not 922,000.** The rule can only give what the entry has. models.dev lists Sol and
Terra for the ChatGPT-plan login and not Astra and Luna, so nothing is documented on those two entries. The
measurement says the limit is at least 915,011 and below 922,500. The record says exactly that: `tokens` 915,011,
`bound: "at_least"`, `measured_refused` 922,500. It is 0.76 % under the number the owner expects, and a client that
takes it as its budget is refused nothing.

**What would make it 922,000, and why that is not in the rule.** 922,000 is what OpenAI documents for the same
models at its API (`openai/gpt-6-astra` and `openai/gpt-6-luna`: `limit.input` 922,000), and the bracket measured on
the login contains it. A further step could say: where nothing is documented on the entry, the entry names the API
entry of the same model (`inherited.from`), that entry documents a value, and a measurement on this entry brackets
that value inside the margin of 4.2 (accepted at 99 % of it or more, refused above it), publish the API entry's
value. The API would name it with a third basis, `reference`, and a key `reference_ref` (`openai/gpt-6-astra`), as
`pricing` names the API entry a subscription price is taken from. It would give 922,000 on Astra and Luna, and on
`devin/gpt-6-1-sol` too (915,390 accepted is above 912,780; 925,000 refused is above 922,000).

It is left out for three reasons:

1. It is the copy decision O2 rules out, with a check added. The number published would be the API's, not one
   measured on the login; the measurement only fails to exclude it.
2. The one fine walk on this login puts the limit under 922,000. On 8 November GPT-6.1 Terra accepted 920,870
   tokens and refused a request of size 921,875, about 921,886 tokens as the provider counts
   (`groundtruth/results/limits-2026-11-08/limits.jsonl`). So on this login the documented figure is right to about
   a tenth of a percent and not to the token. For Sol and Terra that is models.dev's statement about this very
   route, kept inside the margin. For Astra and Luna it would be providers.dev asserting it.
3. On Devin it is plainly not the same limit for a client: Devin puts about 390 tokens of its own in front.

It is not taken (decision 2 of section 13). The step adds one basis and one key and changes no other,
so it could be added later.

**Two ways to a higher number that need no new rule.** A finer walk on Astra and Luna: Terra's took six accepted
requests to reach 920,870, and the published value would then be about that. And models.dev: the day it lists Astra
and Luna for `openai-codex` with `limit.input` 922,000, as it lists Sol and Terra, the entries are imported ones and
the rule gives 922,000, documented, not contradicted.

**Terra's walk is the case the margin decides.** The owner took its row out of `observed.json` on 15 November
(groundtruth `9ac70e3`: "keep the documented 922,000 input limit"). Under a test with no margin that row would mark
the documentation as contradicted, by 114 tokens, and publish 920,870. Under the test of 4.2 it does not contradict
(921,875 is above 912,780), the value stays 922,000, documented, and the row can be published beside it:
`measured_tokens` 920,870, `at_least`, `measured_refused` 921,875 (decision 4).

## 9. What the measurements file has to carry

The measuring is someone else's work, in groundtruth. These are requirements on `limits` rows of `observed.json`,
which the site reads as they are. Requirement 2 is the only one today's 17 rows do not meet.

1. **One row per route, client and model.** A new measurement of the same three replaces the row. A file with two
   is refused when read (section 6).
2. **`input_refused` in tokens, counted like `input_accepted`.** Today `input_accepted` is the provider's count of
   the largest request it answered, and `input_refused` is the size the probe asked for, in filler words: 922,500
   on the Codex login is about 922,511 tokens (11 more), 925,000 on Devin about 925,390 (390 more), and on a Claude
   route one filler word is two tokens. Write the provider's count where the refusal states it; otherwise the
   probe's size converted with the tokens per word and the overhead seen on the accepted requests of the same walk.
3. **A row with `input_refused` has `input_accepted` from the same walk.** A refusal with nothing accepted under it
   does not show that the size was the reason, and does not count.
4. **`context` only where the route's own answer names the number**, in an error or otherwise. A window from a
   vendor's model list or documentation is not a measurement; it stays in `note`. With it, one more request just
   under the named window, so that the row has `input_accepted` beside `context` (the Muse Wonder row has; the three
   Claude-login rows have the request in the raw file, 998,953 tokens accepted, and not in the row; the nine
   OpenRouter rows have none). On a route whose input cap is under its window, that request is refused, and the row
   then has `input_refused` and reads as a bracket.
5. **`input_read`, new, optional.** Tokens: the largest input for which the reply showed that the route read it to
   the end (a word placed before the filler and one after it, both returned, as in the second half of the `swe-2`
   run). Never above `input_accepted`. It is what gives a value to an accepted size with no refusal and no named
   window; with a refusal or a named window it is welcome and changes nothing.
6. **An inconclusive measurement is not a row.** `swe-2` stays in `results/` and out of `observed.json`.
7. **`date`, new.** `YYYY-MM-DD`, the day the requests were sent. Today the site reads it out of the folder name in
   `source`, and goes on doing so where `date` is absent.

Nothing else is needed: `context`, `output`, `input_accepted`, `input_refused`, `output_accepted`, `note` and
`source` keep their meaning. Not covered: a limit that depends on a setting of the request (a beta header that
enlarges the window, say). `limits` rows carry no `options`, as cache runs do; if such a limit is measured, that is
a change to this design.

## 10. What a page prints

A page prints the record as it is. It compares nothing, takes no minimum, applies no margin and picks no source:
which value is the published one is `basis`, whether it is a lower bound is `bound`, and what the rule found of the
documentation is `documented_status`.

**The entry page, in the Limits section, above "Documented".** A sub-heading "Input window" and a table of the
kind the section has (`Limit`, `Value`, `Source`), with the same three rows on every entry:

| Row | Value | Source |
|---|---|---|
| Input window | `tokens`, exact, in tokens; "at least" before it where `bound` is `at_least`; the tag `documented` or `measured` from `basis`; under it "input alone" or "input and output together" from `scope`. Null: "Unknown". | `source` · `date`, the date marked stale as providers.dev evidence is. Null: a dash. |
| Documented | `documented_tokens` with `documented_field` in code. Under it "Documentation contradicted" or "Documentation not contradicted" from `documented_status`, the words of the cache table. Null: "Unknown". | `documented_source` · `documented_date` |
| Measured | One line per item of `measurements`: its `tokens`, "at least" where `bound` says so, and what it is from `kind`: "window named by the route", with "an input of `accepted` accepted" where set; "accepted, and `refused` refused"; "accepted and read to the end, nothing refused". Empty: "Not measured". | `client_label` · `date` · a link to `source`, per line |

The "Documented" and "Measured" tables under it stay as they are; the "Measured" table gets no column for
`input_read`, which the line above prints.

**The catalog, a provider's and a model's page.** One column, "Input", after "Context", printed as that column is:
the compact number with the exact one in the hover text, "Unknown" for null. Where `bound` is `at_least`, "≥" before
it, as the catalog writes a measured input today, and the compact number is rounded down, never up (1,047,604 is
"1.04M", not "1.05M"). The hover text says the basis, the source and the date, and for a measured value its
numbers, all from the record. The column has no sort.

With it, the "Context" column prints `context` and nothing else. Today, where no window is documented, it prints
"≥ 915K input" from `measured_input_accepted`, rounded by the page; that is the one place where a page still works
out a limit, and the record replaces it.

**The look that needs deciding** (the designer's, through the chief):

1. Whether the catalog takes an eighth column, and at which widths it shows, or whether "Input" takes the place of
   another.
2. Whether the top of an entry's page gets a fifth tile, "Input window", after "Context window" (the value, its
   tag, source and date, and the other of the two values under it, as the cache tiles have).
3. Whether a value in the catalog carries the `documented` or `measured` tag, as the cache column does, or only the
   hover text.

Nothing else is new: the table, the tags, "≥", the stale mark and the words are the ones the pages have.

**The API reference** (the guide of the OpenAPI document, a section "Input window" after "Unknown values"):

- What `tokens` is: the most input a request can carry on the entry, in tokens as the provider counts them, the
  client's own system prompt and tools included; null where it is not known; never 0.
- The rule: documented unless a measurement clearly contradicts it, else measured, the lowest across clients, else
  null; the four tests of 4.2 with the 1 % margin, in numbers.
- `bound`: `limit` against `at_least`, and that an `at_least` value is the largest input seen accepted, with
  `measured_refused` beside it where one was refused.
- `scope`: with `window`, the response is counted against the same figure; with `input`, compare `limit.context`
  and `limit.output` of the entry.
- What is read as documented: `limit.input`, else `limit.context`; 0 is "none stated"; a value named in
  `limits.from_measurement` is a measurement; nothing is taken from another entry.
- The three kinds of measurement, and what does not count.
- That `limit`, `context`, `input`, `max_output` and the `measured_*` keys of a summary are unchanged.
- The limits of the evidence, as below.

**The methodology page** (`methodology.astro`, section "Limits"):

- A bullet "Input window" with the rule in the site's words, once.
- The bullet "Measured input" rewritten for the record: the catalog's "≥" is `bound: at_least`.
- The bullet "Usable context" stays and gains a sentence: the input window is what the route accepts, not what is
  left after a client's own prompt.
- "A measured value takes the place of a documented one in one figure only" becomes two figures: the safe cache
  lifetime and the input window; the documented limit stays in `limit` and beside the value.
- The limits of the evidence, once:
  - One account per route. Another plan, region or account can have another limit.
  - Dated. A provider can change a limit the next day; the date is on every value and goes stale as all
    providers.dev evidence does.
  - A few requests. A walk costs quota for each request it gets answered, so it stops early: the real limit lies
    between the accepted size and the refused one, and `at_least` is a lower bound, by as much as that gap.
  - Where no refusal was seen, nothing shows where the limit is, only that it is not below the value.
  - A refused size is the probe's count, not the provider's.
  - Requests were short questions with filler text and a reply of a few tokens. A window that input and output
    share has less room for input when a long reply is asked for.
  - A window a route names is its total. A cap on the input inside it shows only as a refusal.
  - The documented value is models.dev's unless marked, and "not contradicted" is not "confirmed".

## 11. Sort and filter

Not in this work. The value is in every summary, so a client that wants an order or a minimum has the number, and
`sort=context` and `min_context` go on meaning `limit.context`. When wanted, they are one line each in
`src/core/query.ts`: `sort=input_window` (by `input_window.tokens`, null last in either order) and
`min_input_window` (an entry with null does not match; an `at_least` value matches by its number, which is true: the
limit is that or more).

## 12. The work, as tasks

Seven tasks in the site, in this order, each leaving `npm run build && npm run check` passing. Tasks 1 to 5 add
keys and change no existing value; task 6 is the pages. Task 7 is groundtruth's and is not blocked by the others.

**Task 1. The rule, as pure functions.** Nothing calls them yet.

- `src/core/limits.ts` (new): the types of 2.1; `documentedInput`, `windowMeasurement`, `inputWindow`,
  `emptyInputWindow` (section 6); the two constants of the margin. `MeasuredLimit` is used with `input_read`
  optional until task 2.
- `tests/input-window.test.ts` (new), with the numbers written out in the test, not read from `data/`:
  - `documentedInput`: input and context (922,000 from `limit.input`); context alone; input equal to context;
    context 0 and input 4,500; context 0 alone → null; input 0 and context 0 → null; input 0 and a context → the
    context; no `limit`; a `limit` that is not an object; `context` named in `from_measurement` → null; `input`
    with `context` named in `from_measurement` → the input.
  - `windowMeasurement`: the four kinds of row of today (window alone; window with an accepted input; bracket;
    bracket with Devin's numbers); a window with a refusal above it → `window`; a window with a refusal at or below
    it and an accepted input → `bracket`; accepted with `input_read` and nothing else → `accepted`, with `read` as
    `tokens`; accepted alone → null; refused alone → null; output fields alone → null; a named window with a refusal
    below it and nothing accepted → null.
  - `inputWindow`: examples 1, 3, 5, 6, 7, 8, 9, 10, 11 and 12 of section 7, each compared with the whole record;
    the rules of 2.6; each line of the table of 4.2: a refusal at exactly 99 % contradicts (912,780 against
    922,000) and one token above does not; an accepted input at exactly 101 % contradicts (931,220) and one token
    below does not; Terra's walk (920,870 accepted, 921,875 refused, documented 922,000) → documented, not
    contradicted; a named window below a documented `limit.input` → contradicted; a named window above a documented
    `limit.input` → not; a named window other than a documented `limit.context`, above and below → contradicted;
    an accepted size far below the documented value → not contradicted; two clients, one contradicting → measured,
    the lowest; two clients, neither contradicting → documented, `measured_tokens` the lowest; the order of 2.4 with
    a tie in `tokens`; `sourceOf` is asked with the field read, and not asked where nothing is documented; an entry
    with only evaluations that do not count → `none`, `evaluations` 0.

**Task 2. The measurements file and the evaluation.**

- `src/core/schema.ts`: `input_read` and `date` in `ObservedLimit`; the four refusals of section 6 as checks on
  `ObservedFile`; `input_read: number | null` in `MeasuredLimit`.
- `src/core/resolve.ts`, step 5: `input_read` copied; `date` from the row, else from `source` as today.
- `src/core/contract.ts`: `input_read` in `MeasuredLimitSchema`.
- `tests/helpers.ts`: `limitOf`.
- Tests: `tests/sync.test.ts` and `tests/resolve.test.ts`: each of the four refusals names the row and leaves the
  last good copy; today's `data/sources/observed.json` is read without error; a row with `date` publishes it, one
  without publishes the date of its folder; `input_read` is published, null where absent. `tests/api.test.ts`: every
  limit evaluation of the fixture and of the real snapshot has the same keys, on the entry and in
  `/api/v1/evaluations/limits`.

**Task 3. On every entry.**

- `src/core/schema.ts`: `input_window` in `ModelExtension.limits`; `limit-not-counted` in `Issue["code"]`.
- `src/core/resolve.ts`, step 6: `sourceOf` by 3.2, the call of `inputWindow`, the key in `limits`; the report.
- `src/core/contract.ts`: the two schemas, the key in `EntryExtensionSchema`, the two components.
- `tests/helpers.ts`: `extensionOf` gets the empty record.
- `tests/resolve.test.ts`: an imported entry with `limit.input` has `models.dev` and the import date; one with a
  correction of `limit.input` has `providers.dev` and the evidence date, and one with a correction of
  `limit.context` only where that is the field read; an added entry whose file states a limit has `providers.dev`
  and its evidence date; an added entry created by a measurement takes nothing from the entry it inherits from; an
  added entry with a named window has it measured and not documented; a row that does not count is in
  `limits.measured`, in no item, and reported once; `limit`, `limits.measured`, `limits.from_measurement`,
  `verified` and `origin` are as before on every entry of the fixture.
- `tests/api.test.ts`, "the contract": `same(...)` for the record and every item; the rules of 2.6 on every entry of
  the fixture and of the real snapshot (a helper `inputWindowRuleBreaks` in `tests/helpers.ts`, redoing 3.1, 3.3 and
  4.2 from the published entry alone); on the real snapshot, the counts of section 7 by `basis`; the models.dev part
  of an exported entry is equal to the import.

**Task 4. On every summary.**

- `src/core/entries.ts`: `input_window` in `Summary` and `summarize`. `src/core/contract.ts`: the key in
  `EntrySummarySchema`. `tests/helpers.ts`: `summaryOf`.
- `tests/api.test.ts`: `input_window` of a summary equals `providers_dev.limits.input_window` of the entry on the
  entry, provider, model and catalog routes; `context`, `input`, `max_output`, `measured_input_accepted`,
  `measured_input_refused` and `measured_limit_count` of every summary are what they were.

**Task 5. The contract in words.**

- `src/core/openapi.ts`: the guide section "Input window" (section 10); `version` 2.1.0.
- `README.md`: the paragraph on evaluations (two figures, not one); a paragraph in "One contract";
  `entry.input_window.tokens` in the TypeScript example.
- `AGENTS.md`, under Rules: the input window is worked out once, in `inputWindow` (`src/core/limits.ts`), into
  `providers_dev.limits.input_window` (`input_window` of a summary); a page prints it and its `measurements` as they
  are, compares nothing, takes no minimum and applies no margin; `limit` of an imported entry stays models.dev's and
  no limit is taken from another entry; null is unknown and there is no 0. The rule "A measurement never replaces a
  documented value on an upstream entry" holds: `limit` is untouched, and the documented value stays in the record.
- `tests/api.test.ts`: the OpenAPI document has the two components and the guide section.

**Task 6. The pages.** After the designer's answer to the three points of section 10.

- `src/core/render.ts`: the "Input window" table of the entry page; the "Input" column of the entry table;
  `contextCell` prints `context` only. `src/core/format.ts`: a compact number rounded down, for an `at_least` value.
  Whatever of `src/client/` and the stylesheets the column needs.
- `src/pages/reference-content/docs/methodology.astro`: section 10.
- `tests/render.test.ts`, `tests/pages.test.ts`, `tests/format.test.ts`: each row of the table for the five cases
  of 2.2; "at least" and "≥" come from `bound` and from nothing else; the labels come from `documented_status` and
  `kind`; 1,047,604 as an `at_least` value prints "1.04M"; the three rows are there on an entry nothing is known
  about; a test that the renderers read no limit from `measured_input_accepted` or `measured_input_refused` (a
  summary with those two set to null renders the same).

**Task 7. groundtruth (not in this repository).** The requirements of section 9: `input_refused` in tokens on the
four rows that have one; `input_accepted` on the three Claude-login rows; `date` on every row; `input_read` where a
read check was made; the checks of requirement 1 and of the three inconsistencies in `scripts/build_observed.py`.
And Terra's row back in (decision 4).

**Not in these tasks.** A sort or filter on the value (section 11); the `reference` step (section 8); a limit that
depends on a request setting (section 9); the vendor's own lists as values of an entry.

## 13. What was decided

The questions this design left open, each put with a recommendation. All were decided on 2026-11-16, as
recommended.

| # | Decision | Date |
|---|---|---|
| 1 | A refusal or an accepted input contradicts a documented value only clearly, with a margin of 1 % of the documented value (4.2). A window the route names is exact and has no margin. | 2026-11-16 |
| 2 | GPT-6 Astra and Luna on the ChatGPT-plan login publish the measured lower bound: 915,011, "at least", with 922,500 refused beside it (section 8). There is no `reference` step. | 2026-11-16 |
| 3 | A measurement may raise the value above a documented one: an input accepted, below a refusal or read to the end, at 101 % of the documented value or more (4.2, d). | 2026-11-16 |
| 4 | Terra's walk on the login (920,870 accepted, 921,875 refused) goes back into the measurements file and is shown beside the documented 922,000, which stays. | 2026-11-16 |
| 5 | The key is `input_window`, "Input window" on the pages, not "usable" (section 1). | 2026-11-16 |
| 6 | Where several clients were measured on one entry, the lowest decides, with each client's value in `measurements` (3.4). | 2026-11-16 |
| 7 | A measured value does not expire: it is dated, and marked stale after the published number of days, as for cache lifetimes. | 2026-11-16 |
| 8 | Vendors' own lists (Codex's 272K, 500K and 872K; Devin's 1,000,000) do not become values of the entries in this work; they stay in the notes of the evaluations. | 2026-11-16 |
| 9 | A measurements file with a doubled or inconsistent `limits` row is refused when read (section 6), as the cache design refuses a doubled age. | 2026-11-16 |
| 10 | The pages show the value as built: a column before Context with the basis under the number, and on the entry page a first tile and a table (section 10). | 2026-11-16 |

Open: none.

## 14. What the data or the contract makes awkward

1. **Two values on one login.** Sol and Terra show 922,000 and Astra and Luna 915,011, on the same login and, as far
   as measured, with the same limit. Each is labelled for what it is; the difference is whether models.dev lists the
   entry.
2. **`limit.context` beside the record.** On an imported entry with a `limit.input`, the "Context window" tile shows
   1,050,000 and the input window 922,000. Both are right; `scope` and the two labels have to carry the difference.
3. **A measured window above a documented input.** `openrouter/openai/gpt-6.1-sol` has `documented_tokens` 922,000
   and `measured_tokens` 1,050,000. The second is the route's total, by `measured_kind: "window"`; read without the
   kind it looks like a measurement that found more input.
4. **A named window is trusted as documentation is.** Where a route names 1,050,000 and caps the input at 922,000
   inside it, and nothing documents the cap, the record says 1,050,000, scope `window`. Requirement 4 of section 9
   is the cure: the request just under the window is refused, and the row becomes a bracket.
5. **"Documented" means models.dev's for 5,744 entries**, not independently checked, also for a reseller. Where it
   is wrong, the cure is a correction in `data/authored/overrides/`, or a measurement that contradicts it.
6. **`limit.input` equal to `limit.context`** on 438 entries: the record says scope `input`, and the response still
   has to fit in the same window. `scope` says what kind of figure the source gave, not how the provider adds up.
7. **`at_least` depends on where a walk stopped.** 915,011 is not a property of the login; a finer walk gives
   920,870. The value moves up as measuring goes on, and never past the refusal.
8. **The lowest client can be the least measured one** (3.4).
9. **The margin is a chosen number.** 1 % is larger than every overhead seen (11 and 390 tokens on 915,000) and
   smaller than every real difference seen (Devin's list of 1,000,000 against a refusal at 925,000 is 7.5 %).
   Nothing in the data picks 1 % over 0.5 % or 2 %.
10. **A summary's `measured_input_accepted` and `measured_input_refused` say less than the record** and stay: the
    largest accepted and the smallest refused over all evaluations, whether they count or not. A page stops reading
    them (task 6); the API keeps them, unchanged.
11. **Decision O1 is mostly the documented value.** 5,744 of 6,105 entries publish what `limit` already says; the
    record adds a number of its own on 7.
