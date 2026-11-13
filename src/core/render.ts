// HTML for the entry table and the entry detail view. The same functions build the static pages and
// re-render in the browser, so a row looks and reads the same wherever it appears.
import { askedLifetime, cacheBand, CACHE_BANDS_S, type PooledCache, type ProviderSummary, type Summary } from "./entries.ts";
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
  runVerdict,
  shortAge,
  usd,
  warmRange,
} from "./format.ts";
import { isObject, type Json, type JsonObject } from "./merge.ts";
import { NS, type Evidence, type MeasuredLimit, type Measurement, type ModelExtension, type Provenance } from "./schema.ts";

const UNKNOWN = '<span class="unknown" title="The source does not say. Unknown is not zero and not unlimited.">Unknown</span>';
const DASH = '<span class="muted">–</span>';
/** Every entry page has the same rows. These fill a row whose value the source does not give. */
const NOT_STATED = '<span class="muted" title="The source states no such value for this entry.">Not stated</span>';
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

const bandLabel = (seconds: number): string => (seconds < 3600 ? `${seconds / 60}m` : `${seconds / 3600}h`); // 150 -> "2.5m"

/** What a band covers, in words: "Up to 2.5 min", "5 min to 15 min". */
const bandSpan = (limit: number): string => {
  const at = CACHE_BANDS_S.indexOf(limit as (typeof CACHE_BANDS_S)[number]);
  return `${at <= 0 ? "Up to" : `${shortAge(CACHE_BANDS_S[at - 1] as number)} to`} ${shortAge(limit)}`;
};

/** The ages of the heat strip, written once in the column head so that every row lines up under them. */
const STRIP_HEAD = `<span class="heat-strip strip-head" aria-hidden="true"><span></span><span class="strip">${CACHE_BANDS_S.map((limit) => `<span>${bandLabel(limit)}</span>`).join("")}</span></span>`;

/**
 * One line of the measured cell: what the requests sent, then one cell per age band with the share of re-sends at that
 * age that were served from the cache, in percent. A line without evaluations keeps its place, with empty cells.
 */
function strip(group: PooledCache | undefined, long: boolean): string {
  const byBand = new Map((group?.bands ?? []).map((band) => [band.up_to_s, band]));
  const cells = CACHE_BANDS_S.map((limit) => {
    const band = byBand.get(limit);
    if (!band) return `<span class="skip" title="${bandSpan(limit)}: not checked"></span>`;
    const share = band.warm / band.total;
    const level = share === 1 ? "all" : share === 0 ? "none" : share >= 0.5 ? "most" : "few";
    return `<span class="${level}" title="${bandSpan(limit)}: ${band.warm} of ${band.total} re-sends served from the cache">${Math.round(share * 100)}</span>`;
  }).join("");
  const count = group ? plural(group.evaluations, "evaluation") : "Not evaluated";
  const label = long
    ? `<span class="strip-label${group ? "" : " none"}" title="${e(group?.asked ? `The requests asked for a longer lifetime with ${group.parameter ?? "a parameter"}=${group.asked}. ${count}.` : "A longer cache lifetime, asked for with a request parameter. Not evaluated on this entry.")}">Long${group?.asked ? ` <b>${e(group.asked)}</b>` : ""}</span>`
    : `<span class="strip-label${group ? "" : " none"}" title="The requests sent no lifetime parameter: the provider's default cache. ${count}.">Default</span>`;
  return `${label}<span class="strip">${cells}</span>`;
}

/**
 * Every evaluated entry shows the same lines: Default (no lifetime parameter sent) and Long (a lifetime parameter sent),
 * each over the same ages. Measured limits are not shown here: they are on the entry's page.
 */
function measuredCell(entry: Summary, href: string): string {
  if (entry.evaluations === 0) return DASH;
  const groups = entry.measured_cache ?? [];
  const asked = groups.filter((group) => group.asked);
  const lines = [strip(groups.find((group) => !group.asked), false), ...(asked.length > 0 ? asked.map((group) => strip(group, true)) : [strip(undefined, true)])];
  return `<a class="plain heat-strip" href="${e(href)}#cache" aria-label="Cache evaluations by age. Open the entry for each one.">${lines.join("")}</a>`;
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
<th scope="col" class="strip-col"><span title="providers.dev evaluations, all clients together. Each cell is an age since the prompt was cached; the number is the share of re-sends at that age that were served from the cache, in percent. Default: the requests sent no lifetime parameter. Long: they asked for a longer lifetime with a parameter (ttl or prompt_cache_retention), and the value is shown. Hover a cell for the counts.">Cache, measured <span class="muted">% by age</span></span>${STRIP_HEAD}</th>
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
    fact("Reasoning output", "<code>cost.text.output.reasoning</code>: stated where reasoning is priced apart from the rest of the output.", typeof output?.reasoning === "number" ? usd(output.reasoning) : priced ? NOT_STATED : absent, source),
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
  if ((value === UNKNOWN || value === NOT_STATED || value === IN_PLAN) && !source.includes("Corrected")) source = DASH;
  return `<tr><th scope="row">${label}<div class="hint">${hint}</div></th><td class="num">${value}</td><td>${source}</td></tr>`;
}

function optionsText(options: JsonObject | undefined): string {
  if (!options) return "";
  return Object.entries(options)
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(", ");
}

type Check = { warm: number; total: number };
type AgedCheck = Check & { age_s: number };

/** One cell of the entry's table: the checks of one age band added up. The title names the exact ages they were made at. */
function heatCell(checks: readonly AgedCheck[], when: string): string {
  const made = checks.filter((check) => check.total > 0);
  if (made.length === 0) return `<td class="heat"><span class="skip" title="${e(when)}: not checked">·</span></td>`;
  const warm = made.reduce((sum, check) => sum + check.warm, 0);
  const total = made.reduce((sum, check) => sum + check.total, 0);
  const share = warm / total;
  const level = share === 1 ? "all" : share === 0 ? "none" : share >= 0.5 ? "most" : "few";
  // Several ages in one cell (7.5, 10 and 15 minutes in the 15 min column) are listed, each with its own count.
  const byAge = new Map<number, Check>();
  for (const check of made) {
    const sum = byAge.get(check.age_s) ?? { warm: 0, total: 0 };
    byAge.set(check.age_s, { warm: sum.warm + check.warm, total: sum.total + check.total });
  }
  const ages = [...byAge].sort(([a], [b]) => a - b);
  const at = ages.every(([age]) => age < 0)
    ? when
    : ages.length === 1
      ? `Checked at ${exactAge((ages[0] as [number, Check])[0])}`
      : `Checked at ${ages.map(([age, check]) => `${exactAge(age)} (${check.warm}/${check.total})`).join(", ")}`;
  return `<td class="heat"><span class="${level}" title="${e(at)}: ${warm} of ${total} re-sends served from the cache">${warm}/${total}</span></td>`;
}

/** An age as it was checked: "7.5 min", "1 h 5 min", "24 h" (not "1 d": the columns count in hours). */
const exactAge = (seconds: number): string => (seconds % 86400 === 0 ? shortAge(seconds) : duration(seconds));

/** The control of a run as a check: it has no age of its own, so it is given a negative one. */
const controlOf = (run: Measurement): AgedCheck[] => (run.control ? [{ age_s: -1, ...run.control }] : []);

/**
 * The cache evaluations of one entry. Every entry has the same table: the same columns (at once, then the ages from
 * 2.5 minutes to 24 hours) and the same two parts, the default lifetime and the long one, also where one of them
 * was not evaluated. A column holds the checks up to its age and above the column before it.
 */
function heatmap(runs: Measurement[], now: Date): string {
  const sorted = [...runs].sort((a, b) => b.date.localeCompare(a.date));
  const columns = CACHE_BANDS_S.length + 1;
  const width = columns + 3;
  const head = `<tr><th scope="col" rowspan="2">Evaluation</th><th scope="col" rowspan="2">Result</th><th scope="colgroup" colspan="${columns}" class="span">Time since the prompt was cached · re-sends served from the cache</th><th scope="col" rowspan="2">Evidence</th></tr>
<tr><th scope="col" class="age" title="Sent again immediately, to confirm the prompt was cached at all.">At once</th>${CACHE_BANDS_S.map((limit) => `<th scope="col" class="age" title="${e(bandSpan(limit))}">${shortAge(limit)}</th>`).join("")}</tr>`;

  const cells = (members: readonly Measurement[]): string =>
    `${heatCell(members.flatMap(controlOf), "Sent again at once")}${CACHE_BANDS_S.map((limit) =>
      heatCell(
        members.flatMap((run) => (run.checks ?? []).filter((check) => cacheBand(check.age_s) === limit)),
        bandSpan(limit),
      ),
    ).join("")}`;

  const part = (title: string, hint: string, members: Measurement[], missing: string): string => {
    const rows = members
      .map((run) => {
        const verdict = runVerdict(run);
        const options = optionsText(run.options);
        return `<tr>
<th scope="row">${e(run.route_label)} ${dateTag(run.date, now)}<div class="hint">${e(run.client_label)}${options ? ` · ${e(options)}` : ""}</div></th>
<td class="result"><strong>${e(verdict.head)}</strong>${verdict.detail ? `<div class="hint">${e(verdict.detail)}</div>` : ""}${run.note ? `<div class="hint">${e(run.note)}</div>` : ""}</td>
${cells([run])}
<td class="nowrap"><a href="${e(run.source)}" rel="noopener">Raw result</a></td>
</tr>`;
      })
      .join("");
    // Rows of three re-sends jump about. Where a part has several evaluations, a last row adds them up.
    const together =
      members.length > 1
        ? `<tr class="together">
<th scope="row">All ${members.length} together<div class="hint">Every client, added up by age</div></th>
<td class="result"><span class="hint">Single rows have three re-sends per age, so one miss moves them a lot. The sum is steadier.</span></td>
${cells(members)}
<td></td>
</tr>`
        : "";
    return `<tr class="part"><th scope="colgroup" colspan="${width}"><strong>${title}</strong><span class="hint">${hint}</span></th></tr>
${members.length > 0 ? rows + together : `<tr class="part-empty"><td colspan="${width}" class="muted">${missing}</td></tr>`}`;
  };

  const plain = sorted.filter((run) => !askedLifetime(run));
  const asked = new Map<string, Measurement[]>();
  for (const run of sorted) {
    const lifetime = askedLifetime(run);
    if (lifetime) asked.set(`${lifetime.parameter}=${lifetime.value}`, [...(asked.get(`${lifetime.parameter}=${lifetime.value}`) ?? []), run]);
  }
  const parts = [
    part("Default lifetime", "The request sends no lifetime parameter. This is the cache you get without asking for one.", plain, sorted.length === 0 ? "Not evaluated on this entry." : "Not evaluated: every evaluation on this entry sent a lifetime parameter."),
    ...(asked.size > 0
      ? [...asked].map(([sent, members]) => part("Long lifetime", `The request sends <code>${e(sent)}</code>.`, members, ""))
      : [part("Long lifetime", "The request asks for a longer lifetime with a parameter.", [], sorted.length === 0 ? "Not evaluated on this entry." : "Not evaluated: no evaluation on this entry sent a lifetime parameter.")]),
  ];
  return `<p class="hint max-w-3xl">Each evaluation caches a fresh prompt, then sends it again at set ages. A cell shows how many of the re-sends at that age were served from the cache: <code>3/3</code> is all of them. Every entry has the same columns; a column holds the checks up to its age and above the column before it, so <em>15 min</em> is 5 to 15 minutes. Hover a cell for the exact ages.</p>
<div class="scroll mt-3"><table class="facts heat"><thead>${head}</thead><tbody>${parts.join("")}</tbody></table></div>
<p class="legend"><span><span class="heat-key all">3/3</span> All served from the cache</span><span><span class="heat-key most">2/3</span> Most</span><span><span class="heat-key few">1/3</span> Few</span><span><span class="heat-key none">0/3</span> None</span><span><span class="heat-key skip">·</span> Not checked at that age</span></p>
<p class="hint">A result holds for the access method and client named, on that date. It is what was observed, not a guaranteed lifetime. <a href="/docs/methodology/#evaluations">How evaluations work</a></p>`;
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
        ? "Yes"
        : `<span class="muted" title="${cache === false ? "The source says this entry does not cache prompts." : "The source lists the other way of caching only. A way it does not list is not supported."}">No</span>`;
    const ttl = Array.isArray(detail.ttl) && detail.ttl.length > 0 ? detail.ttl.map((item) => `<span class="chip">${e(String(item))}</span>`).join(" ") : UNKNOWN;
    return `<tr>
<th scope="row">${CACHE_MODE_WORD[mode]} <span class="chip">${mode}</span><div class="hint">${mode === "implicit" ? "The provider caches on its own." : "The request marks what to cache."}</div></th>
<td>${state}</td>
<td>${supported ? ttl : DASH}</td>
<td class="num">${supported ? (typeof detail.min_tokens === "number" ? exact(detail.min_tokens) : UNKNOWN) : DASH}</td>
<td class="num">${supported && mode === "explicit" ? (typeof detail.max_breakpoints === "number" ? exact(detail.max_breakpoints) : UNKNOWN) : DASH}</td>
<td>${supported && mode === "explicit" ? (Array.isArray(detail.targets) ? e(detail.targets.join(", ")) : UNKNOWN) : DASH}</td>
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
  const runs = extension.cache?.observed ?? [];
  const measuredLimits = extension.limits?.measured ?? [];
  const fromMeasurement = extension.limits?.from_measurement ?? [];
  const number = (value: Json | undefined): string => (typeof value === "number" ? `${exact(value)} <span class="muted">tokens</span>` : UNKNOWN);
  const big = (value: Json | undefined): string => (typeof value === "number" ? `${exact(value)} <span class="unit">tokens</span>` : '<span class="muted">Unknown</span>');
  const api = `/api/v1/entry?ref=${encodeURIComponent(summary.ref)}`;
  const warm = warmRange(summary);
  const seen = runs.map((run) => run.last_warm_s).filter((age): age is number => age !== null);
  const measuredValue = runs.length === 0 ? '<span class="muted">Not measured</span>' : warm ? e(warm) : seen.length > 0 ? "Part of the time" : "Not cached";
  const measuredFoot =
    runs.length === 0 ? "No evaluations on this entry" : `${plural(runs.length, "evaluation")}${seen.length > 0 ? ` · seen cached as late as ${duration(Math.max(...seen))}` : ""}`;
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
      ${fact("Largest input", "<code>limit.input</code>: stated where the input limit is lower than the context window.", limit.input !== undefined || provenance.some((item) => item.path === "limit.input") ? number(limit.input) : NOT_STATED, sourceOf("limit.input", provenance, extension.origin))}
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
  <h3>Measured</h3>
  ${heatmap(runs, now)}
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
