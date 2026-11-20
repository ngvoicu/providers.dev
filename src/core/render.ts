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
  type LifetimeSource,
  type RetentionProfile,
  type SafeLifetime,
} from "./cache.ts";
import type { ProviderSummary, Summary } from "./entries.ts";
import { conditionText } from "./conditions.ts";
import type { PricingRule, RequestControl } from "./policy-contract.ts";
import type { InputWindow, InputWindowMeasurement } from "./limits.ts";
import {
  compactTokens,
  compactTokensDown,
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
  usdUnrounded,
  type Today,
} from "./format.ts";
import { isObject, type Json, type JsonObject } from "./merge.ts";
import type { PiBlock, PiCostTier, PiDifference, PiDifferenceField, PiSummary } from "./pi.ts";
import { NS, type MeasuredLimit, type MetaPi, type ModelExtension, type Provenance, type PublishedEvidence } from "./schema.ts";

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
 * ones beside it, saying what it means in its title, not a link. In a row it says only that pi lists the entry; on the
 * entry's own page it also says how many values pi states otherwise, as the API counts them (`difference_count`), in
 * words. pi is not a source of the entry: its origin stays as it is.
 */
function piMark(pi: PiSummary, differences: boolean): string {
  const n = pi.difference_count;
  const named = pi.match === "alias" ? `, as ${pi.ref}` : "";
  const said = !differences
    ? `pi's model catalog (pi.dev) also lists this entry${named}. Imported beside models.dev, not verified by providers.dev. The entry's page shows what pi states.`
    : n === 0
      ? `pi's model catalog (pi.dev) also lists this entry${named}. Its price, context window and output limit agree with this page wherever both state one. Imported, not verified by providers.dev.`
      : `pi's model catalog (pi.dev) also lists this entry${named}, and states ${plural(n, "value")} otherwise than this page, which follows models.dev. Imported, not verified by providers.dev.`;
  const differ = differences && n > 0 ? `<span class="pi-differ">${exact(n)} ${n === 1 ? "differs" : "differ"}<span class="sr-only"> from this page</span></span>` : "";
  return `<span class="origin pi" title="${e(said)}">pi.dev${differ}</span>`;
}

/**
 * One line per source with its own date: the models.dev import, and the newest providers.dev evidence. Where pi's
 * catalog lists the entry, the pi.dev mark under them. On the entry's own page (`pi` given) the mark carries the
 * differences and the date providers.dev fetched pi's catalog; in a row it carries neither.
 */
function sourcesHtml(entry: Pick<Summary, "origin" | "verified" | "overridden_fields" | "pi">, options: { today: Today; imported?: string; pi?: MetaPi }, inline = false): string {
  const parts: string[] = [];
  if (entry.origin !== "added") {
    const date = options.imported ? `<span class="muted date" title="Imported from models.dev on this date.">${e(options.imported)}</span>` : "<span></span>";
    parts.push(`<span class="origin upstream" title="${e(ORIGIN_TITLE.upstream)}">${ORIGIN_LABEL.upstream}</span>${date}`);
  }
  if (entry.origin !== "upstream") {
    const corrected = entry.overridden_fields.length > 0 ? ` Corrected fields: ${entry.overridden_fields.join(", ")}.` : "";
    parts.push(`<span class="origin added" title="${e(ORIGIN_TITLE[entry.origin] + corrected)}">${ORIGIN_LABEL.added}</span>${dateTag(entry.verified, options.today) || "<span></span>"}`);
  }
  if (entry.pi) {
    // Last in the list, so in a row it needs no empty cell for a date: the mark can sit beside the first source.
    const dates = piDates(options.pi);
    const date = !options.pi || dates.fetched === null
      ? ""
      : `<span class="${dates.failed ? "stale" : "muted date"}" title="${e(piDatesSaid(options.pi))}">${e(dates.fetched)}${dates.failed ? " · last import failed" : ""}</span>`;
    parts.push(`${piMark(entry.pi, options.pi !== undefined)}${date}`);
  }
  return `<span class="sources${inline ? " side" : ""}">${parts.join("")}</span>`;
}

/** How a provider's prompt cache is switched on, in plain words. The data and the API keep models.dev's names: implicit, explicit. */
export const CACHE_MODE_WORD = { implicit: "Automatic", explicit: "Manual" } as const;
const CACHE_MODE_TITLE = {
  implicit: "Automatic (implicit): the provider caches the start of a prompt by itself. The request does nothing for it.",
  explicit: "Manual (explicit): nothing is cached unless the request marks what to cache. The mark also picks the lifetime.",
} as const;

// ---- the input window: `input_window` of a summary and `providers_dev.limits.input_window` of an entry, as the API
// publishes them. This file compares nothing, takes no minimum, applies no margin and picks no source: which value is
// the published one is `basis`, whether it is a lower bound is `bound` ("at least", "≥"), what the rule found of the
// documentation is `documented_status`, and what a measurement is, is its `kind`.

export const SCOPE_WORD = { input: "Input alone", window: "Input and output together" } as const;
const SCOPE_TITLE = {
  input: "A figure for the input alone: the response is not counted against it.",
  window: "A context window: input and output together. The response is counted against the same figure.",
} as const;
const WINDOW_BASIS_TITLE = {
  documented: "Documented: the input limit or context window the source documents for this entry.",
  measured: "Measured by providers.dev on this access.",
} as const;
/** What a measured value is, by its `kind`, in a sentence. */
const MEASURED_SAID = { window: "the window the route named", bracket: "the largest input seen accepted", accepted: "the largest input seen accepted and read to the end, nothing refused" } as const;

/** "at least " where the record says the value is a lower bound, and only there. */
const atLeast = (bound: InputWindow["bound"]): string => (bound === "at_least" ? "at least " : "");

/** What one measurement saw, in its own numbers, by its `kind`. */
function measurementSaid(item: InputWindowMeasurement): string {
  const parts =
    item.kind === "window"
      ? ["Window named by the route", item.accepted === null ? "" : `an input of ${exact(item.accepted)} accepted`]
      : item.kind === "bracket"
        ? [item.accepted === null ? "" : `${exact(item.accepted)} accepted`, item.refused === null ? "" : `${exact(item.refused)} refused`]
        : [item.accepted === null ? "Accepted" : `${exact(item.accepted)} accepted`, "read to the end", "nothing refused"];
  // A read check is printed wherever one was made; on an `accepted` measurement it is the value itself.
  if (item.read !== null && item.kind !== "accepted") parts.push(`${exact(item.read)} read to the end`);
  if (item.read !== null && item.kind === "accepted") parts[1] = `${exact(item.read)} read to the end`;
  return parts.filter(Boolean).join(" · ");
}

/** The input window of an entry and what it rests on, in plain sentences for a tooltip. All of it is the record's. */
function windowSaid(w: InputWindow): string {
  if (w.tokens === null || w.basis === "none") return "Input window: unknown. Nothing documented or measured.";
  const head = `Input window: ${atLeast(w.bound)}${exact(w.tokens)} tokens${w.scope ? `, ${SCOPE_WORD[w.scope].toLowerCase()}` : ""}.`;
  const basis =
    w.basis === "documented"
      ? `Documented${w.documented_field ? ` in ${w.documented_field}` : ""}, ${w.source ?? "source unknown"}${w.date ? `, ${w.date}` : ""}.`
      : `Measured by providers.dev${w.date ? `, ${w.date}` : ""}${w.measured_kind === null ? "" : `: ${MEASURED_SAID[w.measured_kind]}`}${w.measured_refused === null ? "" : `; ${exact(w.measured_refused)} tokens refused`}.`;
  const other =
    w.basis === "documented"
      ? w.measured_tokens === null ? "Not measured." : `Measured: ${atLeast(w.measured_bound)}${exact(w.measured_tokens)} tokens${w.measured_kind === "window" ? ", a window named by the route" : ""} (${plural(w.clients, "client")}, ${plural(w.evaluations, "evaluation")}).`
      : w.documented_tokens === null ? "Not documented." : `Documented: ${exact(w.documented_tokens)} tokens${w.documented_field ? ` in ${w.documented_field}` : ""}, ${w.documented_source ?? "source unknown"}.`;
  const status = w.documented_status === "contradicted" ? " Documentation contradicted." : w.documented_status === "not_contradicted" ? " Documentation not contradicted." : "";
  return `${head} ${basis} ${other}${status}`;
}

/**
 * The input window in a table row: the compact number, "≥" before it and rounded down where the record says it is a
 * lower bound, and its basis in a word under it. The rest is in the hover text and on the entry's page.
 */
function windowCell(entry: Pick<Summary, "input_window">, href: string): string {
  const w = entry.input_window;
  if (w.tokens === null || w.basis === "none") return `<span class="unknown" title="${e(windowSaid(w))}">Unknown</span>`;
  const value = w.bound === "at_least" ? `≥ ${compactTokensDown(w.tokens)}` : compactTokens(w.tokens);
  return `<a class="plain window" href="${e(href)}#input-window" title="${e(windowSaid(w))}"><span class="window-value">${value}</span>${basisTag(w.basis, null)}</a>`;
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
 * documented, the source says the entry does not cache ("None"); measured, a check missed at the immediate re-send or at the youngest tested age ("0 s").
 */
function lifetimeText(value: number, basis: "documented" | "measured"): string {
  if (value === 0 && basis === "documented") return '<span title="Documented: the source says this entry does not cache prompts.">None</span>';
  if (value === 0) return '<span title="Measured: 0 s. A check missed at the immediate re-send or at the youngest tested age.">0 s</span>';
  return `<span title="${seconds(value)}">${span(value)}</span>`;
}

/** Documented or measured, in words, on every value: no legend needed. `null` leaves the title to what holds the tag. */
function basisTag(basis: "documented" | "measured", title: string | null = BASIS_TITLE[basis]): string {
  return `<span class="basis ${basis}"${title === null ? "" : ` title="${e(title)}"`}>${basis}</span>`;
}

/**
 * Who a value is from, and its date. A providers.dev date is marked stale like all our evidence, after the published
 * `stale_after_days`. `dateTitle` says what the date is where it is not the newest evaluation's or evidence's.
 */
function lifetimeSource(source: LifetimeSource, date: string | null, basis: "documented" | "measured", today: Today, dateTitle?: string): string {
  const name =
    source === "models.dev"
      ? `<span class="origin upstream" title="${e(ORIGIN_TITLE.upstream)}">models.dev</span>`
      : `<span class="origin added" title="${basis === "measured" ? "Measured by providers.dev." : "Documented, with a providers.dev correction or on an entry providers.dev added."}">providers.dev</span>`;
  const title = dateTitle ?? (basis === "measured" ? "The date of the newest evaluation." : source === "models.dev" ? "Imported from models.dev on this date." : "The date of the newest providers.dev evidence.");
  return `<span class="life-source">${name}${dateText(date, source === "providers.dev", title, today)}</span>`;
}

/** A date with what it is in its title; a providers.dev date is marked stale after the published `stale_after_days`. */
function dateText(date: string | null, ours: boolean, title: string, today: Today): string {
  if (date === null) return '<span class="muted date">Date unknown</span>';
  return ours && isStale(date, today)
    ? `<span class="stale" title="${e(title)} More than ${plural(today.stale_after_days, "day")} ago.">${e(date)} · stale</span>`
    : `<span class="muted date" title="${e(title)}">${e(date)}</span>`;
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
  /** Leave the provider column out (on a provider's own page). */
  hideProvider?: boolean;
  providerNames?: Record<string, string>;
}

/** The column names of the entry table. Where the table is stacked, each cell repeats its column's name. */
const COLUMN = { provider: "Provider", input_window: "Input window", context: "Context", max_output:"Max output", price: "Price in / out", released: "Released", lifetime: "Cache lifetime", source: "Source" } as const;

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
${column(null, COLUMN.input_window, "The most input one request can carry on this entry, in tokens (input_window). Each value says whether it is documented or measured by providers.dev; ≥ marks a lower bound, the largest input seen accepted. Hover a value for what it rests on; the entry's page has the documented and measured figures side by side.", "num window-col")}
${column("context", COLUMN.context, "Exposed context window in tokens (limit.context): what this provider accepts for the model.", "num")}
${column("max_output", COLUMN.max_output, "Largest single response in tokens (limit.output). A maximum, not a default.", "num")}
${column("price_in", COLUMN.price, "Base list price in US dollars per million tokens, input then output, as models.dev records it. Conditional rates marks an entry whose price changes with context size, service tier, region, date or the time of day: open the entry for those. A subscription is not paid per token: it shows the API list price of the same model, marked API price, or In plan where the catalog has no API entry of that model.", "num mid-only")}
${column("release_date", COLUMN.released, "When the model was released, as models.dev records it. It is the model's date: the same at every provider.", "wide-only")}
${column(null, COLUMN.lifetime, "How long a cached prompt can be relied on (cache_lifetime): for short retention, what a request gets without asking for a lifetime; for long, what it gets when it asks for a longer one. Each value says whether it is documented or measured by providers.dev, and names the other of the two where there is one. Hover a value for its source and date; the entry's page lists every lifetime.", "life-col")}
${column("verified", COLUMN.source,"Where the entry comes from, with a date per source: the import from models.dev, and the newest providers.dev evidence. pi.dev marks an entry that pi's model catalog also lists, imported beside models.dev and never merged into it; \"2 differ\" counts the prices and limits pi states otherwise than this page.")}
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
<td class="num window-col" data-label="${COLUMN.input_window}">${windowCell(entry, href)}</td>
<td class="num" data-label="${COLUMN.context}">${tokens(entry.context)}</td>
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

/** The safe lifetime of a profile, then the two lifetimes it was chosen from and how many checks hit inside the documented one. */
function profileRow(profile: RetentionProfile, p: SafeLifetime, today: Today, columns: readonly Column[]): string {
  const safe =
    p.safe_s === null || p.basis === "none" || p.source === null
      ? UNKNOWN
      : `<span class="life-value">${lifetimeText(p.safe_s, p.basis)}</span>${basisTag(p.basis)}${lifetimeSource(p.source, p.date, p.basis, today)}`;
  // The case, as the API publishes it in `documented_status`, and from nothing else.
  const verdict =
    p.documented_status === "contradicted"
      ? '<span class="case contradicted" title="An evaluation contradicts the documented lifetime: the safe value is the measured one. The documented lifetime stays in the list.">Documentation contradicted</span>'
      : p.documented_status === "not_contradicted"
        ? '<span class="case" title="No evaluation contradicts the documented lifetime: the safe value is the documented one. Not contradicted is not confirmed.">Documentation not contradicted</span>'
        : "";
  const fact = (label: string, value: string): string => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
  return `<tbody class="profile"><tr><th scope="row" title="${PROFILE_TITLE[profile]}">${PROFILE_WORD[profile]} retention</th><td class="profile-facts" colspan="${1 + columns.length}"><dl>
${fact("Safe lifetime", `<span class="safe">${safe}</span>${verdict}`)}
${fact("Documented", p.documented_s === null ? '<span class="muted">Not documented</span>' : lifetimeText(p.documented_s, "documented"))}
${fact("Measured", p.measured_s === null ? '<span class="muted">Not measured</span>' : `${lifetimeText(p.measured_s, "measured")} <span class="muted">· ${plural(p.clients, "client")}</span>`)}
${fact("Inside the documented lifetime", p.checks_inside === null || p.hits_inside === null ? NOT_APPLICABLE : `<span title="Checks at ages up to the documented lifetime, the control included, and how many were served from the cache.">${exact(p.hits_inside)} of ${exact(p.checks_inside)} checks hit</span>`)}
</dl></td></tr></tbody>`;
}

/** The value of an item, its basis, its source and its date: the first cell of every lifetime. */
function lifetimeHead(item: CacheLifetimeItem, today: Today): string {
  return `<td class="life" data-label="Lifetime"><span class="life-value">${lifetimeText(item.lifetime_s, item.basis)}</span>${basisTag(item.basis)}${lifetimeSource(item.source, item.date, item.basis, today)}</td>`;
}

/** The note of an evaluation, where it has one, named by the evaluation where the note could be read as another's. */
const runNote = (run: CacheEvaluation, named: boolean): string => (run.note ? `<p class="run-note"><b>Note${named ? ` <code>${e(run.id)}</code>` : ""}</b> ${e(run.note)}</p>` : "");

/**
 * One evaluation under its measured lifetime: the run, its settings, the raw result, and its own results by age. Its note
 * is on the lifetime's row, in sight before the evaluations are opened; an evaluation in no lifetime carries its own.
 */
function runRow(run: CacheEvaluation, today: Today, columns: readonly Column[], withNote = false): string {
  const settings = settingsText(run.request_settings);
  const other = otherAges(run.results, columns);
  const date = isStale(run.date, today) ? `<span class="stale" title="Evaluated more than ${plural(today.stale_after_days, "day")} ago.">${e(run.date)} · stale</span>` : `<span class="muted date" title="The date of this evaluation.">${e(run.date)}</span>`;
  return `<tr class="run"><td class="run-head" colspan="2">${withNote ? runNote(run, false) : ""}<code>${e(run.id)}</code> ${date}<div class="hint">${e(run.route_label)}${settings ? ` · <code>${e(settings)}</code>` : ""}${other ? ` · ${e(other)}` : ""}</div><a href="${e(run.source)}" rel="noopener">Raw result</a></td>${heatCells(run.results, columns)}</tr>`;
}

/**
 * One lifetime of the list, in the same columns whatever its basis. A documented one names the way of caching it is
 * documented for and the text as documented; a measured one names its client and setting, its checks and results by
 * age, the notes of its evaluations, and opens onto each evaluation.
 */
function itemRows(item: CacheLifetimeItem, evaluations: readonly CacheEvaluation[], today: Today, columns: readonly Column[]): string {
  if (item.basis === "documented") {
    const what =
      item.mode === null
        ? "Documented as not caching"
        : `<span title="${e(CACHE_MODE_TITLE[item.mode])}">${CACHE_MODE_WORD[item.mode]}</span> <span class="chip">${item.mode}</span><div class="hint">As documented: <code>${e(item.documented_as ?? "")}</code></div>`;
    return `<tbody class="item documented"><tr>${lifetimeHead(item, today)}<td class="through" data-label="Documented for">${what}</td><td class="heat-none" colspan="${columns.length}" data-label="Results by age"><span class="muted" title="A documented lifetime has no results by age.">Not applicable</span></td></tr></tbody>`;
  }
  const runs = item.evaluation_ids.flatMap((id) => evaluations.filter((run) => run.id === id));
  const setting = item.parameter && item.value ? `Sent <code>${e(item.parameter)}=${e(item.value)}</code>` : "No lifetime asked for";
  const checks = `<span title="Re-sends served from the cache, of those made, the control included.">${exact(item.hits)} of ${exact(item.checks)} checks hit</span>`;
  const ages = `${item.tested_from_s === null ? "No timed check" : `Tested from ${span(item.tested_from_s)}`} · ${item.first_miss_s === null ? "No miss" : `First miss ${ageText(item.first_miss_s)}`}`;
  const other = item.results ? otherAges(item.results, columns) : "";
  const notes = runs.map((run) => runNote(run, runs.length > 1)).join("");
  const what = `<strong class="client">${e(item.client_label ?? item.client ?? "")}</strong><div class="hint">${setting} · ${checks}</div><div class="hint">${ages}${other ? ` · ${e(other)}` : ""}</div>${notes}<details class="runs"><summary>${plural(item.evaluations, "evaluation")}</summary></details>`;
  const results = item.results ?? [];
  return `<tbody class="item measured"><tr>${lifetimeHead(item, today)}<td class="through" data-label="Measured through">${what}</td>${heatCells(results, columns)}</tr>${runs.map((run) => runRow(run, today, columns)).join("")}</tbody>`;
}

/**
 * Every lifetime of an entry, one table for all: per retention profile the safe value and what it was chosen from, then
 * each documented and each measured lifetime as the API lists them, in its order. Both profiles on every entry. The age
 * columns are the published ones (`cache_ages_s` of /api/v1/meta). What the ages and the cells are is said to a screen
 * reader by the heading over the ages, and in sight by the legend under the table: one sample cell and its words.
 */
function lifetimesTable(cache: EntryCache, today: Today, ages: CacheAges): string {
  const record = cache.lifetime;
  const columns = columnsOf(ages);
  const body = RETENTION_PROFILES.map((profile) => profileRow(profile, record[profile], today, columns) + record.lifetimes.filter((item) => item.retention_profile === profile).map((item) => itemRows(item, cache.evaluations, today, columns)).join("")).join("");
  // An evaluation that is in no lifetime (no timed result, and a control that hit) is still on the page.
  const named = new Set(record.lifetimes.flatMap((item) => item.evaluation_ids));
  const others = cache.evaluations.filter((run) => !named.has(run.id));
  const rest = others.length
    ? `<tbody class="profile"><tr><th scope="row">Other evaluations</th><td class="profile-facts" colspan="${1 + columns.length}"><span class="muted">In no lifetime</span></td></tr></tbody><tbody class="item others">${others.map((run) => runRow(run, today, columns, true)).join("")}</tbody>`
    : "";
  return `<div class="scroll"><table class="facts heat lifetimes stack-tablet"><caption class="sr-only">Every cache lifetime of this entry, by retention</caption><thead><tr><th scope="col" rowspan="2">Lifetime</th><th scope="col" rowspan="2">Documented for, or measured through</th><th scope="colgroup" colspan="${columns.length}" class="span"><span class="sr-only">Time since the prompt was cached · served from the cache, in percent, with hits/checks</span></th></tr><tr>${heatHead(columns)}</tr></thead>${body}${rest}</table></div>
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

const WINDOW_CASE = {
  contradicted: '<span class="case contradicted" title="A limit evaluation clearly contradicts the documented figure: the input window is the measured one. The documented figure stays here, beside it.">Documentation contradicted</span>',
  not_contradicted: '<span class="case" title="No limit evaluation contradicts the documented figure: the input window is the documented one. Not contradicted is not confirmed.">Documentation not contradicted</span>',
} as const;

/** The date of a value of the input window, said for what it is. */
function windowDateTitle(basis: "documented" | "measured", source: LifetimeSource): string {
  if (basis === "measured") return "The date of the evaluation that gives this value.";
  return source === "models.dev" ? "Imported from models.dev on this date." : "The date of the newest providers.dev evidence for the documented figure.";
}

/** A value of the input window: "at least" where its bound says so, the exact tokens. */
const windowTokens = (value: number, bound: InputWindow["bound"]): string =>
  `<span class="window-value">${bound === "at_least" ? '<span class="bound">at least</span> ' : ""}${exact(value)} <span class="muted">tokens</span></span>`;

/**
 * The input window of an entry, in the columns of the other limit tables and the same three rows on every entry: the
 * published value with its basis, scope, source and date; the documented figure with what the rule found of it; and
 * one line per measurement, each with its client, date and raw result. Printed as the record has it.
 */
function inputWindowTable(w: InputWindow, today: Today): string {
  const row = (label: string, hint: string, rest: string, span = 1): string =>
    `<th scope="row"${span > 1 ? ` rowspan="${span}"` : ""}>${label}<div class="hint">${hint}</div></th>${rest}`;
  const valueCell = (html: string): string => `<td class="num" data-label="Value">${html}</td>`;
  const sourceCell = (html: string): string => `<td data-label="Source">${html}</td>`;

  const published =
    w.tokens === null || w.basis === "none" || w.source === null
      ? valueCell(UNKNOWN) + sourceCell(DASH)
      : valueCell(`${windowTokens(w.tokens, w.bound)}<span class="window-what">${basisTag(w.basis, WINDOW_BASIS_TITLE[w.basis])}${w.scope ? `<span title="${SCOPE_TITLE[w.scope]}">${SCOPE_WORD[w.scope]}</span>` : ""}</span>`) +
        sourceCell(lifetimeSource(w.source, w.date, w.basis, today, windowDateTitle(w.basis, w.source)));

  const documented =
    w.documented_tokens === null || w.documented_source === null
      ? valueCell('<span class="muted">Not documented</span>') + sourceCell(DASH)
      : valueCell(`${windowTokens(w.documented_tokens, "limit")}<span class="window-what">${w.documented_field ? `<code>${e(w.documented_field)}</code>` : ""}${w.documented_status ? WINDOW_CASE[w.documented_status] : ""}</span>`) +
        sourceCell(lifetimeSource(w.documented_source, w.documented_date, "documented", today, windowDateTitle("documented", w.documented_source)));

  const measuredHint = "What each limit evaluation that counts gives, one line per evaluation.";
  const measured =
    w.measurements.length === 0
      ? [`<tr>${row("Measured", measuredHint, valueCell('<span class="muted">Not measured</span>') + sourceCell(DASH))}</tr>`]
      : w.measurements.map((item, at) => {
          const value = valueCell(`${windowTokens(item.tokens, item.bound)}<div class="hint">${e(measurementSaid(item))}</div>`);
          const source = sourceCell(`<span class="client">${e(item.client_label)}</span><div class="hint">${dateText(item.date, true, "The date of this evaluation.", today)} · <a href="${e(item.source)}" rel="noopener">Raw result</a></div>`);
          return `<tr${at > 0 ? ' class="more"' : ""}>${at === 0 ? row("Measured", measuredHint, value + source, w.measurements.length) : value + source}</tr>`;
        });

  return `<div class="scroll"><table class="facts limit-facts window-table stack-phone">
    <thead><tr><th scope="col">Limit</th><th scope="col" class="num">Value</th><th scope="col">Source</th></tr></thead>
    <tbody>
      <tr class="published">${row("Input window", "<code>input_window</code>: the most input one request can carry on this entry, in tokens as the provider counts them.", published)}</tr>
      <tr>${row("Documented", "The figure the source documents, and the field it is in.", documented)}</tr>
      ${measured.join("")}
    </tbody>
  </table></div>
<p class="hint"><a href="/docs/methodology/#input-window">How the input window is worked out, and what it does not say</a></p>`;
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

// ---- pi's catalog: `providers_dev.pi` of an entry and `pi` of /api/v1/meta, as the API publishes them. Printed as
// the block has it: which values differ is `differences`, and nothing here compares, converts or fills in a default.
// What pi does not state says so, never "no": a flag absent from `compat` is not false.

const NOT_STATED = '<span class="unknown" title="pi\'s catalog does not state it.">Not stated</span>';
/** pi writes 0 for a price it does not charge and for a price it has not recorded alike (the contract, PiCost). */
const ZERO_PRICE = '<span class="unknown" title="pi\'s catalog writes 0 here. It writes 0 both for no charge and for no price recorded, so it is not shown as free.">Not stated</span>';

/** The rows of pi's limits and prices: one per field of `differences`, in its order, on every entry pi lists. */
const PI_ROWS: { field: PiDifferenceField; label: string; hint: string }[] = [
  { field: "context_window", label: "Context window", hint: "<code>context_window</code>; here <code>limit.context</code>" },
  { field: "max_tokens", label: "Maximum output", hint: "<code>max_tokens</code>: the most pi asks for in one response; here <code>limit.output</code>" },
  { field: "cost.input", label: "Input", hint: "US dollars per 1M tokens" },
  { field: "cost.output", label: "Output", hint: "US dollars per 1M tokens" },
  { field: "cost.cache_read", label: "Cache read", hint: "US dollars per 1M tokens" },
  { field: "cost.cache_write", label: "Cache write", hint: "pi states one price: a write of the short lifetime" },
  { field: "cost.tiers", label: "Price tiers", hint: "By size of request, in US dollars per 1M tokens: the whole request is priced at a tier once its input is above the threshold" },
];
const TIER_PRICES = [["input", "In"], ["output", "Out"], ["cache_read", "Cache read"], ["cache_write", "Cache write"]] as const;

/** A price per 1M tokens as one side states it: pi's 0 is not a statement; the page's own null is unknown. */
function piPrice(value: number | null, side: "pi" | "published", unit = true): string {
  if (value === null) return NOT_STATED;
  if (value === 0 && side === "pi") return ZERO_PRICE;
  // Never rounded: the number the API states, written as the site writes prices where that is the same number.
  return `${usdUnrounded(value)}${unit ? ' <span class="muted">/ 1M</span>' : ""}`;
}
const piTokens = (value: number | null): string => (value === null || value === 0 ? NOT_STATED : `${exact(value)} <span class="muted">tokens</span>`);

/** Tiers by size of request, each with its threshold and its four prices, laid out alike on both sides so that they read across. */
function tiersHtml(tiers: readonly PiCostTier[], side: "pi" | "published"): string {
  if (tiers.length === 0) return side === "pi" ? '<span class="unknown" title="pi\'s catalog states no tiers for this model.">None stated</span>' : '<span class="muted">None</span>';
  return `<ul class="pi-tiers">${tiers.map((tier) => `<li><span class="tier-at" title="${exact(tier.input_tokens_above)} input tokens: input, cache reads and cache writes together.">Above ${exact(tier.input_tokens_above)}</span>${TIER_PRICES.map(([key, label]) => `<span><span class="muted">${label}</span> ${piPrice(tier[key], side, false)}</span>`).join("")}</li>`).join("")}</ul>`;
}

/** pi's value of a row, as the block states it. */
function piValue(block: PiBlock, field: PiDifferenceField): string {
  switch (field) {
    case "context_window": return piTokens(block.context_window);
    case "max_tokens": return piTokens(block.max_tokens);
    case "cost.input": return piPrice(block.cost.input, "pi");
    case "cost.output": return piPrice(block.cost.output, "pi");
    case "cost.cache_read": return piPrice(block.cost.cache_read, "pi");
    case "cost.cache_write": return piPrice(block.cost.cache_write, "pi");
    case "cost.tiers": return tiersHtml(block.cost.tiers, "pi");
  }
}

/** This page's value of a row where pi's differs: the item's `published` (or `published_tiers`), and the field it is. */
function publishedValue(item: PiDifference): string {
  const value = item.field === "cost.tiers" ? tiersHtml(item.published_tiers ?? [], "published") : item.unit === "tokens" ? piTokens(item.published) : piPrice(item.published, "published");
  const tag = `<span class="pi-differ" title="pi's catalog states this otherwise. This page publishes the value in ${e(item.entry_field)}.">Differs</span>`;
  // Tiers are a list: the tag goes under it, so that the two lists begin on the same line.
  return item.field === "cost.tiers" ? `${value}${tag}` : `${tag} ${value}`;
}

/** A map pi states, a name and a value per line, values as written in pi's catalog. */
function piPairs(pairs: [string, string][], className: string): string {
  return `<dl class="pi-pairs ${className}">${pairs.map(([name, value]) => `<div><dt>${name}</dt><dd>${value}</dd></div>`).join("")}</dl>`;
}

/** How pi calls the model: the request format, the address, the input, reasoning, the flags, the cache and the request limits. */
function piCallTable(block: PiBlock): string {
  const row = (label: string, hint: string, value: string): string => `<tr><th scope="row">${label}<div class="hint">${hint}</div></th><td>${value}</td></tr>`;
  const levels = block.thinking_level_map === null
    ? NOT_STATED
    : piPairs(Object.entries(block.thinking_level_map).map(([level, value]) => [e(level), value === null ? '<span class="muted" title="pi marks this level as not supported.">not supported</span>' : `<code>${e(value)}</code>`]), "levels");
  const flags = block.compat === null || Object.keys(block.compat).length === 0
    ? '<span class="unknown" title="pi\'s catalog states no flags for this model. It is not the same as every flag false.">None stated</span>'
    : piPairs(Object.entries(block.compat).map(([name, value]) => [`<code>${e(name)}</code>`, `<code>${e(JSON.stringify(value))}</code>`]), "flags");
  const cache = block.prompt_cache === null
    ? NOT_STATED
    : piPairs([["Short", block.prompt_cache.short_s === null ? NOT_STATED : `<span title="${seconds(block.prompt_cache.short_s)}">${span(block.prompt_cache.short_s)}</span>`], ["Long", block.prompt_cache.long_s === null ? NOT_STATED : `<span title="${seconds(block.prompt_cache.long_s)}">${span(block.prompt_cache.long_s)}</span>`]], "cache");
  const limits = block.input_limits;
  const limit = (value: number | null, unit: string): string => (value === null ? NOT_STATED : `${exact(value)} <span class="muted">${unit}</span>`);
  const requestLimits = limits.max_request_bytes === null && limits.max_images_per_request === null && limits.max_images_per_message === null
    ? '<span class="unknown" title="pi\'s catalog states no request limits for this model.">None stated</span>'
    : piPairs([["Request size", limit(limits.max_request_bytes, "bytes")], ["Images per request", limit(limits.max_images_per_request, "")], ["Images per message", limit(limits.max_images_per_message, "")]], "limits");
  const named = block.match === "alias"
    ? "Paired by providers.dev: pi spells the provider or model id otherwise than this entry."
    : "The same provider and model id as this entry.";
  return `<div class="scroll"><table class="facts pairs pi-call stack-phone"><thead><tr><th scope="col">In pi's catalog</th><th scope="col">As pi states it</th></tr></thead><tbody>
${row("Model", named, `<strong>${e(block.name)}</strong><div class="id"><code>${e(block.ref)}</code>${copyButton(block.ref, "pi's id")}</div>`)}
${row("Request format", "<code>api</code>: the API pi speaks to this model", `<code>${e(block.api)}</code>`)}
${row("Address", "<code>base_url</code>: where pi sends requests, placeholders as written", block.base_url === null ? NOT_STATED : `<code class="break">${e(block.base_url)}</code> ${copyButton(block.base_url, "address")}`)}
${row("Input", "What pi sends to the model, in pi's words", block.input.length ? block.input.map((kind) => `<span class="chip">${e(kind)}</span>`).join(" ") : NOT_STATED)}
${row("Reasoning", "Whether pi treats the model as one that reasons", block.reasoning ? "Yes" : "No")}
${row("Thinking levels", "The value pi sends for each level. A level not named follows pi's own default", levels)}
${row("Flags", "<code>compat</code>, in pi's words. A flag not named follows pi's own default: it is not false", flags)}
${row("Cache lifetimes", "What pi's own cache timer reckons with. Not this page's lifetimes", cache)}
${row("Request limits", "The provider's limits on one request, as pi states them", requestLimits)}
</tbody></table></div>`;
}

/**
 * The pi section of an entry's page, the same on every entry pi lists: pi's limits and prices beside this page's where
 * they differ, then how pi calls the model. On an entry pi does not list, one line. Whose data it is, and as of when, first.
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
  const differs = new Map(block.differences.map((item) => [item.field, item]));
  const rows = PI_ROWS.map(({ field, label, hint }) => {
    const item = differs.get(field);
    const published = item ? publishedValue(item) : '<span class="muted" title="pi states no other value here: the two agree, or one of them states none.">No difference</span>';
    return `<tr${item ? ' class="differs"' : ""}><th scope="row">${label}<div class="hint">${hint}</div></th><td class="num" data-label="pi's catalog">${piValue(block, field)}</td><td class="num" data-label="This page">${published}</td></tr>`;
  }).join("");
  const count = block.differences.length;
  const list = `https://pi.dev/models?provider=${encodeURIComponent(block.provider)}`;
  return `<p class="pi-facts"><span class="origin pi" title="pi's model catalog, a second source imported beside models.dev.">pi.dev</span>${fetched}${checked}${failed}<span>Not verified by providers.dev</span><span>This page follows models.dev</span><span><a href="${e(list)}" rel="noopener">pi's list for <code>${e(block.provider)}</code></a></span></p>
<h3 id="pi-prices">Limits and prices <span class="hint">${count === 0 ? "no difference" : `${plural(count, "difference")}`}</span></h3>
<div class="scroll"><table class="facts pi-compare stack-phone"><thead><tr><th scope="col">Value</th><th scope="col" class="num">pi's catalog</th><th scope="col" class="num" title="The value this page publishes: models.dev's, or a providers.dev correction.">This page</th></tr></thead><tbody>${rows}</tbody></table></div>
<h3 id="pi-call">How pi calls the model</h3>
${piCallTable(block)}
<p class="hint"><a href="/docs/methodology/#pi">How pi's catalog is used, and how its values are compared</a></p>`;
}

function tile(label: string, value: string, foot: string, small = false): string {
  return `<div class="tile"><div class="label">${label}</div><div class="value${small ? " small" : ""}">${value}</div><div class="foot">${foot}</div></div>`;
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

export function entryHtml(view: EntryView): string {
  const { summary, provider, model, today, cache_ages_s } = view;
  const extension = model[NS] as unknown as ModelExtension;
  const provenance = extension.provenance;
  const limit = isObject(model.limit) ? model.limit : {};
  const cache = extension.cache;
  const measuredLimits = extension.limits.measured;
  const fromMeasurement = extension.limits.from_measurement;
  const number = (value: Json | undefined): string => (typeof value === "number" ? `${exact(value)} <span class="muted">tokens</span>` : UNKNOWN);
  const big = (value: Json | undefined): string => (typeof value === "number" ? `${exact(value)} <span class="unit">tokens</span>` : '<span class="muted">Unknown</span>');
  const api = `/api/v1${entryHref(summary.ref)}`;
  // The sources of the entry, the pi.dev mark among them where pi lists it, dated by the pi import.
  const sources = sourcesHtml(summary, { today, imported: view.imported, pi: view.pi }, true);
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
  // The input window, first: the value, "at least" where its bound says so, its basis, source and date, what kind of
  // figure it is, and the other of the two figures under it, as the cache tiles have it.
  const inputWindow = extension.limits.input_window;
  const windowTile = (): string => {
    const w = inputWindow;
    if (w.tokens === null || w.basis === "none" || w.source === null) return tile("Input window", '<span class="muted">Unknown</span>', "Not documented or measured");
    const contradicted = w.documented_status === "contradicted";
    const other =
      w.basis === "documented"
        ? w.measured_tokens === null ? "" : `<div>Measured ${atLeast(w.measured_bound)}${exact(w.measured_tokens)}${w.measured_kind === "window" ? ", window named" : ""}</div>`
        : w.documented_tokens === null ? "" : `<div${contradicted ? ' class="contradicted"' : ""}>Documented ${exact(w.documented_tokens)}${contradicted ? ", contradicted" : ""}</div>`;
    const value = `<span title="${e(windowSaid(w))}">${w.bound === "at_least" ? '<span class="unit">at least</span> ' : ""}${exact(w.tokens)} <span class="unit">tokens</span></span>${basisTag(w.basis, WINDOW_BASIS_TITLE[w.basis])}`;
    return tile("Input window", value, `${e(w.source)}${w.date ? ` · ${e(w.date)}` : ""}${w.scope ? `<div>${SCOPE_WORD[w.scope]}</div>` : ""}${other}`);
  };

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
  ${windowTile()}
  ${tile("Context window", big(limit.context), "Exposed by this provider")}
  ${tile("Maximum output", big(limit.output), "Per response; not a default")}
  ${lifetimeTile("short")}
  ${lifetimeTile("long")}
</div>

<section aria-labelledby="limits">
  <h2 id="limits">Limits</h2>
  <h3 id="input-window">Input window</h3>
  ${inputWindowTable(inputWindow, today)}
  <h3>Documented</h3>
  <div class="scroll"><table class="facts limit-facts stack-phone">
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
  ${lifetimesTable(cache, today, cache_ages_s)}
  <h3>Cache modes</h3>
  ${cacheDocumented(cache.documented, sourceOf("capabilities.cache", provenance, extension.origin))}
  <h3>Retention</h3>
  ${requestControlTable(summary.request_controls.items.filter((control) => control.id === "cache.retention"))}
</section>

<section aria-labelledby="pi">
  <h2 id="pi">pi's catalog</h2>
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
