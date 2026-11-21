# pi's values beside the entry's own: one set of values on the page

Design for the spec item PMV-01. Written 2026-11-20 against `main` at `78ead1b` with the branch `pi-no-blocks`
(`09bdb42`) on top of it, which reaches `main` before this is built. It continues `design/pi-source.md` (sections a
to k) and changes five of its sentences, listed in section 12. Where the two documents speak of the same thing, this
one decides for the entry page, for `providers_dev.pi.values` and for a difference on a subscription entry;
section k of `design/pi-source.md`, the fence, decides everything about where pi's code runs.

This document says what the software is. The spec says what work is done and in what order.

**What the owner asked**, looking at an entry where pi repeats the entry exactly: can the values be merged? His
decisions:

1. The order of sources for one value: providers.dev's own, then models.dev, then pi.
2. The merge is on the page, not in the data: the entry page shows one set of values and no longer repeats them.
3. Where no other source states a value and pi does, the value is shown, marked as pi's.
4. pi's block stays in the API.
5. The page shows what pi returns beyond the entry's values.
6. Open: can pi's data contribute to the safe values?

**Decided with the owner on 2026-11-21**, after two reviews of the page: "our measurements are highest priority,
then models.dev and then pi.dev; and if they don't match we show they dont match". **pi never takes the place of
the entry's value.** Every row and tile prints the entry's own value, or Unknown, as without pi; pi speaks only on
its line under it. Decision 3 is met there: a value only pi states is "pi states X" on that line, with pi's mark
and date (section 7).

**What this design answers, in short:**

- One rule gives every value pi can speak of a **standing**: `agrees`, `differs`, `only`, `not_compared` or
  `silent`. It is worked out once, when the data is built, and published as one new key of the pi block,
  `providers_dev.pi.values`. The page prints it and works nothing out (sections 2, 7, 8).
- A value only pi states is **not written into `limit` or `cost`**. It is an item with the standing `only`, and
  the page prints it on pi's line under that row's value, "pi states X", with pi's mark and date; the value
  itself stays the entry's (Unknown, or a limit of 0). There are ten such values today, on five entries
  (section 3).
- The fence stays as it is, sentence for sentence (section 4).
- pi's data does **not** contribute to the safe values (section 5).
- The section "pi's catalog" of the entry page keeps only what pi alone returns: how pi calls the model
  (sections 6, 7).
- The API takes a minor step, 1.3.0, for one added property and one added component (section 8).

---

## 1. What was measured

All counts: the dataset built from `main` `78ead1b` with the code of `pi-no-blocks` (`09bdb42`): models.dev
snapshot `5d7ea98`, pi revision `sha256-dd93eb27…`, `dataset_version` `ce47d4e2c00c341e`, 333 providers, 6,313
entries, 813 of them with a pi block (570 by equal ids, 243 through the alias file).

**The differences as published today.** 101 entries have at least one item in `differences` and 712 have none.
162 items: `context_window` 27, `max_tokens` 18, `cost.input` 25, `cost.output` 24, `cost.cache_read` 25,
`cost.cache_write` 0, `cost.tiers` 43 (38 with tiers on both sides, 3 where only the entry has tiers, 2 where only
pi has).

**32 of those items are not differences.** On ten subscription entries the entry's own `cost` is models.dev's 0
("in the plan") and pi lists the API price of the same model, so every price "differs":
`kimi-code-plan-cn/k3`, `k3-256k`, `k3.1-pro`, `k3.1-pro-highspeed`, `kimi-for-coding`,
`kimi-for-coding-highspeed`, `zhipuai-coding-plan/glm-5.3`, `glm-5.3-flash` (three price items each) and
`openai-codex/gpt-6.1-sol`, `gpt-6.1-terra` (three price items and the tiers each). A subscription entry is not
paid per token, and the entry page shows another entry's list price for it (`providers_dev.pricing`,
`billing: reference`). Section 2 stops comparing prices there. That leaves 130 items on 93 entries.

**The standing of every value**, by the rule of section 2, over the 813 blocks:

| field | `agrees` | `differs` | `only` | `not_compared` | `silent` |
|---|---|---|---|---|---|
| `context_window` | 781 | 27 | 5 | 0 | 0 |
| `max_tokens` | 790 | 18 | 5 | 0 | 0 |
| `cost.input` | 665 | 15 | 0 | 37 | 96 |
| `cost.output` | 666 | 14 | 0 | 37 | 96 |
| `cost.cache_read` | 587 | 15 | 0 | 37 | 174 |
| `cost.cache_write` | 100 | 0 | 0 | 96 | 617 |
| `cost.tiers` | 105 | 41 | 0 | 17 | 650 |
| `prompt_cache.short` | 4 | 0 | 0 | 0 | 809 |
| `prompt_cache.long` | 4 | 0 | 0 | 0 | 809 |

Each row adds up to 813. 615 entries have nothing but `agrees` and `silent`: on them the page says "pi agrees"
and nothing else. 98 entries have at least one `differs` or `only`.

**The values only pi states: ten, on five entries.**

| entry | what it is | `context_window` | `max_tokens` |
|---|---|---|---|
| `openai-codex/gpt-6-astra` | added by providers.dev, ChatGPT-plan login | 272,000 | 128,000 |
| `openai-codex/gpt-6-luna` | the same | 272,000 | 128,000 |
| `openai-codex/gpt-6.2-astra` | the same | 272,000 | 128,000 |
| `openai-codex/gpt-6.2-sol` | the same | 500,000 | 128,000 |
| `vercel/spacexai/grok-voice-3.0` | imported, type `realtime`, `limit` 0 and 0 | 4,096 | 4,096 |

No price is among them. The two cache-write prices pi alone states (`openai-codex/gpt-6.1-sol` 2.5,
`gpt-6.1-terra` 1.25) are on subscription entries, where a price is not compared. Tiers never fill (section 2).

**What these ten are.** On the four login entries `limit` is empty by rule: an entry providers.dev adds inherits
identity fields only, never limits, and a login entry's values are measured on the login
(`design/usable-input-window.md`, decision O2). pi's 272,000 and 500,000 are the windows the Codex client works
with, which that design names in its section 3.4 and has decided on once already: "Vendors' own lists (Codex's
272K, 500K and 872K […]) do not become values of the entries" (its decision 8). On two of the four,
providers.dev measured the login itself: an
input of 921,500 tokens was accepted and one of 922,300 refused, and the published input window is "at least
921,500, measured". So on `openai-codex/gpt-6-astra` and `gpt-6-luna` a context window of 272,000 from pi will
stand on the same page as a measured input window more than three times as large. That is what pi's catalog says
and it is shown as pi's; it is one more reason it is not written into `limit` (section 3).

**What only pi returns** (section 6): the request format on all 813; an address on 805; thinking levels on 506,
of which 40 on entries where models.dev lists no effort values; call flags (`compat`) on 735, 27 different names;
request limits (bytes, images) on 91; prompt-cache lifetimes on 4, the Anthropic entries, equal to the documented
ones.

**Input kinds and reasoning** are in the API on both sides and on the page only in pi's section, so nothing is
repeated there and no row waits to be filled. They are not part of the rule (section 11, decision 5). For the
record: pi's input kinds agree with `modalities.input` on 807 (reading every `image/*` as `image`), differ on 2,
and pi alone states them on the 4 added login entries; `reasoning` agrees on 804, differs on 5, pi alone on the
same 4.

**The numbers for the safe values** are in section 5.

The per-entry table of standings and the scripts of this recount are not in the repository; the worker's step M1
reproduces the table above from the built data (section 10).

---

## 2. The rule for one value from three sources

### The order is already in the entry

providers.dev's own value and models.dev's are merged in `resolve()`, in that order: an override, an added
entry's own value or a measured limit stands over what models.dev states, and `providers_dev.provenance`,
`origin` and `limits.from_measurement` say whose a value is. That is unchanged. **The entry's field is the value
of the first two sources.** pi is third and never changes it. So the rule only has to say where pi stands beside
the entry's field.

### The fields

Nine fields, in this fixed order. The first seven are the fields of a difference (`design/pi-source.md`,
section e), read exactly as there; two are new.

| `field` | pi's value (`P`) | the entry's value (`E`), `entry_field` | `unit` |
|---|---|---|---|
| `context_window` | `contextWindow` | `limit.context` | `tokens` |
| `max_tokens` | `maxTokens` | `limit.output` | `tokens` |
| `cost.input` | `cost.input` | `cost.text.input.price` | `usd_per_million_tokens` |
| `cost.output` | `cost.output` | `cost.text.output.price` | `usd_per_million_tokens` |
| `cost.cache_read` | `cost.cacheRead` | `cost.text.input.cache.read` | `usd_per_million_tokens` |
| `cost.cache_write` | `cost.cacheWrite` | `cost.text.input.cache.write` | `usd_per_million_tokens` |
| `cost.tiers` | `cost.tiers` | the entry's tiers by size of request, `cost.text` | `usd_per_million_tokens` |
| `prompt_cache.short` | `promptCache.short` | `providers_dev.cache.lifetime.short.documented_s` | `seconds` |
| `prompt_cache.long` | `promptCache.long` | `providers_dev.cache.lifetime.long.documented_s` | `seconds` |

A lifetime of pi's is compared with the **documented** lifetime of the profile, not with the safe value: pi's
statement is of the kind a documentation makes, and a measurement is not something pi can agree with.

### When a source states a value

| source | states a value | states none |
|---|---|---|
| providers.dev | an override that sets the field; an added entry's own value; a measured limit written into `limit` (`from_measurement`). **And an override that publishes the field as unknown or removes it** (`null`, `"$delete"`): that is providers.dev saying "unknown" on purpose | no override touches the field: models.dev's value stands |
| models.dev | the field is there: a limit above 0; a price of 0 or more (a listed 0 is a price); a documented lifetime of the profile (`documented_s` is a number, 0 included: "does not cache") | the field is absent; a limit of 0 ("none stated", as everywhere in `limit`); `documented_s` is `null` |
| pi | a limit above 0; a price above 0; a lifetime, 0 included | a limit of 0; **a price of 0** (pi's 0 is also "no price recorded"); no `promptCache`, or the key absent |

`null` is unknown and never a value: a field the entry does not have is absent or `null`, never 0.

### The standing

For one field, with `P` and `E` as above. The first line that holds decides.

| # | when | `standing` | `pi` of the item |
|---|---|---|---|
| 1 | pi states no value | `silent` | `null` |
| 2 | the field cannot be compared on this entry (below) | `not_compared` | `P` |
| 3 | the entry states no value | `only` | `P` |
| 4 | `P` equals `E` | `agrees` | `P` |
| 5 | otherwise | `differs` | `P` |

Equality is exact: limits and lifetimes are whole numbers, two prices are equal when they are the same number.
No tolerance, no percentage and no verdict on who is right, as in section e.

**Not compared**, each for a reason section e already gives or the order of sources demands:

- **a price or the tiers on an entry whose `providers_dev.access` is `subscription`.** The entry is not paid per
  token; its own `cost` is not what a request costs, and pi's price for a login is a list price too;
- a price whose side of the entry is in another unit than per million tokens (section e, rule 3);
- a cache-write price the entry keys by lifetime (rule 4);
- tiers the entry states in a form that cannot be read as tiers (rule 5);
- **a field providers.dev published as unknown or removed**: a correction with `op` `unknown` or `delete` whose
  `path` is the field's path, a path above it or a path below it (`limit.context`; `limit.output`; the four price
  paths; `cost.text` for the tiers; `capabilities.cache` for both lifetimes). providers.dev's "unknown" is its
  statement, and pi does not fill it.

**Tiers** follow section e, rule 5, and have their own first line. In order:

1. neither pi nor the entry has a tier: nothing is stated, `silent`;
2. the tiers are not compared on this entry (a subscription entry, tiers the entry states in a form that cannot
   be read, or `cost.text` published as unknown): `not_compared`;
3. the two lists agree (rule 5): `agrees`;
4. otherwise `differs`. Both lists are statements here, an empty one included, so one side having tiers and the
   other none is `differs`, as it is in `differences` today, and tiers are never `only`.

The item of the tiers has `pi: null`. Its `pi_tiers` is pi's list wherever the standing is not `silent`, and
that list can be empty; with `silent` it is `null`. Every other item has `pi_tiers: null`.

### What is published in each case

| the three sources | the entry's field | the item | the entry page (section 7) |
|---|---|---|---|
| pi agrees with the entry | the value, as today | `agrees` | the value with its source, and "pi agrees" |
| pi differs | the value by the order: providers.dev's, else models.dev's | `differs`, with pi's value; `differences` has both values, as today | the value with its source, and "pi says X" |
| only providers.dev or models.dev speaks | the value | `silent` | the value with its source; nothing about pi |
| only pi speaks | absent, as today | `only`, with pi's value | the row as without pi (Unknown, or the entry's 0), and "pi states X" under it, with pi's mark and date |
| pi speaks and the field is not compared | whatever it is today | `not_compared`, with pi's value | the row as today, and "pi lists X", without a verdict |
| nobody speaks | absent | `silent` | Unknown |

### `differences` follows the same rule

`differences` stays, with its seven fields and its shape. One thing changes in what it lists: rule 1 of section e
gains "**no price and no tiers item is listed on an entry whose `providers_dev.access` is `subscription`**". So
after this work, for the seven fields: an item of `values` is `differs` exactly where `differences` has an item
of that field, on every entry. On the data of section 1 the list loses the 32 items named there;
`difference_count` of the ten summaries falls with it (`openai-codex/gpt-6.1-sol` from 5 to 1). Without this the
page would show "3 differ" on an entry where no row differs (section 11, decision 3).

---

## 3. Where a value only pi states lives

**In the pi block, as the item with the standing `only`. Not in `limit`, `cost` or any other field of the
entry.** The page says it where a reader looks for it: on pi's line under the value of that row and tile, with
pi's mark and date; the value itself stays the entry's (section 7). The API consumer finds it where it is today, in `providers_dev.pi`, now with the published fact
that the entry itself states none.

Why not the main field with a source mark:

1. **None of the existing marks fits.** `providers_dev.provenance` is a correction of an imported field, with a
   reason and evidence that the build requires; pi's value has neither. `inherited.fields` names fields copied
   from another entry. `limits.from_measurement` names measured values. A fourth mechanism would be needed, on a
   field every reader takes for models.dev's or providers.dev's.
2. **The main field feeds other values.** `inputWindow` reads `limit.context` as the documented window
   (`design/usable-input-window.md`, 3.1). A filled `limit.context` would make 272,000 the documented input
   window of `openai-codex/gpt-6.2-astra`, and on `gpt-6-astra` and `gpt-6-luna` a documented value that
   providers.dev's own measurement contradicts. The summaries' `context` and `max_output`, the ranges of the
   canonical models, and the sort and the filters of the lists read the same fields. So pi would decide the
   answer to the owner's sixth question through the back door, against section 5.
3. **The rules of the catalog say what `limit` is.** On an added entry it is what its own file states or what was
   measured on that access. pi's figure for a login is the window a client works with.
4. **The fence** (section 4).
5. **It is ten values.**

A consequence, stated so that it is seen: in every list (the home page, a provider's page, a model's page) these
five entries show their context window and output limit as unknown, as today, and so does their own page, with
pi's figures on the line under each. The lists say nothing of pi's values, as they say nothing of pi's differences (decision 8).

---

## 4. The fence

**The promise stays as section k has it, sentence for sentence.** The dataset is complete without pi before any
pi code runs; pi's code runs in one guarded place in the build and one in the sync; outside the fence only
checked, plain data is used; and the models.dev part of the dataset is the same with or without pi's data. No
field outside `providers_dev.pi`, the `pi` of a summary and `meta.pi` is written from pi's data, now as before.

What changes inside the fence is small and is of the kind the fence already handles:

- the block has one more key, `values`, checked by `PiBlockSchema` like every key of the block;
- pi's code is handed three more **copies** of plain facts of the entry (section 8): its access, the paths and
  kinds of its corrections, and its two documented lifetimes. As with `limit` and `cost`, it is handed
  `structuredClone`s, never an object the build goes on to use;
- `piOfBuild` changes in that one place, the facts it copies for `entryOf`. Its four checks, its warnings, its
  states and `publish()` do not change. The fence still turns nothing away for what pi says of the world.

**A build with pi's part turned away or absent** publishes `pi: null` on every entry. The page then shows the
entry's own values and nothing else: the ten rows of section 3 keep the value they have with pi, without pi's line,
and no row says "pi agrees". That is
said where it is said today and nowhere new: `meta.pi.snapshot: null`, the `pi-snapshot-unreadable` warning in
`/api/v1/meta` and on the run where the part was turned away, and the one line of the page's pi section ("This
dataset is built without pi's catalog"). No sentence is needed for "the filled values are gone", because nothing
was filled: pi's figures were lines of pi's, and go with pi's block.

**pi's code still cannot stop or alter a build.** A fault in the new code is a throw or a misfit inside
`piPart`, which the guard catches like every other. What the fence does not promise is unchanged too: a part
that fits the contract and is wrong is published as pi's part. Its reach on the page is wider than before, and
bounded: a wrong standing puts a wrong "pi agrees" or a wrong pi figure **beside** a value, and never changes
the value, because the page prints the entry's own value in every row and tile, whatever the standing says, and
pi's figure only on pi's line (section 7, rule 1). The first builds of the page put pi's figure in the value's
place where the standing said `only`, and then where the page judged that the entry stated nothing; two reviews
found a well-formed wrong block that hid an entry's value that way (a subscription's "In plan", an explicit
unknown, a removed price, a 0 read through a wrong unit). Nothing on the page decides any more when pi may take
the place of a value.

**What the alternative would cost**, for the record. A pi value in `limit` or `cost` means one of two things.
Either pi's code runs before the values that are made from those fields (the input window, the summaries, the
model ranges, the facets), and rule 1 of the fence, "the dataset is complete without pi before any pi code
runs", is gone; or the fence writes into finished entries and those values are worked out a second time, which
is the second build path the fence was made to remove. In both cases the whole-dataset comparison can no longer
require that every entry is deep-equal once the pi block is taken off, and the fault tables can no longer
require that a turned-away build is the build without pi, byte for byte. That is the price of ten values, and
this design does not pay it.

---

## 5. The safe values

**The owner's question: can pi's data contribute to the safe values? No.** Not to raise one, not to lower one,
not to fill an unknown one. The rules of the two safe values say so themselves, and the data agrees.

### What the rules take in

Both rules have two inputs and no third (`design/safe-cache-lifetime.md`, 4.1;
`design/usable-input-window.md`, 4.1):

- **documented**: what the provider documents for this entry, as models.dev records it or as a providers.dev
  correction states it with evidence (a kind, a URL, a date);
- **measured**: what providers.dev's own evaluations found on this access.

A value of pi's is neither. It is not a measurement. It is not documentation of the provider: pi's catalog names
no page and no date for a figure, a flag pi does not state "follows pi's own default", and several of its
figures are settings of a client. `AGENTS.md` asks evidence of every value providers.dev publishes as its own and
says "do not invent limits, lifetimes"; a safe value is providers.dev's own.

### The input window

pi's `contextWindow` is the window pi works with, not the limit of the route. Where the two can be told apart,
they are apart:

- pi's figure is **below** the published input window on 25 entries. On 8 of them providers.dev has a
  measurement, and **on all 8 the route accepted or named more than pi's figure**: the four `openai-codex`
  entries with a measurement (pi 272,000 or 500,000; 920,870 to 921,500 accepted) and four OpenRouter entries
  where the route named its window (1,048,576 or 1,050,000 against pi's 1,048,575, 262,144 and twice 1,048,576).
- On 7 more, the `openai/gpt-6…` API entries, models.dev documents `limit.input` 922,000 and pi states 272,000,
  the number at which the higher price tier of those entries begins.
- The other 10 have no measurement: `deepseek/deepseek-flash` and `deepseek-v4-pro` (1,048,576 against
  1,000,000) and eight OpenRouter entries.

So **"pi may lower a safe value" would change 17 input windows** (the 25 less the 8 where a measurement speaks),
7 of them from 922,000 to 272,000, and it would be wrong wherever it can be checked. **"pi may fill an unknown"
would change 3**: `openai-codex/gpt-6.2-astra` (272,000), `gpt-6.2-sol` (500,000) and
`vercel/spacexai/grok-voice-3.0` (4,096); on the first two, the same login accepted 921,500 on the sibling
models. The record has no place for such a figure either: `basis` is `documented` or `measured`, and
`bound: "at_least"` means "the largest input seen accepted".

A lower number is safe for a client's budget and still false as "the most input a request can carry on this
entry", which is what `tokens` is. The design of the input window already has this case: "a client can have a
window of its own. Codex's own client works with 272K and 500K windows on a login that accepts about 922K."

### The cache lifetimes

- pi states lifetimes on 4 entries, `anthropic/claude-fable-5-2`, `claude-haiku-5-5`, `claude-opus-5-5` and
  `claude-sonnet-5-5`: 300 and 3,600 seconds, **equal to the documented lifetimes on all eight profiles**. As a
  second documented opinion they would change **0 safe values**.
- `supportsLongCacheRetention: false`, on 88 entries, is not a lifetime. pi's own description of the flag:
  whether the provider supports "long prompt cache retention", a request field (`prompt_cache_retention: "24h"`,
  or `cache_control.ttl` on the Anthropic format). It says pi does not ask for the long lifetime there. Read as
  "the long lifetime is 0" it would turn 86 `null`s into 0 (the other 2 are 0 already: the provider documents
  that it does not cache), and `safe_s: 0` means "does not cache: do not wait on a cache". 69 of those 86
  entries document automatic caching. Whether a request can ask for a lifetime is `providers_dev.cache.retention`,
  and that needs "a sourced declaration", the provider's own page: pi's flag is not one, and "no control is
  copied from one provider to another".

### The chief's proposal, and the order of sources

The proposal was: pi as a second documented opinion that may make a safe value more cautious or fill an unknown
one, never raise one, never against a measurement. It is rejected, for the reasons above, and with it goes the
oddity it brought: "pi may lower models.dev's value" beside "models.dev before pi". There is one order, for
every value, and the safe values keep their two bases.

### How pi's data does contribute

As a lead. A `differs` on a limit or a lifetime is a reason to read the provider's page or to run an evaluation.
What that finds enters the way everything of providers.dev's enters: an override with evidence, or a measurement.
Then it is providers.dev's value, first in the order, and the safe value follows it by its own rule.

The page says what pi says, beside the safe value and not in it: pi's context window in the row of the context
window, pi's lifetimes in the rows of the two profiles (section 7).

---

## 6. What only pi returns

Everything here stays **pi's**: it is printed from `providers_dev.pi` as pi states it, in pi's section of the
page. **None of it becomes a value of providers.dev's with a name of its own.** The reasons, once:

- a capability or a retention setting of an entry needs a sourced declaration; pi's catalog is generated and
  names no source;
- only what the feed states is published, and a flag that is absent follows a default that lives in pi's code:
  coverage is partial, and absence does not mean the same thing in every request format;
- a flag speaks of **one** request format at **one** address, pi's; an entry can list three formats
  (`api.chat-completions`, `api.messages`, `api.responses`). Reading `supportsTemperature` into
  `capabilities.temperature`, or `maxTokensField` into `api.*.compatibility.max_tokens_field`, would need a
  hand-made mapping per flag and per format: a case per field, for values the entry page does not show today.

What the page shows of it, and in what words. The words are the page's labels; the raw name and value are always
shown with them.

**The request format** (`api`), on every entry pi lists. The page says the format in plain words and pi's word
beside it:

| pi's word | on the page |
|---|---|
| `openai-completions` | OpenAI Chat Completions |
| `openai-responses` | OpenAI Responses |
| `azure-openai-responses` | Azure OpenAI Responses |
| `openai-codex-responses` | OpenAI Responses, through the ChatGPT sign-in |
| `anthropic-messages` | Anthropic Messages |
| `bedrock-converse-stream` | Amazon Bedrock Converse, streaming |
| `google-generative-ai` | Google Gemini API |
| `google-vertex` | Google Vertex AI |
| `mistral-conversations` | Mistral Conversations |
| any other value | pi's word alone |

**The address** (`base_url`), as stated, placeholders included.

**Input kinds and reasoning** (`input`, `reasoning`), as today: what pi sends, and whether pi treats the model as
one that reasons.

**The thinking levels** (`thinking_level_map`): each level pi names, with the value pi sends for it, or "not
supported" where pi marks it so; and the sentence that a level not named follows pi's own default. It is not the
list of effort values the provider accepts (`capabilities.reasoning.effort`) and is not compared with it: the
map leaves out the levels that follow pi's defaults, and those are not published.

**The call flags** (`compat`), in three groups. A flag is printed only where pi states it; a flag that is absent
is never shown as `false`.

*Group A: what the provider or the model accepts, as pi states it.* Facts a reader can use when calling the
model in the same request format. Label, then pi's name and value.

| pi's flag | entries | the page's words for it |
|---|---|---|
| `supportsStrictMode`, `supportsStrictTools` | 506, 8 | Strict tool schemas |
| `supportsStore` | 180 | The `store` request field |
| `supportsReasoningEffort` | 120 | The `reasoning_effort` request field |
| `maxTokensField` | 109 | The request field for the output limit |
| `supportsTemperature` | 17 | The `temperature` request field |
| `supportsUsageInStreaming` | 14 | Token usage in a streamed response |
| `thinkingFormat` | 302 | How thinking is asked for (pi's name for the convention) |
| `requiresReasoningContentOnAssistantMessages` | 44 | Replayed assistant messages must carry `reasoning_content` |
| `supportsLongCacheRetention` | 88 | Asking for the long cache lifetime in the request |
| `supportsExplicitPromptCacheMode` | 10 | The `prompt_cache_options` request field |
| `supportsCacheControlOnTools` | 16 | Cache markers on tool definitions |
| `supportsMidConvoSystemMessages` | 74 | System messages after the conversation has started |
| `supportsMidConvoToolAdditions`, `supportsMidConvoToolChanges` | 18, 4 | Tools added or removed in the middle of a conversation |
| `supportsMidConvoEffort` | 26 | A change of thinking level in the middle of a conversation |
| `supportsOpenAIGrammarTools` | 34 | Custom tools with a grammar |
| `supportsAdditionalTools` | 27 | `additional_tools` input items |
| `supportsToolSearch` | 13 | Tool search run by the client |
| `supportsEagerToolInputStreaming` | 16 | Eager streaming of tool input |
| `zaiToolStream` | 7 | The `tool_stream` request field |

A flag whose value is `true` or `false` is said as "Accepted" or "Not accepted" ("Required" for the one that
names a requirement); any other value is printed as stated.

*Group B: what pi does.* pi's own switches, printed raw, with one line that says so:
`sendSessionAffinityHeaders` (241), `sessionAffinityFormat` (18), `allowEmptySignature` (170),
`forceAdaptiveThinking` (45), `chatTemplateArgs` (2), `allowedFallbackModels` (1).

*Group C: every other name*, printed raw. pi adds flags; a new one appears here until the table gives it a
place. Moving a flag between groups is a change of this table and of the page's words, never of the data.

**The request limits** (`input_limits`): the size of a request in bytes and the images per request and per
message, as pi states them, on 91 entries. The entry has no field of this kind, so nothing is compared.

**The cache lifetimes pi reckons with** (`prompt_cache`) leave pi's section: they are two fields of the rule and
are said in the rows of the two profiles.

The table of words lives in one module of the page, `src/core/pi-words.ts`: the nine formats and the three
groups, as plain data. It is not one of pi's two modules and imports nothing from them, so the rule of the
modules (section k) is untouched. The methodology page (`#pi`) carries the same table.

---

## 7. The page's data

Purpose and data only; the look is the frontend designer's. Everything comes from
`GET /api/v1/entries/{provider}/{model}` (`entry`, `summary`) and `GET /api/v1/meta` (`pi`).

Three rules for the whole page:

1. **The entry's own value is printed in every row and tile, with its source, as today, or Unknown where the entry
   has none: on every entry, whatever pi's block says.** Nothing of pi's replaces it, hides it or reorders it;
   pi speaks only on its line under the value.
2. **What the page says of pi in a row is the item's `standing` and nothing else.** The page does not compare
   two numbers, does not test a value for 0, a unit or an access, and does not look for a correction. It prints
   `pi` (or `pi_tiers`) of the item, formatted.
3. **On an entry pi does not list (`pi: null`) and in a dataset without pi data, every row is today's row.**

What a row can say, by the item's standing:

| `standing` | the row |
|---|---|
| `agrees` | the entry's value and source, and that pi agrees |
| `differs` | the entry's value and source, and what pi says: `pi` of the item (for the tiers, `pi_tiers` beside the entry's tiers, both from the `cost.tiers` item of `differences`, as today) |
| `only` | the row as today (Unknown, or the entry's 0), and "pi states X" under it, with pi's mark and the date of pi's data |
| `not_compared` | the row as today, and that pi lists `pi` of the item, with no verdict; the methodology says the five reasons |
| `silent` | the row as today; nothing about pi |

Row by row. "Item" is the item of `providers_dev.pi.values` with that `field`.

| on the page | the value and its source, as today | of pi |
|---|---|---|
| tile "Input window"; the input-window table | `providers_dev.limits.input_window` | nothing (section 5) |
| tile "Context window" | `limit.context` | under the entry's value: what pi says where the item `context_window` is `differs`, "pi states X" with pi's mark where it is `only`. That pi agrees, or lists a value, is said once, in the row |
| tile "Maximum output" | `limit.output` | the same with `max_tokens` |
| Limits, row "Context window" | `limit.context`, source by `provenance`, `origin`, `from_measurement` | the item `context_window`, every standing |
| Limits, row "Largest input" | `limit.input` | nothing: pi states no input limit |
| Limits, row "Maximum output" | `limit.output` | the item `max_tokens` |
| Limits, measured | `limits.measured` | nothing |
| Price, rows "Input", "Output", "Cache read", "Cache write" | `summary.pricing` | the items `cost.input`, `cost.output`, `cost.cache_read`, `cost.cache_write`. On a subscription entry they are `not_compared` or `silent`, so the row never says "pi agrees" beside another entry's list price |
| Price, row "Reasoning output" and every other charge | `summary.pricing` | nothing |
| Price, conditional rates | `summary.pricing` | the item `cost.tiers`, said once for the tiers by size of request as a whole: agrees, or differs with both lists |
| tiles "Cache lifetime, short" and "long"; the two profile rows of the lifetimes | `providers_dev.cache.lifetime` | the items `prompt_cache.short` and `prompt_cache.long`: pi's lifetime beside the documented one. Never in `safe_s` |
| Cache modes, Retention | `cache.documented`, `request_controls` | nothing. pi's three cache flags are in pi's section |
| the head of the page: the sources | `summary.origin`, `verified`, `summary.pi` | the pi.dev mark, with `difference_count` in words, and the date of the pi import, as today |

Wherever pi's value is shown, the page must be able to say: that it is pi's (the pi.dev mark); that it is
imported and not checked by providers.dev; when it was imported (`meta.pi.snapshot.fetched_at`) and, if so, that
the last import failed (`meta.pi.sync`). A pi price is never shown as free: an item with pi's 0 is `silent` and
has `pi: null`, so there is no 0 to print.

### What becomes of the section "pi's catalog"

It stays, at the same place and anchor (`#pi`), and holds **only what pi alone returns**:

- whose data it is and as of when: the line of today (the pi.dev mark, fetched, last checked, a failed import,
  "not verified by providers.dev", the link to pi's list for the provider);
- pi's own name for the model and, where `match` is `alias`, pi's spelling (`ref`);
- how pi calls the model, as section 6 has it: the request format, the address, the input kinds, reasoning, the
  thinking levels, the flags in their three groups, the request limits.

The table "Limits and prices" (`#pi-prices`), which repeats pi's seven values beside the page's, **goes**: its
content is in the rows above. The row "Cache lifetimes" of the call table goes for the same reason. On an entry
pi does not list, and in a dataset without pi data, the section is the one line of today.

The heading of the section should say what is left in it; the words are the designer's and the owner's
("How pi calls the model" is this document's working title).

---

## 8. The API

**Version:** `info.version` becomes `1.3.0`. One property and one component are added. Nothing is renamed,
retyped or removed, no enumerated field gets a new value, and there is no new path or parameter.

### `providers_dev.pi.values`

```ts
// src/core/pi.ts
export const PI_VALUE_FIELDS = ["context_window", "max_tokens", "cost.input", "cost.output", "cost.cache_read", "cost.cache_write", "cost.tiers", "prompt_cache.short", "prompt_cache.long"] as const;
export type PiValueField = (typeof PI_VALUE_FIELDS)[number];

/** Where pi's catalog stands beside one value of the entry (design/pi-merged.md, section 2). */
export interface PiValue {
  field: PiValueField;
  entry_field: string;
  unit: "tokens" | "usd_per_million_tokens" | "seconds";
  standing: "agrees" | "differs" | "only" | "not_compared" | "silent";
  pi: number | null;
  pi_tiers: PiCostTier[] | null;
}

export interface PiBlock { /* the keys of today, in today's order, then: */ values: PiValue[] }
```

```ts
// src/core/contract.ts
export const PiValueSchema = z.strictObject({
  field: z.enum(PI_VALUE_FIELDS).describe("The value of pi's catalog the item speaks of."),
  entry_field: z.string().describe("The field of the entry it stands beside: limit.context, limit.output, cost.text.input.price, cost.text.output.price, cost.text.input.cache.read, cost.text.input.cache.write, cost.text for the tiers, providers_dev.cache.lifetime.short.documented_s, providers_dev.cache.lifetime.long.documented_s."),
  unit: z.enum(["tokens", "usd_per_million_tokens", "seconds"]),
  standing: z.enum(["agrees", "differs", "only", "not_compared", "silent"]).describe("agrees = pi and the entry state the same value. differs = they state different values: the entry's is published in its own field, pi's is here. only = pi states a value and the entry states none: pi's value is here and in no field of the entry. not_compared = pi states a value that is not compared with the entry's: a price on a subscription entry, a price in another unit, a cache-write price the entry keys by lifetime, tiers that cannot be read as tiers, or a field providers.dev publishes as unknown. silent = pi states no value: a limit or a price of 0 in pi's catalog is no statement."),
  pi: z.number().min(0).nullable().describe("pi's value, where pi states one. Null with silent, and for cost.tiers."),
  pi_tiers: z.array(PiCostTierSchema).nullable().describe("For cost.tiers, where the standing is not silent: pi's tiers, ascending; an empty list = pi states none. Null otherwise."),
}).describe("Where pi's catalog stands beside one value of the entry. providers.dev's own value comes first, then models.dev's, then pi's: pi's value never replaces the entry's.") satisfies z.ZodType<PiValue>;
```

`PiBlockSchema` gains, as its last key:
`values: z.array(PiValueSchema).length(9).describe("One item for each value pi's catalog can state of an entry, in a fixed order: context_window, max_tokens, cost.input, cost.output, cost.cache_read, cost.cache_write, cost.tiers, prompt_cache.short, prompt_cache.long. Since 1.3.0.")`.
`PiValue` joins `COMPONENTS`. Every block has all nine items, on every entry pi lists; an entry pi does not list
has `pi: null`, as today.

The description of `PiDifferenceSchema` gains one sentence: no price and no tiers are listed on a subscription
entry. The description of `differences` keeps its text. The description of `PiBlockSchema` keeps "never merged
into the entry's own fields", which stays true.

`PiSummary`, `meta.pi`, `license` and every other schema are unchanged. The summary gets nothing new: the lists
say nothing of pi's values (decision 8).

### In `src/core/openapi.ts`

- `info.version: "1.3.0"`; the sentence of the guide that counts the steps gains "then 1.3.0".
- The guide section `pi` gains one paragraph after the one on the differences, with these facts: the order of
  sources; `values` and its five standings; that a value only pi states is in the block and in no field of the
  entry; that pi's data does not enter `providers_dev.cache.lifetime` or `providers_dev.limits.input_window`;
  "since 1.3.0". And the paragraph on the differences says that prices are not compared on a subscription entry.
- `structure/api-v1.json` by `npm run structure:update`, in the same commit. `structure/api-v1-1.0.0.json` is not
  touched.

### What pi's code is handed

`PiPartInput.entryOf` returns more plain facts of the published entry, all copies:

```ts
// src/core/pi.ts
export interface PiEntryFacts {
  limit: unknown;                 // as today
  cost: unknown;                  // as today
  /** providers_dev.access of the entry. */
  access: "api" | "subscription" | "unknown";
  /** `path` and `op` of every item of providers_dev.provenance. */
  corrections: { path: string; op: "set" | "unknown" | "delete" }[];
  /** providers_dev.cache.lifetime.short.documented_s and .long.documented_s. */
  documented_s: { short: number | null; long: number | null };
}
export interface PiPartInput { /* as today, with: */ entryOf: (ref: string) => PiEntryFacts | undefined }
```

`scripts/lib/pi-fence.ts` fills them in the `Map` it already makes from the catalog and hands out
`structuredClone`s, as it does for `limit` and `cost`. Nothing else in the fence changes.

`piValues(model: PiModel, facts: PiEntryFacts): PiValue[]` in `src/core/pi.ts` is the rule of section 2, once;
`piDifferences` takes the same `facts` and gains the subscription rule; `piBlock` calls both. The two must not
each have their own reading of a field: the seven shared fields are read by one function that `piDifferences`
and `piValues` both use, so that "`differs` exactly where `differences` has the item" holds by construction and
not by two copies of a rule.

### Example 1: an entry where pi differs

`GET /api/v1/entries/deepseek/deepseek-v4-pro`, `data.entry.providers_dev.pi.values`. The rest of the block is
as in example 1 of `design/pi-source.md`.

```json
[
  { "field": "context_window", "entry_field": "limit.context", "unit": "tokens", "standing": "differs", "pi": 1000000, "pi_tiers": null },
  { "field": "max_tokens", "entry_field": "limit.output", "unit": "tokens", "standing": "differs", "pi": 384000, "pi_tiers": null },
  { "field": "cost.input", "entry_field": "cost.text.input.price", "unit": "usd_per_million_tokens", "standing": "differs", "pi": 1.32, "pi_tiers": null },
  { "field": "cost.output", "entry_field": "cost.text.output.price", "unit": "usd_per_million_tokens", "standing": "differs", "pi": 3.96, "pi_tiers": null },
  { "field": "cost.cache_read", "entry_field": "cost.text.input.cache.read", "unit": "usd_per_million_tokens", "standing": "differs", "pi": 0.044, "pi_tiers": null },
  { "field": "cost.cache_write", "entry_field": "cost.text.input.cache.write", "unit": "usd_per_million_tokens", "standing": "silent", "pi": null, "pi_tiers": null },
  { "field": "cost.tiers", "entry_field": "cost.text", "unit": "usd_per_million_tokens", "standing": "silent", "pi": null, "pi_tiers": null },
  { "field": "prompt_cache.short", "entry_field": "providers_dev.cache.lifetime.short.documented_s", "unit": "seconds", "standing": "silent", "pi": null, "pi_tiers": null },
  { "field": "prompt_cache.long", "entry_field": "providers_dev.cache.lifetime.long.documented_s", "unit": "seconds", "standing": "silent", "pi": null, "pi_tiers": null }
]
```

The cache-write price is `silent` because pi writes 0; the tiers are `silent` because neither side has one (the
entry's multiplier by time of day is not a tier).

### Example 2: an added login entry, where pi alone states the limits

`GET /api/v1/entries/openai-codex/gpt-6-astra`: the entry has no `limit`; its `cost` is the API entry's, marked
in `inherited.fields`; `providers_dev.access` is `subscription`; its input window is 921,500, measured, at least.

```json
[
  { "field": "context_window", "entry_field": "limit.context", "unit": "tokens", "standing": "only", "pi": 272000, "pi_tiers": null },
  { "field": "max_tokens", "entry_field": "limit.output", "unit": "tokens", "standing": "only", "pi": 128000, "pi_tiers": null },
  { "field": "cost.input", "entry_field": "cost.text.input.price", "unit": "usd_per_million_tokens", "standing": "not_compared", "pi": 10, "pi_tiers": null },
  { "field": "cost.output", "entry_field": "cost.text.output.price", "unit": "usd_per_million_tokens", "standing": "not_compared", "pi": 50, "pi_tiers": null },
  { "field": "cost.cache_read", "entry_field": "cost.text.input.cache.read", "unit": "usd_per_million_tokens", "standing": "not_compared", "pi": 1, "pi_tiers": null },
  { "field": "cost.cache_write", "entry_field": "cost.text.input.cache.write", "unit": "usd_per_million_tokens", "standing": "not_compared", "pi": 12.5, "pi_tiers": null },
  { "field": "cost.tiers", "entry_field": "cost.text", "unit": "usd_per_million_tokens", "standing": "not_compared", "pi": null, "pi_tiers": [ { "input_tokens_above": 272000, "input": 20, "output": 75, "cache_read": 2, "cache_write": 25 } ] },
  { "field": "prompt_cache.short", "entry_field": "providers_dev.cache.lifetime.short.documented_s", "unit": "seconds", "standing": "silent", "pi": null, "pi_tiers": null },
  { "field": "prompt_cache.long", "entry_field": "providers_dev.cache.lifetime.long.documented_s", "unit": "seconds", "standing": "silent", "pi": null, "pi_tiers": null }
]
```

The entry itself is unchanged: no `limit`, and `input_window.tokens` 921,500.

### How the standing rules stay true

- **"The site never shows anything that is not from the API"; "a page never works anything out".** Which rows
  say what of pi is `standing`, worked out in the build. Today the page finds "no difference" by looking for a
  field in `differences`, which cannot tell "agrees" from "one of them states none"; after this it reads one
  word.
- **"Unknown is `null`."** `pi: null` with `silent`; `limit` is not filled.
- **"A pi price of 0 is not a statement."** It is `silent`, and the item carries no 0.
- **"Prices are compared exactly."** As in section e.
- **"The home page's rows say nothing about pi's differences."** No summary field is added and `rowHtml` does
  not change.
- **"One contract."** Nine items on every block, six keys on every item.
- **"The API only grows."** One property, one component, 1.3.0.
- **"For every entry, every field that exists keeps its value."** Outside `providers_dev.pi` and the `pi` of a
  summary nothing changes. Inside the block, `differences` loses the 32 items of section 1 and gains none, and
  `difference_count` follows.

---

## 9. Tests and proofs

### `tests/pi-source.test.ts`, the rule

1. Every block has nine items, in the order of `PI_VALUE_FIELDS`, each with the six keys.
2. One case per standing for a limit, a price and a lifetime: equal values give `agrees`; unequal `differs`; an
   absent entry field gives `only` with pi's value; pi's 0 (a limit, a price) and an absent `promptCache` give
   `silent` with `pi: null`.
3. A limit of 0 on the entry's side is "none stated": with pi's value above 0 the standing is `only`.
4. A listed price of 0 on an entry with `access: "api"` is a price: with pi's price above 0 the standing is
   `differs`, and `differences` lists it.
5. The same prices on an entry with `access: "subscription"`: every price item and the tiers are `not_compared`
   with pi's value, and `differences` has no `cost.` item; its limits are compared as on any entry.
6. `not_compared` for a price in another unit, for a cache-write price keyed by lifetime, and for tiers that
   cannot be read; in each, `pi` is pi's value.
7. A correction with `op: "unknown"` on `limit.context`, and one on `limit`: `context_window` is `not_compared`,
   not `only`. A correction with `op: "set"` to pi's number: `agrees`. One with `"$delete"` on `cost`: every
   price item is `not_compared`.
8. Tiers: none on either side is `silent` with `pi_tiers: null`; equal tiers `agrees`; tiers on one side only
   `differs`, and never `only`; `pi` is `null` on the tiers item in every case.
9. Lifetimes: pi's 300 against `documented_s` 300 is `agrees`; against 600 `differs`; against `null` `only`; and
   in none of these does `providers_dev.cache.lifetime` change: the record with pi is deep-equal to the record
   without.
10. **One rule for both lists:** over every entry of the fixture build, and for each of the seven shared fields,
    the item is `differs` exactly where `differences` has an item of that field.
11. **Nothing existing moves** (case 10 of `design/pi-source.md`, section j, unchanged): with the pi block taken
    off, every entry and every summary is deep-equal with and without pi; in particular `limit`, `cost`,
    `providers_dev.limits.input_window` and `providers_dev.cache.lifetime` of an entry with an `only` item.

### The fence

`tests/pi-fence.test.ts` needs no new table: it mutates every key and value of the first block at every depth,
and `values` is part of the block. Its fixture's first block must have, besides what section k asks, a `values`
list with a tiers item that has `pi_tiers`. What is shown: the number of rows before and after, that every fault
fired and every row ended turned away, the two rows of "does not promise" apart. One row is added to those two:
`piPart` returns its true result with the `standing` of the first item changed from one allowed word to
another; it is published, the state is `published`, and 0 objects differ in the reference.

`tests/pi-fence-imports.test.ts` passes unchanged; one case is added: `src/core/pi-words.ts` imports nothing
from `src/core/pi.ts` or `scripts/lib/pi-sync.ts`.

### The contract and the structure

`tests/api-structure.test.ts` passes with the new record and reports no break against 1.0.0;
`tests/contract.test.ts` and the contract check of the built snapshot pass; `tests/api.test.ts` gains:
`info.version` is `1.3.0`, and every block of `/entries/{provider}/{model}` has `values` with nine items.

### The pages (`tests/pages.test.ts`, `tests/render.test.ts`)

One entry page for each of: every item `agrees` or `silent`; a `differs` on a limit and on a price; a `differs`
on the tiers; an `only` on both limits; a subscription entry with `not_compared` prices; an alias match;
`pi: null`; a dataset without pi data. For each:

- every value on the page is in the API answers it was drawn from;
- the entry's own value of each row is on the page wherever the entry has one, also where the item is `differs`;
- an `only` value is on pi's line with pi's mark and date, and the row's value is the same HTML as on the page of
  the same entry with `pi: null`; every value of every page is that HTML, whatever each item's standing, unit or
  figure (the reviews' injections among them);
- nothing of pi's is in a row whose item is `silent`; no price of pi's is shown as 0 or as free;
- the input-window table and the safe lifetime are the same HTML with and without the pi block;
- the table "Limits and prices" of the pi section is gone, and pi's section has the request format in words and
  in pi's word, and each stated flag once, in its group; a flag absent from `compat` is not shown;
- `rowHtml` of every summary of the fixture gives the same HTML as before this work.

### The proofs on the built data

- `npm run compare:published -- <main> <branch>`: 0 differing objects (it takes the pi block off both sides).
- With `data/pi/` absent, in a copy of the data folder and with `generated_at` fixed: every file under
  `data/published/` has the SHA-256 of the same build of `main`, and the `dataset_version` is the same. Nothing
  outside pi's block moved.
- The table of standings of section 1, reproduced from the built data by counting `values` of every entry, with
  the ten `only` items named.

No test asserts a count of the real pi data (section k, 4): the table is shown in the task's result, and what
the tests hold is the rule.

---

## 10. The steps

Two steps, each one task, on a branch from `main` once `pi-no-blocks` is there, reviewed before `main`. The
rules of every step are those of section j: no data folder is edited by hand, the API only grows, and
`npm run check` passes at the end.

### Step M1, a worker: the data and the contract

Files: `src/core/pi.ts` (`PI_VALUE_FIELDS`, `PiValue`, `PiEntryFacts`, the one reading of the seven fields,
`piValues`, the subscription rule in `piDifferences`, `values` in `piBlock`), `src/core/contract.ts` (section 8),
`scripts/lib/pi-fence.ts` (the three more facts in the `Map`, cloned), `src/core/openapi.ts` (1.3.0, the guide),
`structure/api-v1.json` (`npm run structure:update`), `tests/pi-source.test.ts`, `tests/pi-fence.test.ts` (the
fixture, the one more row), `tests/api.test.ts`, `tests/helpers.ts` where the fixture needs it;
`design/pi-source.md` (the five sentences of section 12); `README.md` ("API": 1.3.0 and what it added) and
`AGENTS.md` (one rule: pi's values stand third, are never written into a field of the entry or into a safe
value, and their standing is worked out once, in `piValues`).

Not touched: `src/core/resolve.ts`, `src/core/entries.ts`, `src/core/cache.ts`, `src/core/limits.ts`,
`scripts/lib/publish.ts`, `scripts/lib/fenced.ts`, `scripts/lib/compare-published.ts`, the workflow, every page.
The pages still build: they read `differences`, which is still there.

**What must hold afterwards, shown in the result:**

- the three proofs of section 9, with the comparison's whole output;
- on the data of 2026-11-20: 813 blocks before and after; the table of section 1; `differences` 162 items on 101
  entries before, 130 on 93 after, the ten entries that lost items named. On another day the numbers follow the
  snapshots, and what must hold is: each row of the table adds up to the blocks; the `differs` of a field is the
  number of `differences` items of that field; no `only` on a price of a subscription entry;
- the fence tables: rows before and after, every fault fired, every row turned away but the three of "does not
  promise";
- `npm run check`.

### Step M2, the frontend designer: the page

Files: `src/core/render.ts` (`piSection`, `piCallTable`, the rows of section 7, `entryHtml`),
`src/core/pi-words.ts` (new: the table of section 6), the styles, `tests/pages.test.ts`, `tests/render.test.ts`,
and the methodology text (`#pi`): the order of sources, the five standings with the reasons a value is not
compared, that pi's values enter no safe value, and the table of section 6.

**What must hold afterwards:** `npm run data` prints the same `dataset_version` before and after (this step
changes pages and words, no data); the page tests of section 9; `npm run check`; and the affected pages looked
at in a browser, with a screenshot of each in the result: `anthropic/claude-opus-5-5` (pi agrees, lifetimes
included), `deepseek/deepseek-v4-pro` (five values differ), `vercel/alibaba/qwen3.7-flash` (an alias; the tiers
differ), `openai-codex/gpt-6-astra` (two values from pi beside a measured input window; prices not compared),
`openai/gpt-6-astra` (pi's 272,000 beside a documented input of 922,000), an entry pi does not list, and the
home page.

The review builds `main` and the branch after M2 on the same data and runs the comparison once across both
steps.

---

## 11. What is to be decided

Each is designed one way above, so that the steps can start; the other way is said with what it costs.

1. **A value only pi states is shown on the page, on pi's line under the entry's value, and stays out of `limit` and
   `cost`** (section 3). The other
   way, the main field with a mark, costs the fence its first rule or a second build pass, moves the input
   window on the same entries, and buys ten values (section 4).
2. **The ten values are shown although pi's figure is a client's window on four of the five entries.** On
   `openai-codex/gpt-6-astra` and `gpt-6-luna` the page shows "Unknown" with "pi states 272,000 tokens" under it,
   beside an input window of at least 921,500, measured. The other way: no `only` on a limit where the entry has a
   counted limit evaluation. It would leave six values on three entries, and adds a case to the rule. Decided:
   shown, on pi's line, never in the value's place (the decision of 2026-11-21 at the top).
3. **`differences` loses 32 items on ten subscription entries**, and their `difference_count` falls. The other
   way: `differences` stays byte for byte and only `values` says `not_compared` there; the head of those ten
   pages then says "3 differ" (or 4, or 5) over rows that do not differ. Recommended: correct it.
4. **pi's data enters no safe value** (section 5). This is the answer to the owner's question; the numbers for
   the other answers are there: 17 input windows lowered, 3 filled, 0 lifetimes changed.
5. **Input kinds and reasoning are not in the rule**, because the entry page has no row of the entry's own for
   them: pi's section is the only place they are shown. If models.dev's `modalities.input` and
   `capabilities.reasoning.supported` are wanted on the page, the rule takes two more fields the same way (807
   and 804 agree, 2 and 5 differ, 4 and 4 from pi alone, the four added login entries).
6. **`values` is a key of pi's block.** The block keeps every key it has, with its meaning; one is added. If
   "the block unchanged" is meant to the letter, the same list can be a key beside it,
   `providers_dev.pi_values`, `null` where `pi` is `null`: then the fence carries a second thing per entry, with
   its own checks and its own rows in the fault tables, for no gain to a reader.
7. **The version is 1.3.0.**
8. **The lists stay as they are.** The five entries of section 3 show "Unknown" for the context window and the
   output limit in every list and on their own page, with pi's figures on the line under each.
9. **The words**: the heading of what is left of pi's section, and the plain words for the request formats and
   the flags (section 6). They are proposed here; they are the designer's and the owner's.

Where the owner's wish is not met as said: "fill the real gaps" is met on the page and not in the entry's
fields, and the real gaps are ten values, not about thirty; "can pi data contribute to safe values" is answered
no. Nothing simpler serves the rest: a merge on the page with no change of the API would make the page apply
the rules about 0, units, lifetimes and subscriptions itself, which the site does not allow.

---

## 12. The sentences of `design/pi-source.md` that change

Applied in step M1, in that file.

1. **The opening, "Decided by the owner"**, second point ("Nothing of pi's is merged into an entry's existing
   fields"): stays, and gains "The entry page shows one set of values, with pi's standing beside each
   (`design/pi-merged.md`)."
2. **Section d**, the first paragraph of "The additions to `v1`" and the version: a note that 1.3.0 adds
   `values` to the block, with a pointer here.
3. **Section e, rule 1**: gains "No price and no tiers item is listed on an entry whose `providers_dev.access`
   is `subscription`: the entry is not paid per token." And after rule 6: "The standing of every value, the
   differing ones included, is `values` (`design/pi-merged.md`, section 2)."
4. **Section h**, point 2 ("Where pi differs from the reference, at a glance") and point 1's cache lifetimes:
   replaced by a pointer to section 7 here. Points 3 and 4 stay.
5. **Section k, "pi's one entry point"**: `entryOf` returns `PiEntryFacts` (section 8 here): copies of `limit`,
   `cost`, the access, the corrections' paths and kinds, and the two documented lifetimes.

Section k's promise, its rules, its checks, its warnings and its tests are not changed by this work.
