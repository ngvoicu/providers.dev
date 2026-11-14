// HTML for the entry table and the entry detail view. The same functions render server responses and
// re-render in the browser, so a row looks and reads the same wherever it appears.
import { CACHE_AGES_S, settingsText, type CacheDocumentation, type CacheResult, type CacheSummaryRow, type EntryCache } from "./cache.ts";
import type { ProviderSummary, Summary } from "./entries.ts";
import { conditionText } from "./conditions.ts";
import type { PricingRule, RequestControl } from "./policy-contract.ts";
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
import { NS, type MeasuredLimit, type ModelExtension, type Provenance, type PublishedEvidence } from "./schema.ts";

const UNKNOWN = '<span class="unknown" title="The source does not say. Unknown is not zero and not unlimited.">Unknown</span>';
const DASH = '<span class="muted">–</span>';
/** Every entry page has the same rows. These fill a row whose value the source does not give. */
const NOT_APPLICABLE = '<span class="muted" title="This field does not apply to this entry.">Not applicable</span>';
/** A list with nothing in it: a known nothing, not a missing value. */
const NONE = '<span class="muted">None</span>';
const IN_PLAN = '<span class="muted" title="No price per token: the entry is paid for through a plan or subscription, which providers.dev does not list.">In plan</span>';
const ACCESS_LABEL = { api: "API key", subscription: "Subscription", unknown: "Unclassified" } as const;

function tokens(value: number | null): string {
  return value === null ? UNKNOWN : `<span title="${exact(value)} tokens">${compactTokens(value)}</span>`;
}

function copyButton(value: string, label: string): string {
  return `<button type="button" class="copy" data-copy="${e(value)}" aria-label="Copy ${e(label)}" title="Copy ${e(label)}">Copy</button>`;
}

function dateTag(date: string | null, now: Date): string {
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
      const ttl = entry.cache_ttl_by_mode_s[mode] ?? [];
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
  if (entry.context !== null || accepted === null) return tokens(entry.context);
  // Rounded down: "at least" must stay true.
  const floor = compactTokens(Math.floor(accepted / 1000) * 1000);
  const refused = entry.measured_input_refused;
  const title = `Measured, not documented: no window is documented for this entry. An evaluation saw an input of ${exact(accepted)} tokens accepted${refused === null ? "" : ` and one of ${exact(refused)} refused`}. Input only: the output comes on top.`;
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
${column("price_in", "Price in / out", "Base list price in US dollars per million tokens, input then output, as models.dev records it. Conditional rates marks an entry whose price changes with context size, service tier, region, date or the time of day: open the entry for those. A subscription is not paid per token: it shows the API list price of the same model, marked API price, or In plan where the catalog has no API entry of that model.", "num mid-only")}
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

// ---- prices: `pricing` as the API publishes it. Nothing here multiplies or compares: a multiplier's prices are its
// `resulting_rates`, and a time rule's name is its `period`.

const LISTED_PRICE = "The price models.dev lists for this entry. The entry is a subscription; what the listed price bills is not established.";

function priceCell(entry: Pick<Summary, "price_in" | "price_out" | "price_from" | "access" | "pricing">): string {
  const { price_in: input, price_out: output } = entry;
  const conditional = entry.pricing.rules?.some((rule) => rule.when !== null || rule.operation === "multiply");
  const conditionNote = conditional ? '<div class="hint">Conditional rates</div>' : "";
  // A subscription entry with no API entry of the same model to refer to has no price per token at all.
  if (input === null && output === null) return (entry.pricing.billing === "not_applicable" ? IN_PLAN : UNKNOWN) + conditionNote;
  // A listed 0 is shown as the source has it. It can mean free, or paid for another way: the page does not decide.
  const price = `<span class="price">${input === null ? DASH : usd(input)} <span class="muted">/</span> ${output === null ? DASH : usd(output)}</span>${conditionNote}`;
  // Two short lines: the price, then whose price it is.
  if (entry.price_from) {
    return `<span class="price-inherited" title="Not what this entry costs: a subscription is not paid per token. This is the API list price of ${e(entry.price_from)}.">${price}<span class="price-from">API price</span></span>`;
  }
  if (entry.access === "subscription") return `<span class="price-inherited" title="${e(LISTED_PRICE)}">${price}<span class="price-from">Listed price</span></span>`;
  return price;
}

const METER_ORDER = ["text.input", "text.output", "text.reasoning_output", "text.cache_read", "text.cache_write", "text.cache_storage"];
const METER_LABEL: Record<string, string> = { "text.input": "Input", "text.output": "Output", "text.reasoning_output": "Reasoning output", "text.cache_read": "Cache read", "text.cache_write": "Cache write", "text.cache_storage": "Cache storage", "text.*": "All text charges", "*": "All charges" };
const meterLabel = (meter: string): string => METER_LABEL[meter] ?? meter;
const meterRank = (meter: string): number => { const at = METER_ORDER.indexOf(meter); return at === -1 ? METER_ORDER.length : at; };
const PERIOD_LABEL = { peak: "Peak hours", off_peak: "Off-peak hours" } as const;
const APPLIES_TO = { all_usage: "Whole request", above_threshold: "Only the part above the threshold" } as const;

/** "$2 / 1M tokens". */
function rateHtml(rate: Pick<PricingRule, "amount" | "currency" | "unit">): string {
  const amount = rate.currency === "USD" ? usd(rate.amount) : `${e(rate.currency ?? "Currency unknown")} ${e(String(rate.amount))}`;
  if (!rate.unit) return `${amount} <span class="muted">· unit unknown</span>`;
  const { name, quantity } = rate.unit;
  const per = quantity === null ? `${name}s · quantity unknown` : quantity === 1 ? name : `${quantity === 1000000 ? "1M" : quantity === 1000 ? "1K" : exact(quantity)} ${name}s`;
  return `${amount} <span class="muted">/ ${e(per)}</span>`;
}

/** A cache write price that differs by lifetime only is a base price with a lifetime, not a conditional rate. */
function lifetimeOf(rule: PricingRule): string | null {
  const when = rule.when;
  if (rule.operation !== "set" || when?.kind !== "predicate" || when.op !== "eq") return null;
  if (when.field === "cache.retention_s" && typeof when.value === "number") return duration(when.value);
  return when.field === "cache.retention_value" && typeof when.value === "string" ? when.value : null;
}

function priceSection(summary: Summary): string {
  const pricing = summary.pricing;
  const rules = pricing.rules ?? [];
  const base = rules.filter((rule) => rule.when === null && rule.operation === "set");
  const byLifetime = rules.filter((rule) => lifetimeOf(rule) !== null);
  const conditional = rules.filter((rule) => (rule.when !== null || rule.operation === "multiply") && lifetimeOf(rule) === null);
  // Every entry has the same five rows; a charge the source prices beyond them gets a row too.
  const meters = [...new Set([...METER_ORDER.slice(0, 5), ...base.map((rule) => rule.meter), ...byLifetime.map((rule) => rule.meter)])].sort((a, b) => meterRank(a) - meterRank(b));
  const absent = pricing.billing === "not_applicable" ? IN_PLAN : UNKNOWN;
  const rows = meters
    .map((meter) => {
      const own = base.filter((rule) => rule.meter === meter).map(rateHtml);
      const lifetimes = byLifetime.filter((rule) => rule.meter === meter).map((rule) => `${rateHtml(rule)} <span class="muted">· ${e(lifetimeOf(rule)!)} lifetime</span>`);
      const value = [...own, ...lifetimes];
      return `<tr><th scope="row">${e(meterLabel(meter))}</th><td class="num">${value.length ? value.join("<br>") : absent}</td></tr>`;
    })
    .join("");

  // One block per condition, in the order of the API: its charges and what each costs when the condition holds.
  const groups = new Map<string, PricingRule[]>();
  for (const rule of conditional) {
    const key = JSON.stringify(rule.when);
    groups.set(key, [...(groups.get(key) ?? []), rule]);
  }
  const changes = [...groups.values()]
    .map((members) => {
      const first = members[0]!;
      const lines = members
        .flatMap((rule) => {
          if (rule.operation === "set") return [{ meter: rule.meter, rate: rateHtml(rule) }];
          const factor = `<span class="muted">· × ${e(String(rule.amount))}</span>`;
          if (!rule.resulting_rates) return [{ meter: rule.meter, rate: `× ${e(String(rule.amount))}` }];
          return rule.resulting_rates.map((rate) => ({ meter: rate.meter, rate: `${rateHtml(rate)} ${factor}` }));
        })
        .sort((a, b) => meterRank(a.meter) - meterRank(b.meter));
      const period = members.find((rule) => rule.period !== null)?.period;
      const label = period ? `<strong>${PERIOD_LABEL[period]}</strong><div class="hint">${e(first.when ? conditionText(first.when) : "")}</div>` : e(first.when ? conditionText(first.when) : "Always");
      const applies = members.every((rule) => rule.applies_to === first.applies_to) && first.applies_to ? APPLIES_TO[first.applies_to] : UNKNOWN;
      const span = lines.length > 1 ? ` rowspan="${lines.length}"` : "";
      return lines.map((line, at) => `<tr${at === 0 ? ' class="group"' : ""}>${at === 0 ? `<th scope="rowgroup"${span}>${label}</th>` : ""}<td>${e(meterLabel(line.meter))}</td><td class="num">${line.rate}</td>${at === 0 ? `<td${span}>${applies}</td>` : ""}</tr>`).join("");
    })
    .join("");
  const none = pricing.coverage === "complete" ? "No conditional rates." : pricing.billing === "not_applicable" ? "Not applicable: the entry has no price per token." : "No conditional rates recorded.";
  const note = pricing.reference_ref
    ? `<p class="hint">API list prices of <a href="${e(entryHref(pricing.reference_ref))}"><code>${e(pricing.reference_ref)}</code></a>. This entry is a subscription and is not paid per token.</p>`
    : summary.access === "subscription" && pricing.rules !== null
      ? `<p class="hint">${e(LISTED_PRICE)}</p>`
      : "";
  const source = pricing.evidence.map((item) => `<a href="${e(item.url)}" rel="noopener">${e(shortUrl(item.url))}</a>${item.date ? ` <span class="date">${e(item.date)}</span>` : ""}`).join(" · ");
  return `${note}<div class="scroll"><table class="facts"><thead><tr><th scope="col">Base charge</th><th scope="col" class="num">Rate</th></tr></thead><tbody>${rows}</tbody></table></div>
<h3>Conditional rates</h3>
<div class="scroll"><table class="facts conditional"><thead><tr><th scope="col">Condition</th><th scope="col">Charge</th><th scope="col" class="num">Rate</th><th scope="col">Applies to</th></tr></thead><tbody>${changes || `<tr class="empty-row"><td colspan="4" class="muted">${none}</td></tr>`}</tbody></table></div>
<p class="hint">Source: ${source || (pricing.billing === "not_applicable" ? NOT_APPLICABLE : UNKNOWN)}</p>
<details><summary>Other prices in the source, not shown above (${pricing.unparsed.length})</summary>${pricing.unparsed.length ? `<pre>${e(JSON.stringify(pricing.unparsed, null, 2))}</pre>` : `<p class="muted mt-3">${NONE}</p>`}</details>`;
}

function evidenceList(items: PublishedEvidence[]): string {
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

function show(value: Json): string {
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
  return `<p class="hint">Cache hits by age: percentage, with hits/checks below. Rows are grouped by requested retention. <a href="/docs/methodology/#evaluations">Methodology</a></p>
<div class="scroll mt-3"><table class="facts heat summary"><thead><tr><th scope="col" rowspan="2">Retention</th><th scope="colgroup" colspan="${columns}" class="span">Time since the prompt was cached · served from the cache, in percent</th></tr><tr>${HEAT_HEAD}</tr></thead><tbody>${summary}</tbody></table></div>
<p class="legend"><span><span class="heat-key all">100</span> All served from the cache</span><span><span class="heat-key most">67</span> Half or more</span><span><span class="heat-key few">33</span> Fewer</span><span><span class="heat-key none">0</span> None</span><span><span class="heat-key skip">·</span> Not checked at that age</span></p>
<details class="evaluations"><summary>Individual evaluations (${cache.evaluations.length})</summary>
<div class="scroll mt-3"><table class="facts heat"><thead><tr><th scope="col" rowspan="2">Evaluation</th><th scope="colgroup" colspan="${columns}" class="span">Time since the prompt was cached · re-sends served from the cache, of those made</th><th scope="col" rowspan="2">Evidence</th></tr><tr>${HEAT_HEAD}</tr></thead><tbody>${evaluations || `<tr class="empty-row"><td colspan="${columns + 2}" class="muted">No evaluations on this entry.</td></tr>`}</tbody></table></div>
</details>`;
}

/** A JSON Pointer into the request body as the field a developer writes: /cache_control/ttl -> cache_control.ttl. */
const dotted = (pointer: string): string => pointer.replace(/^\//, "").split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~")).join(".");
const fieldOf = (binding: { location: string; path: string }): string => (binding.location === "body" ? dotted(binding.path) : binding.path);
const BINDING_PLACE = { body: "Request body", header: "Request header", query: "Query string" } as const;
const BINDING_SCOPE = { content_block: ", on a content block", request: ", top level" } as const;
const jsonText = (value: Json): string => (typeof value === "string" ? value : JSON.stringify(value));
const CONTROL_LABEL: Record<string, string> = { "cache.retention": "Cache retention", service_tier: "Service tier" };

/**
 * What a request can set, one row per control. The same columns on every entry: a control nobody documented says
 * Unknown in each of them. The sources of the rows are named under the table.
 */
function requestControlTable(controls: RequestControl[]): string {
  const rows = controls.map((control) => {
    const support = { supported: "Supported", unsupported: "Unsupported", unknown: UNKNOWN }[control.support];
    const absent = control.support === "unsupported" ? NOT_APPLICABLE : UNKNOWN;
    const bindings = control.bindings?.map((binding) => `<code>${e(fieldOf(binding))}</code><div class="hint">${BINDING_PLACE[binding.location]}${binding.location === "body" && binding.scope ? BINDING_SCOPE[binding.scope] : ""}</div>`).join("") || absent;
    const options = control.options?.map((option) => {
      const profile = option.attributes?.profile;
      const name = profile === "short" ? "Short: " : profile === "long" ? "Long: " : "";
      const value = option.value === null ? "leave the field out" : `<code>${e(jsonText(option.value))}</code>`;
      // The exact fields an option is sent with, where they are more than the field itself: a companion field or header.
      const sent = (option.settings ?? []).length > 1 ? option.settings!.map((setting) => `${fieldOf(setting)}${setting.location === "header" ? ": " : "="}${jsonText(setting.value)}`).join(", ") : "";
      return `<div>${name}${value}${sent ? `<div class="hint"><code>${e(sent)}</code></div>` : ""}${option.when ? `<div class="hint">${e(conditionText(option.when))}</div>` : ""}</div>`;
    }).join("") || absent;
    const conditions = [control.when ? conditionText(control.when) : "", ...control.conditions].filter(Boolean).map(e).join("<br>") || (control.support === "unknown" ? UNKNOWN : "None recorded");
    return `<tr><th scope="row">${e(CONTROL_LABEL[control.id] ?? control.id)}</th><td>${support}</td><td>${bindings}</td><td>${options}</td><td>${control.default === null ? absent : `<code>${e(jsonText(control.default.value))}</code>`}</td><td>${conditions}</td></tr>`;
  }).join("");
  const sources = controls.flatMap((control) => control.evidence).filter((item, at, all) => all.findIndex((other) => other.url === item.url && other.date === item.date) === at);
  const source = sources.map((item) => `<a href="${e(item.url)}" rel="noopener" title="${e(item.note)}">${e(shortUrl(item.url))}</a>${item.date ? ` <span class="date">${e(item.date)}</span>` : ""}`).join(" · ");
  return `<div class="scroll"><table class="facts"><thead><tr><th scope="col">Control</th><th scope="col">Support</th><th scope="col">Request field</th><th scope="col">Accepted values</th><th scope="col">Default</th><th scope="col">Conditions</th></tr></thead><tbody>${rows}</tbody></table></div>
<p class="hint">Source: ${source || UNKNOWN}</p>`;
}

function measuredLimitRows(limits: MeasuredLimit[]): string {
  const cell = (value: number | null): string => `<td class="num">${value === null ? UNKNOWN : exact(value)}</td>`;
  return limits.map((limit) => `<tr><td>${limit.date ? `<span class="muted date">${e(limit.date)}</span>` : UNKNOWN}</td><td>${e(limit.route_label)}<div class="hint">${e(limit.client_label)}</div></td>${cell(limit.context)}${cell(limit.input_accepted)}${cell(limit.input_refused)}${cell(limit.output)}${cell(limit.output_accepted)}<td><a href="${e(limit.source)}" rel="noopener">Raw result</a></td></tr>`).join("");
}

/** Documented caching. Every entry has the same table: one row for each way of caching, supported or not. */
function cacheDocumented(documented: CacheDocumentation, source: string): string {
  const rows = (["implicit", "explicit"] as const).map((mode) => {
    const detail = documented.modes[mode];
    const state = { supported: "Supported", unsupported: '<span class="muted">Unsupported</span>', unknown: UNKNOWN }[detail.support];
    const supported = detail.support === "supported";
    const ttl = detail.ttl === null ? UNKNOWN : detail.ttl.length > 0 ? detail.ttl.map((item) => `<span class="chip">${e(item)}</span>`).join(" ") : "None listed";
    const blank = detail.support === "unsupported" ? NOT_APPLICABLE : UNKNOWN;
    return `<tr>
<th scope="row">${CACHE_MODE_WORD[mode]} <span class="chip">${mode}</span></th>
<td>${state}</td>
<td>${supported ? ttl : blank}</td>
<td class="num">${supported ? (detail.min_tokens === null ? UNKNOWN : exact(detail.min_tokens)) : blank}</td>
<td class="num">${supported && mode === "explicit" ? (detail.max_breakpoints === null ? UNKNOWN : exact(detail.max_breakpoints)) : supported ? NOT_APPLICABLE : blank}</td>
<td>${supported && mode === "explicit" ? (detail.targets === null ? UNKNOWN : e(detail.targets.join(", "))) : supported ? NOT_APPLICABLE : blank}</td>
</tr>`;
  });
  return `<div class="scroll"><table class="facts"><thead><tr><th scope="col">Mode</th><th scope="col">Supported</th><th scope="col">Lifetimes</th><th scope="col" class="num">Min. tokens</th><th scope="col" class="num">Breakpoints</th><th scope="col">Targets</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>
<p class="hint">Source: ${source} · <a href="/docs/methodology/#caching">Cache modes</a></p>`;
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
  const provenance = extension.provenance;
  const limit = isObject(model.limit) ? model.limit : {};
  const cache = extension.cache;
  const measuredLimits = extension.limits.measured;
  const fromMeasurement = extension.limits.from_measurement;
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

  return `
<header class="entry-head">
  <p class="crumbs"><a href="/providers/">Providers</a> / <a href="/providers/${e(provider.id)}/">${e(provider.name)}</a>${summary.canonical_id ? ` · <a href="${e(modelHref(summary.canonical_id))}">All access methods for ${e(summary.canonical_id)}</a>` : ""}</p>
  <h1>${e(summary.name)}</h1>
  <p class="id"><code>${e(summary.ref)}</code>${copyButton(summary.ref, "entry id")} <span class="badge ${summary.access}">${ACCESS_LABEL[summary.access]}</span>
  ${sourcesHtml(summary, view, true)}${summary.status ? ` <span class="badge">${e(summary.status)}</span>` : ""}</p>
  <p class="released muted">Type <span title="The kind of model, as models.dev records it.">${summary.type ? e(summary.type) : "unknown"}</span> · ${
    summary.release_date
      ? `Released <span class="date" title="The model's release date, as models.dev records it. It is the same at every provider.">${e(summary.release_date)}</span>`
      : "Release date unknown"
  }</p>
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
  <h3>Measured <span class="hint">tokens</span></h3>
  <div class="scroll"><table class="facts"><thead><tr><th scope="col">Date</th><th scope="col">Measured through</th><th scope="col" class="num">Context</th><th scope="col" class="num">Input accepted</th><th scope="col" class="num">Input refused</th><th scope="col" class="num">Output limit</th><th scope="col" class="num">Requested output accepted</th><th scope="col">Evidence</th></tr></thead><tbody>${
    measuredLimits.length > 0 ? measuredLimitRows(measuredLimits) : '<tr class="empty-row"><td colspan="8" class="muted">No limits were measured on this entry.</td></tr>'
  }</tbody></table></div>
</section>

<section aria-labelledby="price">
  <h2 id="price">Price</h2>
  ${priceSection(summary)}
  <h3>Request controls</h3>
  ${requestControlTable(summary.request_controls.items.filter((control) => control.id !== "cache.retention"))}
</section>

<section aria-labelledby="cache">
  <h2 id="cache">Prompt caching</h2>
  <h3>Documented</h3>
  ${cacheDocumented(cache.documented, sourceOf("capabilities.cache", provenance, extension.origin))}
  <h3>Retention</h3>
  ${requestControlTable(summary.request_controls.items.filter((control) => control.id === "cache.retention"))}
  <h3>Measured</h3>
  ${cacheMeasured(cache, now)}
</section>

<section aria-labelledby="provenance">
  <h2 id="provenance">Provenance</h2>
  <div class="scroll"><table class="facts">
    <thead><tr><th scope="col">Provenance</th><th scope="col">Value</th></tr></thead>
    <tbody>
      <tr><th scope="row">Source</th><td>${sourcesHtml(summary, view, true)}</td></tr>
      <tr><th scope="row">Inherited from</th><td>${
        extension.inherited
          ? `<a href="${e(entryHref(extension.inherited.from))}"><code>${e(extension.inherited.from)}</code></a><div class="hint">${extension.inherited.fields.map((field) => `<code>${e(field)}</code>`).join(", ")}</div>`
          : NONE
      }</td></tr>
      <tr><th scope="row">Corrections</th><td>${
        provenance.length === 0
          ? NONE
          : provenance
              .map(
                (change) => `<div class="change">
        <p><code>${e(change.path)}</code> ${change.op === "set" ? `is <strong>${show(change.value)}</strong>` : change.op === "unknown" ? "is published as <strong>unknown</strong>" : "is <strong>removed</strong>"}. models.dev says: ${change.had_upstream ? show(change.upstream) : '<span class="muted">nothing</span>'}.</p>
        <p class="muted">${e(change.reason)}</p>
        ${evidenceList(change.evidence)}
      </div>`,
              )
              .join("")
      }</td></tr>
      <tr><th scope="row">Evidence</th><td>${extension.evidence.length > 0 ? evidenceList(extension.evidence) : NONE}</td></tr>
    </tbody>
  </table></div>
</section>

<section aria-labelledby="raw">
  <h2 id="raw">Data</h2>
  <p><a href="${e(api)}"><code>GET ${e(api)}</code></a> ${copyButton(api, "API path")}</p>
  <details class="mt-3"><summary class="hint">Show the full entry as published</summary><pre class="mt-2">${e(JSON.stringify(model, null, 2))}</pre></details>
</section>`;
}
