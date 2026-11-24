// HTML for the entry table and the entry detail view. The same functions render server responses and
// re-render in the browser, so a row looks and reads the same wherever it appears.
import {
  RETENTION_PROFILES,
  settingsText,
  type CacheDocumentation,
  type CacheEvaluation,
  type CacheLifetimeItem,
  type CacheResult,
  type EntryCache,
  type RetentionProfile,
} from "./cache.ts";
import type { ProviderSummary, Summary } from "./entries.ts";
import type { InputWindowMeasurement } from "./limits.ts";
import { conditionText } from "./conditions.ts";
import type { PricingRule, RequestControl } from "./policy-contract.ts";
import {
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
  usdUnrounded,
  type Today,
} from "./format.ts";
import type { Json, JsonObject } from "./merge.ts";
import type { PiBlock, PiSummary } from "./pi.ts";
import { PI_ACCEPTS_FLAGS, PI_FLAG_GROUPS, PI_FORMAT_WORDS, piFlagGroup, type PiFlagGroup } from "./pi-words.ts";
import type { PricePart, SafeQuantity, SafeValue } from "./safe.ts";
import { lifetimeWords, priceWarning, QUANTITY_LABEL, safeCompact, safeText, safeTitle, safeWarning, span, warnId, wholePriceWarning, windowNote } from "./safe-view.ts";
import { NS, type MeasuredLimit, type MetaPi, type ModelExtension, type Provenance, type PublishedEvidence } from "./schema.ts";

const UNKNOWN = '<span class="unknown" title="The source does not say. Unknown is not zero and not unlimited.">Unknown</span>';
const DASH = '<span class="muted">–</span>';
/** Every entry page has the same rows. These fill a row whose value the source does not give. */
const NOT_APPLICABLE = '<span class="muted" title="This field does not apply to this entry.">Not applicable</span>';
/** A list with nothing in it: a known nothing, not a missing value. */
const NONE = '<span class="muted">None</span>';
const IN_PLAN = '<span class="muted" title="No price per token: the entry is paid for through a plan or subscription, which providers.dev does not list.">In plan</span>';
const ACCESS_LABEL = { api: "API key", subscription: "Subscription", unknown: "Unclassified" } as const;

export function copyButton(value: string, label: string): string {
  return `<button type="button" class="copy" data-copy="${e(value)}" aria-label="Copy ${e(label)}" title="Copy ${e(label)}">Copy</button>`;
}

function dateTag(date: string | null, today: Today): string {
  if (!date) return "";
  return isStale(date, today)
    ? `<span class="stale" title="The newest providers.dev evidence for this entry is from ${e(date)}, more than ${plural(today.stale_after_days, "day")} ago.">${e(date)} · stale</span>`
    : `<span class="muted date" title="Date of the newest providers.dev evidence.">${e(date)}</span>`;
}

/**
 * When providers.dev fetched pi's catalog, and when it last found it unchanged: `meta.pi.snapshot.fetched_at` moves only
 * when pi's feed changed, `checked_at` on every successful check, so the second says the data is current as of then.
 * Whether the last import failed is `meta.pi.sync`. All three are the API's; nothing here compares them.
 */
export interface PiDates {
  fetched: string | null;
  checked: string | null;
  failed_at: string | null;
  failed: boolean;
}
export function piDates(meta: MetaPi | undefined): PiDates {
  const day = (stamp: string | null | undefined): string | null => (stamp ? stamp.slice(0, 10) : null);
  // A check is said only where there was one after the fetch: on the fetch itself, checked_at is fetched_at.
  return { fetched: day(meta?.snapshot?.fetched_at), checked: piRechecked(meta) ? day(meta?.snapshot?.checked_at) : null, failed_at: day(meta?.sync.last_attempt_at), failed: meta?.sync.last_attempt_ok === false };
}
/** Whether pi's feed was checked again after the fetch: `checked_at` a later instant than `fetched_at`, however spelled. */
export function piRechecked(meta: MetaPi | undefined): boolean {
  const snapshot = meta?.snapshot;
  return snapshot ? Date.parse(snapshot.checked_at) > Date.parse(snapshot.fetched_at) : false;
}
const UTC = (stamp: string): string => `${stamp.slice(0, 10)} ${stamp.slice(11, 16)} UTC`;
function piDatesSaid(meta: MetaPi | undefined): string {
  const snapshot = meta?.snapshot;
  const lastFailed = meta?.sync.last_attempt_ok === false ? ` The last import${meta.sync.last_attempt_at ? `, ${UTC(meta.sync.last_attempt_at)},` : ""} failed` : "";
  if (!snapshot) return `This dataset has no pi data.${lastFailed ? `${lastFailed}.` : ""}`;
  const failed = lastFailed ? `${lastFailed}: this is the last good one.` : "";
  const checked = piRechecked(meta) ? ` Last checked ${UTC(snapshot.checked_at)}: unchanged since the fetch.` : "";
  return `Fetched from pi's catalog ${UTC(snapshot.fetched_at)}.${checked}${failed}`;
}

/**
 * The pi.dev mark of an entry pi's catalog also lists (`pi` of a summary): a mark like the models.dev and providers.dev
 * ones beside it, saying what it means in its title, not a link. pi is the last source of each value: where its figure
 * contradicts another source's, the value's warning lists it.
 */
function piMark(pi: PiSummary): string {
  const named = pi.match === "alias" ? `, as ${pi.ref}` : "";
  return `<span class="origin pi" title="${e(`pi's model catalog (pi.dev) also lists this entry${named}. Imported, not verified by providers.dev. It is the last source of each value.`)}">pi.dev</span>`;
}

/**
 * One line per source with its own date: the models.dev import, the newest providers.dev evidence, and, where pi's
 * catalog lists the entry, the pi.dev mark with the import of pi's catalog (`fetched_at` of `pi.snapshot` in
 * /api/v1/meta: like the models.dev date, it moves only when the data changed). The date is there wherever `pi` is
 * given: in a row and on the entry's own page. Only the entry's page (`entry`) has the date say that the last import
 * failed; in a row the date is plain like the models.dev one, and its title says the rest.
 */
function sourcesHtml(entry: Pick<Summary, "origin" | "verified" | "overridden_fields" | "pi">, options: { today: Today; imported?: string; pi?: MetaPi; entry?: boolean }, inline = false, first = ""): string {
  // `first`: pairs a provider's page puts before the entry's own sources (the vendor's list that names the entry).
  const parts: string[] = first ? [first] : [];
  if (entry.origin !== "added") {
    const date = options.imported ? `<span class="muted date" title="Imported from models.dev on this date.">${e(options.imported)}</span>` : "<span></span>";
    parts.push(`<span class="origin upstream" title="${e(ORIGIN_TITLE.upstream)}">${ORIGIN_LABEL.upstream}</span>${date}`);
  }
  if (entry.origin !== "upstream") {
    const corrected = entry.overridden_fields.length > 0 ? ` Corrected fields: ${entry.overridden_fields.join(", ")}.` : "";
    parts.push(`<span class="origin added" title="${e(ORIGIN_TITLE[entry.origin] + corrected)}">${ORIGIN_LABEL.added}</span>${dateTag(entry.verified, options.today) || "<span></span>"}`);
  }
  if (entry.pi) {
    // Without pi's data in /api/v1/meta there is no date, and the mark ends the list.
    const dates = piDates(options.pi);
    const failed = options.entry === true && dates.failed;
    const date = !options.pi || dates.fetched === null
      ? ""
      : `<span class="${failed ? "stale" : "muted date"}" title="${e(piDatesSaid(options.pi))}">${e(dates.fetched)}${failed ? " · last import failed" : ""}</span>`;
    parts.push(`${piMark(entry.pi)}${date}`);
  }
  return `<span class="sources${inline ? " side" : ""}">${parts.join("")}</span>`;
}

/** How a provider's prompt cache is switched on, in plain words. The data and the API keep models.dev's names: implicit, explicit. */
export const CACHE_MODE_WORD = { implicit: "Automatic", explicit: "Manual" } as const;
const CACHE_MODE_TITLE = {
  implicit: "Automatic (implicit): the provider caches the start of a prompt by itself. The request does nothing for it.",
  explicit: "Manual (explicit): nothing is cached unless the request marks what to cache. The mark also picks the lifetime.",
} as const;

// ---- the safe values in a list: `safe` of a summary, as `src/core/safe-view.ts` prints it. The value, compact, and
// the warning where its sources disagree; the exact value is in the hover text and on the entry's page.

const PROFILE_WORD = { short: "Short", long: "Long" } as const;
const PROFILE_TITLE = {
  short: "Short retention: the cache a request gets without asking for a lifetime, or with the provider's shortest setting.",
  long: "Long retention: the cache a request gets when it asks for a longer lifetime.",
} as const;
/** An age as a column heading or in a sentence: "at once" for the control, then "2.5 min", "1 h 15 min", "24 h". */
const ageText = (seconds: number): string => (seconds === 0 ? "at once" : span(seconds));
const LIFETIME_KEY = { short: "cache_short", long: "cache_long" } as const;

/**
 * A safe value in a list's cell. In a column of numbers the warning comes first, so that the numbers stay aligned on
 * the right; in the lines of the cache lifetimes, read from the left, it comes after.
 */
function listValue(entry: Pick<Summary, "ref" | "safe">, quantity: Exclude<SafeQuantity, "price">, href: string, today: Today, after = false): string {
  const safe: SafeValue = entry.safe[quantity];
  const warning = safeWarning(safe, quantity, warnId(entry.ref, quantity), today);
  const value = safe.value === null ? '<span class="unknown">Unknown</span>' : `<a class="plain" href="${e(href)}" title="${e(safeTitle(safe))}">${safeCompact(safe)}</a>`;
  return `<span class="safe-cell">${after ? value + warning : warning + value}</span>`;
}

/** The cache lifetimes of an entry in a list: short and long, each on its line, the same two lines for every entry. */
function lifetimeCell(entry: Pick<Summary, "ref" | "safe">, href: string, today: Today): string {
  return `<span class="lifes">${RETENTION_PROFILES.map((profile) => `<span class="life-profile" title="${PROFILE_TITLE[profile]}">${PROFILE_WORD[profile]}</span>${listValue(entry, LIFETIME_KEY[profile], `${href}#cache`, today, true)}`).join("")}</span>`;
}

// ---- results by age: the cells of an item, of an evaluation, and of the evidence page's list of evaluations.
// The ages, counts and percentages are the API's; a cell rounds the percentage to a whole number and the hover text
// has the exact one with the counts.

const columnLabel = (value: number): string => (value < 3600 ? `${value / 60}m` : value % 3600 === 0 ? `${value / 3600}h` : `${value / 60}m`); // 150 -> "2.5m", 4500 -> "75m"
const CONTROL_TITLE = "At once: the prompt sent again immediately. It shows that the prompt was cached at all.";
const level = (result: CacheResult): string => (result.hit_rate_pct === 100 ? "all" : result.hit_rate_pct === 0 ? "none" : result.hit_rate_pct >= 50 ? "most" : "few");
const said = (result: CacheResult): string => `${result.kind === "control" ? "At once" : `After ${ageText(result.age_s)}`}: ${result.hits} of ${result.checks} re-sends served from the cache (${result.hit_rate_pct}%)`;

/**
 * The ages, in seconds, that every table of results by age has a column for, after the control: `cache_ages_s` of
 * /api/v1/meta, as the page read it for this request. A page has no ages of its own.
 */
export type CacheAges = readonly number[];

/** One column of a table of results by age. */
interface Column {
  kind: CacheResult["kind"];
  age_s: number;
}

/** The columns of every table of results by age: the control, then the published ages. */
const columnsOf = (ages: CacheAges): Column[] => [{ kind: "control", age_s: 0 }, ...ages.map((age) => ({ kind: "timed" as const, age_s: age }))];
const inColumn = (results: readonly CacheResult[], column: Column): CacheResult | undefined =>
  results.find((result) => result.kind === column.kind && result.age_s === column.age_s);
/**
 * The ages of the strip: in the column head (`column`), written once so that every row lines up under them, or inside a
 * row (`row`), shown only where the table is stacked and the column head is out of sight.
 */
export const stripHead = (ages: CacheAges, where: "column" | "row"): string =>
  `<span class="heat-strip strip-head${where === "row" ? " in-row" : ""}" aria-hidden="true"><span></span><span class="strip">${columnsOf(ages).map((column) => `<span${column.kind === "control" ? ' class="control"' : ""}>${column.kind === "control" ? "once" : columnLabel(column.age_s)}</span>`).join("")}</span></span>`;

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
export function evaluationStrip(evaluation: RetentionSetting & { results: readonly CacheResult[]; date: string }, ages: CacheAges): string {
  const label = `<span class="strip-label" title="${e(`${retentionSaid(evaluation)} Evaluated on ${evaluation.date}.`)}">${retentionWord(evaluation)}</span>`;
  const cells = columnsOf(ages).map((column) => {
    const result = inColumn(evaluation.results, column);
    const control = column.kind === "control" ? " control" : "";
    if (!result) return `<span class="skip${control}" title="${column.kind === "control" ? "At once" : `After ${ageText(column.age_s)}`}: not checked"></span>`;
    return `<span class="${level(result)}${control}" title="${e(said(result))}">${Math.round(result.hit_rate_pct)}</span>`;
  }).join("");
  return `<span class="heat-strip">${label}<span class="strip">${cells}</span></span>`;
}

export interface RowOptions {
  today: Today;
  /** The date of the models.dev import, shown next to the models.dev source. */
  imported?: string;
  /** pi's catalog as /api/v1/meta describes it (`pi`): its import date is shown next to the pi.dev mark. */
  pi?: MetaPi;
  /** Leave the provider column out (on a provider's own page). */
  hideProvider?: boolean;
  providerNames?: Record<string, string>;
  /**
   * What a provider's page adds to a row from the provider's listing, by entry ref: `note`, lines under the model's id
   * (the plan names a vendor's list attaches); `source`, a source and its date before the entry's own (a vendor's list
   * that names the model). Both are HTML made from fields of the listing.
   */
  listed?: Record<string, RowListed>;
}
export interface RowListed { note: string; source: string }

/** The column names of the entry table. Where the table is stacked, each cell repeats its column's name. */
export const COLUMN = { provider: "Provider", input_window: "Context window", max_output: "Max output", price: "Price in / out", released: "Released", lifetime: "Cache lifetime", source: "Source" } as const;
const WARNED = ` A warning sign marks a value whose sources do not all agree: it opens each source's value.`;

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
${column("input_window", COLUMN.input_window, `The most input one request can carry on this entry, in tokens (safe.input_window). ≥ marks a lower bound, rounded down.${WARNED}`, "num window-col")}
${column("max_output", COLUMN.max_output, `The most tokens one response can hold (safe.max_output). A maximum, not a default.${WARNED}`, "num")}
${column("price_in", COLUMN.price, `List price in US dollars per million tokens, input then output, before any conditional rate (pricing). Conditional rates marks an entry whose price changes with context size, service tier, region, date or the time of day: open the entry for those. A subscription is not paid per token: it shows the API list price of the same model, marked API price, or In plan where the catalog has no API entry of that model.${WARNED}`, "num mid-only")}
${column("release_date", COLUMN.released, "When the model was released, as models.dev records it. It is the model's date: the same at every provider.", "wide-only")}
${column(null, COLUMN.lifetime, `How long a cached prompt can be relied on (safe.cache_short, safe.cache_long): short, what a request gets without asking for a lifetime; long, what it gets when it asks for a longer one. None: no time at all.${WARNED}`, "life-col")}
${column("verified", COLUMN.source, "Where the entry comes from, with a date per source: the import from models.dev, the newest providers.dev evidence, and the import of pi's catalog, where pi lists the entry.")}
</tr>`;
}

export function rowHtml(entry: Summary, options: RowOptions): string {
  const href = entryHref(entry.ref);
  const provider = options.providerNames?.[entry.provider] ?? entry.provider;
  const access = entry.access === "api" ? "" : ` <span class="badge ${entry.access}" title="Access: ${ACCESS_LABEL[entry.access]}">${ACCESS_LABEL[entry.access]}</span>`;
  const status = entry.status ? ` <span class="badge">${e(entry.status)}</span>` : "";
  const listed = options.listed?.[entry.ref];
  return `<tr>
<th scope="row"><a href="${e(href)}">${e(entry.name)}</a>${status}<div class="id"><code>${e(entry.model)}</code>${copyButton(entry.ref, "entry id")}</div>${listed?.note ?? ""}</th>
${options.hideProvider ? "" : `<td class="provider-col" data-label="${COLUMN.provider}"><a class="plain" href="/providers/${e(entry.provider)}/">${e(provider)}</a>${access}</td>`}
<td class="num window-col" data-label="${COLUMN.input_window}">${listValue(entry, "input_window", `${href}#limits`, options.today)}</td>
<td class="num" data-label="${COLUMN.max_output}">${listValue(entry, "max_output", `${href}#limits`, options.today)}</td>
<td class="num mid-only" data-label="${COLUMN.price}">${priceCell(entry, wholePriceWarning(entry.safe.price, warnId(entry.ref, "price"), options.today))}</td>
<td class="wide-only" data-label="${COLUMN.released}">${entry.release_date ? `<span class="muted date">${e(entry.release_date)}</span>` : UNKNOWN}</td>
<td class="life-col" data-label="${COLUMN.lifetime}">${lifetimeCell(entry, href, options.today)}</td>
<td class="nowrap source-col" data-label="${COLUMN.source}">${sourcesHtml(entry, options, false, listed?.source)}</td>
</tr>`;
}

// ---- prices: `pricing` as the API publishes it, the price of `safe.price.source` whole. Nothing here multiplies or
// compares: a multiplier's prices are its `resulting_rates`, and a time rule's name is its `period`. Every price is
// printed with every digit the API states.

const LISTED_PRICE = "The price models.dev lists for this entry. The entry is a subscription; what the listed price bills is not established.";

/** The base price of text in a list, input then output, and the warning of the price before it where its sources disagree. */
function priceCell(entry: Pick<Summary, "price_in" | "price_out" | "price_from" | "access" | "pricing">, warning = ""): string {
  const { price_in: input, price_out: output } = entry;
  const conditional = entry.pricing.rules?.some((rule) => rule.when !== null || rule.operation === "multiply");
  const conditionNote = conditional ? '<div class="hint">Conditional rates</div>' : "";
  const cell = (html: string): string => `<span class="safe-cell">${warning}${html}</span>`;
  // A subscription entry with no API entry of the same model to refer to has no price per token at all.
  if (input === null && output === null) {
    // No price per token for text: a model that makes video or transcribes speech is priced by the second, the image
    // or the minute. The first of its base charges stands in the cell, with its name; the rest are on its page.
    const other = (entry.pricing.rules ?? []).filter((rule) => rule.when === null && rule.operation === "set").sort((a, b) => meterRank(a.meter) - meterRank(b.meter))[0];
    if (other) return `${cell(`<span class="price">${rateHtml(other)}</span>`)}<div class="hint">${e(meterLabel(other.meter))}</div>${conditionNote}`;
    return cell(entry.pricing.billing === "not_applicable" ? IN_PLAN : UNKNOWN) + conditionNote;
  }
  // A listed 0 is shown as the source has it. It can mean free, or paid for another way: the page does not decide.
  const price = `<span class="price">${input === null ? DASH : usdUnrounded(input)} <span class="muted">/</span> ${output === null ? DASH : usdUnrounded(output)}</span>`;
  // Two short lines: the price, then whose price it is.
  if (entry.price_from) {
    return `<span class="price-inherited" title="Not what this entry costs: a subscription is not paid per token. This is the API list price of ${e(entry.price_from)}.">${cell(price)}<span class="price-from">API price</span></span>${conditionNote}`;
  }
  if (entry.access === "subscription") return `<span class="price-inherited" title="${e(LISTED_PRICE)}">${cell(price)}<span class="price-from">Listed price</span></span>${conditionNote}`;
  return cell(price) + conditionNote;
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
  const amount = rate.currency === "USD" ? usdUnrounded(rate.amount) : `${e(rate.currency ?? "Currency unknown")} ${e(String(rate.amount))}`;
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

/** The part of the price each of the four text charges is, where the sources compare it (`safe.price.differs`). */
const PRICE_PART: Readonly<Record<string, PricePart>> = { "text.input": "input", "text.output": "output", "text.cache_read": "cache_read", "text.cache_write": "cache_write" };

/**
 * The price of an entry, `pricing` whole: one row per base charge, then one block per condition. The warning is on a
 * row where `safe.price.differs` names its part, and on the conditional rates where it names `tiers` or `other`.
 */
function priceSection(summary: Summary, today: Today): string {
  const pricing = summary.pricing;
  const price = summary.safe.price;
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
      const part = PRICE_PART[meter];
      const warning = part ? priceWarning(price, [part], meterLabel(meter), warnId("price", part), today) : "";
      return `<tr><th scope="row">${e(meterLabel(meter))}</th><td class="num"><span class="safe-cell">${warning}<span class="rates">${value.length ? value.join("<br>") : absent}</span></span></td></tr>`;
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
  const ratesWarning = priceWarning(price, ["tiers", "other"], "Conditional rates", warnId("price", "rates"), today);
  return `${note}<div class="scroll"><table class="facts pairs stack-phone"><thead><tr><th scope="col">Base charge</th><th scope="col" class="num">Rate</th></tr></thead><tbody>${rows}</tbody></table></div>
<h3 class="with-warning"><span>Conditional rates</span>${ratesWarning}</h3>
<div class="scroll"><table class="facts conditional stack-phone"><thead><tr><th scope="col">Condition</th><th scope="col">Charge</th><th scope="col" class="num">Rate</th><th scope="col">Applies to</th></tr></thead>${changes || `<tbody><tr class="empty-row"><td colspan="4" class="muted">${none}</td></tr></tbody>`}</table></div>
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

function sourceOf(path: string, provenance: Provenance[], origin: ModelExtension["origin"]): string {
  const change = provenance.find((item) => item.path === path || path.startsWith(`${item.path}.`) || item.path.startsWith(`${path}.`));
  if (change) return `<span class="origin modified" title="Corrected by providers.dev. models.dev says: ${e(change.had_upstream ? JSON.stringify(change.upstream) : "nothing")}">providers.dev</span>`;
  if (origin === "added") return '<span class="origin added">providers.dev</span>';
  return '<span class="origin upstream" title="Imported from models.dev. Not independently checked.">models.dev</span>';
}

/** A column's heading in the table of lifetimes, also repeated by each of its cells where the table is stacked. */
const heatLabel = (column: Column): string => (column.kind === "control" ? "At once" : shortAge(column.age_s));

/** One cell of results by age: the hit rate in percent, rounded, with hits/checks under it; the exact rate is in the title. */
function heatCell(result: CacheResult | undefined, column: Column): string {
  const label = ` data-label="${heatLabel(column)}"`;
  if (!result) return `<td class="heat unchecked"${label}><span class="skip" title="${column.kind === "control" ? "At once" : `After ${ageText(column.age_s)}`}: not checked">·</span></td>`;
  return `<td class="heat"${label}><span class="${level(result)}" title="${e(said(result))}">${Math.round(result.hit_rate_pct)}<small>${result.hits}/${result.checks}</small></span></td>`;
}

/** The headings of the age columns, each saying in its hover text what its age is. */
const heatHead = (columns: readonly Column[]): string =>
  columns.map((column) => `<th scope="col" class="age" title="${column.kind === "control" ? CONTROL_TITLE : `The prompt sent again ${ageText(column.age_s)} after it was cached.`}">${heatLabel(column)}</th>`).join("");
/** The cells of one row of results by age, one per column. */
const heatCells = (results: readonly CacheResult[], columns: readonly Column[]): string => columns.map((column) => heatCell(inColumn(results, column), column)).join("");

/** Results at ages without a column, in words. Nothing an evaluation checked is left out of the page. */
function otherAges(results: readonly CacheResult[], columns: readonly Column[]): string {
  const others = results.filter((result) => !columns.some((column) => column.kind === result.kind && column.age_s === result.age_s));
  if (others.length === 0) return "";
  return `Also checked: ${others.map((result) => `${ageText(result.age_s)} ${Math.round(result.hit_rate_pct)}% (${result.hits}/${result.checks})`).join(", ")}`;
}

/** A retention profile in the table of cache evaluations: its name, over the lifetimes measured for it. */
function profileRow(profile: RetentionProfile, items: number, columns: readonly Column[]): string {
  return `<tbody class="profile"><tr><th scope="rowgroup" title="${PROFILE_TITLE[profile]}">${PROFILE_WORD[profile]} retention</th><td class="profile-facts" colspan="${1 + columns.length}">${items === 0 ? '<span class="muted">No evaluation</span>' : `<span class="muted">${items === 1 ? "1 client and setting" : `${exact(items)} clients and settings`}</span>`}</td></tr></tbody>`;
}

/** The lifetime one client held, and the date of its newest evaluation: the first cell of each lifetime. */
function lifetimeHead(item: CacheLifetimeItem, today: Today): string {
  const date = item.date === null
    ? '<span class="muted date">Date unknown</span>'
    : isStale(item.date, today)
      ? `<span class="stale" title="The newest evaluation, more than ${plural(today.stale_after_days, "day")} ago.">${e(item.date)} · stale</span>`
      : `<span class="muted date" title="The date of the newest evaluation.">${e(item.date)}</span>`;
  return `<td class="life" data-label="Lifetime"><span class="life-value" title="${exact(item.lifetime_s)} s: the oldest age through which every check hit.">${lifetimeWords(item.lifetime_s)}</span>${date}</td>`;
}

/** The note of an evaluation, where it has one, named by the evaluation where the note could be read as another's. */
const runNote = (run: CacheEvaluation, named: boolean): string => (run.note ? `<p class="run-note"><b>Note${named ? ` <code>${e(run.id)}</code>` : ""}</b> ${e(run.note)}</p>` : "");

/**
 * One evaluation under its lifetime: the run, its settings, the raw result, and its own results by age. Its note is on
 * the lifetime's row, in sight before the evaluations are opened; an evaluation in no lifetime carries its own.
 */
function runRow(run: CacheEvaluation, today: Today, columns: readonly Column[], withNote = false): string {
  const settings = settingsText(run.request_settings);
  const other = otherAges(run.results, columns);
  const date = isStale(run.date, today) ? `<span class="stale" title="Evaluated more than ${plural(today.stale_after_days, "day")} ago.">${e(run.date)} · stale</span>` : `<span class="muted date" title="The date of this evaluation.">${e(run.date)}</span>`;
  return `<tr class="run"><td class="run-head" colspan="2">${withNote ? runNote(run, false) : ""}<code>${e(run.id)}</code> ${date}<div class="hint">${e(run.route_label)}${settings ? ` · <code>${e(settings)}</code>` : ""}${other ? ` · ${e(other)}` : ""}</div><a href="${e(run.source)}" rel="noopener">Raw result</a></td>${heatCells(run.results, columns)}</tr>`;
}

const NOT_COUNTED = '<span class="chip not-counted" title="On this entry another kind of client counts: what this one held gives no value. The methodology says which counts.">Not counted</span>';
const NOT_COUNTED_LIMIT = '<span class="chip not-counted" title="On this entry another kind of client counts: the window this evaluation gives is no value of the entry. The methodology says which counts.">Not counted</span>';

/**
 * The lifetime one client held with one request setting: its client and setting, its checks and results by age, the
 * notes of its evaluations, and each evaluation under it. One that does not feed the value (`chosen: false`) says so.
 */
function itemRows(item: CacheLifetimeItem, evaluations: readonly CacheEvaluation[], today: Today, columns: readonly Column[]): string {
  const runs = item.evaluation_ids.flatMap((id) => evaluations.filter((run) => run.id === id));
  const setting = item.parameter && item.value ? `Sent <code>${e(item.parameter)}=${e(item.value)}</code>` : "No lifetime asked for";
  const checks = `<span title="Re-sends served from the cache, of those made, the control included.">${exact(item.hits)} of ${exact(item.checks)} checks hit</span>`;
  const ages = `${item.tested_from_s === null ? "No timed check" : `Tested from ${span(item.tested_from_s)}`} · ${item.first_miss_s === null ? "No miss" : `First miss ${ageText(item.first_miss_s)}`}`;
  const other = item.results ? otherAges(item.results, columns) : "";
  const notes = runs.map((run) => runNote(run, runs.length > 1)).join("");
  const what = `<strong class="client">${e(item.client_label ?? item.client ?? "")}</strong>${item.chosen ? "" : ` ${NOT_COUNTED}`}<div class="hint">${setting} · ${checks}</div><div class="hint">${ages}${other ? ` · ${e(other)}` : ""}</div>${notes}<details class="runs"><summary>${plural(item.evaluations, "evaluation")}</summary></details>`;
  const results = item.results ?? [];
  return `<tbody class="item measured${item.chosen ? "" : " not-counted"}"><tr>${lifetimeHead(item, today)}<td class="through" data-label="Client">${what}</td>${heatCells(results, columns)}</tr>${runs.map((run) => runRow(run, today, columns)).join("")}</tbody>`;
}

/**
 * The cache evaluations of an entry, one table for all: per retention profile the lifetime each client held with each
 * request setting, those that feed the value (`chosen`) first and the others marked as not counted, each opening onto
 * its evaluations. Both profiles on every entry. The age columns are the published ones (`cache_ages_s` of
 * /api/v1/meta). What the ages and the cells are is said to a screen reader by the heading over the ages, and in sight
 * by the legend under the table: one sample cell and its words.
 */
function evaluationsTable(cache: EntryCache, today: Today, ages: CacheAges): string {
  const record = cache.lifetime;
  const columns = columnsOf(ages);
  const body = RETENTION_PROFILES.map((profile) => {
    const measured = record.lifetimes.filter((item) => item.retention_profile === profile && item.basis === "measured");
    const ordered = [...measured.filter((item) => item.chosen), ...measured.filter((item) => !item.chosen)];
    return profileRow(profile, ordered.length, columns) + ordered.map((item) => itemRows(item, cache.evaluations, today, columns)).join("");
  }).join("");
  // An evaluation that is in no lifetime (no timed result, and a control that hit) is still on the page.
  const named = new Set(record.lifetimes.flatMap((item) => item.evaluation_ids));
  const others = cache.evaluations.filter((run) => !named.has(run.id));
  const rest = others.length
    ? `<tbody class="profile"><tr><th scope="rowgroup">Other evaluations</th><td class="profile-facts" colspan="${1 + columns.length}"><span class="muted">In no lifetime</span></td></tr></tbody><tbody class="item others">${others.map((run) => runRow(run, today, columns, true)).join("")}</tbody>`
    : "";
  return `<div class="scroll"><table class="facts heat lifetimes stack-tablet"><caption class="sr-only">The cache evaluations of this entry, by retention</caption><thead><tr><th scope="col" rowspan="2">Lifetime</th><th scope="col" rowspan="2">Client</th><th scope="colgroup" colspan="${columns.length}" class="span"><span class="sr-only">Time since the prompt was cached · served from the cache, in percent, with hits/checks</span></th></tr><tr>${heatHead(columns)}</tr></thead>${body}${rest}</table></div>
<p class="legend"><span class="legend-head"><span class="heat-key most" aria-hidden="true">67<small>2/3</small></span> Checks served from the cache, in percent and as hits/checks, by time since the prompt was cached</span><span><span class="heat-key all">100</span> All</span><span><span class="heat-key most">67</span> Half or more</span><span><span class="heat-key few">33</span> Fewer</span><span><span class="heat-key none">0</span> None</span><span><span class="heat-key skip">·</span> Not checked at that age</span><span><a href="/docs/methodology/#evaluations">Methodology</a></span></p>`;
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

/**
 * The limit evaluations of an entry, one row each. An evaluation whose item of the input window says it does not feed
 * the value (`chosen: false` in `measurements`: another kind of client counts on this entry) says so, as the cache
 * table does. The item is the one of the same route, client, date and raw result; the page applies no rule.
 */
function measuredLimitRows(limits: MeasuredLimit[], measurements: readonly InputWindowMeasurement[]): string {
  const cell = (value: number | null, label: string): string => `<td class="num" data-label="${label}">${value === null ? UNKNOWN : exact(value)}</td>`;
  const notCounted = (limit: MeasuredLimit): boolean =>
    measurements.some((item) => !item.chosen && item.route === limit.route && item.client === limit.client && item.date === limit.date && item.source === limit.source);
  return limits
    .map(
      (limit) =>
        `<tr${notCounted(limit) ? ' class="not-counted"' : ""}><td data-label="Date">${limit.date ? `<span class="muted date">${e(limit.date)}</span>` : UNKNOWN}</td><td class="span-row" data-label="Route and client">${e(limit.route_label)}<div class="hint">${e(limit.client_label)}${notCounted(limit) ? ` ${NOT_COUNTED_LIMIT}` : ""}</div></td>${cell(limit.context, "Context")}${cell(limit.input_accepted, "Input accepted")}${cell(limit.input_refused, "Input refused")}${cell(limit.output, "Output limit")}${cell(limit.output_accepted, "Requested output accepted")}<td data-label="Evidence"><a href="${e(limit.source)}" rel="noopener">Raw result</a></td></tr>`,
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
<th scope="row" title="${e(CACHE_MODE_TITLE[mode])}">${CACHE_MODE_WORD[mode]} <span class="chip">${mode}</span></th>
<td data-label="Supported">${state}</td>
<td class="num" data-label="Min. tokens">${supported ? (detail.min_tokens === null ? UNKNOWN : exact(detail.min_tokens)) : blank}</td>
<td class="num" data-label="Breakpoints">${supported && mode === "explicit" ? (detail.max_breakpoints === null ? UNKNOWN : exact(detail.max_breakpoints)) : supported ? NOT_APPLICABLE : blank}</td>
<td data-label="Targets">${supported && mode === "explicit" ? (detail.targets === null ? UNKNOWN : e(detail.targets.join(", "))) : supported ? NOT_APPLICABLE : blank}</td>
</tr>`;
  });
  return `<div class="scroll"><table class="facts stack-phone"><thead><tr><th scope="col">Mode</th><th scope="col">Supported</th><th scope="col" class="num">Min. tokens</th><th scope="col" class="num">Breakpoints</th><th scope="col">Targets</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>
<p class="hint">Source: ${source} · <a href="/docs/methodology/#caching">Cache modes</a></p>`;
}

// ---- pi's catalog: `providers_dev.pi` of an entry and `pi` of /api/v1/meta, as the API publishes them: what only pi
// returns, printed as the block has it. pi's limits, prices and lifetimes are statements of the safe values, and the
// page shows them only in a value's warning, or as the value where pi alone states one. What pi does not state says
// so, never "no": a flag absent from `compat` is not false.

const NOT_STATED = '<span class="unknown" title="pi\'s catalog does not state it.">Not stated</span>';

/** A map pi states, a name and a value per line, values as written in pi's catalog. */
function piPairs(pairs: [string, string][], className: string): string {
  return `<dl class="pi-pairs ${className}">${pairs.map(([name, value]) => `<div><dt>${name}</dt><dd>${value}</dd></div>`).join("")}</dl>`;
}

/** A word of the table of words: escaped, a field or value in backticks as code. */
const piWord = (text: string): string => e(text).replace(/`([^`]+)`/g, "<code>$1</code>");
const rawFlag = (value: Json): string => (typeof value === "string" ? value : JSON.stringify(value));

/**
 * pi's flags in their three groups (`src/core/pi-words.ts`), each printed only where pi states it, once, in the order pi
 * lists them. Group A says a flag in words, then pi's name and value; groups B and C print pi's name and value.
 */
function piFlags(compat: PiBlock["compat"]): Record<PiFlagGroup, string> {
  const flags = Object.entries(compat ?? {});
  const none = (group: PiFlagGroup): string =>
    `<span class="unknown" title="pi's catalog states no ${group === "other" ? "other flag" : "flag of this group"} for this model. A flag not stated follows pi's own default: it is not false.">None stated</span>`;
  const of = (group: PiFlagGroup) => flags.filter(([name]) => piFlagGroup(name) === group);
  const accepts = of("accepts").map(([name, value]): [string, string] => {
    const words = PI_ACCEPTS_FLAGS[name]!;
    const said = typeof value === "boolean" && words.says !== "value"
      ? words.says === "required" ? (value ? "Required" : "Not required") : value ? "Accepted" : "Not accepted"
      : `<code>${e(rawFlag(value))}</code>`;
    return [`${piWord(words.label)}<div class="hint"><code>${e(name)}: ${e(JSON.stringify(value))}</code></div>`, said];
  });
  const raw = (group: PiFlagGroup): [string, string][] => of(group).map(([name, value]) => [`<code>${e(name)}</code>`, `<code>${e(JSON.stringify(value))}</code>`]);
  return {
    accepts: accepts.length ? piPairs(accepts, "accepts") : none("accepts"),
    own: of("own").length ? piPairs(raw("own"), "flags") : none("own"),
    other: of("other").length ? piPairs(raw("other"), "flags") : none("other"),
  };
}

/**
 * How pi calls the model: pi's name for it, the request format in words and in pi's word, the address, the input,
 * reasoning, the thinking levels, the flags in their three groups and the request limits. The same rows on every entry
 * pi lists. pi's limits, prices and cache lifetimes are not here: they are statements of the values above.
 */
function piCallTable(block: PiBlock): string {
  const row = (label: string, hint: string, value: string): string => `<tr><th scope="row">${label}<div class="hint">${hint}</div></th><td>${value}</td></tr>`;
  const levels = block.thinking_level_map === null
    ? NOT_STATED
    : piPairs(Object.entries(block.thinking_level_map).map(([level, value]) => [e(level), value === null ? '<span class="muted" title="pi marks this level as not supported.">not supported</span>' : `<code>${e(value)}</code>`]), "levels");
  const flags = piFlags(block.compat);
  const limits = block.input_limits;
  const limit = (value: number | null, unit: string): string => (value === null ? NOT_STATED : `${exact(value)} <span class="muted">${unit}</span>`);
  const requestLimits = limits.max_request_bytes === null && limits.max_images_per_request === null && limits.max_images_per_message === null
    ? '<span class="unknown" title="pi\'s catalog states no request limits for this model.">None stated</span>'
    : piPairs([["Request size", limit(limits.max_request_bytes, "bytes")], ["Images per request", limit(limits.max_images_per_request, "")], ["Images per message", limit(limits.max_images_per_message, "")]], "limits");
  const named = block.match === "alias"
    ? "Paired by providers.dev: pi spells the provider or model id otherwise than this entry."
    : "The same provider and model id as this entry.";
  const words = PI_FORMAT_WORDS[block.api];
  const format = words ? `${e(words)}<div class="id"><code>${e(block.api)}</code></div>` : `<code>${e(block.api)}</code>`;
  const group = (key: PiFlagGroup): string => row(e(PI_FLAG_GROUPS[key].title), piWord(PI_FLAG_GROUPS[key].said), flags[key]);
  return `<div class="scroll"><table class="facts pairs pi-call stack-phone"><thead><tr><th scope="col">In pi's catalog</th><th scope="col">As pi states it</th></tr></thead><tbody>
${row("Model", named, `<strong>${e(block.name)}</strong><div class="id"><code>${e(block.ref)}</code>${copyButton(block.ref, "pi's id")}</div>`)}
${row("Request format", "<code>api</code>: the API pi speaks to this model, in words and in pi's word", format)}
${row("Address", "<code>base_url</code>: where pi sends requests, placeholders as written", block.base_url === null ? NOT_STATED : `<code class="break">${e(block.base_url)}</code> ${copyButton(block.base_url, "address")}`)}
${row("Input", "What pi sends to the model, in pi's words", block.input.length ? block.input.map((kind) => `<span class="chip">${e(kind)}</span>`).join(" ") : NOT_STATED)}
${row("Reasoning", "Whether pi treats the model as one that reasons", block.reasoning ? "Yes" : "No")}
${row("Thinking levels", "The value pi sends for each level it names. A level not named follows pi's own default. Not the provider's list of effort values", levels)}
${group("accepts")}
${group("own")}
${group("other")}
${row("Request limits", "The provider's limits on one request, as pi states them", requestLimits)}
</tbody></table></div>`;
}

/**
 * The section of an entry's page that holds only what pi alone returns, the same on every entry pi lists: whose data it
 * is and as of when, then how pi calls the model. On an entry pi does not list, one line.
 */
function piSection(block: PiBlock | null, meta: MetaPi | undefined): string {
  const dates = piDates(meta);
  const source = `<a href="${e(meta?.source ?? "https://pi.dev/api/models")}" rel="noopener">${e(shortUrl(meta?.source ?? "https://pi.dev/api/models"))}</a>`;
  const fetched = dates.fetched ? `<span>Fetched <span class="date" title="${e(UTC(meta!.snapshot!.fetched_at))}">${e(dates.fetched)}</span> from ${source}</span>` : `<span>From ${source}</span>`;
  const checked = dates.checked ? `<span title="pi's feed was checked again on this date and had not changed since the fetch.">Last checked <span class="date" title="${e(UTC(meta!.snapshot!.checked_at))}">${e(dates.checked)}</span>, unchanged</span>` : "";
  // "The last good one" only where there is one: after a first import that failed, the dataset has no pi data.
  const failed = dates.failed ? `<span class="stale" title="${e(piDatesSaid(meta))}">The last import${dates.failed_at ? `, ${e(dates.failed_at)},` : ""} failed${meta?.snapshot ? ": this is the last good one" : ""}</span>` : "";
  if (block === null) {
    if (meta && meta.snapshot === null) return `<p class="muted">This dataset is built without pi's catalog (${source}).${failed ? ` ${failed}` : ""}</p>`;
    return `<p class="muted">pi's model catalog does not list this entry.</p><p class="pi-facts muted">${fetched}${checked}${failed}</p>`;
  }
  const list = `https://pi.dev/models?provider=${encodeURIComponent(block.provider)}`;
  return `<p class="pi-facts"><span class="origin pi" title="pi's model catalog, a second source imported beside models.dev.">pi.dev</span>${fetched}${checked}${failed}<span>Not verified by providers.dev</span><span>Its limits, prices and cache lifetimes: the last source of each value above</span><span><a href="${e(list)}" rel="noopener">pi's list for <code>${e(block.provider)}</code></a></span></p>
${piCallTable(block)}
<p class="hint"><a href="/docs/methodology/#pi">How pi's catalog is used</a></p>`;
}

function tile(label: string, value: string, foot: string, small = false): string {
  return `<div class="tile"><div class="label">${label}</div><div class="value${small ? " small" : ""}">${value}</div>${foot ? `<div class="foot">${foot}</div>` : ""}</div>`;
}

export interface EntryView {
  summary: Summary;
  provider: ProviderSummary;
  model: JsonObject;
  today: Today;
  /** The age columns of the results by age: `cache_ages_s` of /api/v1/meta. */
  cache_ages_s: CacheAges;
  /** The date of the models.dev import. */
  imported?: string;
  /** pi's catalog as /api/v1/meta describes it (`pi`): where it came from, when, and whether the last import worked. */
  pi?: MetaPi;
}

/** What each safe quantity is, under its label in its table: the same words on every entry. */
const QUANTITY_HINT = {
  input_window: "The most input one request can carry, in tokens",
  max_output: "The most one response can hold. A maximum, not a default",
  cache_short: "Without asking for a lifetime, or with the shortest one",
  cache_long: "When the request asks for a longer lifetime",
} as const;

/**
 * The page of one entry. Each quantity is shown as its safe value and nothing else (`safe` of the summary): in a tile
 * at the top, and in its row of its topic's table, with the warning where its sources disagree. Under each table, the
 * evidence: the limit evaluations, the price's conditions and request controls, the cache evaluations.
 */
export function entryHtml(view: EntryView): string {
  const { summary, provider, model, today, cache_ages_s } = view;
  const extension = model[NS] as unknown as ModelExtension;
  const provenance = extension.provenance;
  const cache = extension.cache;
  const measuredLimits = extension.limits.measured;
  const safe = summary.safe;
  const api = `/api/v1${entryHref(summary.ref)}`;
  // The sources of the entry, the pi.dev mark among them where pi lists it, dated by the pi import.
  const sources = sourcesHtml(summary, { today, imported: view.imported, pi: view.pi, entry: true }, true);
  // The note under the context window: exactly where the API publishes `window_tokens`.
  const window = safe.input_window.window_tokens;
  const note = window === null ? "" : `<div class="window-note" title="${exact(window)} tokens: the window the input shares with the response.">${windowNote(window)}</div>`;

  /** A safe value in a tile: the value, then its warning. */
  const tileValue = (quantity: Exclude<SafeQuantity, "price">): string =>
    `<span class="safe-cell">${safeText(safe[quantity])}${safeWarning(safe[quantity], quantity, warnId("tile", quantity), today)}</span>`;
  /** The price in a tile: text input and output, or the first other charge; whose price it is under it. */
  const priceTile = (): string => {
    const warning = wholePriceWarning(safe.price, warnId("tile", "price"), today);
    const conditional = summary.pricing.rules?.some((rule) => rule.when !== null || rule.operation === "multiply") ? "<div>Conditional rates below</div>" : "";
    const whose = summary.price_from
      ? `<div>API list price of <a href="${e(entryHref(summary.price_from))}"><code>${e(summary.price_from)}</code></a></div>`
      : summary.access === "subscription" && summary.pricing.rules !== null ? `<div title="${e(LISTED_PRICE)}">Listed price</div>` : "";
    if (summary.price_in === null && summary.price_out === null) {
      const other = (summary.pricing.rules ?? []).filter((rule) => rule.when === null && rule.operation === "set").sort((a, b) => meterRank(a.meter) - meterRank(b.meter))[0];
      if (other) return tile("Price", `<span class="safe-cell"><span>${rateHtml(other)}</span>${warning}</span>`, `${e(meterLabel(other.meter))}${whose}${conditional}`, true);
      return tile("Price", `<span class="safe-cell">${summary.pricing.billing === "not_applicable" ? IN_PLAN : UNKNOWN}${warning}</span>`, `${whose}${conditional}`);
    }
    const side = (value: number | null): string => (value === null ? DASH : usdUnrounded(value));
    return tile("Price", `<span class="safe-cell"><span class="price">${side(summary.price_in)} <span class="unit">/</span> ${side(summary.price_out)}</span>${warning}</span>`, `Input / output, per 1M tokens${whose}${conditional}`);
  };
  /** A safe value in its row: the warning first, so that the column's numbers stay aligned on the right. */
  const row = (quantity: Exclude<SafeQuantity, "price">, more = ""): string =>
    `<tr><th scope="row">${QUANTITY_LABEL[quantity]}<div class="hint">${QUANTITY_HINT[quantity]}</div></th><td class="num" data-label="Value"><span class="safe-cell">${safeWarning(safe[quantity], quantity, warnId("row", quantity), today)}<span class="safe-value">${safeText(safe[quantity])}</span></span>${more}</td></tr>`;
  const valueTable = (head: string, rows: string): string =>
    `<div class="scroll"><table class="facts safe-facts stack-phone"><thead><tr><th scope="col">${head}</th><th scope="col" class="num">Value</th></tr></thead><tbody>${rows}</tbody></table></div>`;

  return `
<header class="entry-head">
  <p class="crumbs"><a href="/providers/">Providers</a> / <a href="/providers/${e(provider.id)}/">${e(provider.name)}</a>${summary.canonical_id ? ` · <a href="${e(modelHref(summary.canonical_id))}">All access methods for ${e(summary.canonical_id)}</a>` : ""}</p>
  <h1>${e(summary.name)}</h1>
  <p class="id"><code>${e(summary.ref)}</code>${copyButton(summary.ref, "entry id")} <span class="badge ${summary.access}">${ACCESS_LABEL[summary.access]}</span>
  ${sources}${summary.status ? ` <span class="badge">${e(summary.status)}</span>` : ""}</p>
  <p class="released muted">Type <span title="The kind of model, as models.dev records it.">${summary.type ? e(summary.type) : "unknown"}</span> · ${
    summary.release_date
      ? `Released <span class="date" title="The model's release date, as models.dev records it. It is the same at every provider.">${e(summary.release_date)}</span>`
      : "Release date unknown"
  }</p>
</header>

<div class="tiles tiles-five mt-6">
  ${tile(QUANTITY_LABEL.input_window, tileValue("input_window"), note)}
  ${tile(QUANTITY_LABEL.max_output, tileValue("max_output"), "")}
  ${priceTile()}
  ${tile(QUANTITY_LABEL.cache_short, tileValue("cache_short"), "")}
  ${tile(QUANTITY_LABEL.cache_long, tileValue("cache_long"), "")}
</div>

<section aria-labelledby="limits">
  <h2 id="limits">Limits</h2>
  ${valueTable("Limit", row("input_window", note) + row("max_output"))}
  <h3>Limit evaluations <span class="hint">tokens</span></h3>
  <div class="scroll"><table class="facts stack-tablet"><thead><tr><th scope="col">Date</th><th scope="col">Route and client</th><th scope="col" class="num">Context</th><th scope="col" class="num">Input accepted</th><th scope="col" class="num">Input refused</th><th scope="col" class="num">Output limit</th><th scope="col" class="num">Requested output accepted</th><th scope="col">Evidence</th></tr></thead><tbody>${
    measuredLimits.length > 0 ? measuredLimitRows(measuredLimits, extension.limits.input_window.measurements) : '<tr class="empty-row"><td colspan="8" class="muted">No limit evaluation on this entry.</td></tr>'
  }</tbody></table></div>
</section>

<section aria-labelledby="price">
  <h2 id="price">Price</h2>
  ${priceSection(summary, today)}
  <h3>Request controls</h3>
  ${requestControlTable(summary.request_controls.items.filter((control) => control.id !== "cache.retention"))}
</section>

<section aria-labelledby="cache">
  <h2 id="cache">Prompt caching</h2>
  ${valueTable("Lifetime", row("cache_short") + row("cache_long"))}
  <h3>Cache evaluations</h3>
  ${evaluationsTable(cache, today, cache_ages_s)}
  <h3>Cache modes</h3>
  ${cacheDocumented(cache.documented, sourceOf("capabilities.cache", provenance, extension.origin))}
  <h3>Retention</h3>
  ${requestControlTable(summary.request_controls.items.filter((control) => control.id === "cache.retention"))}
</section>

<section aria-labelledby="pi">
  <h2 id="pi">How pi calls the model</h2>
  ${piSection(extension.pi, view.pi)}
</section>

<section aria-labelledby="provenance">
  <h2 id="provenance">Provenance</h2>
  <div class="scroll"><table class="facts pairs stack-phone">
    <thead><tr><th scope="col">Provenance</th><th scope="col">Value</th></tr></thead>
    <tbody>
      <tr><th scope="row">Source</th><td>${sources}</td></tr>
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
