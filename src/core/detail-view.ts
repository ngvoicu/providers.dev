import { settingsText } from "./cache.ts";
import { apiLink, pageLinks, type Envelope } from "./catalog-view.ts";
import type { ProviderSummary, Summary } from "./entries.ts";
import { compactTokens, compactTokensDown, entryHref, escapeHtml as e, exact, isStale, plural, type Today } from "./format.ts";
import type { WindowBound } from "./limits.ts";
import type { Listing, ListingModel, ListingSource } from "./listings.ts";
import { evaluationStrip, rowHtml, stripHead, tableHead } from "./render.ts";
import type { CacheEvaluationRecord, CanonicalModelDetail, Correction, LimitEvaluationRecord } from "./resources.ts";
import type { Meta, MetaPi } from "./schema.ts";

// ---- the provider's model list: /api/v1/listings/{provider}, printed as the API gives it.

/** A listing's source, as a mark like the ones beside an entry's values, and in words for a hover text. */
const LISTING_MARK: Record<ListingSource, string> = {
  listed: '<span class="badge listed">listed</span>',
  "providers.dev": '<span class="origin added">providers.dev</span>',
  "models.dev": '<span class="origin upstream">models.dev</span>',
  "pi.dev": '<span class="origin pi">pi.dev</span>',
};
const LISTING_SOURCE_WORD: Record<ListingSource, string> = {
  listed: "the vendor's own list",
  "providers.dev": "providers.dev",
  "models.dev": "models.dev",
  "pi.dev": "pi's catalog",
};
/** What the date beside the mark is, in its hover text. */
const LISTING_DATE_WORD: Record<ListingSource, string> = {
  listed: "The day the vendor's list was read.",
  "providers.dev": "Date of the newest providers.dev evidence for this list.",
  "models.dev": "Imported from models.dev on this date.",
  "pi.dev": "Fetched from pi's catalog on this date.",
};
const LISTING_UNKNOWN = '<span class="unknown" title="No source states it. Unknown is not zero and not unlimited.">Unknown</span>';
const from = (source: ListingSource | null): string => (source ? ` From ${LISTING_SOURCE_WORD[source]}.` : "");

/** The facts row of the provider's page: how many models its list has, from which sources' lists, and a way down to it. */
function listingFact(listing: Listing | null): string {
  if (!listing) return '<span class="muted">No list yet</span>';
  const sources = (Object.keys(listing.lists) as ListingSource[]).filter((source) => listing.lists[source] !== null);
  const date = listing.listed_at ? `, ${e(listing.listed_at)}` : "";
  const from = sources.length > 1 ? `from ${sources.slice(0, -1).map((source) => LISTING_SOURCE_WORD[source]).join(", ")} and ${LISTING_SOURCE_WORD[sources.at(-1)!]}` : `${LISTING_SOURCE_WORD[listing.basis]}${date}`;
  return `<a href="#model-list">${plural(listing.model_count, "model")}</a><span class="muted"> · ${e(from)}</span>`;
}

/** The line under the heading: the source's mark and date, what the list is, and its evidence. */
function listingFrom(listing: Listing, today: Today): string {
  const { basis, listed_at: date } = listing;
  // A list read or stated by providers.dev's side is evidence and can be stale; an import is never marked stale.
  const own = basis === "listed" || basis === "providers.dev";
  const dated = !date ? "" : own && isStale(date, today)
    ? `<span class="stale" title="${e(`${LISTING_DATE_WORD[basis]} More than ${plural(today.stale_after_days, "day")} ago.`)}">${e(date)} · stale</span>`
    : `<span class="muted date" title="${e(LISTING_DATE_WORD[basis])}">${e(date)}</span>`;
  // The models of this source's list; since API 1.6.0 the listing also holds the models only other sources list.
  const inBasis = listing.lists[basis]?.model_count ?? listing.model_count;
  const n = plural(inBasis, "model");
  const more = listing.model_count > inBasis ? ` ${plural(listing.model_count - inBasis, "more model")} from other sources' lists.` : "";
  const said = (basis === "listed"
    ? `${n} on the vendor's own list, read through ${e(listing.client_label ?? listing.client ?? "a client")}.`
    : basis === "providers.dev" ? `${n} on a list providers.dev states.` : `${n} listed by ${LISTING_SOURCE_WORD[basis]} for this provider.`) + more;
  const sources = listing.evidence.length === 1
    ? ` <a href="${e(listing.evidence[0]!.url)}">Source</a>`
    : listing.evidence.length > 1 ? ` Sources: ${listing.evidence.map((item) => `<a href="${e(item.url)}">${e(item.kind)}, ${e(item.date)}</a>`).join(" · ")}` : "";
  return `<p class="listing-from"><span class="sources side">${LISTING_MARK[basis]}${dated}</span><span>${said}${sources}</span></p>`;
}

function listingTokens(value: number | null, source: ListingSource | null): string {
  return value === null ? LISTING_UNKNOWN : `<span title="${e(`${exact(value)} tokens.${from(source)}`)}">${compactTokens(value)}</span>`;
}

/** Reasoning as the listing states it: the levels a request can ask for; else whether the model reasons at all. */
function listingReasoning(model: ListingModel): string {
  const reasoning = model.reasoning;
  if (reasoning === null) return LISTING_UNKNOWN;
  const sources = model.sources.reasoning;
  if (reasoning.levels !== null && reasoning.levels.length > 0) {
    return `<span class="levels" title="${e(`The levels a request can ask for.${from(sources.levels)}`)}">${reasoning.levels.map((level) => `<span class="chip">${e(level)}</span>`).join("")}</span>`;
  }
  if (reasoning.supported === true) return `<span title="${e(`The model reasons. No source states the levels a request can ask for.${from(sources.supported)}`)}">Yes</span>`;
  if (reasoning.supported === false) return `<span title="${e(`The model does not reason.${from(sources.supported)}`)}">No</span>`;
  if (reasoning.levels !== null) return `<span class="muted" title="${e(`The source states no levels.${from(sources.levels)}`)}">None</span>`;
  return LISTING_UNKNOWN;
}

function listingRow(model: ListingModel): string {
  const ref = model.entry ? `${model.entry.provider}/${model.entry.model}` : null;
  const name = e(model.name ?? model.id);
  const head = ref ? `<a href="${e(entryHref(ref))}">${name}</a>` : `<span class="listed-name">${name}</span>`;
  const notes = [
    model.plans.length > 0 ? `<div class="hint" title="${e(`Plan names the vendor's list attaches to the model, as it writes them.${from(model.sources.plans)}`)}">Plans: ${model.plans.map(e).join(", ")}</div>` : "",
    model.hidden === true ? `<div class="hint" title="${e(`The vendor's list marks the model as not shown in its model picker.${from(model.sources.hidden)}`)}">Hidden in the vendor's picker</div>` : "",
  ].join("");
  const entry = ref
    ? `<a href="${e(entryHref(ref))}" title="${e(`The catalog entry ${ref}: its values, sources and any evaluations.`)}">Entry page</a>`
    : '<span class="muted" title="The catalog has no entry for this model at this provider. It is on the list; providers.dev has not evaluated it.">Listed, not evaluated</span>';
  const input = model.input_modalities === null ? LISTING_UNKNOWN : `<span title="${e(`What a request can send.${from(model.sources.input_modalities)}`)}">${e(model.input_modalities.join(", "))}</span>`;
  const released = model.released === null ? LISTING_UNKNOWN : `<span class="date" title="${e(`Release date.${from(model.sources.released)}`)}">${e(model.released)}</span>`;
  return `<tr${ref ? "" : ' class="no-entry"'}><th scope="row">${head}${model.name !== null ? `<div class="id"><code>${e(model.id)}</code></div>` : ""}${notes}</th><td class="nowrap" data-label="Entry">${entry}</td><td class="num" data-label="Context">${listingTokens(model.context_window, model.sources.context_window)}</td><td class="num" data-label="Max output">${listingTokens(model.max_output, model.sources.max_output)}</td><td data-label="Reasoning">${listingReasoning(model)}</td><td data-label="Input">${input}</td><td data-label="Released">${released}</td></tr>`;
}

/**
 * The section "Model list" of a provider's page: every model the provider offers on this access method, evaluated or
 * not, as `/api/v1/listings/{provider}` gives it. Null: the API has no listing for the provider. It prints the fields of
 * the listing and works nothing out but the one thing a page may, whether a list read by providers.dev's side is stale.
 */
export function listingHtml(provider: ProviderSummary, listing: Listing | null, today: Today): string {
  const how = '<a href="/docs/methodology/#listings">Where a model list comes from</a>';
  const head = `<div class="mt-10 flex flex-wrap items-end justify-between gap-3"><h2 id="model-list" class="!m-0">Model list</h2><p class="hint">${how}${listing ? ` · ${apiLink(`/api/v1/listings/${encodeURIComponent(provider.id)}`)}` : ""}</p></div>`;
  if (!listing) return `${head}<p class="empty listing-empty">No model list for this provider yet: no source gives one.</p>`;
  const models = listing.models ?? [];
  return `${head}${listingFrom(listing, today)}
    <div class="scroll mt-3"><table class="entries listing stack-tablet"><caption class="sr-only">Models on the list of ${e(provider.name)}</caption><thead><tr><th scope="col">Model</th><th scope="col">Entry</th><th scope="col" class="num">Context</th><th scope="col" class="num">Max output</th><th scope="col">Reasoning</th><th scope="col">Input</th><th scope="col">Released</th></tr></thead><tbody>${models.map(listingRow).join("")}</tbody></table></div>${models.length === 0 ? '<p class="empty">The list names no model.</p>' : ""}`;
}

export function providerHtml(provider: ProviderSummary, entries: Summary[], listing: Listing | null, imported: string, today: Today, pi?: MetaPi): string {
  const extension = provider.providers_dev;
  const access = { api: "API key, billed by use", subscription: "Subscription login", unknown: "Unclassified" };
  return `<p class="crumbs"><a href="/providers/">Providers</a> / ${e(provider.name)}</p><h1>${e(provider.name)}</h1>
    <p class="id mt-1"><code>${e(provider.id)}</code><button type="button" class="copy" data-copy="${e(provider.id)}">Copy</button><span class="origin ${provider.origin}">${provider.origin === "added" ? "providers.dev" : "models.dev"}</span>${provider.doc ? `<a href="${e(provider.doc)}" rel="noopener">Documentation ↗</a>` : ""}</p>
    <dl class="mt-6 grid max-w-4xl grid-cols-[9rem_1fr] gap-x-4 gap-y-3 text-[0.9rem]"><dt class="muted">Access</dt><dd><strong>${access[extension.access]}</strong><div class="hint">${e(extension.access_basis)}${extension.access_source ? ` <a href="${e(extension.access_source)}">Source</a>` : ""}</div></dd><dt class="muted">Entries</dt><dd>${exact(provider.entry_count)}, ${exact(provider.evidence_entry_count)} with providers.dev evidence</dd><dt class="muted">Model list</dt><dd>${listingFact(listing)}</dd>
    ${provider.env.length ? `<dt class="muted">Key variables</dt><dd>${provider.env.map((name) => `<code class="mr-2">${e(name)}</code>`).join("")}</dd>` : ""}
    ${extension.note ? `<dt class="muted">Note</dt><dd>${e(extension.note)}</dd>` : ""}
    ${extension.evidence.length ? `<dt class="muted">Evidence</dt><dd>${extension.evidence.map((item) => `<div><span class="badge ${item.kind}">${e(item.kind)}</span> <a href="${e(item.url)}">Source</a> <span class="muted">${e(item.date)}</span></div>`).join("")}</dd>` : ""}</dl>
    <div class="mt-8 flex flex-wrap items-end justify-between gap-3"><h2 class="!m-0">Entries</h2><p class="hint"><a href="/?provider=${e(provider.id)}">Filter and sort in the catalog</a> · ${apiLink(`/api/v1/providers/${encodeURIComponent(provider.id)}`)}</p></div>
    <div class="scroll mt-3"><table class="entries stack-tablet"><caption class="sr-only">Entries at ${e(provider.name)}</caption><thead>${tableHead({ hideProvider: true })}</thead><tbody>${entries.map((entry) => rowHtml(entry, { today, imported, pi, hideProvider: true })).join("")}</tbody></table></div>${entries.length === 0 ? '<p class="empty">No entries are listed for this provider. What providers.dev leaves out of the catalog is listed under <a href="/evidence/#issues">Dataset issues</a>.</p>' : ""}
    ${listingHtml(provider, listing, today)}`;
}

/** An input window as the entry table prints it: "≥" before it and rounded down where it is a lower bound; or in full. */
function windowFigure(w: { tokens: number; bound: WindowBound | null }, full = false): string {
  if (w.bound === "at_least") return `≥ ${full ? exact(w.tokens) : compactTokensDown(w.tokens)}`;
  return full ? exact(w.tokens) : compactTokens(w.tokens);
}

/** An input window in words, for the hover text: the exact tokens, "at least" where it is a bound. */
const windowWords = (w: { tokens: number; bound: WindowBound | null }): string => `${w.bound === "at_least" ? "at least " : ""}${exact(w.tokens)} tokens`;

/**
 * The context window of a model, as a page names the safe input window, as the API publishes it: `input_window_min`
 * to `input_window_max`, "≥" at an end that is a lower bound, `input_window_unknown_count`, and
 * `input_window_reference`, the lab's own entry. It compares no values and looks up no entry: every figure is a field
 * of the model.
 */
function modelWindowTile(model: CanonicalModelDetail, providerNames: Record<string, string>): string {
  const { entry_count: entries, input_window_min: min, input_window_max: max, input_window_unknown_count: unknown } = model;
  const lines: string[] = [];
  let value: string;
  if (min === null || max === null) {
    value = '<span class="muted">Unknown</span>';
    lines.push(entries === 1 ? "No source states one" : `No source states one at any of its ${exact(entries)} entries`);
  } else {
    const same = min.tokens === max.tokens && min.bound === max.bound;
    // Two ends that round to the same figure are written out in full.
    const full = !same && windowFigure(min) === windowFigure(max);
    const said = same ? `${windowWords(min)}, ${min.entry_ref}${entries === 1 ? "" : ", the same at every entry that has one"}.` : `Smallest: ${windowWords(min)}, ${min.entry_ref}. Largest: ${windowWords(max)}, ${max.entry_ref}.`;
    value = `<span title="${e(said)}">${same ? windowFigure(min) : `${windowFigure(min, full)} to ${windowFigure(max, full)}`}</span> <span class="unit">tokens</span>`;
    const where = !same ? "Smallest to largest among its entries" : entries === 1 ? "Its only entry" : unknown > 0 ? "The same at every entry that has one" : entries === 2 ? "The same at both entries" : `The same at all ${exact(entries)} entries`;
    lines.push(unknown === 0 ? where : `${where}; unknown at ${exact(unknown)} of ${exact(entries)}`);
    if (min.bound === "at_least" || max.bound === "at_least") lines.push("≥ marks a lower bound");
  }
  // The lab's own entry, where the model has one: its context window as the API publishes it with the model.
  if (model.reference_ref !== null) {
    const w = model.input_window_reference;
    const said = `The lab's own entry, ${model.reference_ref}: ${w ? windowWords(w) : "unknown"}.`;
    lines.push(`<span title="${e(said)}">At ${e(providerNames[model.lab] ?? model.lab)}: ${w ? windowFigure(w) : "unknown"}</span>`);
  }
  return `<div class="tile"><div class="label">Context window</div><div class="value small">${value}</div><div class="foot">${lines.map((line) => `<div>${line}</div>`).join("")}</div></div>`;
}

export function modelHtml(model: CanonicalModelDetail, providerNames: Record<string, string>, imported: string, today: Today, pi?: MetaPi): string {
  const range = (low: number | null, high: number | null): string => low === null || high === null ? "Unknown" : low === high ? compactTokens(low) : `${compactTokens(low)} to ${compactTokens(high)}`;
  const tile = (label: string, value: string, foot: string): string => `<div class="tile"><div class="label">${label}</div><div class="value small">${value}</div><div class="foot">${foot}</div></div>`;
  // The two limits first, as on an entry's page, then the two counts. The context window is the safe input window.
  return `<p class="crumbs"><a href="/models/">Models</a> / ${e(model.name)}</p><h1>${e(model.name)}</h1><p class="id mt-1"><code>${e(model.id)}</code><button type="button" class="copy" data-copy="${e(model.id)}">Copy</button></p>
    <div class="tiles mt-6">${modelWindowTile(model, providerNames)}${tile("Maximum output", `${range(model.max_output_min, model.max_output_max)} <span class="unit">tokens</span>`, "Smallest to largest among its entries")}${tile("Entries", exact(model.entry_count), `${exact(model.subscription_entry_count)} by subscription`)}${tile("With providers.dev evidence", exact(model.evidence_entry_count), "Corrections or evaluations")}</div>
    ${model.reference_ref ? `<p class="note mt-5">Reference entry: <a href="${e(entryHref(model.reference_ref))}"><code>${e(model.reference_ref)}</code></a>. Values below are specific to each provider and access method.</p>` : ""}
    <div class="scroll mt-5"><table class="entries stack-tablet"><caption class="sr-only">Entries for ${e(model.name)}</caption><thead>${tableHead({})}</thead><tbody>${model.entries.map((entry) => rowHtml(entry, { today, imported, pi, providerNames })).join("")}</tbody></table></div><p class="hint mt-3">${apiLink(`/api/v1/models/${model.id.split("/").map(encodeURIComponent).join("/")}`)}</p>`;
}

export function evidenceHtml(meta: Meta, corrections: Envelope<Correction>, added: ProviderSummary[], cache: Envelope<CacheEvaluationRecord>, measured: Envelope<LimitEvaluationRecord>, url: URL, today: Today): string {
  const runs = cache.data;
  const limits = measured.data;
  // The age columns of the strips are the published ones, `cache_ages_s` of /api/v1/meta.
  const ages = meta.cache_ages_s;
  const agesInRow = stripHead(ages, "row");
  const number = (value: number | null): string => value === null ? '<span class="muted">Unknown</span>' : exact(value);
  return `<h1>Evidence</h1><p class="lead mt-3">Corrections and evaluations published by providers.dev. Evidence older than ${plural(today.stale_after_days, "day")} is marked stale. To propose a correction or ask for an evaluation, see <a href="/docs/contributing/">Contributing</a>.</p>
    <dl class="stats mt-8"><div><dt>Corrected entries</dt><dd>${exact(meta.counts.corrected_entries)}</dd></div><div><dt>Added providers</dt><dd>${exact(meta.counts.added_providers)}</dd></div><div><dt>Cache evaluations</dt><dd>${exact(meta.counts.cache_evaluations)}</dd></div><div><dt>Measured limits</dt><dd>${exact(meta.counts.limit_evaluations)}</dd></div></dl>
    <h2 id="corrections">Corrections</h2>${corrections.data.map(({ change, entry_refs }) => `<div class="change !max-w-none"><p><code>${e(change.path)}</code>: ${change.op === "set" ? `<code>${e(JSON.stringify(change.value))}</code>` : change.op === "unknown" ? "Unknown" : "Removed"}. models.dev: ${change.had_upstream ? `<code>${e(JSON.stringify(change.upstream))}</code>` : "Not provided"}.</p><p class="muted mt-1">${e(change.reason)}</p><ul class="evidence">${change.evidence.map((item) => `<li><span class="badge ${item.kind}">${e(item.kind)}</span> <a href="${e(item.url)}">Source</a> <span class="muted date">${e(item.date)}</span></li>`).join("")}</ul><details><summary>${exact(entry_refs.length)} entries</summary><p class="mt-1 flex flex-wrap gap-x-3 gap-y-1">${entry_refs.map((ref) => `<a href="${e(entryHref(ref))}"><code>${e(ref)}</code></a>`).join("")}</p></details></div>`).join("") || '<p class="muted">No corrections on this page.</p>'}${pageLinks(corrections, url, "corrections_")}<p class="hint mt-3">${apiLink(`/api/v1/corrections?offset=${corrections.offset}`)}</p>
    <h2 id="added">Added providers</h2><div class="scroll"><table class="entries stack-phone"><thead><tr><th>Provider</th><th>Access</th><th class="num">Entries</th></tr></thead><tbody>${added.map((provider) => `<tr><th><a href="/providers/${e(provider.id)}/">${e(provider.name)}</a></th><td class="span-row" data-label="Access">${e(provider.providers_dev.access_basis)}</td><td class="num" data-label="Entries">${exact(provider.entry_count)}</td></tr>`).join("")}</tbody></table></div>
    <h2 id="cache">Cache evaluations</h2><p class="hint mb-3">Observed hit percentages by exact age, for the client and request setting shown.</p><details><summary>${exact(cache.total)} cache evaluations</summary><div class="scroll mt-3"><table class="entries stack-tablet"><thead><tr><th>Entry</th><th>Measured through</th><th class="strip-col">Served from cache, % by age${stripHead(ages, "column")}</th><th>Date</th><th>Evidence</th></tr></thead><tbody>${runs.map((run) => `<tr><th scope="row"><a href="${e(entryHref(run.entry_ref))}#cache">${e(run.entry_name)}</a><div class="id"><code>${e(run.entry_ref)}</code></div></th><td class="span-row" data-label="Measured through">${e(run.route_label)}<div class="hint">${e(run.client_label)} · ${e(settingsText(run.request_settings))}</div></td><td class="strip-col" data-label="Served from cache, % by age">${agesInRow}${evaluationStrip(run, ages)}</td><td class="${isStale(run.date, today) ? "stale" : "muted date"}" data-label="Date">${e(run.date)}</td><td data-label="Evidence"><a href="${e(run.source)}">Raw result</a></td></tr>`).join("")}</tbody></table></div>${pageLinks(cache, url, "cache_")}<p class="hint mt-3">${apiLink(`/api/v1/evaluations/cache?offset=${cache.offset}`)}</p></details>
    <h2 id="limits">Measured limits</h2><p class="hint">All limits in tokens.</p><div class="scroll mt-3"><table class="entries stack-tablet"><thead><tr><th>Entry</th><th>Date</th><th>Measured through</th><th class="num">Context</th><th class="num">Input accepted</th><th class="num">Input refused</th><th class="num">Output limit</th><th class="num">Requested output accepted</th><th>Evidence</th></tr></thead><tbody>${limits.map((limit) => `<tr><th scope="row"><a href="${e(entryHref(limit.entry_ref))}#limits">${e(limit.entry_name)}</a><div class="id"><code>${e(limit.entry_ref)}</code></div></th><td data-label="Date">${e(limit.date ?? "Unknown")}</td><td class="span-row" data-label="Measured through">${e(limit.route_label)}<div class="hint">${e(limit.client_label)}</div></td>${([[limit.context, "Context"], [limit.input_accepted, "Input accepted"], [limit.input_refused, "Input refused"], [limit.output, "Output limit"], [limit.output_accepted, "Requested output accepted"]] as const).map(([value, label]) => `<td class="num" data-label="${label}">${number(value)}</td>`).join("")}<td data-label="Evidence"><a href="${e(limit.source)}">Raw result</a></td></tr>`).join("")}</tbody></table></div>
    ${pageLinks(measured, url, "limits_")}<p class="hint mt-3">${apiLink(`/api/v1/evaluations/limits?offset=${measured.offset}`)}</p>
    <h2 id="issues">Dataset issues</h2><ul class="prose">${meta.issues.map((issue) => `<li><span class="badge plain">${e(issue.level)}</span> <code>${e(issue.target)}</code> ${e(issue.message)}</li>`).join("")}${meta.exclusions.map((item) => item.kind === "rule" ? `<li><span class="badge plain">left out</span> ${e(item.leaves_out ?? item.target)}: ${e(item.entries === 1 ? "1 entry" : `${exact(item.entries)} entries`)}. ${e(item.reason)} <span class="hint">${e(item.date ?? "")}</span></li>` : `<li><span class="badge plain">excluded</span> <code>${e(item.target)}</code> ${e(item.reason)}</li>`).join("")}</ul><p class="hint mt-3">${apiLink("/api/v1/meta")}</p>`;
}
