// HTML for the entry table and the entry detail view. The same functions build the static pages and
// re-render in the browser, so a row looks and reads the same wherever it appears.
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
  runVerdict,
  shortAge,
  usd,
  warmRange,
} from "./format.ts";
import { isObject, type Json, type JsonObject } from "./merge.ts";
import { NS, type Evidence, type MeasuredLimit, type Measurement, type ModelExtension, type Provenance } from "./schema.ts";

const UNKNOWN = '<span class="unknown" title="The source does not say. Unknown is not zero and not unlimited.">Unknown</span>';
const DASH = '<span class="muted">–</span>';
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

function cacheCell(entry: Pick<Summary, "cache" | "cache_modes" | "cache_ttl_s">): string {
  if (entry.cache === "unknown") return UNKNOWN;
  if (entry.cache === "no") return '<span title="The source says this entry does not cache prompts.">None</span>';
  // Two short lines, like the name and id beside them: how it caches, then for how long.
  const words = entry.cache_modes.join(", ");
  const modes = words ? `<span class="cache-modes">${e(words.charAt(0).toUpperCase() + words.slice(1))}</span>` : "";
  const ttl = entry.cache_ttl_s.length > 0 ? `<span class="cache-ttl">${entry.cache_ttl_s.map(duration).join(", ")}</span>` : "";
  return `<span class="cache">${modes}${ttl}</span>`;
}

function measuredCell(entry: Summary, href: string): string {
  if (entry.evaluations === 0) return entry.measured_limits > 0 ? `<a class="measured" href="${e(href)}#limits">Limits measured</a>` : DASH;
  const range = warmRange(entry);
  const count = plural(entry.evaluations, "evaluation");
  const title = range ? "Every re-send up to this age was served from the cache. Open the entry for the results by age." : "Open the entry for the results by age.";
  return `<a class="measured" href="${e(href)}#cache" title="${title}">${range ? `${e(range)} <small>${count}</small>` : count}</a>`;
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
${column("price_in", "Price in / out", "List price in US dollars per million tokens, input then output, as models.dev records it. Before the changes some providers make by context size or service tier: open the entry for those.", "num mid-only")}
${column("release_date", "Released", "When the model was released, as models.dev records it. It is the model's date: the same at every provider.", "wide-only")}
${column(null, "Cache, documented", "Prompt caching as the source documents it: mode and lifetimes.")}
${column(null, "Cache, measured", "providers.dev evaluations: the age up to which every re-send was still served from the cache.")}
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
<td class="num">${tokens(entry.context)}</td>
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

function priceCell(entry: Pick<Summary, "price_in" | "price_out" | "access">): string {
  const { price_in: input, price_out: output } = entry;
  const plan = '<span class="muted" title="No price per token: the entry is paid for through a plan or subscription, which providers.dev does not list.">In plan</span>';
  if (input === undefined && output === undefined) return entry.access === "subscription" ? plan : UNKNOWN;
  // A listed 0 is shown as the source has it. It can mean free, or paid for another way: the page does not decide.
  if ((input ?? 0) === 0 && (output ?? 0) === 0) {
    return entry.access === "subscription" ? plan : `<span class="price" title="The source lists a price of 0. That can mean free of charge, or paid for another way (a plan or a seat).">$0 <span class="muted">/</span> $0</span>`;
  }
  return `<span class="price">${input === undefined ? DASH : usd(input)} <span class="muted">/</span> ${output === undefined ? DASH : usd(output)}</span>`;
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
  const cost = record(model.cost);
  const words = record(cost?.text);
  const input = record(words?.input);
  const output = record(words?.output);
  if (!input && !output) {
    return `<p class="hint">${summary.access === "api" ? "The source gives no price per token for this entry." : "No price per token: this entry is paid for through a plan or subscription. providers.dev does not list plans or their prices."}</p>`;
  }
  if ((summary.price_in ?? 0) === 0 && (summary.price_out ?? 0) === 0 && summary.price_in !== undefined) {
    return `<p class="hint">The source lists a price of 0 per token. ${summary.access === "subscription" ? "This entry is paid for through a plan or subscription, not per token." : "That can mean free of charge, or paid for another way (a plan or a seat): check the provider."} providers.dev does not list plans or their prices.</p>`;
  }
  const unit = typeof input?.unit === "string" ? `${e(input.unit)}s` : "tokens";
  const amount = (value: Json | undefined): string => (typeof value === "number" ? usd(value) : UNKNOWN);
  const cache = record(input?.cache);
  const rows = [
    fact("Input", "<code>cost.text.input.price</code>", amount(input?.price), source),
    fact("Output", "<code>cost.text.output.price</code>", amount(output?.price), source),
    typeof output?.reasoning === "number" ? fact("Reasoning output", "<code>cost.text.output.reasoning</code>", usd(output.reasoning), source) : "",
    typeof cache?.read === "number" ? fact("Cached input, read", "<code>cost.text.input.cache.read</code>: input served from the prompt cache.", usd(cache.read), source) : "",
    cacheWrite(cache?.write) ? fact("Cached input, write", "<code>cost.text.input.cache.write</code>: input stored in the prompt cache, by lifetime where it differs.", cacheWrite(cache?.write) as string, source) : "",
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
      ? `<h3>Price changes</h3><ul class="changes">${[...changes].map(([when, parts]) => `<li><strong>${when}:</strong> ${parts.join(", ")}</li>`).join("")}${
          other > 0 ? `<li class="muted">${plural(other, "more condition")} (by region, time or a mix): see <code>cost</code> in the full record below.</li>` : ""
        }</ul>`
      : "";
  return `<div class="scroll"><table class="facts">
    <thead><tr><th scope="col">Price</th><th scope="col" class="num">US dollars per million ${unit}</th><th scope="col">Source</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
  <p class="hint">List prices as the source records them. Other kinds of use (web search, audio, images, video) are priced in <code>cost</code> in the full record below. A subscription's price is not a price per token and is not listed.</p>
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
  if (value === UNKNOWN && !source.includes("Corrected")) source = DASH;
  return `<tr><th scope="row">${label}<div class="hint">${hint}</div></th><td class="num">${value}</td><td>${source}</td></tr>`;
}

function optionsText(options: JsonObject | undefined): string {
  if (!options) return "";
  return Object.entries(options)
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(", ");
}

type Check = { warm: number; total: number };

function heatCell(check: Check | undefined, when: string): string {
  if (!check || check.total === 0) return `<td class="heat"><span class="skip" title="${e(when)}: not checked">·</span></td>`;
  const share = check.warm / check.total;
  const level = share === 1 ? "all" : share === 0 ? "none" : share >= 0.5 ? "most" : "few";
  return `<td class="heat"><span class="${level}" title="${e(when)}: ${check.warm} of ${check.total} re-sends served from the cache">${check.warm}/${check.total}</span></td>`;
}

/** One row per evaluation, one column per age: how many of the re-sends at that age were served from the cache. */
function heatmap(runs: Measurement[], now: Date): string {
  const sorted = [...runs].sort((a, b) => b.date.localeCompare(a.date));
  const ages = [...new Set(sorted.flatMap((run) => (run.checks ?? []).map((check) => check.age_s)))].sort((a, b) => a - b);
  const control = sorted.some((run) => run.control);
  const columns = ages.length + (control ? 1 : 0);
  const span = columns > 0 ? ' rowspan="2"' : "";
  const head = `<tr><th scope="col"${span}>Evaluation</th><th scope="col"${span}>Result</th>${
    columns > 0 ? `<th scope="colgroup" colspan="${columns}" class="span">Time since the prompt was cached · re-sends served from the cache</th>` : ""
  }<th scope="col"${span}>Evidence</th></tr>${
    columns > 0
      ? `<tr>${control ? '<th scope="col" class="age" title="Sent again immediately, to confirm the prompt was cached at all.">At once</th>' : ""}${ages.map((age) => `<th scope="col" class="age">${shortAge(age)}</th>`).join("")}</tr>`
      : ""
  }`;
  const rows = sorted
    .map((run) => {
      const verdict = runVerdict(run);
      const byAge = new Map((run.checks ?? []).map((check) => [check.age_s, check]));
      const options = optionsText(run.options);
      return `<tr>
<th scope="row">${e(run.route_label)} ${dateTag(run.date, now)}<div class="hint">${e(run.client_label)}${options ? ` · ${e(options)}` : ""}</div></th>
<td class="result"><strong>${e(verdict.head)}</strong>${verdict.detail ? `<div class="hint">${e(verdict.detail)}</div>` : ""}${run.note ? `<div class="hint">${e(run.note)}</div>` : ""}</td>
${control ? heatCell(run.control, "Sent again at once") : ""}${ages.map((age) => heatCell(byAge.get(age), `After ${duration(age)}`)).join("")}
<td class="nowrap"><a href="${e(run.source)}" rel="noopener">Raw result</a></td>
</tr>`;
    })
    .join("");
  return `<p class="hint max-w-3xl">Each evaluation caches a fresh prompt, then sends it again at set ages. A cell shows how many of the re-sends at that age were served from the cache: <code>3/3</code> is all of them.</p>
<div class="scroll mt-3"><table class="facts heat"><thead>${head}</thead><tbody>${rows}</tbody></table></div>
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

function cacheDocumented(model: JsonObject, provenance: Provenance[], origin: ModelExtension["origin"]): string {
  const capabilities = isObject(model.capabilities) ? model.capabilities : {};
  const cache = capabilities.cache;
  const source = sourceOf("capabilities.cache", provenance, origin);
  if (cache === false) return `<p>Documented: <strong>no prompt caching</strong> on this entry. ${source}</p>`;
  if (!isObject(cache)) {
    return `<p class="muted">${origin === "added" ? "No documentation is recorded for this access method." : "models.dev says nothing about caching for this entry. That is not the same as no caching."}</p>`;
  }
  const rows: string[] = [];
  for (const mode of ["implicit", "explicit"] as const) {
    const value = cache[mode];
    if (value === undefined) continue;
    const detail = isObject(value) ? value : {};
    const ttl = Array.isArray(detail.ttl) && detail.ttl.length > 0 ? detail.ttl.map((item) => `<span class="chip">${e(String(item))}</span>`).join(" ") : UNKNOWN;
    rows.push(`<tr>
<th scope="row"><span class="chip">${mode}</span><div class="hint">${mode === "implicit" ? "The provider caches on its own." : "The request marks what to cache."}</div></th>
<td>${ttl}</td>
<td class="num">${typeof detail.min_tokens === "number" ? exact(detail.min_tokens) : UNKNOWN}</td>
<td class="num">${mode === "explicit" ? (typeof detail.max_breakpoints === "number" ? exact(detail.max_breakpoints) : UNKNOWN) : DASH}</td>
<td>${Array.isArray(detail.targets) ? e(detail.targets.join(", ")) : mode === "explicit" ? UNKNOWN : DASH}</td>
</tr>`);
  }
  return `<div class="scroll"><table class="facts"><thead><tr><th scope="col">Mode</th><th scope="col">Lifetimes</th><th scope="col" class="num">Min. tokens</th><th scope="col" class="num">Breakpoints</th><th scope="col">Targets</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>
<p class="hint">Documented values. Source: ${source} Whether a cache read renews the lifetime is not recorded in the source.</p>`;
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
        : `${summary.cache_modes.join(" + ")}${summary.cache_ttl_s.length > 0 ? ` <span class="unit">${summary.cache_ttl_s.map(duration).join(", ")}</span>` : ""}`;

  const inherited = extension.inherited
    ? `<p class="note">Name, family and dates are taken from <a href="${e(entryHref(extension.inherited.from))}"><code>${e(extension.inherited.from)}</code></a>. Limits, caching and prices are <strong>not</strong> copied from it, because this access method can differ.</p>`
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
  <div class="scroll"><table class="facts">
    <thead><tr><th scope="col">Limit</th><th scope="col" class="num">Value</th><th scope="col">Source</th></tr></thead>
    <tbody>
      ${fact("Context window", "<code>limit.context</code>: what this provider accepts for the model, input and output together.", number(limit.context), sourceOf("limit.context", provenance, extension.origin, fromMeasurement))}
      ${limit.input !== undefined || provenance.some((item) => item.path === "limit.input") ? fact("Largest input", "<code>limit.input</code>: stated where the input limit is lower than the context window.", number(limit.input), sourceOf("limit.input", provenance, extension.origin)) : ""}
      ${fact("Maximum output", "<code>limit.output</code>: the most one response can hold. A maximum, not what you get by default.", number(limit.output), sourceOf("limit.output", provenance, extension.origin, fromMeasurement))}
    </tbody>
  </table></div>
  <p class="hint">Usable context is smaller than the window by the system prompt and tool definitions of the client in use. That overhead varies, so no usable figure is published. An agent's compaction threshold is a client setting, not a limit of this entry.</p>
  ${
    measuredLimits.length > 0
      ? `<h3>Measured limits</h3><div class="scroll"><table class="facts"><thead><tr><th scope="col">Date</th><th scope="col">Measured through</th><th scope="col">Result</th><th scope="col">Evidence</th></tr></thead><tbody>${measuredLimitRows(measuredLimits)}</tbody></table></div>`
      : ""
  }
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
  ${runs.length > 0 ? heatmap(runs, now) : '<p class="muted">No evaluations on this entry.</p>'}
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
