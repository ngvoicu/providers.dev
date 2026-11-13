// The catalog table. It downloads the same index the API answers from and runs the same query code,
// and it keeps the filters in the URL so a view can be shared.
import type { Index } from "../core/entries.ts";
import { exact, importDate } from "../core/format.ts";
import { parseQuery, runQuery, serializeQuery, SITE_DEFAULT, utcToday, type Query, type SortKey } from "../core/query.ts";
import { rowHtml, tableHead } from "../core/render.ts";

const form = document.getElementById("filters") as HTMLFormElement;
const table = document.getElementById("entries") as HTMLTableElement;
const head = document.getElementById("head") as HTMLElement;
const rows = document.getElementById("rows") as HTMLElement;
const count = document.getElementById("count") as HTMLElement;
const page = document.getElementById("page") as HTMLElement;
const prev = document.getElementById("prev") as HTMLButtonElement;
const next = document.getElementById("next") as HTMLButtonElement;
const empty = document.getElementById("empty") as HTMLElement;
const failed = document.getElementById("failed") as HTMLElement;
const apiLink = document.getElementById("api-link") as HTMLAnchorElement;
const apiCopy = document.getElementById("api-copy") as HTMLButtonElement;
const now = new Date(table.dataset.now ?? Date.now());

const FIELDS = ["q", "provider", "access", "type", "cache", "cache_mode", "origin", "min_context", "min_output", "max_age_months", "measured"] as const;

let index: Index | undefined;
let providerNames: Record<string, string> = {};
let query: Query = readUrl();

const siteDefault = (): Query => {
  const parsed = parseQuery(new URLSearchParams(SITE_DEFAULT), false);
  if (!parsed.ok) throw new Error("SITE_DEFAULT is not a valid query");
  return parsed.query;
};

function readUrl(): Query {
  const params = new URLSearchParams(location.search);
  // Without a sort in the address, the site's own order applies (our evidence first).
  if (!params.has("sort")) for (const [name, value] of new URLSearchParams(SITE_DEFAULT)) params.set(name, value);
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
    if (name === "max_age_months" && element instanceof HTMLSelectElement && text && ![...element.options].some((option) => option.value === text)) {
      element.add(new Option(`Last ${text} months`, text));
    }
    element.value = text;
  }
}

function readForm(): void {
  const params = new URLSearchParams();
  for (const name of FIELDS) {
    let value = control(name)?.value.trim() ?? "";
    // "200,000" and "200 000" are accepted in the two number fields.
    if (name.startsWith("min_")) value = value.replace(/[\s,_.](?=\d{3}\b)/g, "");
    if (value) params.set(name, value);
  }
  params.set("sort", query.sort);
  params.set("order", query.order);
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

function render(): void {
  const search = serializeQuery(query);
  const address = siteSearch();
  history.replaceState(null, "", address ? `?${address}` : location.pathname);
  const api = `/api/v1/models${search ? `?${search}` : ""}`;
  apiLink.href = api;
  apiLink.innerHTML = `<code>${api.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</code>`;
  apiCopy.dataset.copy = api;
  head.innerHTML = tableHead({ sortable: true, sort: query.sort, order: query.order });
  if (!index) return;

  const result = runQuery(index.entries, query, utcToday());
  const imported = importDate(index);
  rows.innerHTML = result.data.map((entry) => rowHtml(entry, { now, providerNames, ...(imported ? { imported } : {}) })).join("");
  const all = index.entries.length;
  count.textContent = result.total === all ? `${exact(all)} entries` : `${exact(result.total)} of ${exact(all)} entries`;
  const pages = Math.max(1, Math.ceil(result.total / query.limit));
  page.textContent = `Page ${Math.floor(query.offset / query.limit) + 1} of ${exact(pages)}`;
  prev.disabled = query.offset === 0;
  next.disabled = result.next_offset === null;
  empty.hidden = result.total > 0;
  table.hidden = result.total === 0;
}

function update(): void {
  readForm();
  query.offset = 0;
  render();
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
    render();
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
  render();
  head.querySelector<HTMLButtonElement>(`button[data-sort="${key}"]`)?.focus();
});

prev.addEventListener("click", () => {
  query.offset = Math.max(0, query.offset - query.limit);
  render();
  table.scrollIntoView({ block: "start" });
});
next.addEventListener("click", () => {
  query.offset += query.limit;
  render();
  table.scrollIntoView({ block: "start" });
});

document.addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement;
  if (event.key !== "/" || event.metaKey || event.ctrlKey || /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
  event.preventDefault();
  control("q")?.focus();
});

async function load(): Promise<void> {
  failed.hidden = true;
  try {
    // Ask the server every time whether the data changed (it answers 304 when not): a stored copy must never show an old table.
    const response = await fetch("/data/index.json", { cache: "no-cache" });
    if (!response.ok) throw new Error(String(response.status));
    index = (await response.json()) as Index;
    providerNames = Object.fromEntries(index.providers.map((provider) => [provider.id, provider.name]));
    table.hidden = false;
    render();
  } catch {
    // The rows built ahead of time stay visible when the URL has no filters; otherwise say what happened.
    if (siteSearch()) table.hidden = true;
    failed.hidden = false;
  }
}
document.getElementById("retry")?.addEventListener("click", load);

fillForm();
render();
void load();
