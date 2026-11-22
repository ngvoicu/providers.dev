import type { ProviderSummary, Summary } from "./entries.ts";
import { escapeHtml as e, exact, modelHref, plural, type Today } from "./format.ts";
import type { Query } from "./query.ts";
import { PARAMS, serializeQuery } from "./query.ts";
import { rowHtml, tableHead } from "./render.ts";
import type { CanonicalModel, Facets, Page } from "./resources.ts";
import type { Meta } from "./schema.ts";

export interface Envelope<T> extends Page<T> { meta: { dataset_version: string; generated_at: string; upstream_fetched_at: string } }
export interface One<T> { meta: Envelope<never>["meta"]; data: T }

export function pageLinks(result: Page<unknown>, url: URL, prefix = ""): string {
  const href = (offset: number): string => {
    const params = new URLSearchParams(url.search);
    params.set(`${prefix}offset`, String(offset));
    return `${url.pathname}?${params}`;
  };
  const button = (id: string, label: string, offset: number | null): string => offset === null
    ? `<a id="${id}" class="button" aria-disabled="true">${label}</a>`
    : `<a id="${id}" class="button" href="${e(href(offset))}">${label}</a>`;
  return `<nav class="mt-4 flex items-center justify-between gap-3 text-[0.85rem]" aria-label="Pages">
    ${button(`${prefix}prev`, "Previous", result.offset > 0 ? Math.max(0, result.offset - result.limit) : null)}
    <span id="${prefix}page" class="muted">Page ${Math.floor(result.offset / result.limit) + 1} of ${Math.max(1, Math.ceil(result.total / result.limit))}</span>
    ${button(`${prefix}next`, "Next", result.next_offset)}</nav>`;
}

export function apiLink(path: string): string {
  return `<a href="${e(path)}"><code>GET ${e(path)}</code></a>`;
}

/** Parameters the form never carries: a new filter starts again at the first page. */
const NOT_CARRIED: readonly (keyof Query)[] = ["offset"];

export function catalogHtml(result: Envelope<Summary>, query: Query, facets: Facets, meta: Meta, url: URL, today: Today): string {
  const value = (name: keyof Query): string => e(Array.isArray(query[name]) ? (query[name] as string[]).join(",") : String(query[name] ?? ""));
  // Every control registers its name as it is written; each other declared parameter of the query is carried in a hidden input.
  const controls = new Set<keyof Query>();
  const named = (name: keyof Query): string => (controls.add(name), `name="${name}"`);
  const select = (name: keyof Query, label: string, options: [string, string][]): string => `<label class="field">${label}<select ${named(name)}><option value="">Any</option>${options.map(([id, text]) => `<option value="${e(id)}"${value(name) === e(id) ? " selected" : ""}>${e(text)}</option>`).join("")}</select></label>`;
  const api = `/api/v1/entries?${serializeQuery(query)}`;
  const providerNames = Object.fromEntries(facets.providers.map((provider) => [provider.id, provider.name]));
  return `<header class="home-head"><h1>AI models as each provider exposes them</h1>
    <p class="lead">Context window, maximum output, price and prompt caching for ${exact(meta.counts.entries)} entries. Built on <a href="https://models.dev">models.dev</a>, with <a href="/?origin=modified,added">${exact(facets.evidence_entries)} entries</a> corrected or evaluated by providers.dev${meta.pi.snapshot ? `, and <a href="/docs/methodology/#pi">pi's model catalog</a> as the last source for ${exact(meta.pi.counts.entries_with_block)}` : ""}. Each quantity has one value; <a href="/docs/methodology/#safe-values">a warning</a> marks where its sources disagree.</p>
    <p class="facts-line muted"><span>${exact(meta.counts.providers)} providers, <a href="/?access=subscription">${exact(facets.subscription_providers)} by subscription</a></span><span><a href="/models/">${exact(meta.counts.models)} models</a></span><span><a href="/evidence/#cache">${exact(meta.counts.cache_evaluations)} cache evaluations</a></span><span>Updated ${e(meta.generated_at.slice(0, 10))}</span></p></header>
    <form id="filters" class="mt-5" role="search" aria-label="Filter entries" method="get">
      <label class="search block"><span class="sr-only">Search</span><input type="search" ${named("q")} value="${value("q")}" placeholder="Search models, providers and families" autocomplete="off" spellcheck="false"><kbd class="hidden sm:block">/</kbd></label>
      <details id="more-filters" class="mt-3" open><summary class="button sm:hidden">Filters</summary><div class="panel mt-3 grid grid-cols-2 gap-3 sm:mt-0 sm:grid-cols-4 lg:grid-cols-8">
        <label class="field">Provider<input ${named("provider")} value="${value("provider")}" list="provider-ids" placeholder="Any" autocomplete="off"></label>
        ${select("access", "Access", [["api", "API key"], ["subscription", "Subscription"], ["unknown", "Unclassified"]])}
        ${select("type", "Type", facets.types.map((type) => [type, type]))}
        ${select("cache", "Caching", [["yes", "Supported"], ["no", "Not supported"], ["unknown", "Unknown"]])}
        ${select("cache_mode", "Cache mode", [["implicit", "Automatic"], ["explicit", "Manual"]])}
        ${select("origin", "Source", [["modified,added", "With providers.dev evidence"], ["added", "providers.dev only"], ["upstream", "models.dev only"]])}
        ${select("evaluated", "Cache evaluated", [["true", "Yes"], ["false", "No"]])}
        <div class="field justify-end"><button type="reset" class="button">Clear filters</button></div>
        <label class="field col-span-2">Minimum context window (tokens)<input ${named("min_input_window")} value="${value("min_input_window")}" inputmode="numeric" placeholder="200000"><span class="hint">Entries with an unknown window are excluded.</span></label>
        <label class="field col-span-2">Minimum maximum output (tokens)<input ${named("min_output")} value="${value("min_output")}" inputmode="numeric" placeholder="64000"><span class="hint">The largest single response, not a default.</span></label>
        ${select("max_age_months", "Released", [...new Set([1, 3, 6, 12, 24, ...(query.max_age_months ? [query.max_age_months] : [])])].map((months) => [String(months), `Last ${months} months`]))}
        ${select("disagree", "Warning", [["true", "Not all sources agree"], ["false", "No warning"]])}
        <div class="field justify-end"><button class="button" type="submit">Apply filters</button></div>
      </div></details>
      ${PARAMS.map(({ name }) => name).filter((name) => !controls.has(name) && !NOT_CARRIED.includes(name) && value(name) !== "").map((name) => `<input type="hidden" name="${name}" value="${value(name)}">`).join("")}
      <datalist id="provider-ids">${facets.providers.map((provider) => `<option value="${e(provider.id)}">${e(provider.name)}</option>`).join("")}</datalist>
    </form>
    <div class="mt-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[0.85rem]"><p id="count" class="font-medium" aria-live="polite">${exact(result.total)} entries</p><p class="muted flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 sm:flex-nowrap"><span>This view as JSON</span><a id="api-link" class="min-w-0 sm:truncate" href="${e(api)}"><code>${e(api)}</code></a><button type="button" id="api-copy" class="copy" data-copy="${e(api)}">Copy</button></p></div>
    <div class="scroll mt-3"><table class="entries stack-tablet" id="entries" data-now="${today.date.toISOString().slice(0, 10)}" data-stale-after-days="${today.stale_after_days}" data-version="${e(meta.dataset_version)}" data-publication="${e(meta.generated_at)}" data-pi="${e(JSON.stringify(meta.pi))}"${result.total === 0 ? " hidden" : ""}>
      <caption class="sr-only">Provider-model entries</caption><thead id="head">${tableHead({ sortable: true, sort: query.sort, order: query.order })}</thead><tbody id="rows">${result.data.map((entry) => rowHtml(entry, { today, providerNames, imported: result.meta.upstream_fetched_at.slice(0, 10), pi: meta.pi })).join("")}</tbody></table>
      <div id="empty" class="empty"${result.total > 0 ? " hidden" : ""}><p class="font-medium text-fg">No entries match these filters</p><button type="button" class="button mt-4" id="empty-reset">Clear filters</button></div>
      <div id="failed" class="empty" role="alert" hidden><p class="font-medium text-fg">The API request failed</p><p>Try again to load this view.</p><button type="button" class="button mt-4" id="retry">Try again</button></div></div>
    ${pageLinks(result, url)}
    <noscript><p class="note mt-3">Use Apply filters and the page links to browse.</p></noscript>`;
}

const accessLabel = { api: "API key", subscription: "Subscription", unknown: "Unclassified" } as const;

export function providersHtml(result: Envelope<ProviderSummary>, url: URL): string {
  return `<h1>Providers</h1><p class="lead mt-3">${plural(result.total, "provider")}. Access describes how each provider is reached.</p>${searchForm("providers", url)}
    <div class="scroll mt-3"><table class="entries stack-phone"><thead><tr><th>Provider</th><th>Access</th><th class="num">Entries</th><th class="num">With providers.dev evidence</th><th>Source</th></tr></thead><tbody>${result.data.map((provider) => `<tr><th scope="row"><a href="/providers/${e(provider.id)}/">${e(provider.name)}</a><div class="id"><code>${e(provider.id)}</code></div></th><td data-label="Access">${accessLabel[provider.access]}${provider.access_reviewed ? "" : `<span class="hint"> · ${provider.access === "api" ? "default" : "by name"}</span>`}</td><td class="num" data-label="Entries">${exact(provider.entry_count)}</td><td class="num" data-label="With providers.dev evidence">${exact(provider.evidence_entry_count)}</td><td data-label="Source"><span class="origin ${provider.origin}">${provider.origin === "added" ? "providers.dev" : "models.dev"}</span></td></tr>`).join("")}</tbody></table></div>${result.total === 0 ? '<p class="empty">No provider matches.</p>' : ""}${pageLinks(result, url)}<p class="hint mt-3">${apiLink(`/api/v1/providers${url.search}`)}</p>`;
}

export function modelsHtml(result: Envelope<CanonicalModel>, url: URL): string {
  return `<h1>Models</h1><p class="lead mt-3">${plural(result.total, "canonical model")}. Each page compares its entries across providers and access methods.</p>${searchForm("models", url)}
    <div class="scroll mt-3"><table class="entries stack-phone"><thead><tr><th>Model</th><th class="num">Entries</th><th class="num">By subscription</th><th class="num">With providers.dev evidence</th></tr></thead><tbody>${result.data.map((model) => `<tr><th scope="row"><a href="${e(modelHref(model.id))}">${e(model.name)}</a><div class="id"><code>${e(model.id)}</code></div></th><td class="num" data-label="Entries">${exact(model.entry_count)}</td><td class="num" data-label="By subscription">${exact(model.subscription_entry_count)}</td><td class="num" data-label="With providers.dev evidence">${exact(model.evidence_entry_count)}</td></tr>`).join("")}</tbody></table></div>${result.total === 0 ? '<p class="empty">No model matches.</p>' : ""}${pageLinks(result, url)}<p class="hint mt-3">${apiLink(`/api/v1/models${url.search}`)}</p>`;
}

function searchForm(resource: "models" | "providers", url: URL): string {
  const retained = [...url.searchParams].filter(([name]) => name !== "q" && name !== "offset").map(([name, value]) => `<input type="hidden" name="${e(name)}" value="${e(value)}">`).join("");
  return `<form method="get" class="mt-6 flex max-w-lg items-end gap-2"><label class="field flex-1">Filter ${resource}<input name="q" type="search" value="${e(url.searchParams.get("q") ?? "")}" placeholder="Name or id"></label>${retained}<button type="submit" class="button">Search</button></form>`;
}
