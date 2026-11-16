// Enhance the server-rendered table. Every filter and sort is answered by the public API.
import type { Summary } from "../core/entries.ts";
import type { Envelope } from "../core/catalog-view.ts";
import { exact, type Today } from "../core/format.ts";
import { parseQuery, serializeQuery, SITE_DEFAULT, type Query, type SortKey } from "../core/query.ts";
import { rowHtml, tableHead } from "../core/render.ts";

const form = document.getElementById("filters") as HTMLFormElement;
const table = document.getElementById("entries") as HTMLTableElement;
const head = document.getElementById("head") as HTMLElement;
const rows = document.getElementById("rows") as HTMLElement;
const count = document.getElementById("count") as HTMLElement;
const page = document.getElementById("page") as HTMLElement;
const prev = document.getElementById("prev") as HTMLAnchorElement;
const next = document.getElementById("next") as HTMLAnchorElement;
const empty = document.getElementById("empty") as HTMLElement;
const failed = document.getElementById("failed") as HTMLElement;
const apiLink = document.getElementById("api-link") as HTMLAnchorElement;
const apiCopy = document.getElementById("api-copy") as HTMLButtonElement;
// Today and the published stale threshold (`stale_after_days` of /api/v1/meta), as the server wrote them from the meta it
// read for this page. A new publication reloads the page, so the threshold is always the one of the rows' publication.
const today: Today = { date: new Date(table.dataset.now ?? Date.now()), stale_after_days: Number(table.dataset.staleAfterDays) };

const FIELDS = ["q", "provider", "access", "type", "cache", "cache_mode", "origin", "min_context", "min_output", "max_age_months", "evaluated"] as const;

const providerNames = Object.fromEntries([...document.querySelectorAll<HTMLOptionElement>("#provider-ids option")].map((option) => [option.value, option.textContent ?? option.value]));
let active: AbortController | undefined;
let query: Query = readUrl();

const siteDefault = (): Query => {
  const parsed = parseQuery(new URLSearchParams(SITE_DEFAULT), false);
  if (!parsed.ok) throw new Error("SITE_DEFAULT is not a valid query");
  return parsed.query;
};

function readUrl(): Query {
  const params = new URLSearchParams(location.search);
  // Without a sort in the address, the site's own order applies (our evidence first).
  if (!params.has("sort")) for (const [name, value] of new URLSearchParams(SITE_DEFAULT)) if (!params.has(name)) params.set(name, value);
  let parsed = parseQuery(params, false);
  if (!parsed.ok) {
    // A shared link with a bad value still opens: the bad parameters are dropped.
    for (const error of parsed.errors) params.delete(error.param);
    parsed = parseQuery(params, false);
  }
  return parsed.ok ? parsed.query : siteDefault();
}

/** The address of a view: the site's default order is left out, any other order is spelled out. */
function siteSearch(): string {
  const api = serializeQuery(query);
  const params = new URLSearchParams(api);
  if (query.sort === "verified" && query.order === "desc") {
    params.delete("sort");
    params.delete("order");
  } else if (query.sort === "provider") {
    params.set("sort", "provider");
  }
  return params.toString();
}

function control(name: string): HTMLInputElement | HTMLSelectElement | null {
  return form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null;
}

function fillForm(): void {
  for (const name of FIELDS) {
    const element = control(name);
    if (!element) continue;
    const value = query[name];
    const text = value === undefined ? "" : Array.isArray(value) ? value.join(",") : String(value);
    // A shared link may carry a number of months the list does not offer: it gets its own option.
    if (element instanceof HTMLSelectElement && text && ![...element.options].some((option) => option.value === text)) {
      element.add(new Option(name === "max_age_months" ? `Last ${text} months` : text, text));
    }
    element.value = text;
  }
}

function readForm(): void {
  const params = new URLSearchParams(serializeQuery(query));
  for (const name of FIELDS) params.delete(name);
  for (const name of FIELDS) {
    let value = control(name)?.value.trim() ?? "";
    // "200,000" and "200 000" are accepted in the two number fields.
    if (name.startsWith("min_")) value = value.replace(/[\s,_.](?=\d{3}\b)/g, "");
    if (value) params.set(name, value);
  }
  params.set("sort", query.sort);
  params.set("order", query.order);
  params.set("limit", String(query.limit));
  const parsed = parseQuery(params, false);
  for (const name of FIELDS) control(name)?.removeAttribute("aria-invalid");
  if (!parsed.ok) {
    for (const error of parsed.errors) {
      control(error.param)?.setAttribute("aria-invalid", "true");
      params.delete(error.param);
    }
    const retry = parseQuery(params, false);
    if (retry.ok) query = retry.query;
    return;
  }
  query = parsed.query;
}

async function render(): Promise<void> {
  active?.abort();
  const request = new AbortController();
  active = request;
  const search = serializeQuery(query);
  const address = siteSearch();
  history.replaceState(null, "", address ? `?${address}` : location.pathname);
  const api = `/api/v1/entries${search ? `?${search}` : ""}`;
  apiLink.href = api;
  apiLink.textContent = api;
  apiCopy.dataset.copy = api;
  head.innerHTML = tableHead({ sortable: true, sort: query.sort, order: query.order });
  const sort = control("sort");
  const order = control("order");
  if (sort) sort.value = query.sort;
  if (order) order.value = query.order;
  table.setAttribute("aria-busy", "true");
  table.hidden = true;
  empty.hidden = true;
  failed.hidden = true;
  count.textContent = "Loading entries…";
  for (const link of [prev, next]) { link.removeAttribute("href"); link.setAttribute("aria-disabled", "true"); }
  try {
    const response = await fetch(api, { cache: "no-cache", signal: request.signal });
    if (!response.ok) throw new Error(String(response.status));
    const result = await response.json() as Envelope<Summary>;
    if (active !== request) return;
    // Reload the surrounding API-derived counts, filters and footer if publication changed.
    if (result.meta.dataset_version !== table.dataset.version || result.meta.generated_at !== table.dataset.publication) {
      location.reload();
      return;
    }
    rows.innerHTML = result.data.map((entry) => rowHtml(entry, { today, providerNames, imported: result.meta.upstream_fetched_at.slice(0, 10) })).join("");
    count.textContent = `${exact(result.total)} entries`;
    page.textContent = `Page ${Math.floor(result.offset / result.limit) + 1} of ${exact(Math.max(1, Math.ceil(result.total / result.limit)))}`;
    const linkTo = (link: HTMLAnchorElement, offset: number | null): void => {
      if (offset === null) return;
      link.removeAttribute("aria-disabled");
      link.href = `?${serializeQuery({ ...query, offset })}`;
    };
    linkTo(prev, result.offset > 0 ? Math.max(0, result.offset - result.limit) : null);
    linkTo(next, result.next_offset);
    empty.hidden = result.total > 0;
    table.hidden = result.total === 0;
  } catch {
    if (request.signal.aborted || active !== request) return;
    count.textContent = "Entries unavailable";
    failed.hidden = false;
  } finally {
    if (active === request) table.removeAttribute("aria-busy");
  }
}

function update(): void {
  readForm();
  query.offset = 0;
  void render();
}

let timer: number | undefined;
form.addEventListener("input", () => {
  clearTimeout(timer);
  timer = window.setTimeout(update, 120);
});
form.addEventListener("submit", (event) => {
  event.preventDefault();
  update();
});
form.addEventListener("reset", () => {
  window.setTimeout(() => {
    query = siteDefault();
    fillForm();
    void render();
  });
});
document.getElementById("empty-reset")?.addEventListener("click", () => form.reset());

head.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-sort]");
  if (!button) return;
  const key = button.dataset.sort as SortKey;
  // Numbers and dates are most useful largest or newest first.
  const firstOrder = key === "context" || key === "max_output" || key === "verified" || key === "release_date" ? "desc" : "asc"; // a price starts at the cheapest
  query.order = query.sort === key ? (query.order === "asc" ? "desc" : "asc") : firstOrder;
  query.sort = key;
  query.offset = 0;
  void render();
  head.querySelector<HTMLButtonElement>(`button[data-sort="${key}"]`)?.focus();
});

prev.addEventListener("click", (event) => {
  event.preventDefault();
  if (!prev.hasAttribute("href")) return;
  query.offset = Math.max(0, query.offset - query.limit);
  void render();
  table.scrollIntoView({ block: "start" });
});
next.addEventListener("click", (event) => {
  event.preventDefault();
  if (!next.hasAttribute("href")) return;
  query.offset += query.limit;
  void render();
  table.scrollIntoView({ block: "start" });
});

document.addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement;
  if (event.key !== "/" || event.metaKey || event.ctrlKey || /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
  event.preventDefault();
  control("q")?.focus();
});

document.getElementById("retry")?.addEventListener("click", () => { void render(); });
window.addEventListener("popstate", () => { query = readUrl(); fillForm(); void render(); });
fillForm();
// The first filtered page is already rendered from the API. No second fetch on hydration.
