// HTML for the entry table and the entry detail view. The same functions render server responses and
// re-render in the browser, so a row looks and reads the same wherever it appears.
import {
  CACHE_AGES_S,
  RETENTION_PROFILES,
  settingsText,
  type CacheDocumentation,
  type CacheEvaluation,
  type CacheLifetimeItem,
  type CacheResult,
  type EntryCache,
  type LifetimeSource,
  type RetentionProfile,
  type SafeLifetime,
} from "./cache.ts";
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

// ---- cache lifetimes: `cache_lifetime` of a summary and `providers_dev.cache.lifetime` of an entry, as the API
// publishes them. Per retention profile the safe value, then every lifetime of the entry in one list, documented and
// measured alike, each with its source and date. This file picks no value and compares none: which value is the safe
// one is `basis`, and the results by age are the items' and the evaluations' own.

const PROFILE_WORD = { short: "Short", long: "Long" } as const;
const PROFILE_TITLE = {
  short: "Short retention: the cache a request gets without asking for a lifetime, or with the provider's shortest setting.",
  long: "Long retention: the cache a request gets when it asks for a longer lifetime.",
} as const;
const BASIS_TITLE = {
  documented: "Documented: a lifetime the source documents for this entry.",
  measured: "Measured by providers.dev: the oldest age through which every check hit.",
} as const;

/** A span of time, as a lifetime or an age: "2.5 min", "1 h 15 min", "24 h" (never "1 d": caches are counted in hours). */
const span = (seconds: number): string => (seconds > 0 && seconds % 86400 === 0 ? shortAge(seconds) : duration(seconds));
/** An age as a column heading or in a sentence: "at once" for the control, then "2.5 min", "1 h 15 min", "24 h". */
const ageText = (seconds: number): string => (seconds === 0 ? "at once" : span(seconds));
const seconds = (value: number): string => `${exact(value)} s`;

/**
 * A lifetime as a page prints it, the exact seconds in its title. 0 is two statements, told apart by the basis:
 * documented, the source says the entry does not cache ("None"); measured, no tested age at which every check hit ("0 s").
 */
function lifetimeText(value: number, basis: "documented" | "measured"): string {
  if (value === 0 && basis === "documented") return '<span title="Documented: the source says this entry does not cache prompts.">None</span>';
  if (value === 0) return '<span title="Measured: 0 s. No tested age at which every check hit.">0 s</span>';
  return `<span title="${seconds(value)}">${span(value)}</span>`;
}

/** Documented or measured, in words, on every value: no legend needed. */
function basisTag(basis: "documented" | "measured"): string {
  return `<span class="basis ${basis}" title="${BASIS_TITLE[basis]}">${basis}</span>`;
}

/** Who a lifetime is from, and its date. A providers.dev date is marked stale after 90 days, like all our evidence. */
function lifetimeSource(source: LifetimeSource, date: string | null, basis: "documented" | "measured", now: Date): string {
  const name =
    source === "models.dev"
      ? `<span class="origin upstream" title="${e(ORIGIN_TITLE.upstream)}">models.dev</span>`
      : `<span class="origin added" title="${basis === "measured" ? "Measured by providers.dev." : "Documented, with a providers.dev correction or on an entry providers.dev added."}">providers.dev</span>`;
  const title = basis === "measured" ? "The date of the newest evaluation." : source === "models.dev" ? "Imported from models.dev on this date." : "The date of the newest providers.dev evidence.";
  const when = date === null ? '<span class="muted date">Date unknown</span>' : source === "providers.dev" && isStale(date, now) ? `<span class="stale" title="${title} More than 90 days ago.">${e(date)} · stale</span>` : `<span class="muted date" title="${title}">${e(date)}</span>`;
  return `<span class="life-source">${name}${when}</span>`;
}

/** The safe lifetime of a profile and what it was chosen from, in one plain sentence for a tooltip. */
function safeSaid(profile: RetentionProfile, p: SafeLifetime): string {
  const name = `${PROFILE_WORD[profile]} retention`;
  if (p.safe_s === null || p.basis === "none") return `${name}: no lifetime is documented or measured.`;
  const documented = p.documented_s === null ? "none" : p.documented_s === 0 ? "0 s, does not cache" : seconds(p.documented_s);
  const measured = p.measured_s === null ? "not measured" : `${seconds(p.measured_s)} (${plural(p.clients, "client")}, ${plural(p.evaluations, "evaluation")})`;
  const inside = p.checks_inside === null || p.hits_inside === null ? "" : ` ${exact(p.hits_inside)} of ${exact(p.checks_inside)} checks hit inside the documented lifetime.`;
  return `${name}, safe lifetime: ${seconds(p.safe_s)}, ${p.basis}, ${p.source}${p.date ? `, ${p.date}` : ""}. Documented: ${documented}. Measured: ${measured}.${inside}`;
}

/**
 * One line of the list cell: the profile, the safe value and its basis, and beside it the other of the two lifetimes
 * it was chosen from where there is one. Which is the other is read from `basis`, and its emphasis from
 * `documented_status`; nothing is compared.
 */
function lifetimeLine(profile: RetentionProfile, p: SafeLifetime): string {
  const name = `<span class="life-profile">${PROFILE_WORD[profile]}</span>`;
  if (p.safe_s === null || p.basis === "none") return `${name}<span class="life-value unknown" title="${e(safeSaid(profile, p))}">Unknown</span><span></span>`;
  const other =
    p.basis === "documented"
      ? p.measured_s === null ? "" : `<span class="life-other">measured ${span(p.measured_s)}</span>`
      : p.documented_s === null ? "" : `<span class="life-other${p.documented_status === "contradicted" ? " contradicted" : ""}">documented ${p.documented_s === 0 ? "None" : span(p.documented_s)}</span>`;
  const value = p.safe_s === 0 ? (p.basis === "documented" ? "None" : "0 s") : span(p.safe_s);
  return `${name}<span class="life-value" title="${e(safeSaid(profile, p))}">${value}</span><span class="life-basis">${basisTag(p.basis)}${other}</span>`;
}

/** The cache lifetime of an entry in a table row: short and long, each on its line, the same two lines for every entry. */
function lifetimeCell(entry: Pick<Summary, "cache_lifetime">, href: string): string {
  const record = entry.cache_lifetime;
  return `<a class="plain lifes" href="${e(href)}#cache" aria-label="Cache lifetimes. Open the entry for every lifetime and its source.">${lifetimeLine("short", record.short)}${lifetimeLine("long", record.long)}</a>`;
}

// ---- results by age: the cells of an item, of an evaluation, and of the evidence page's list of evaluations.
// The ages, counts and percentages are the API's; a cell rounds the percentage to a whole number and the hover text
// has the exact one with the counts.

const columnLabel = (value: number): string => (value < 3600 ? `${value / 60}m` : value % 3600 === 0 ? `${value / 3600}h` : `${value / 60}m`); // 150 -> "2.5m", 4500 -> "75m"
const CONTROL_TITLE = "At once: the prompt sent again immediately. It shows that the prompt was cached at all.";
const level = (result: CacheResult): string => (result.hit_rate_pct === 100 ? "all" : result.hit_rate_pct === 0 ? "none" : result.hit_rate_pct >= 50 ? "most" : "few");
const said = (result: CacheResult): string => `${result.kind === "control" ? "At once" : `After ${ageText(result.age_s)}`}: ${result.hits} of ${result.checks} re-sends served from the cache (${result.hit_rate_pct}%)`;

/** The columns of every summary table: the control, then the ladder of ages. */
const COLUMNS: { kind: CacheResult["kind"]; age_s: number }[] = [{ kind: "control", age_s: 0 }, ...CACHE_AGES_S.map((age) => ({ kind: "timed" as const, age_s: age }))];
const inColumn = (results: readonly CacheResult[], column: (typeof COLUMNS)[number]): CacheResult | undefined =>
  results.find((result) => result.kind === column.kind && result.age_s === column.age_s);
const stripHead = (where: "column" | "row"): string =>
  `<span class="heat-strip strip-head${where === "row" ? " in-row" : ""}" aria-hidden="true"><span></span><span class="strip">${COLUMNS.map((column) => `<span${column.kind === "control" ? ' class="control"' : ""}>${column.kind === "control" ? "once" : columnLabel(column.age_s)}</span>`).join("")}</span></span>`;
/** The ages of the strip, written once in the column head so that every row lines up under them. */
export const STRIP_HEAD = stripHead("column");
/** The same ages inside a row, shown only where the table is stacked and the column head is out of sight. */
export const STRIP_HEAD_IN_ROW = stripHead("row");

/** What an evaluation's requests asked for: the retention profile, and the request field and value where one was sent. */
type RetentionSetting = Pick<CacheEvaluation, "retention_profile" | "parameter" | "value">;

/** "Short" or "Long 1h": the retention profile, and the value the requests asked for. */
function retentionWord(setting: RetentionSetting): string {
  return `${PROFILE_WORD[setting.retention_profile]}${setting.value ? ` <b>${e(setting.value)}</b>` : ""}`;
}

/** What an evaluation's requests sent, in one sentence. */
function retentionSaid(setting: RetentionSetting): string {
  if (setting.parameter && setting.value) return `${PROFILE_WORD[setting.retention_profile]} retention: the requests sent ${setting.parameter}=${setting.value}.`;
  return setting.retention_profile === "short" ? "Short retention: the requests asked for no lifetime, so this is the provider's default cache." : "Long retention: a request that asks for a longer lifetime.";
}

/** One evaluation as a line of small cells, one per column, with the hit rate in percent (the evidence page). */
export function evaluationStrip(evaluation: RetentionSetting & { results: readonly CacheResult[]; date: string }): string {
  const label = `<span class="strip-label" title="${e(`${retentionSaid(evaluation)} Evaluated on ${evaluation.date}.`)}">${retentionWord(evaluation)}</span>`;
  const cells = COLUMNS.map((column) => {
    const result = inColumn(evaluation.results, column);
    const control = column.kind === "control" ? " control" : "";
    if (!result) return `<span class="skip${control}" title="${column.kind === "control" ? "At once" : `After ${ageText(column.age_s)}`}: not checked"></span>`;
    return `<span class="${level(result)}${control}" title="${e(said(result))}">${Math.round(result.hit_rate_pct)}</span>`;
  }).join("");
  return `<span class="heat-strip">${label}<span class="strip">${cells}</span></span>`;
}

export interface RowOptions {
  now: Date;
  /** The date of the models.dev import, shown next to the models.dev source. */
  imported?: string;
  /** Leave the provider column out (on a provider's own page). */
  hideProvider?: boolean;
  providerNames?: Record<string, string>;
}

/** The column names of the entry table. Where the table is stacked, each cell repeats its column's name. */
const COLUMN = { provider: "Provider", context: "Context", max_output: "Max output", price: "Price in / out", released: "Released", lifetime: "Cache lifetime", source: "Source" } as const;

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
${options.hideProvider ? "" : column("provider", COLUMN.provider, "Who serves it, and how it is reached.")}
${column("context", COLUMN.context, "Exposed context window in tokens (limit.context): what this provider accepts for the model.", "num")}
${column("max_output", COLUMN.max_output, "Largest single response in tokens (limit.output). A maximum, not a default.", "num")}
${column("price_in", COLUMN.price, "Base list price in US dollars per million tokens, input then output, as models.dev records it. Conditional rates marks an entry whose price changes with context size, service tier, region, date or the time of day: open the entry for those. A subscription is not paid per token: it shows the API list price of the same model, marked API price, or In plan where the catalog has no API entry of that model.", "num mid-only")}
${column("release_date", COLUMN.released, "When the model was released, as models.dev records it. It is the model's date: the same at every provider.", "wide-only")}
${column(null, COLUMN.lifetime, "How long a cached prompt can be relied on (cache_lifetime): for short retention, what a request gets without asking for a lifetime; for long, what it gets when it asks for a longer one. Each value says whether it is documented or measured by providers.dev, and names the other of the two where there is one. Hover a value for its source and date; the entry's page lists every lifetime.", "life-col")}
${column("verified", COLUMN.source,"Where the entry comes from, with a date per source: the import from models.dev, and the newest providers.dev evidence.")}
</tr>`;
}

export function rowHtml(entry: Summary, options: RowOptions): string {
  const href = entryHref(entry.ref);
  const provider = options.providerNames?.[entry.provider] ?? entry.provider;
  const access = entry.access === "api" ? "" : ` <span class="badge ${entry.access}" title="Access: ${ACCESS_LABEL[entry.access]}">${ACCESS_LABEL[entry.access]}</span>`;
  const status = entry.status ? ` <span class="badge">${e(entry.status)}</span>` : "";
  return `<tr>
<th scope="row"><a href="${e(href)}">${e(entry.name)}</a>${status}<div class="id"><code>${e(entry.model)}</code>${copyButton(entry.ref, "entry id")}</div></th>
${options.hideProvider ? "" : `<td class="provider-col" data-label="${COLUMN.provider}"><a class="plain" href="/providers/${e(entry.provider)}/">${e(provider)}</a>${access}</td>`}
<td class="num" data-label="${COLUMN.context}">${contextCell(entry, href)}</td>
<td class="num" data-label="${COLUMN.max_output}">${tokens(entry.max_output)}</td>
<td class="num mid-only" data-label="${COLUMN.price}">${priceCell(entry)}</td>
<td class="wide-only" data-label="${COLUMN.released}">${entry.release_date ? `<span class="muted date">${e(entry.release_date)}</span>` : UNKNOWN}</td>
<td class="life-col" data-label="${COLUMN.lifetime}">${lifetimeCell(entry, href)}</td>
<td class="nowrap source-col" data-label="${COLUMN.source}">${sourcesHtml(entry, options)}</td>
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
  if (input === null && output === null) {
    // No price per token for text: a model that makes video or transcribes speech is priced by the second, the image
    // or the minute. The first of its base charges stands in the cell, with its name; the rest are on its page.
    const other = (entry.pricing.rules ?? []).filter((rule) => rule.when === null && rule.operation === "set").sort((a, b) => meterRank(a.meter) - meterRank(b.meter))[0];
    if (other) return `<span class="price">${rateHtml(other)}</span><div class="hint">${e(meterLabel(other.meter))}</div>${conditionNote}`;
    return (entry.pricing.billing === "not_applicable" ? IN_PLAN : UNKNOWN) + conditionNote;
  }
  // A listed 0 is shown as the source has it. It can mean free, or paid for another way: the page does not decide.
  const price = `<span class="price">${input === null ? DASH : usd(input)} <span class="muted">/</span> ${output === null ? DASH : usd(output)}</span>${conditionNote}`;
  // Two short lines: the price, then whose price it is.
  if (entry.price_from) {
    return `<span class="price-inherited" title="Not what this entry costs: a subscription is not paid per token. This is the API list price of ${e(entry.price_from)}.">${price}<span class="price-from">API price</span></span>`;
  }
  if (entry.access === "subscription") return `<span class="price-inherited" title="${e(LISTED_PRICE)}">${price}<span class="price-from">Listed price</span></span>`;
  return price;
}

// A charge is a kind of content and what is charged for it: `text.input`, `audio.cache_read`, `video.output`. The
// text charges come first and are named without their kind, since they are what the page is mostly about.
const CHARGE: Record<string, string> = { input: "Input", output: "Output", reasoning_output: "Reasoning output", cache_read: "Cache read", cache_write: "Cache write", cache_storage: "Cache storage" };
const CONTENT = ["text", "audio", "image", "video"];
const WEB_SEARCH = "web_search";
const METER_ORDER = [...CONTENT.flatMap((content) => Object.keys(CHARGE).map((charge) => `${content}.${charge}`)), WEB_SEARCH];
function meterLabel(meter: string): string {
  if (meter === "*") return "All charges";
  if (meter === WEB_SEARCH) return "Web search";
  const [content = "", charge = ""] = meter.split(".");
  if (!CONTENT.includes(content)) return meter;
  const name = content.charAt(0).toUpperCase() + content.slice(1);
  if (charge === "*") return `All ${content} charges`;
  const label = CHARGE[charge];
  return !label ? meter : content === "text" ? label : `${name} ${label.toLowerCase()}`;
}
const meterRank = (meter: string): number => { const at = METER_ORDER.indexOf(meter); return at === -1 ? METER_ORDER.length : at; };
const PERIOD_LABEL = { peak: "Peak hours", off_peak: "Off-peak hours" } as const;
const APPLIES_TO = { all_usage: "Whole request", above_threshold: "Only the part above the threshold" } as const;

/** "$2 / 1M tokens". */
function rateHtml(rate: Pick<PricingRule, "amount" | "currency" | "unit">): string {
  const amount = rate.currency === "USD" ? usd(rate.amount) : `${e(rate.currency ?? "Currency unknown")} ${e(String(rate.amount))}`;
  if (!rate.unit) return `${amount} <span class="muted">· unit unknown</span>`;
  const { name, quantity } = rate.unit;
  const plural = name.endsWith("ch") ? `${name}es` : `${name}s`;
  const per = quantity === null ? `${plural} · quantity unknown` : quantity === 1 ? name : `${quantity === 1000000 ? "1M" : exact(quantity)} ${plural}`;
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
  // Every entry has the same five rows, the text charges; a charge the source prices beyond them gets a row too
  // (cache storage, and audio, image, video and web search, each in its own unit).
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
      // One row group per condition: where the table is stacked, the condition, its charges and what it applies to stay together.
      return `<tbody>${lines.map((line, at) => `<tr${at === 0 ? ' class="group"' : ""}>${at === 0 ? `<th scope="rowgroup"${span}>${label}</th>` : ""}<td>${e(meterLabel(line.meter))}</td><td class="num">${line.rate}</td>${at === 0 ? `<td class="applies"${span} data-label="Applies to">${applies}</td>` : ""}</tr>`).join("")}</tbody>`;
    })
    .join("");
  const none = pricing.coverage === "complete" ? "No conditional rates." : pricing.billing === "not_applicable" ? "Not applicable: the entry has no price per token." : "No conditional rates recorded.";
  const note = pricing.reference_ref
    ? `<p class="hint">API list prices of <a href="${e(entryHref(pricing.reference_ref))}"><code>${e(pricing.reference_ref)}</code></a>. This entry is a subscription and is not paid per token.</p>`
    : summary.access === "subscription" && pricing.rules !== null
      ? `<p class="hint">${e(LISTED_PRICE)}</p>`
      : "";
  const source = pricing.evidence.map((item) => `<a href="${e(item.url)}" rel="noopener">${e(shortUrl(item.url))}</a>${item.date ? ` <span class="date">${e(item.date)}</span>` : ""}`).join(" · ");
  return `${note}<div class="scroll"><table class="facts pairs stack-phone"><thead><tr><th scope="col">Base charge</th><th scope="col" class="num">Rate</th></tr></thead><tbody>${rows}</tbody></table></div>
<h3>Conditional rates</h3>
<div class="scroll"><table class="facts conditional stack-phone"><thead><tr><th scope="col">Condition</th><th scope="col">Charge</th><th scope="col" class="num">Rate</th><th scope="col">Applies to</th></tr></thead>${changes || `<tbody><tr class="empty-row"><td colspan="4" class="muted">${none}</td></tr></tbody>`}</table></div>
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
  return `<tr><th scope="row">${label}<div class="hint">${hint}</div></th><td class="num" data-label="Value">${value}</td><td data-label="Source">${source}</td></tr>`;
}

/** A column's heading in the table of lifetimes, also repeated by each of its cells where the table is stacked. */
const heatLabel = (column: (typeof COLUMNS)[number]): string => (column.kind === "control" ? "At once" : shortAge(column.age_s));

/** One cell of results by age: the hit rate in percent, rounded, with hits/checks under it; the exact rate is in the title. */
function heatCell(result: CacheResult | undefined, column: (typeof COLUMNS)[number]): string {
  const label = ` data-label="${heatLabel(column)}"`;
  if (!result) return `<td class="heat unchecked"${label}><span class="skip" title="${column.kind === "control" ? "At once" : `After ${ageText(column.age_s)}`}: not checked">·</span></td>`;
  return `<td class="heat"${label}><span class="${level(result)}" title="${e(said(result))}">${Math.round(result.hit_rate_pct)}<small>${result.hits}/${result.checks}</small></span></td>`;
}

const HEAT_HEAD = COLUMNS.map((column) => `<th scope="col" class="age"${column.kind === "control" ? ` title="${CONTROL_TITLE}"` : ""}>${heatLabel(column)}</th>`).join("");
const AGE_COLUMNS = COLUMNS.length;

/** Results at ages without a column, in words. Nothing an evaluation checked is left out of the page. */
function otherAges(results: readonly CacheResult[]): string {
  const others = results.filter((result) => !COLUMNS.some((column) => column.kind === result.kind && column.age_s === result.age_s));
  if (others.length === 0) return "";
  return `Also checked: ${others.map((result) => `${ageText(result.age_s)} ${Math.round(result.hit_rate_pct)}% (${result.hits}/${result.checks})`).join(", ")}`;
}

/** The safe lifetime of a profile, then the two lifetimes it was chosen from and how many checks hit inside the documented one. */
function profileRow(profile: RetentionProfile, p: SafeLifetime, now: Date): string {
  const safe =
    p.safe_s === null || p.basis === "none" || p.source === null
      ? UNKNOWN
      : `<span class="life-value">${lifetimeText(p.safe_s, p.basis)}</span>${basisTag(p.basis)}${lifetimeSource(p.source, p.date, p.basis, now)}`;
  // The case, as the API publishes it in `documented_status`, and from nothing else.
  const verdict =
    p.documented_status === "contradicted"
      ? '<span class="case contradicted" title="An evaluation contradicts the documented lifetime: the safe value is the measured one. The documented lifetime stays in the list.">Documentation contradicted</span>'
      : p.documented_status === "not_contradicted"
        ? '<span class="case" title="No evaluation contradicts the documented lifetime: the safe value is the documented one. Not contradicted is not confirmed.">Documentation not contradicted</span>'
        : "";
  const fact = (label: string, value: string): string => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
  return `<tbody class="profile"><tr><th scope="row" title="${PROFILE_TITLE[profile]}">${PROFILE_WORD[profile]} retention</th><td class="profile-facts" colspan="${1 + AGE_COLUMNS}"><dl>
${fact("Safe lifetime", `<span class="safe">${safe}</span>${verdict}`)}
${fact("Documented", p.documented_s === null ? '<span class="muted">Not documented</span>' : lifetimeText(p.documented_s, "documented"))}
${fact("Measured", p.measured_s === null ? '<span class="muted">Not measured</span>' : `${lifetimeText(p.measured_s, "measured")} <span class="muted">· ${plural(p.clients, "client")}</span>`)}
${fact("Inside the documented lifetime", p.checks_inside === null || p.hits_inside === null ? NOT_APPLICABLE : `<span title="Checks at ages up to the documented lifetime, the control included, and how many were served from the cache.">${exact(p.hits_inside)} of ${exact(p.checks_inside)} checks hit</span>`)}
</dl></td></tr></tbody>`;
}

/** The value of an item, its basis, its source and its date: the first cell of every lifetime. */
function lifetimeHead(item: CacheLifetimeItem, now: Date): string {
  return `<td class="life" data-label="Lifetime"><span class="life-value">${lifetimeText(item.lifetime_s, item.basis)}</span>${basisTag(item.basis)}${lifetimeSource(item.source, item.date, item.basis, now)}</td>`;
}

/** The note of an evaluation, where it has one, named by the evaluation where the note could be read as another's. */
const runNote = (run: CacheEvaluation, named: boolean): string => (run.note ? `<p class="run-note"><b>Note${named ? ` <code>${e(run.id)}</code>` : ""}</b> ${e(run.note)}</p>` : "");

/**
 * One evaluation under its measured lifetime: the run, its settings, the raw result, and its own results by age. Its note
 * is on the lifetime's row, in sight before the evaluations are opened; an evaluation in no lifetime carries its own.
 */
function runRow(run: CacheEvaluation, now: Date, withNote = false): string {
  const settings = settingsText(run.request_settings);
  const other = otherAges(run.results);
  const date = isStale(run.date, now) ? `<span class="stale" title="Evaluated more than 90 days ago.">${e(run.date)} · stale</span>` : `<span class="muted date" title="The date of this evaluation.">${e(run.date)}</span>`;
  return `<tr class="run"><td class="run-head" colspan="2">${withNote ? runNote(run, false) : ""}<code>${e(run.id)}</code> ${date}<div class="hint">${e(run.route_label)}${settings ? ` · <code>${e(settings)}</code>` : ""}${other ? ` · ${e(other)}` : ""}</div><a href="${e(run.source)}" rel="noopener">Raw result</a></td>${COLUMNS.map((column) => heatCell(inColumn(run.results, column), column)).join("")}</tr>`;
}

/**
 * One lifetime of the list, in the same columns whatever its basis. A documented one names the way of caching it is
 * documented for and the text as documented; a measured one names its client and setting, its checks and results by
 * age, the notes of its evaluations, and opens onto each evaluation.
 */
function itemRows(item: CacheLifetimeItem, evaluations: readonly CacheEvaluation[], now: Date): string {
  if (item.basis === "documented") {
    const what =
      item.mode === null
        ? "Documented as not caching"
        : `<span title="${e(CACHE_MODE_TITLE[item.mode])}">${CACHE_MODE_WORD[item.mode]}</span> <span class="chip">${item.mode}</span><div class="hint">As documented: <code>${e(item.documented_as ?? "")}</code></div>`;
    return `<tbody class="item documented"><tr>${lifetimeHead(item, now)}<td class="through" data-label="Documented for">${what}</td><td class="heat-none" colspan="${AGE_COLUMNS}" data-label="Results by age"><span class="muted" title="A documented lifetime has no results by age.">Not applicable</span></td></tr></tbody>`;
  }
  const runs = item.evaluation_ids.flatMap((id) => evaluations.filter((run) => run.id === id));
  const setting = item.parameter && item.value ? `Sent <code>${e(item.parameter)}=${e(item.value)}</code>` : "No lifetime asked for";
  const checks = `<span title="Re-sends served from the cache, of those made, the control included.">${exact(item.hits)} of ${exact(item.checks)} checks hit</span>`;
  const ages = `${item.tested_from_s === null ? "No timed check" : `Tested from ${span(item.tested_from_s)}`} · ${item.first_miss_s === null ? "No miss" : `First miss ${ageText(item.first_miss_s)}`}`;
  const other = item.results ? otherAges(item.results) : "";
  const notes = runs.map((run) => runNote(run, runs.length > 1)).join("");
  const what = `<strong class="client">${e(item.client_label ?? item.client ?? "")}</strong><div class="hint">${setting} · ${checks}</div><div class="hint">${ages}${other ? ` · ${e(other)}` : ""}</div>${notes}<details class="runs"><summary>${plural(item.evaluations, "evaluation")}</summary></details>`;
  const results = item.results ?? [];
  return `<tbody class="item measured"><tr>${lifetimeHead(item, now)}<td class="through" data-label="Measured through">${what}</td>${COLUMNS.map((column) => heatCell(inColumn(results, column), column)).join("")}</tr>${runs.map((run) => runRow(run, now)).join("")}</tbody>`;
}

/**
 * Every lifetime of an entry, one table for all: per retention profile the safe value and what it was chosen from, then
 * each documented and each measured lifetime as the API lists them, in its order. Both profiles on every entry.
 */
function lifetimesTable(cache: EntryCache, now: Date): string {
  const record = cache.lifetime;
  const body = RETENTION_PROFILES.map((profile) => profileRow(profile, record[profile], now) + record.lifetimes.filter((item) => item.retention_profile === profile).map((item) => itemRows(item, cache.evaluations, now)).join("")).join("");
  // An evaluation that is in no lifetime (no timed result, and a control that hit) is still on the page.
  const named = new Set(record.lifetimes.flatMap((item) => item.evaluation_ids));
  const others = cache.evaluations.filter((run) => !named.has(run.id));
  const rest = others.length
    ? `<tbody class="profile"><tr><th scope="row">Other evaluations</th><td class="profile-facts" colspan="${1 + AGE_COLUMNS}"><span class="muted">In no lifetime</span></td></tr></tbody><tbody class="item others">${others.map((run) => runRow(run, now, true)).join("")}</tbody>`
    : "";
  return `<div class="scroll"><table class="facts heat lifetimes stack-tablet"><caption class="sr-only">Every cache lifetime of this entry, by retention</caption><thead><tr><th scope="col" rowspan="2">Lifetime</th><th scope="col" rowspan="2">Documented for, or measured through</th><th scope="colgroup" colspan="${AGE_COLUMNS}" class="span">Time since the prompt was cached · served from the cache, in percent, with hits/checks</th></tr><tr>${HEAT_HEAD}</tr></thead>${body}${rest}</table></div>
<p class="legend"><span><span class="heat-key all">100</span> All served from the cache</span><span><span class="heat-key most">67</span> Half or more</span><span><span class="heat-key few">33</span> Fewer</span><span><span class="heat-key none">0</span> None</span><span><span class="heat-key skip">·</span> Not checked at that age</span><span><a href="/docs/methodology/#evaluations">Methodology</a></span></p>`;
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
    return `<tr><th scope="row">${e(CONTROL_LABEL[control.id] ?? control.id)}</th><td data-label="Support">${support}</td><td class="span-row" data-label="Request field">${bindings}</td><td class="span-row" data-label="Accepted values">${options}</td><td data-label="Default">${control.default === null ? absent : control.default.value === null ? "The field left out" : `<code>${e(jsonText(control.default.value))}</code>`}</td><td class="span-row" data-label="Conditions">${conditions}</td></tr>`;
  }).join("");
  const sources = controls.flatMap((control) => control.evidence).filter((item, at, all) => all.findIndex((other) => other.url === item.url && other.date === item.date) === at);
  const source = sources.map((item) => `<a href="${e(item.url)}" rel="noopener" title="${e(item.note)}">${e(shortUrl(item.url))}</a>${item.date ? ` <span class="date">${e(item.date)}</span>` : ""}`).join(" · ");
  return `<div class="scroll"><table class="facts controls stack-phone"><thead><tr><th scope="col">Control</th><th scope="col">Support</th><th scope="col">Request field</th><th scope="col">Accepted values</th><th scope="col">Default</th><th scope="col">Conditions</th></tr></thead><tbody>${rows}</tbody></table></div>
<p class="hint">Source: ${source || UNKNOWN}</p>`;
}

function measuredLimitRows(limits: MeasuredLimit[]): string {
  const cell = (value: number | null, label: string): string => `<td class="num" data-label="${label}">${value === null ? UNKNOWN : exact(value)}</td>`;
  return limits
    .map(
      (limit) =>
        `<tr><td data-label="Date">${limit.date ? `<span class="muted date">${e(limit.date)}</span>` : UNKNOWN}</td><td class="span-row" data-label="Measured through">${e(limit.route_label)}<div class="hint">${e(limit.client_label)}</div></td>${cell(limit.context, "Context")}${cell(limit.input_accepted, "Input accepted")}${cell(limit.input_refused, "Input refused")}${cell(limit.output, "Output limit")}${cell(limit.output_accepted, "Requested output accepted")}<td data-label="Evidence"><a href="${e(limit.source)}" rel="noopener">Raw result</a></td></tr>`,
    )
    .join("");
}

/**
 * The ways of caching the source documents. Every entry has the same table: one row for each way, supported or not.
 * Their lifetimes are items of the list of lifetimes, each with its way of caching.
 */
function cacheDocumented(documented: CacheDocumentation, source: string): string {
  const rows = (["implicit", "explicit"] as const).map((mode) => {
    const detail = documented.modes[mode];
    const state = { supported: "Supported", unsupported: '<span class="muted">Unsupported</span>', unknown: UNKNOWN }[detail.support];
    const supported = detail.support === "supported";
    const blank = detail.support === "unsupported" ? NOT_APPLICABLE : UNKNOWN;
    return `<tr>
<th scope="row">${CACHE_MODE_WORD[mode]} <span class="chip">${mode}</span></th>
<td data-label="Supported">${state}</td>
<td class="num" data-label="Min. tokens">${supported ? (detail.min_tokens === null ? UNKNOWN : exact(detail.min_tokens)) : blank}</td>
<td class="num" data-label="Breakpoints">${supported && mode === "explicit" ? (detail.max_breakpoints === null ? UNKNOWN : exact(detail.max_breakpoints)) : supported ? NOT_APPLICABLE : blank}</td>
<td data-label="Targets">${supported && mode === "explicit" ? (detail.targets === null ? UNKNOWN : e(detail.targets.join(", "))) : supported ? NOT_APPLICABLE : blank}</td>
</tr>`;
  });
  return `<div class="scroll"><table class="facts stack-phone"><thead><tr><th scope="col">Mode</th><th scope="col">Supported</th><th scope="col" class="num">Min. tokens</th><th scope="col" class="num">Breakpoints</th><th scope="col">Targets</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>
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
  // The safe lifetime of each profile, at the top of the page: the value, its basis, and whose it is as of when.
  const lifetimeTile = (profile: RetentionProfile): string => {
    const p = cache.lifetime[profile];
    const label = `Cache lifetime, ${profile}`;
    if (p.safe_s === null || p.basis === "none" || p.source === null) return tile(label, '<span class="muted">Unknown</span>', "Not documented or measured");
    // The other of the two lifetimes it was chosen from, where there is one, read from `basis` as in the list; whether
    // the documented one is contradicted is `documented_status`.
    const other =
      p.basis === "documented"
        ? p.measured_s === null ? "" : `<div>Measured ${p.measured_s === 0 ? "0 s" : span(p.measured_s)}</div>`
        : p.documented_s === null
          ? ""
          : p.documented_status === "contradicted"
            ? `<div class="contradicted">Documented ${p.documented_s === 0 ? "None" : span(p.documented_s)}, contradicted</div>`
            : `<div>Documented ${p.documented_s === 0 ? "None" : span(p.documented_s)}</div>`;
    return tile(label, `<span title="${e(safeSaid(profile, p))}">${lifetimeText(p.safe_s, p.basis)}</span>${basisTag(p.basis)}`, `${e(p.source)}${p.date ? ` · ${e(p.date)}` : ""}${other}`);
  };

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
  ${lifetimeTile("short")}
  ${lifetimeTile("long")}
</div>

<section aria-labelledby="limits">
  <h2 id="limits">Limits</h2>
  <h3>Documented</h3>
  <div class="scroll"><table class="facts stack-phone">
    <thead><tr><th scope="col">Limit</th><th scope="col" class="num">Value</th><th scope="col">Source</th></tr></thead>
    <tbody>
      ${fact("Context window", "<code>limit.context</code>: what this provider accepts for the model, input and output together.", number(limit.context), sourceOf("limit.context", provenance, extension.origin, fromMeasurement))}
      ${fact("Largest input", "<code>limit.input</code>: stated where the input limit is lower than the context window.", number(limit.input), sourceOf("limit.input", provenance, extension.origin))}
      ${fact("Maximum output", "<code>limit.output</code>: the most one response can hold. A maximum, not what you get by default.", number(limit.output), sourceOf("limit.output", provenance, extension.origin, fromMeasurement))}
    </tbody>
  </table></div>
  <h3>Measured <span class="hint">tokens</span></h3>
  <div class="scroll"><table class="facts stack-tablet"><thead><tr><th scope="col">Date</th><th scope="col">Measured through</th><th scope="col" class="num">Context</th><th scope="col" class="num">Input accepted</th><th scope="col" class="num">Input refused</th><th scope="col" class="num">Output limit</th><th scope="col" class="num">Requested output accepted</th><th scope="col">Evidence</th></tr></thead><tbody>${
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
  <h3>Lifetimes</h3>
  ${lifetimesTable(cache, now)}
  <h3>Cache modes</h3>
  ${cacheDocumented(cache.documented, sourceOf("capabilities.cache", provenance, extension.origin))}
  <h3>Retention</h3>
  ${requestControlTable(summary.request_controls.items.filter((control) => control.id === "cache.retention"))}
</section>

<section aria-labelledby="provenance">
  <h2 id="provenance">Provenance</h2>
  <div class="scroll"><table class="facts pairs stack-phone">
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
