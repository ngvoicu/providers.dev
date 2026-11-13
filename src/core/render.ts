// HTML for the entry table and the entry detail view. The same functions build the static pages and
// re-render in the browser, so a row looks and reads the same wherever it appears.
import type { ProviderSummary, Summary } from "./entries.ts";
import {
  cacheLabel,
  compactTokens,
  duration,
  entryHref,
  escapeHtml as e,
  exact,
  isStale,
  measuredLabel,
  modelHref,
  ORIGIN_LABEL,
  ORIGIN_TITLE,
} from "./format.ts";
import { isObject, type Json, type JsonObject } from "./merge.ts";
import { NS, type Evidence, type MeasuredLimit, type Measurement, type ModelExtension, type Provenance, type ProviderExtension } from "./schema.ts";

const UNKNOWN = '<span class="unknown" title="The source does not say. Unknown is not zero and not unlimited.">unknown</span>';

function tokens(value: number | undefined): string {
  return value === undefined ? UNKNOWN : `<span title="${exact(value)} tokens">${compactTokens(value)}</span>`;
}

function copyButton(value: string, label: string): string {
  return `<button type="button" class="copy" data-copy="${e(value)}" aria-label="Copy ${e(label)}" title="Copy ${e(label)}">copy</button>`;
}

function verifiedTag(date: string | undefined, now: Date): string {
  if (!date) return "";
  return isStale(date, now)
    ? `<span class="stale" title="Our newest evidence for this entry is from ${e(date)}, more than 90 days ago.">${e(date)} · stale</span>`
    : `<span class="muted date" title="The date of our own evidence.">${e(date)}</span>`;
}

export interface RowOptions {
  now: Date;
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
${column(null, "Cache, documented", "Prompt caching as the source documents it: mode and lifetimes.")}
${column(null, "Cache, measured", "Our own runs: the ages at which every check was still served from the cache.")}
${column("verified", "Source", "Where the entry comes from, and the newest date of our own evidence.")}
</tr>`;
}

export function rowHtml(entry: Summary, options: RowOptions): string {
  const href = entryHref(entry.ref);
  const provider = options.providerNames?.[entry.provider] ?? entry.provider;
  const access =
    entry.access === "api" ? "" : `<span class="badge ${entry.access}" title="Access: ${entry.access}">${entry.access === "subscription" ? "subscription" : "access unknown"}</span>`;
  const status = entry.status ? ` <span class="badge plain">${e(entry.status)}</span>` : "";
  const measured = measuredLabel(entry);
  const overridden = entry.overridden_fields.length > 0 ? ` Our overrides: ${entry.overridden_fields.join(", ")}.` : "";
  return `<tr>
<th scope="row"><a href="${e(href)}">${e(entry.name)}</a>${status}<div class="id"><code>${e(entry.model)}</code>${copyButton(entry.ref, "entry id")}</div></th>
${options.hideProvider ? "" : `<td><a class="quiet" href="/providers/${e(entry.provider)}/">${e(provider)}</a> ${access}</td>`}
<td class="num">${tokens(entry.context)}</td>
<td class="num">${tokens(entry.max_output)}</td>
<td>${entry.cache === "unknown" ? UNKNOWN : e(cacheLabel(entry))}</td>
<td>${measured ? `<a class="measured" href="${e(href)}#cache">${e(measured)}</a>` : '<span class="muted">–</span>'}</td>
<td><span class="origin ${entry.origin}" title="${e(ORIGIN_TITLE[entry.origin] + overridden)}">${ORIGIN_LABEL[entry.origin]}</span> ${verifiedTag(entry.verified, options.now)}</td>
</tr>`;
}

// ---- the entry detail view

function evidenceList(items: Evidence[]): string {
  return `<ul class="evidence">${items
    .map(
      (item) =>
        `<li><span class="badge ${item.kind}">${item.kind}</span> <a href="${e(item.url)}" rel="noopener">${e(shortUrl(item.url))}</a> <span class="muted">${e(item.date)}</span>${item.note ? `<div class="muted">${e(item.note)}</div>` : ""}</li>`,
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
  if (measured.some((field) => path === `limit.${field}`)) return '<span class="badge measured" title="Measured by us on this access. See the measurement below.">measured</span>';
  const change = provenance.find((item) => item.path === path || path.startsWith(`${item.path}.`) || item.path.startsWith(`${path}.`));
  if (change) return `<span class="origin modified" title="Our override. models.dev says: ${e(change.had_upstream ? JSON.stringify(change.upstream) : "nothing")}">ours</span>`;
  if (origin === "added") return '<span class="origin added">ours</span>';
  return '<span class="origin upstream" title="Imported from models.dev. Not checked by us.">models.dev</span>';
}

function fact(label: string, hint: string, value: string, source: string): string {
  // An unknown value has no source to name, unless we published it as unknown on purpose.
  if (value === UNKNOWN && !source.includes("override")) source = '<span class="muted">–</span>';
  return `<tr><th scope="row">${label}<div class="hint">${hint}</div></th><td class="num">${value}</td><td>${source}</td></tr>`;
}

function checksText(run: Measurement): string {
  if (!run.checks?.length) return "";
  return run.checks.map((check) => `${duration(check.age_s)}: ${check.warm}/${check.total}`).join(" · ");
}

function optionsText(options: JsonObject | undefined): string {
  if (!options) return "";
  return Object.entries(options)
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(", ");
}

function measurementRows(runs: Measurement[], now: Date): string {
  return runs
    .map((run) => {
      const through = run.all_warm_through_s === null ? '<span class="muted">no age with every check warm</span>' : `every check warm through <strong>${duration(run.all_warm_through_s)}</strong>`;
      const cold = run.first_all_cold_s === null ? "" : `; every check cold at ${duration(run.first_all_cold_s)}`;
      const options = optionsText(run.options);
      return `<tr>
<td>${verifiedTag(run.date, now)}</td>
<td>${e(run.route_label)}<div class="hint" title="${e(run.client_label)}">client: ${e(run.client)}${options ? ` · ${e(options)}` : ""}</div></td>
<td class="wide">${through}${cold}<div class="hint">warm checks by age: ${e(checksText(run)) || "not recorded"}</div>${run.note ? `<div class="hint">${e(run.note)}</div>` : ""}</td>
<td><a href="${e(run.source)}" rel="noopener">raw result</a></td>
</tr>`;
    })
    .join("");
}

function measuredLimitRows(limits: MeasuredLimit[]): string {
  return limits
    .map((limit) => {
      const parts = [
        limit.context !== undefined ? `context ${exact(limit.context)}` : "",
        limit.output !== undefined ? `output ${exact(limit.output)}` : "",
        limit.input_accepted !== undefined ? `accepted an input of ${exact(limit.input_accepted)}` : "",
        limit.input_refused !== undefined ? `refused an input of ${exact(limit.input_refused)}` : "",
        limit.output_accepted !== undefined ? `accepted a requested output of ${exact(limit.output_accepted)}` : "",
      ].filter(Boolean);
      return `<tr><td class="date">${limit.date ? e(limit.date) : '<span class="muted">undated</span>'}</td><td>${e(limit.route_label)}<div class="hint" title="${e(limit.client_label)}">client: ${e(limit.client)}</div></td><td class="wide">${e(parts.join("; "))} <span class="muted">tokens</span>${limit.note ? `<div class="hint">${e(limit.note)}</div>` : ""}</td><td><a href="${e(limit.source)}" rel="noopener">raw result</a></td></tr>`;
    })
    .join("");
}

function cacheDocumented(model: JsonObject, provenance: Provenance[], origin: ModelExtension["origin"]): string {
  const capabilities = isObject(model.capabilities) ? model.capabilities : {};
  const cache = capabilities.cache;
  const source = sourceOf("capabilities.cache", provenance, origin);
  if (cache === false) return `<p>Documented: <strong>no prompt caching</strong> on this entry. ${source}</p>`;
  if (!isObject(cache)) {
    return `<p>Documented: ${UNKNOWN}. ${origin === "added" ? "We have not recorded documentation for this access." : "models.dev says nothing about caching here, which is not the same as no caching."}</p>`;
  }
  const rows: string[] = [];
  for (const mode of ["implicit", "explicit"] as const) {
    const value = cache[mode];
    if (value === undefined) continue;
    const detail = isObject(value) ? value : {};
    const ttl = Array.isArray(detail.ttl) && detail.ttl.length > 0 ? detail.ttl.map((item) => e(String(item))).join(", ") : UNKNOWN;
    rows.push(`<tr>
<th scope="row">${mode}<div class="hint">${mode === "implicit" ? "The provider caches on its own." : "The request marks what to cache."}</div></th>
<td>${ttl}</td>
<td class="num">${typeof detail.min_tokens === "number" ? exact(detail.min_tokens) : UNKNOWN}</td>
<td class="num">${mode === "explicit" ? (typeof detail.max_breakpoints === "number" ? exact(detail.max_breakpoints) : UNKNOWN) : '<span class="muted">–</span>'}</td>
<td>${Array.isArray(detail.targets) ? e(detail.targets.join(", ")) : mode === "explicit" ? UNKNOWN : '<span class="muted">–</span>'}</td>
</tr>`);
  }
  return `<div class="scroll"><table class="facts"><thead><tr><th scope="col">Mode</th><th scope="col">Lifetimes</th><th scope="col" class="num">Min. tokens</th><th scope="col" class="num">Breakpoints</th><th scope="col">Targets</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>
<p class="hint">Documented values. ${source} Whether a read renews the lifetime is not recorded in the source.</p>`;
}

export interface EntryView {
  summary: Summary;
  provider: ProviderSummary;
  providerExtension?: ProviderExtension;
  model: JsonObject;
  now: Date;
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
  const api = `/api/v1/entry?ref=${encodeURIComponent(summary.ref)}`;
  const known = view.providerExtension?.cache_known ?? [];

  const inherited = extension.inherited
    ? `<p class="note">Name, family and dates are taken from <a href="${e(entryHref(extension.inherited.from))}"><code>${e(extension.inherited.from)}</code></a>. Limits, caching and prices are <strong>not</strong> copied from it: this access can differ.</p>`
    : "";

  return `
<header class="entry-head">
  <p class="crumbs"><a href="/providers/${e(provider.id)}/">${e(provider.name)}</a>${summary.canonical_id ? ` · <a href="${e(modelHref(summary.canonical_id))}">all access to ${e(summary.canonical_id)}</a>` : ""}</p>
  <h1>${e(summary.name)}</h1>
  <p class="id"><code>${e(summary.ref)}</code>${copyButton(summary.ref, "entry id")} <span class="badge ${summary.access}">${summary.access === "unknown" ? "access unknown" : summary.access}</span>
  <span class="origin ${summary.origin}" title="${e(ORIGIN_TITLE[summary.origin])}">${ORIGIN_LABEL[summary.origin]}</span> ${verifiedTag(summary.verified, now)}${summary.status ? ` <span class="badge plain">${e(summary.status)}</span>` : ""}</p>
  ${typeof model.description === "string" ? `<p class="lead">${e(model.description)}</p>` : ""}
  ${inherited}
</header>

<section aria-labelledby="limits">
  <h2 id="limits">Limits</h2>
  <div class="scroll"><table class="facts">
    <thead><tr><th scope="col">What</th><th scope="col" class="num">Value</th><th scope="col">Source</th></tr></thead>
    <tbody>
      ${fact("Context window", "limit.context: what this provider accepts for the model, input and output together.", number(limit.context), sourceOf("limit.context", provenance, extension.origin, fromMeasurement))}
      ${limit.input !== undefined || provenance.some((item) => item.path === "limit.input") ? fact("Largest input", "limit.input: stated where the input limit is lower than the context window.", number(limit.input), sourceOf("limit.input", provenance, extension.origin)) : ""}
      ${fact("Maximum output", "limit.output: the most one response can hold. A maximum, not what you get by default.", number(limit.output), sourceOf("limit.output", provenance, extension.origin, fromMeasurement))}
    </tbody>
  </table></div>
  <p class="hint">Usable context is smaller than the window by the system prompt and tool definitions of whatever client you use. That overhead varies, so no usable number is published. An agent's own compaction threshold is a client setting, not a limit of this entry.</p>
  ${
    measuredLimits.length > 0
      ? `<h3>Measured</h3><div class="scroll"><table class="facts"><thead><tr><th scope="col">Date</th><th scope="col">Measured through</th><th scope="col">Result</th><th scope="col">Evidence</th></tr></thead><tbody>${measuredLimitRows(measuredLimits)}</tbody></table></div>`
      : ""
  }
</section>

<section aria-labelledby="cache">
  <h2 id="cache">Prompt caching</h2>
  ${cacheDocumented(model, provenance, extension.origin)}
  <h3>Measured</h3>
  ${
    runs.length > 0
      ? `<div class="scroll"><table class="facts"><thead><tr><th scope="col">Date</th><th scope="col">Measured through</th><th scope="col">Result</th><th scope="col">Evidence</th></tr></thead><tbody>${measurementRows(runs, now)}</tbody></table></div>
  <p class="hint">Each run primes a fresh prompt and re-sends it once at fixed ages. "Warm through 30 min" means every check up to 30 minutes was served from the cache; it is not a promised lifetime, and the next age checked may be much later. A measurement holds for the route and client named, on that date.</p>`
      : '<p class="muted">No measurements on this entry.</p>'
  }
  ${
    known.length > 0
      ? `<h3>Set by the client</h3><ul class="evidence">${known.map((item) => `<li>${e(item.basis)} <span class="muted">(${e(item.client)}${item.when ? `, when ${e(optionsText(item.when))}` : ""}: ${duration(item.ttl_s)})</span> <a href="${e(item.source)}" rel="noopener">source</a></li>`).join("")}</ul>`
      : ""
  }
</section>

<section aria-labelledby="provenance">
  <h2 id="provenance">Where the values come from</h2>
  ${
    extension.origin === "added"
      ? `<p>models.dev has no entry for this access. Every value here is ours.</p>${evidenceList(extension.evidence ?? [])}`
      : provenance.length === 0
        ? `<p>Every documented field is imported from models.dev as is. We have not checked those; imported is not the same as verified.${runs.length + measuredLimits.length > 0 ? " Our own measurements are shown above, next to them, and replace nothing." : ""}</p>`
        : `<p>Imported from models.dev, except:</p>`
  }
  ${provenance
    .map(
      (change) => `<div class="change">
    <p><code>${e(change.path)}</code> ${change.op === "set" ? `is <strong>${show(change.value)}</strong>` : change.op === "unknown" ? "is published as <strong>unknown</strong>" : "is <strong>removed</strong>"}. models.dev says: ${change.had_upstream ? show(change.upstream) : '<span class="muted">nothing</span>'}.</p>
    <p>${e(change.reason)}</p>
    ${evidenceList(change.evidence)}
  </div>`,
    )
    .join("")}
</section>

<section aria-labelledby="raw">
  <h2 id="raw">Data</h2>
  <p><a href="${e(api)}"><code>GET ${e(api)}</code></a>${copyButton(api, "API path")}</p>
  <details><summary>The full entry as published</summary><pre>${e(JSON.stringify(model, null, 2))}</pre></details>
</section>`;
}
