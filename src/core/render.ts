// HTML for the entry table and the entry detail view. The same functions build the static pages and
// re-render in the browser, so a row looks and reads the same wherever it appears.
import { CACHE_AGES_S, settingsText, type CacheResult, type CacheRetention, type CacheSummaryRow, type EntryCache } from "./cache.ts";
import type { ProviderSummary, Summary } from "./entries.ts";
import {
  compactTokens,
  duration,
  entryHref,
  escapeHtml as e,
  exact,
  isStale,
  modelHref,
  ORIGIN_LABEL,
  ORIGIN_TITLE,
  plural,
  shortAge,
  usd,
} from "./format.ts";
import { isObject, type Json, type JsonObject } from "./merge.ts";
import { NS, type Evidence, type MeasuredLimit, type ModelExtension, type Provenance } from "./schema.ts";

const UNKNOWN = '<span class="unknown" title="The source does not say. Unknown is not zero and not unlimited.">Unknown</span>';
const DASH = '<span class="muted">–</span>';
/** Every entry page has the same rows. These fill a row whose value the source does not give. */
const NOT_APPLICABLE = '<span class="muted" title="This field does not apply to this entry.">Not applicable</span>';
const IN_PLAN = '<span class="muted" title="No price per token: the entry is paid for through a plan or subscription, which providers.dev does not list.">In plan</span>';
const ACCESS_LABEL = { api: "API key", subscription: "Subscription", unknown: "Unclassified" } as const;

function tokens(value: number | undefined): string {
  return value === undefined ? UNKNOWN : `<span title="${exact(value)} tokens">${compactTokens(value)}</span>`;
}

function copyButton(value: string, label: string): string {
  return `<button type="button" class="copy" data-copy="${e(value)}" aria-label="Copy ${e(label)}" title="Copy ${e(label)}">Copy</button>`;
}

function dateTag(date: string | undefined, now: Date): string {
  if (!date) return "";
  return isStale(date, now)
    ? `<span class="stale" title="The newest providers.dev evidence for this entry is from ${e(date)}, more than 90 days ago.">${e(date)} · stale</span>`
    : `<span class="muted date" title="Date of the newest providers.dev evidence.">${e(date)}</span>`;
}

/** One line per source with its own date: the models.dev import, and the newest providers.dev evidence. */
function sourcesHtml(entry: Pick<Summary, "origin" | "verified" | "overridden_fields">, options: { now: Date; imported?: string }, inline = false): string {
  const parts: string[] = [];
  if (entry.origin !== "added") {
    const date = options.imported ? `<span class="muted date" title="Imported from models.dev on this date.">${e(options.imported)}</span>` : "<span></span>";
    parts.push(`<span class="origin upstream" title="${e(ORIGIN_TITLE.upstream)}">${ORIGIN_LABEL.upstream}</span>${date}`);
  }
  if (entry.origin !== "upstream") {
    const corrected = entry.overridden_fields.length > 0 ? ` Corrected fields: ${entry.overridden_fields.join(", ")}.` : "";
    parts.push(`<span class="origin added" title="${e(ORIGIN_TITLE[entry.origin] + corrected)}">${ORIGIN_LABEL.added}</span>${dateTag(entry.verified, options.now) || "<span></span>"}`);
  }
  return `<span class="sources${inline ? " side" : ""}">${parts.join("")}</span>`;
}

/** How a provider's prompt cache is switched on, in plain words. The data and the API keep models.dev's names: implicit, explicit. */
export const CACHE_MODE_WORD = { implicit: "Automatic", explicit: "Manual" } as const;
const CACHE_MODE_TITLE = {
  implicit: "Automatic (implicit): the provider caches the start of a prompt by itself. The request does nothing for it.",
  explicit: "Manual (explicit): nothing is cached unless the request marks what to cache. The mark also picks the lifetime.",
} as const;

function cacheCell(entry: Pick<Summary, "cache" | "cache_modes" | "cache_ttl_by_mode_s">): string {
  if (entry.cache === "unknown") return UNKNOWN;
  if (entry.cache === "no") return '<span title="The source says this entry does not cache prompts.">None</span>';
  // One line per way of caching: the word, then a box with its documented lifetimes. Every word has its box, so that a value
  // is never read as belonging to the line above or below; where the source gives no lifetime the box says so.
  const lines = entry.cache_modes
    .map((mode) => {
      const ttl = entry.cache_ttl_by_mode_s?.[mode] ?? [];
      const box =
        ttl.length > 0
          ? `<span class="cache-box" title="How long this cache lasts, as documented.">${ttl.map(duration).join(", ")}</span>`
          : '<span class="cache-box none" title="The source gives no lifetime for this way of caching. Unknown is not the same as short.">Unknown</span>';
      return `<span class="cache-mode" title="${e(CACHE_MODE_TITLE[mode])}">${CACHE_MODE_WORD[mode]}</span>${box}`;
    })
    .join("");
  return lines ? `<span class="cache">${lines}</span>` : UNKNOWN;
}

/** The documented window. Where there is none, the largest input an evaluation saw accepted, said as what it is. */
function contextCell(entry: Summary, href: string): string {
  const accepted = entry.measured_input_accepted;
  if (entry.context !== undefined || accepted === undefined) return tokens(entry.context);
  // Rounded down: "at least" must stay true.
  const floor = compactTokens(Math.floor(accepted / 1000) * 1000);
  const refused = entry.measured_input_refused;
  const title = `Measured, not documented: no window is documented for this entry. An evaluation saw an input of ${exact(accepted)} tokens accepted${refused === undefined ? "" : ` and one of ${exact(refused)} refused`}. Input only: the output comes on top.`;
  return `<a class="plain limit-measured" href="${e(href)}#limits" title="${e(title)}"><span class="limit-value">≥ ${floor}</span><span class="limit-note">input</span></a>`;
}

// ---- cache evaluations: one summary table, the same on every page
// Everything shown comes from `cache_results` as the API publishes it: the lines, the ages, the counts and the
// percentages. This file lays them out; it adds nothing up.

const columnLabel = (seconds: number): string => (seconds < 3600 ? `${seconds / 60}m` : seconds % 3600 === 0 ? `${seconds / 3600}h` : `${seconds / 60}m`); // 150 -> "2.5m", 4500 -> "75m"
const CONTROL_TITLE = "At once: the prompt sent again immediately. It shows that the prompt was cached at all.";
/** An age as a column heading or in a sentence: "2.5 min", "1 h 15", "24 h" (never "1 d": the columns count in hours). */
const ageText = (seconds: number): string => (seconds === 0 ? "at once" : seconds % 86400 === 0 ? shortAge(seconds) : duration(seconds));
const level = (result: CacheResult): string => (result.hit_rate_pct === 100 ? "all" : result.hit_rate_pct === 0 ? "none" : result.hit_rate_pct >= 50 ? "most" : "few");
const said = (result: CacheResult): string => `${result.kind === "control" ? "At once" : `After ${ageText(result.age_s)}`}: ${result.hits} of ${result.checks} re-sends served from the cache (${result.hit_rate_pct}%)`;

/** The columns of every summary table: the control, then the ladder of ages. */
const COLUMNS: { kind: CacheResult["kind"]; age_s: number }[] = [{ kind: "control", age_s: 0 }, ...CACHE_AGES_S.map((age) => ({ kind: "timed" as const, age_s: age }))];
const inColumn = (results: readonly CacheResult[], column: (typeof COLUMNS)[number]): CacheResult | undefined =>
  results.find((result) => result.kind === column.kind && result.age_s === column.age_s);
/** The ages of the strip, written once in the column head so that every row lines up under them. */
export const STRIP_HEAD = `<span class="heat-strip strip-head" aria-hidden="true"><span></span><span class="strip">${COLUMNS.map((column) => `<span${column.kind === "control" ? ' class="control"' : ""}>${column.kind === "control" ? "once" : columnLabel(column.age_s)}</span>`).join("")}</span></span>`;

/** "Short" or "Long 1h": the retention profile, and the value the requests asked for. */
function retentionWord(row: Pick<CacheSummaryRow, "retention_profile" | "value">): string {
  return `${row.retention_profile === "short" ? "Short" : "Long"}${row.value ? ` <b>${e(row.value)}</b>` : ""}`;
}

/** What a line's requests sent, in one sentence. */
function retentionSaid(row: Pick<CacheSummaryRow, "retention_profile" | "parameter" | "value">): string {
  if (row.parameter && row.value) return `${row.retention_profile === "short" ? "Short" : "Long"} retention: the requests sent ${row.parameter}=${row.value}.`;
  return row.retention_profile === "short" ? "Short retention: the requests asked for no lifetime, so this is the provider's default cache." : "Long retention: a request that asks for a longer lifetime.";
}

/** Why a line has no results: nobody evaluated it, or the entry cannot do it. */
function notEvaluated(row: CacheSummaryRow, support: Summary["cache_retention"]): string {
  if (row.retention_profile === "long" && support === "unsupported") return '<span class="muted" title="The source says this entry does not cache prompts, so there is no lifetime to ask for.">Unsupported</span>';
  return `<span class="muted" title="${row.retention_profile === "long" ? "No evaluation on this entry asked for a longer lifetime. Not evaluated is not the same as unsupported." : "No evaluation on this entry left the lifetime to the provider."}">Not evaluated</span>`;
}

/** One line of the catalog's summary: the retention setting, then one cell per column with the hit rate in percent. */
function strip(row: CacheSummaryRow, support: Summary["cache_retention"]): string {
  const count = row.evaluations > 0 ? ` ${plural(row.evaluations, "evaluation")}, the newest on ${row.last_date}.` : "";
  const label = `<span class="strip-label${row.results ? "" : " none"}" title="${e(retentionSaid(row) + count)}">${retentionWord(row)}</span>`;
  if (!row.results) return `${label}<span class="strip-none">${notEvaluated(row, support)}</span>`;
  const results = row.results;
  const cells = COLUMNS.map((column) => {
    const result = inColumn(results, column);
    const control = column.kind === "control" ? " control" : "";
    if (!result) return `<span class="skip${control}" title="${column.kind === "control" ? "At once" : `After ${ageText(column.age_s)}`}: not checked"></span>`;
    return `<span class="${level(result)}${control}" title="${e(said(result))}">${Math.round(result.hit_rate_pct)}</span>`;
  }).join("");
  return `${label}<span class="strip">${cells}</span>`;
}

/** One evaluation as a line of the same cells (the evidence page). */
export function evaluationStrip(evaluation: Pick<CacheSummaryRow, "retention_profile" | "parameter" | "value"> & { results: CacheResult[]; date: string }): string {
  return `<span class="heat-strip">${strip({ ...evaluation, evaluations: 1, evaluation_ids: [], last_date: evaluation.date, results: evaluation.results }, "unknown")}</span>`;
}

/** The summary of an entry's cache evaluations for a table cell. The same lines and columns for every entry. */
function measuredCell(entry: Summary, href: string): string {
  if (!entry.cache_results) return '<span class="muted" title="No cache evaluation on this entry.">Not evaluated</span>';
  return `<a class="plain heat-strip" href="${e(href)}#cache" aria-label="Cache evaluations by age. Open the entry for each one.">${entry.cache_results.map((row) => strip(row, entry.cache_retention)).join("")}</a>`;
}

export interface RowOptions {
  now: Date;
  /** The date of the models.dev import, shown next to the models.dev source. */
  imported?: string;
  /** Leave the provider column out (on a provider's own page). */
  hideProvider?: boolean;
  providerNames?: Record<string, string>;
}

export function tableHead(options: { hideProvider?: boolean; sortable?: boolean; sort?: string; order?: string }): string {
  const column = (key: string | null, label: string, title: string, className = ""): string => {
    const current = key && options.sort === key ? ` aria-sort="${options.order === "desc" ? "descending" : "ascending"}"` : "";
    const inner =
      options.sortable && key
        ? `<button type="button" data-sort="${key}" title="${e(title)} Click to sort.">${label}<span class="arrow" aria-hidden="true"></span></button>`
        : `<span title="${e(title)}">${label}</span>`;
    return `<th scope="col" class="${className}"${current}>${inner}</th>`;
  };
  return `<tr>
${column("name", "Model", "The model's name and its id at this provider.")}
${options.hideProvider ? "" : column("provider", "Provider", "Who serves it, and how it is reached.")}
${column("context", "Context", "Exposed context window in tokens (limit.context): what this provider accepts for the model.", "num")}
${column("max_output", "Max output", "Largest single response in tokens (limit.output). A maximum, not a default.", "num")}
${column("price_in", "Price in / out", "List price in US dollars per million tokens, input then output, as models.dev records it. Before the changes some providers make by context size or service tier: open the entry for those. On a subscription entry, the line API price marks the price of the same model at the API.", "num mid-only")}
${column("release_date", "Released", "When the model was released, as models.dev records it. It is the model's date: the same at every provider.", "wide-only")}
${column(null, "Cache, documented", "Prompt caching as the source documents it: mode and lifetimes.")}
<th scope="col" class="strip-col"><span title="providers.dev evaluations, all clients together. Each cell is an age since the prompt was cached, starting with the prompt sent again at once; the number is the share of re-sends at that age that were served from the cache, in percent. Short: the requests asked for no lifetime. Long: they asked for a longer one, and the value is shown. Hover a cell for the counts.">Cache, measured <span class="muted">% by age</span></span>${STRIP_HEAD}</th>
${column("verified", "Source", "Where the entry comes from, with a date per source: the import from models.dev, and the newest providers.dev evidence.")}
</tr>`;
}

export function rowHtml(entry: Summary, options: RowOptions): string {
  const href = entryHref(entry.ref);
  const provider = options.providerNames?.[entry.provider] ?? entry.provider;
  const access = entry.access === "api" ? "" : ` <span class="badge ${entry.access}" title="Access: ${ACCESS_LABEL[entry.access]}">${ACCESS_LABEL[entry.access]}</span>`;
  const status = entry.status ? ` <span class="badge">${e(entry.status)}</span>` : "";
  return `<tr>
<th scope="row"><a href="${e(href)}">${e(entry.name)}</a>${status}<div class="id"><code>${e(entry.model)}</code>${copyButton(entry.ref, "entry id")}</div></th>
${options.hideProvider ? "" : `<td><a class="plain" href="/providers/${e(entry.provider)}/">${e(provider)}</a>${access}</td>`}
<td class="num">${contextCell(entry, href)}</td>
<td class="num">${tokens(entry.max_output)}</td>
<td class="num mid-only">${priceCell(entry)}</td>
<td class="wide-only">${entry.release_date ? `<span class="muted date">${e(entry.release_date)}</span>` : UNKNOWN}</td>
<td>${cacheCell(entry)}</td>
<td>${measuredCell(entry, href)}</td>
<td class="nowrap">${sourcesHtml(entry, options)}</td>
</tr>`;
}

// ---- prices (cost.text, as models.dev records it)

const record = (value: Json | undefined): JsonObject | undefined => (isObject(value) ? value : undefined);

function priceCell(entry: Pick<Summary, "price_in" | "price_out" | "price_from" | "access">): string {
  const { price_in: input, price_out: output } = entry;
  const plan = IN_PLAN;
  if (input === undefined && output === undefined) return entry.access === "subscription" ? plan : UNKNOWN;
  // A listed 0 is shown as the source has it. It can mean free, or paid for another way: the page does not decide.
  if ((input ?? 0) === 0 && (output ?? 0) === 0) {
    return entry.access === "subscription" ? plan : `<span class="price" title="The source lists a price of 0. That can mean free of charge, or paid for another way (a plan or a seat).">$0 <span class="muted">/</span> $0</span>`;
  }
  const price = `<span class="price">${input === undefined ? DASH : usd(input)} <span class="muted">/</span> ${output === undefined ? DASH : usd(output)}</span>`;
  if (!entry.price_from) return price;
  // Two short lines: the price, then whose price it is.
  return `<span class="price-inherited" title="Not what this entry costs: a subscription is not paid per token. This is the API list price of ${e(entry.price_from)}, inherited from it.">${price}<span class="price-from">API price</span></span>`;
}

/** A condition of a price change, in words. Undefined for the shapes not handled here: they stay in the raw data. */
function condition(value: Json | undefined): string | undefined {
  const when = record(value);
  if (!when || Object.keys(when).length !== 1) return undefined;
  const context = record(when.context);
  if (context && typeof context.gt === "number" && Object.keys(context).length === 1) return `Above ${exact(context.gt)} tokens of context`;
  const tier = record(when.service_tier);
  if (tier && typeof tier.equals === "string" && Object.keys(tier).length === 1) return `Service tier <code>${e(tier.equals)}</code>`;
  return undefined;
}

function cacheWrite(value: Json | undefined): string | undefined {
  if (typeof value === "number") return usd(value);
  const byLifetime = record(value);
  if (!byLifetime) return undefined;
  const parts = Object.entries(byLifetime).flatMap(([lifetime, amount]) => (typeof amount === "number" ? [`${usd(amount)} <span class="muted">for ${e(lifetime)}</span>`] : []));
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function priceSection(model: JsonObject, summary: Summary, source: string): string {
  const from = summary.price_from;
  if (from) source = `<span class="origin upstream" title="Inherited from ${e(from)}, where it is imported from models.dev.">inherited</span>`;
  const cost = record(model.cost);
  const words = record(cost?.text);
  const input = record(words?.input);
  const output = record(words?.output);
  // Every entry has the same table. What differs is said in a note above it.
  const priced = Boolean(input || output);
  const zero = priced && (summary.price_in ?? 0) === 0 && (summary.price_out ?? 0) === 0 && summary.price_in !== undefined;
  const absent = !priced && summary.access !== "api" ? IN_PLAN : UNKNOWN;
  const unit = typeof input?.unit === "string" ? `${e(input.unit)}s` : "tokens";
  const amount = (value: Json | undefined): string => (typeof value === "number" ? usd(value) : absent);
  const cache = record(input?.cache);
  const rows = [
    fact("Input", "<code>cost.text.input.price</code>", amount(input?.price), source),
    fact("Output", "<code>cost.text.output.price</code>", amount(output?.price), source),
    fact("Reasoning output", "<code>cost.text.output.reasoning</code>: stated where reasoning is priced apart from the rest of the output.", typeof output?.reasoning === "number" ? usd(output.reasoning) : absent, source),
    fact("Cached input, read", "<code>cost.text.input.cache.read</code>: input served from the prompt cache.", amount(cache?.read), source),
    fact("Cached input, write", "<code>cost.text.input.cache.write</code>: input stored in the prompt cache, by lifetime where it differs.", cacheWrite(cache?.write) ?? absent, source),
  ].join("");

  // Changes to those prices. Only the two common conditions are put in words; the rest stay in the raw data.
  const changes = new Map<string, string[]>();
  let other = 0;
  const add = (when: Json | undefined, part: string): void => {
    const key = condition(when);
    if (!key) other += 1;
    else changes.set(key, [...(changes.get(key) ?? []), part]);
  };
  for (const [side, value] of [["input", input], ["output", output]] as const) {
    for (const item of Array.isArray(value?.overrides) ? value.overrides : []) {
      const change = record(item);
      if (!change) continue;
      const parts = [typeof change.price === "number" ? `${side} ${usd(change.price)}` : ""];
      const changedCache = record(change.cache);
      if (typeof changedCache?.read === "number") parts.push(`cached read ${usd(changedCache.read)}`);
      add(change.when, parts.filter(Boolean).join(", "));
    }
  }
  for (const item of Array.isArray(cost?.multipliers) ? cost.multipliers : []) {
    const multiplier = record(item);
    const factor = record(multiplier?.factor);
    if (multiplier && typeof factor?.text === "number") add(multiplier.when, `every price × ${factor.text}`);
    else other += 1;
  }
  const list =
    changes.size > 0 || other > 0
      ? `<ul class="changes">${[...changes].map(([when, parts]) => `<li><strong>${when}:</strong> ${parts.join(", ")}</li>`).join("")}${
          other > 0 ? `<li class="muted">${plural(other, "more condition")} (by region, time or a mix): see <code>cost</code> in the full record below.</li>` : ""
        }</ul>`
      : `<p class="muted">${priced ? "None listed in the source: the prices above do not change by context size or service tier." : "None listed."}</p>`;
  const note = from
    ? `<p class="note">This entry is a subscription: it is <strong>not</strong> paid per token. These are the API list prices of <a href="${e(entryHref(from))}"><code>${e(from)}</code></a>, inherited so that a client can work out what the usage is worth.</p>`
    : !priced
      ? `<p class="note">${summary.access === "api" ? "The source gives no price per token for this entry. Unknown is not the same as free." : "No price per token: this entry is paid for through a plan or subscription. providers.dev does not list plans or their prices."}</p>`
      : zero
        ? `<p class="note">The source lists a price of 0 per token. ${summary.access === "subscription" ? "This entry is paid for through a plan or subscription, not per token." : "That can mean free of charge, or paid for another way (a plan or a seat): check the provider."} providers.dev does not list plans or their prices.</p>`
        : "";
  return `${note}<div class="scroll"><table class="facts">
    <thead><tr><th scope="col">Price</th><th scope="col" class="num">US dollars per million ${unit}</th><th scope="col">Source</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
  <p class="hint">List prices as the source records them. Other kinds of use (web search, audio, images, video) are priced in <code>cost</code> in the full record below. A subscription's price is not a price per token and is not listed.</p>
  <h3>Price changes</h3>
  ${list}`;
}

// ---- the entry detail view

function evidenceList(items: Evidence[]): string {
  return `<ul class="evidence">${items
    .map(
      (item) =>
        `<li><span class="badge ${item.kind}">${item.kind}</span> <a href="${e(item.url)}" rel="noopener">${e(shortUrl(item.url))}</a> <span class="muted date">${e(item.date)}</span>${item.note ? `<div class="hint">${e(item.note)}</div>` : ""}</li>`,
    )
    .join("")}</ul>`;
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.length > 46 ? `…${parsed.pathname.slice(-44)}` : parsed.pathname;
    return `${parsed.hostname}${path === "/" ? "" : path}${parsed.hash}`;
  } catch {
    return url;
  }
}

function show(value: Json | undefined): string {
  if (value === undefined) return '<span class="muted">nothing</span>';
  if (typeof value === "number") return exact(value);
  if (typeof value === "string") return e(value);
  return `<code>${e(JSON.stringify(value))}</code>`;
}

function sourceOf(path: string, provenance: Provenance[], origin: ModelExtension["origin"], measured: string[] = []): string {
  if (measured.some((field) => path === `limit.${field}`)) return '<span class="badge measured" title="Measured by providers.dev on this access. See the evaluation below.">measured</span>';
  const change = provenance.find((item) => item.path === path || path.startsWith(`${item.path}.`) || item.path.startsWith(`${path}.`));
  if (change) return `<span class="origin modified" title="Corrected by providers.dev. models.dev says: ${e(change.had_upstream ? JSON.stringify(change.upstream) : "nothing")}">providers.dev</span>`;
  if (origin === "added") return '<span class="origin added">providers.dev</span>';
  return '<span class="origin upstream" title="Imported from models.dev. Not independently checked.">models.dev</span>';
}

function fact(label: string, hint: string, value: string, source: string): string {
  // An unknown value has no source to name, unless it was published as unknown on purpose.
  if ((value === UNKNOWN || value === IN_PLAN) && !source.includes("Corrected")) source = DASH;
  return `<tr><th scope="row">${label}<div class="hint">${hint}</div></th><td class="num">${value}</td><td>${source}</td></tr>`;
}

/** One cell of a full-size table: the hit rate in percent with the counts under it, or the counts alone for one evaluation. */
function heatCell(result: CacheResult | undefined, column: (typeof COLUMNS)[number], counts: boolean): string {
  if (!result) return `<td class="heat"><span class="skip" title="${column.kind === "control" ? "At once" : `After ${ageText(column.age_s)}`}: not checked">·</span></td>`;
  const inner = counts ? `${result.hits}/${result.checks}` : `${Math.round(result.hit_rate_pct)}<small>${result.hits}/${result.checks}</small>`;
  return `<td class="heat"><span class="${level(result)}" title="${e(said(result))}">${inner}</span></td>`;
}

const HEAT_HEAD = `<th scope="col" class="age" title="${CONTROL_TITLE}">At once</th>${CACHE_AGES_S.map((age) => `<th scope="col" class="age">${shortAge(age)}</th>`).join("")}`;

/** Results at ages without a column, in words. Nothing an evaluation checked is left out of the page. */
function otherAges(results: readonly CacheResult[], counts: boolean): string {
  const others = results.filter((result) => !COLUMNS.some((column) => column.kind === result.kind && column.age_s === result.age_s));
  if (others.length === 0) return "";
  return `Also checked: ${others.map((result) => `${ageText(result.age_s)} ${counts ? "" : `${Math.round(result.hit_rate_pct)}% `}(${result.hits}/${result.checks})`).join(", ")}`;
}

/**
 * The cache evaluations of one entry: the summary table (the same lines and columns as in the catalog, with the counts
 * under each percentage), then every evaluation under it. Every entry has both, also where nothing was evaluated.
 */
function cacheMeasured(cache: EntryCache, now: Date): string {
  const columns = COLUMNS.length;
  const rows: CacheSummaryRow[] = cache.results ?? [
    { retention_profile: "short", parameter: null, value: null, evaluations: 0, evaluation_ids: [], last_date: null, results: null },
    { retention_profile: "long", parameter: null, value: null, evaluations: 0, evaluation_ids: [], last_date: null, results: null },
  ];
  const summary = rows
    .map((row) => {
      const sent = row.parameter && row.value ? `<code>${e(row.parameter)}=${e(row.value)}</code>` : row.retention_profile === "short" ? "No lifetime asked for" : "A longer lifetime asked for";
      const head = `<th scope="row">${row.retention_profile === "short" ? "Short" : "Long"}<div class="hint">${sent}${row.evaluations > 0 ? ` · ${plural(row.evaluations, "evaluation")}` : ""}</div>${row.results && otherAges(row.results, false) ? `<div class="hint">${e(otherAges(row.results, false))}</div>` : ""}</th>`;
      if (!row.results) return `<tr>${head}<td class="heat-none" colspan="${columns}">${notEvaluated(row, cache.retention.support)}</td></tr>`;
      const results = row.results;
      return `<tr>${head}${COLUMNS.map((column) => heatCell(inColumn(results, column), column, false)).join("")}</tr>`;
    })
    .join("");
  const evaluations = cache.evaluations
    .map((run) => {
      const settings = settingsText(run.request_settings);
      const other = otherAges(run.results, true);
      return `<tr>
<th scope="row">${e(run.route_label)} ${dateTag(run.date, now)}<div class="hint">${e(run.client_label)}${settings ? ` · ${e(settings)}` : ""}</div><div class="hint">${run.retention_profile === "short" ? "Short" : "Long"} retention${run.parameter && run.value ? `: <code>${e(run.parameter)}=${e(run.value)}</code>` : ""}${other ? ` · ${e(other)}` : ""}</div>${run.note ? `<div class="hint">${e(run.note)}</div>` : ""}</th>
${COLUMNS.map((column) => heatCell(inColumn(run.results, column), column, true)).join("")}
<td class="nowrap"><a href="${e(run.source)}" rel="noopener">Raw result</a></td>
</tr>`;
    })
    .join("");
  return `<p class="hint max-w-3xl">An evaluation caches a fresh prompt, sends it again at once, and then again at set ages. A cell is the share of those re-sends that were served from the cache, in percent, with the counts under it. Short is the cache a request gets without asking for a lifetime; Long is what it gets when it asks for a longer one.</p>
<div class="scroll mt-3"><table class="facts heat summary"><thead><tr><th scope="col" rowspan="2">Retention</th><th scope="colgroup" colspan="${columns}" class="span">Time since the prompt was cached · served from the cache, in percent</th></tr><tr>${HEAT_HEAD}</tr></thead><tbody>${summary}</tbody></table></div>
<p class="legend"><span><span class="heat-key all">100</span> All served from the cache</span><span><span class="heat-key most">67</span> Half or more</span><span><span class="heat-key few">33</span> Fewer</span><span><span class="heat-key none">0</span> None</span><span><span class="heat-key skip">·</span> Not checked at that age</span></p>
<details class="evaluations"${cache.evaluations.length > 0 ? " open" : ""}><summary>Individual evaluations (${cache.evaluations.length})</summary>
${
  cache.evaluations.length > 0
    ? `<div class="scroll mt-3"><table class="facts heat"><thead><tr><th scope="col" rowspan="2">Evaluation</th><th scope="colgroup" colspan="${columns}" class="span">Time since the prompt was cached · re-sends served from the cache, of those made</th><th scope="col" rowspan="2">Evidence</th></tr><tr>${HEAT_HEAD}</tr></thead><tbody>${evaluations}</tbody></table></div>`
    : '<p class="muted mt-3">No evaluations on this entry.</p>'
}
</details>
<p class="hint">A result holds for the access method and client named, on that date. It is what was observed, not a guaranteed lifetime. <a href="/docs/methodology/#evaluations">How evaluations work</a></p>`;
}

/** What a request can do about the cache lifetime. The same rows on every entry. */
function retentionTable(retention: CacheRetention): string {
  const support = { supported: "Supported", unsupported: '<span class="muted">Unsupported</span>', unknown: UNKNOWN }[retention.support];
  const none = retention.support === "unsupported" ? NOT_APPLICABLE : UNKNOWN;
  const profile = (name: "short" | "long"): string => {
    const items = retention.profiles.filter((item) => item.profile === name);
    if (items.length === 0) return none;
    return items.map((item) => (item.value === null ? "Leave the parameter out" : `<code>${e(item.value)}</code>`)).join(", ");
  };
  const row = (label: string, hint: string, value: string): string => `<tr><th scope="row">${label}<div class="hint">${hint}</div></th><td>${value}</td></tr>`;
  const evidence =
    retention.evidence.length > 0
      ? `<ul class="evidence">${retention.evidence.map((item) => `<li><span class="badge ${item.kind}">${item.kind}</span> <a href="${e(item.url)}" rel="noopener">${e(shortUrl(item.url))}</a>${item.date ? ` <span class="muted date">${e(item.date)}</span>` : ""}<div class="hint">${e(item.note)}</div></li>`).join("")}</ul>`
      : none;
  return `<div class="scroll"><table class="facts"><thead><tr><th scope="col">Retention</th><th scope="col">Value</th></tr></thead><tbody>
${row("Support", "<code>support</code>: whether a request can ask for a cache lifetime on this entry.", support)}
${row("Parameter", "<code>parameter</code>: the request field, and where it goes.", retention.parameter ? `<code>${e(retention.parameter.name)}</code><div class="hint">${e(retention.parameter.location)}</div>` : none)}
${row("Accepted values", "<code>accepted_values</code>: documented, or accepted in an evaluation.", retention.accepted_values ? retention.accepted_values.map((value) => `<code>${e(value)}</code>`).join(", ") : none)}
${row("Default", "<code>default</code>: the lifetime when the parameter is left out.", retention.default ? `<code>${e(retention.default)}</code>` : none)}
${row("Short", "<code>profiles</code>: what gives the short retention.", profile("short"))}
${row("Long", "<code>profiles</code>: what gives the long retention.", profile("long"))}
${row("Conditions", "<code>conditions</code>: a client, protocol or header this depends on.", retention.conditions.length > 0 ? retention.conditions.map(e).join("<br>") : retention.support === "unknown" ? UNKNOWN : "None recorded")}
${row("Evidence", "<code>evidence</code>: the source of the rows above, and its date.", evidence)}
</tbody></table></div>
<p class="hint">Supported means the access method accepts the value. The lifetime it then gives is in the measured results below, not here.</p>`;
}

function measuredLimitRows(limits: MeasuredLimit[]): string {
  return limits
    .map((limit) => {
      const parts = [
        limit.context !== undefined ? `Context ${exact(limit.context)}` : "",
        limit.output !== undefined ? `output ${exact(limit.output)}` : "",
        limit.input_accepted !== undefined ? `accepted an input of ${exact(limit.input_accepted)}` : "",
        limit.input_refused !== undefined ? `refused an input of ${exact(limit.input_refused)}` : "",
        limit.output_accepted !== undefined ? `accepted a requested output of ${exact(limit.output_accepted)}` : "",
      ].filter(Boolean);
      const text = parts.join("; ");
      return `<tr><td>${limit.date ? `<span class="muted date">${e(limit.date)}</span>` : '<span class="muted">Undated</span>'}</td><td>${e(limit.route_label)}<div class="hint">${e(limit.client_label)}</div></td><td class="wide">${e(text.charAt(0).toUpperCase() + text.slice(1))} <span class="muted">tokens</span>${limit.note ? `<div class="hint">${e(limit.note)}</div>` : ""}</td><td><a href="${e(limit.source)}" rel="noopener">Raw result</a></td></tr>`;
    })
    .join("");
}

/** Documented caching. Every entry has the same table: one row for each way of caching, supported or not. */
function cacheDocumented(model: JsonObject, provenance: Provenance[], origin: ModelExtension["origin"]): string {
  const capabilities = isObject(model.capabilities) ? model.capabilities : {};
  const cache = capabilities.cache;
  const source = sourceOf("capabilities.cache", provenance, origin);
  const known = cache === false || isObject(cache);
  const rows = (["implicit", "explicit"] as const).map((mode) => {
    const value = isObject(cache) ? cache[mode] : undefined;
    const supported = value !== undefined && value !== false;
    const detail = isObject(value) ? value : {};
    const state = !known
      ? UNKNOWN
      : supported
        ? "Supported"
        : `<span class="muted" title="${cache === false ? "The source says this entry does not cache prompts." : "The source lists the other way of caching only. A way it does not list is not supported."}">Unsupported</span>`;
    const ttl = Array.isArray(detail.ttl) && detail.ttl.length > 0 ? detail.ttl.map((item) => `<span class="chip">${e(String(item))}</span>`).join(" ") : UNKNOWN;
    // A way of caching the entry does not have has no details; where the source says nothing, the details are unknown too.
    const blank = known ? NOT_APPLICABLE : UNKNOWN;
    return `<tr>
<th scope="row">${CACHE_MODE_WORD[mode]} <span class="chip">${mode}</span><div class="hint">${mode === "implicit" ? "The provider caches on its own." : "The request marks what to cache."}</div></th>
<td>${state}</td>
<td>${supported ? ttl : blank}</td>
<td class="num">${supported ? (typeof detail.min_tokens === "number" ? exact(detail.min_tokens) : UNKNOWN) : blank}</td>
<td class="num">${supported && mode === "explicit" ? (typeof detail.max_breakpoints === "number" ? exact(detail.max_breakpoints) : UNKNOWN) : mode === "implicit" && known ? NOT_APPLICABLE : blank}</td>
<td>${supported && mode === "explicit" ? (Array.isArray(detail.targets) ? e(detail.targets.join(", ")) : UNKNOWN) : mode === "implicit" && known ? NOT_APPLICABLE : blank}</td>
</tr>`;
  });
  const foot = !known
    ? origin === "added"
      ? "No documentation is recorded for this access method. That is not the same as no caching."
      : "models.dev says nothing about caching for this entry. That is not the same as no caching."
    : cache === false
      ? `Documented: no prompt caching on this entry. Source: ${source}`
      : `Documented values. Source: ${source} Whether a cache read renews the lifetime is not recorded in the source.`;
  return `<div class="scroll"><table class="facts"><thead><tr><th scope="col">Mode</th><th scope="col">Supported</th><th scope="col">Lifetimes</th><th scope="col" class="num">Min. tokens</th><th scope="col" class="num">Breakpoints</th><th scope="col">Targets</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>
<p class="hint">${foot}</p>`;
}

function tile(label: string, value: string, foot: string, small = false): string {
  return `<div class="tile"><div class="label">${label}</div><div class="value${small ? " small" : ""}">${value}</div><div class="foot">${foot}</div></div>`;
}

export interface EntryView {
  summary: Summary;
  provider: ProviderSummary;
  model: JsonObject;
  now: Date;
  /** The date of the models.dev import. */
  imported?: string;
}

export function entryHtml(view: EntryView): string {
  const { summary, provider, model, now } = view;
  const extension = model[NS] as unknown as ModelExtension;
  const provenance = extension.provenance ?? [];
  const limit = isObject(model.limit) ? model.limit : {};
  const cache = extension.cache;
  const runs = cache.evaluations;
  const measuredLimits = extension.limits?.measured ?? [];
  const fromMeasurement = extension.limits?.from_measurement ?? [];
  const number = (value: Json | undefined): string => (typeof value === "number" ? `${exact(value)} <span class="muted">tokens</span>` : UNKNOWN);
  const big = (value: Json | undefined): string => (typeof value === "number" ? `${exact(value)} <span class="unit">tokens</span>` : '<span class="muted">Unknown</span>');
  const api = `/api/v1${entryHref(summary.ref)}`;
  const newest = (cache.results ?? []).map((row) => row.last_date).filter((date): date is string => date !== null).sort().at(-1);
  const measuredValue = summary.evaluation_count === 0 ? '<span class="muted">Not evaluated</span>' : plural(summary.evaluation_count, "evaluation");
  const measuredFoot = summary.evaluation_count === 0 ? "No evaluations on this entry" : `The newest on ${newest}`;
  const cacheTile =
    summary.cache === "unknown"
      ? '<span class="muted">Unknown</span>'
      : summary.cache === "no"
        ? "None"
        : `${summary.cache_modes.map((mode, at) => (at === 0 ? CACHE_MODE_WORD[mode] : CACHE_MODE_WORD[mode].toLowerCase())).join(" + ")}${summary.cache_ttl_s.length > 0 ? ` <span class="unit">${summary.cache_ttl_s.map(duration).join(", ")}</span>` : ""}`;

  const inherited = extension.inherited
    ? `<p class="note">Name, family and dates are taken from <a href="${e(entryHref(extension.inherited.from))}"><code>${e(extension.inherited.from)}</code></a>. Limits and caching are <strong>not</strong> copied from it, because this access method can differ.${extension.inherited.fields.includes("cost") ? " The prices are that entry's API list prices, marked as inherited." : ""}</p>`
    : "";

  return `
<header class="entry-head">
  <p class="crumbs"><a href="/providers/">Providers</a> / <a href="/providers/${e(provider.id)}/">${e(provider.name)}</a>${summary.canonical_id ? ` · <a href="${e(modelHref(summary.canonical_id))}">All access methods for ${e(summary.canonical_id)}</a>` : ""}</p>
  <h1>${e(summary.name)}</h1>
  <p class="id"><code>${e(summary.ref)}</code>${copyButton(summary.ref, "entry id")} <span class="badge ${summary.access}">${ACCESS_LABEL[summary.access]}</span>
  ${sourcesHtml(summary, view, true)}${summary.status ? ` <span class="badge">${e(summary.status)}</span>` : ""}</p>
  <p class="released muted">${
    summary.release_date
      ? `Released <span class="date" title="The model's release date, as models.dev records it. It is the same at every provider.">${e(summary.release_date)}</span>`
      : "Release date unknown"
  }</p>
  ${typeof model.description === "string" ? `<p class="lead">${e(model.description)}</p>` : ""}
  ${inherited}
</header>

<div class="tiles mt-6">
  ${tile("Context window", big(limit.context), "Exposed by this provider")}
  ${tile("Maximum output", big(limit.output), "Per response; not a default")}
  ${tile("Prompt cache, documented", cacheTile, summary.cache === "unknown" ? "The source does not say" : "As documented", true)}
  ${tile("Prompt cache, measured", measuredValue, measuredFoot, true)}
</div>

<section aria-labelledby="limits">
  <h2 id="limits">Limits</h2>
  <h3>Documented</h3>
  <div class="scroll"><table class="facts">
    <thead><tr><th scope="col">Limit</th><th scope="col" class="num">Value</th><th scope="col">Source</th></tr></thead>
    <tbody>
      ${fact("Context window", "<code>limit.context</code>: what this provider accepts for the model, input and output together.", number(limit.context), sourceOf("limit.context", provenance, extension.origin, fromMeasurement))}
      ${fact("Largest input", "<code>limit.input</code>: stated where the input limit is lower than the context window.", number(limit.input), sourceOf("limit.input", provenance, extension.origin))}
      ${fact("Maximum output", "<code>limit.output</code>: the most one response can hold. A maximum, not what you get by default.", number(limit.output), sourceOf("limit.output", provenance, extension.origin, fromMeasurement))}
    </tbody>
  </table></div>
  <p class="hint">Usable context is smaller than the window by the system prompt and tool definitions of the client in use. That overhead varies, so no usable figure is published. An agent's compaction threshold is a client setting, not a limit of this entry.</p>
  <h3>Measured</h3>
  <div class="scroll"><table class="facts"><thead><tr><th scope="col">Date</th><th scope="col">Measured through</th><th scope="col">Result</th><th scope="col">Evidence</th></tr></thead><tbody>${
    measuredLimits.length > 0 ? measuredLimitRows(measuredLimits) : '<tr class="empty-row"><td colspan="4" class="muted">No limits were measured on this entry.</td></tr>'
  }</tbody></table></div>
</section>

<section aria-labelledby="price">
  <h2 id="price">Price</h2>
  ${priceSection(model, summary, sourceOf("cost", provenance, extension.origin))}
</section>

<section aria-labelledby="cache">
  <h2 id="cache">Prompt caching</h2>
  <h3>Documented</h3>
  ${cacheDocumented(model, provenance, extension.origin)}
  <h3>Retention</h3>
  ${retentionTable(cache.retention)}
  <h3>Measured</h3>
  ${cacheMeasured(cache, now)}
</section>

<section aria-labelledby="provenance">
  <h2 id="provenance">Provenance</h2>
  ${
    extension.origin === "added"
      ? `<p>models.dev has no entry for this access method. Every value here is published by providers.dev.</p>${evidenceList(extension.evidence ?? [])}`
      : provenance.length === 0
        ? `<p>Every documented field is imported from models.dev as is and has not been independently checked.${runs.length + measuredLimits.length > 0 ? " The providers.dev evaluations above are shown next to the documented values and replace none of them." : ""}</p>`
        : `<p>Imported from models.dev, with these corrections by providers.dev:</p>`
  }
  ${provenance
    .map(
      (change) => `<div class="change">
    <p><code>${e(change.path)}</code> ${change.op === "set" ? `is <strong>${show(change.value)}</strong>` : change.op === "unknown" ? "is published as <strong>unknown</strong>" : "is <strong>removed</strong>"}. models.dev says: ${change.had_upstream ? show(change.upstream) : '<span class="muted">nothing</span>'}.</p>
    <p class="muted">${e(change.reason)}</p>
    ${evidenceList(change.evidence)}
  </div>`,
    )
    .join("")}
</section>

<section aria-labelledby="raw">
  <h2 id="raw">Data</h2>
  <p><a href="${e(api)}"><code>GET ${e(api)}</code></a> ${copyButton(api, "API path")}</p>
  <details class="mt-3"><summary class="hint">Show the full entry as published</summary><pre class="mt-2">${e(JSON.stringify(model, null, 2))}</pre></details>
</section>`;
}
