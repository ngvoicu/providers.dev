// The safe value of a quantity as a page prints it, and the warning where its sources disagree
// (design/sources-side-by-side.md, section 8). One value per quantity: `value` of its key of `safe`, formatted, "at
// least" where `at_least`, Unknown where it is null; no source, no basis and no date beside it. The warning is
// `agreement: "differ"` and nothing else (for the price, the parts of `differs`), and its list prints `sources` item by
// item, in the API's order. Nothing here compares, picks or works out a value.
//
// The warning is a button that opens a popover: it works with a click, a tap, Enter or Space without any script, and
// `src/client/warnings.ts` places it beside its sign and also opens it on hover. In the top layer, a table that scrolls
// sideways does not clip it.
import { compactTokens, compactTokensDown, duration, escapeHtml as e, exact, isStale, plural, shortAge, usdUnrounded, type Today } from "./format.ts";
import type { PricePart, PriceStatement, PriceTier, SafePrice, SafeQuantity, SafeValue, SourceValue, ValueSource } from "./safe.ts";

/** The warning's name, on the sign for a screen reader and at the head of its list. */
export const WARNING = "Not all sources agree";
/** The four sources, as a page names them. */
export const SOURCE_NAME: Readonly<Record<ValueSource, string>> = { measured: "Measured", "providers.dev": "providers.dev", "models.dev": "models.dev", "pi.dev": "pi.dev" };
/** Each safe quantity as a page labels it. The input window is the page's "Context window". */
export const QUANTITY_LABEL: Readonly<Record<SafeQuantity, string>> = {
  input_window: "Context window",
  max_output: "Maximum output",
  cache_short: "Cache lifetime, short",
  cache_long: "Cache lifetime, long",
  price: "Price",
};
/** A part of a price, as the price table labels its row. */
export const PART_LABEL: Readonly<Record<PricePart, string>> = {
  input: "Input",
  output: "Output",
  cache_read: "Cache read",
  cache_write: "Cache write",
  tiers: "Tiers by size of request",
  other: "Other rates",
};
const METHOD = "/docs/methodology/#safe-values";

/** A span of time, as a lifetime or an age: "2.5 min", "1 h 15 min", "24 h" (never "1 d": caches are counted in hours). */
export const span = (seconds: number): string => (seconds > 0 && seconds % 86400 === 0 ? shortAge(seconds) : duration(seconds));
/** A lifetime as a page prints it: 0 is None, whatever the source; the exact seconds go in a title. */
export const lifetimeWords = (seconds: number): string => (seconds === 0 ? "None" : span(seconds));

const UNKNOWN_VALUE = '<span class="unknown">Unknown</span>';

/** The value of a number quantity, exact, as an entry's page prints it: "at least 921,500 tokens", "5 min", "None". */
export function safeText(safe: Pick<SafeValue, "value" | "at_least" | "unit">): string {
  if (safe.value === null) return UNKNOWN_VALUE;
  if (safe.unit === "seconds") return `<span title="${exact(safe.value)} s">${lifetimeWords(safe.value)}</span>`;
  return `${safe.at_least ? '<span class="bound">at least</span> ' : ""}${exact(safe.value)} <span class="unit">tokens</span>`;
}

/** The value of a number quantity in a list: compact, "≥" and rounded down where it is a lower bound. */
export function safeCompact(safe: Pick<SafeValue, "value" | "at_least" | "unit">): string {
  if (safe.value === null) return "Unknown";
  if (safe.unit === "seconds") return lifetimeWords(safe.value);
  return safe.at_least ? `≥ ${compactTokensDown(safe.value)}` : compactTokens(safe.value);
}

/** The value in words, for a title: "at least 921,500 tokens", "300 s". */
export function safeTitle(safe: Pick<SafeValue, "value" | "at_least" | "unit" | "window_tokens">): string {
  if (safe.value === null) return "Unknown: no source states a value.";
  if (safe.unit === "seconds") return safe.value === 0 ? "None: 0 s." : `${exact(safe.value)} s.`;
  const note = safe.window_tokens === null ? "" : ` ${windowNote(safe.window_tokens)}.`;
  return `${safe.at_least ? "At least " : ""}${exact(safe.value)} tokens.${note}`;
}

/** The note under the context window, where the entry states a larger window the response shares: `window_tokens`. */
export const windowNote = (tokens: number): string => `${exact(tokens)} including the response`;

/** An id for a warning's list: ids hold no white space, and the same quantity can warn twice on one page (a tile and a row). */
export const warnId = (...parts: string[]): string => `warn-${parts.join("-").replace(/\s+/g, "_")}`;

const SIGN = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path class="tri" d="M7.13 1.98a1 1 0 0 1 1.74 0l6.2 11.03A1 1 0 0 1 14.2 14.5H1.8a1 1 0 0 1-.87-1.49z"/><path class="bang" d="M8 5.6v4.1M8 11.9v.05"/></svg>';

/**
 * The warning: a sign, and the list it opens, right after it so that Tab goes from the sign into its links. `what` is
 * the quantity or the part the list is about.
 */
function warning(id: string, what: string, lines: string): string {
  return `<button type="button" class="warn-sign" popovertarget="${e(id)}" aria-label="${WARNING}: ${e(what)}">${SIGN}</button><div class="warn-tip" id="${e(id)}" popover><p class="warn-head"><span class="warn-title">${WARNING}</span><span class="warn-what">${e(what)}</span></p><ul class="warn-lines">${lines}</ul><p class="warn-foot"><a href="${METHOD}">How a value is chosen</a></p></div>`;
}

/** A source's date: a providers.dev date (its evidence, or a measurement) is marked stale after the published threshold. */
function dateOf(source: ValueSource, date: string | null, today: Today): string {
  if (date === null) return '<span class="warn-date muted">Date unknown</span>';
  const ours = source === "measured" || source === "providers.dev";
  return ours && isStale(date, today)
    ? `<span class="warn-date stale" title="More than ${plural(today.stale_after_days, "day")} ago.">${e(date)} · stale</span>`
    : `<span class="warn-date">${e(date)}</span>`;
}

/** One line of the list: the source, its value, its date; under it, what a measurement went through and where its result is. */
function line(source: ValueSource, value: string, date: string | null, today: Today, shown: boolean, sub: string[] = []): string {
  const rest = sub.filter(Boolean);
  return `<li${shown ? ' class="shown"' : ""}><span class="warn-src">${SOURCE_NAME[source]}</span><span class="warn-val">${value}${shown ? '<span class="sr-only"> (the value on this page)</span>' : ""}</span>${dateOf(source, date, today)}${rest.length ? `<span class="warn-sub">${rest.join(" · ")}</span>` : ""}</li>`;
}

const link = (url: string | null, words: string): string => (url ? `<a href="${e(url)}" rel="noopener">${words}</a>` : "");

/** What one source states of a number quantity, as its line says it: the value as the cell writes it, "Unknown" where withheld. */
function sourceLine(item: SourceValue, unit: SafeValue["unit"], shown: boolean, today: Today): string {
  const value = item.withheld ? "Unknown" : item.value === null ? "Unknown" : unit === "seconds" ? lifetimeWords(item.value) : `${item.at_least ? "at least " : ""}${exact(item.value)} tokens`;
  if (item.source === "measured") {
    const below = item.below === null ? "" : unit === "tokens" ? `${exact(item.below)} refused` : `first miss at ${span(item.below)}`;
    return line(item.source, value, item.date, today, shown, [item.client_label ? e(item.client_label) : "", below, link(item.evidence_url, "Raw result")]);
  }
  return line(item.source, value, item.date, today, shown, [link(item.evidence_url, "Evidence")]);
}

/** The warning of a number quantity where its sources disagree, and nothing where they do not. */
export function safeWarning(safe: SafeValue, quantity: Exclude<SafeQuantity, "price">, id: string, today: Today): string {
  if (safe.agreement !== "differ") return "";
  return warning(id, QUANTITY_LABEL[quantity], safe.sources.map((item) => sourceLine(item, safe.unit, item.source === safe.source, today)).join(""));
}

// ---- the price: whose price `pricing` is, and each source's price beside it, in the parts sources are compared on

const dollars = (value: number | null): string => (value === null ? '<span class="muted">Not stated</span>' : `${usdUnrounded(value)} <span class="unit">/ 1M</span>`);
const TIER_PARTS = [["input", "input"], ["output", "output"], ["cache_read", "cache read"], ["cache_write", "cache write"]] as const;

/** A source's tiers by size of request, one per line: "Above 200,000: input $4, output $18". */
function tiersText(tiers: readonly PriceTier[] | null): string {
  if (tiers === null) return '<span class="muted">Not readable as tiers</span>';
  if (tiers.length === 0) return "None";
  return `<span class="warn-tiers">${tiers.map((tier) => `<span>Above ${exact(tier.input_tokens_above)}: ${TIER_PARTS.filter(([key]) => tier[key] !== null).map(([key, label]) => `${label} ${usdUnrounded(tier[key]!)}`).join(", ")}</span>`).join("")}</span>`;
}

/** One source's statement of one part of the price, as its line says it. */
function partLine(item: PriceStatement, part: PricePart, shown: boolean, today: Today): string {
  const evidence = [link(item.evidence_url, "Evidence")];
  if (item.withheld) return line(item.source, "Unknown", item.date, today, shown, evidence);
  if (part === "tiers") return line(item.source, tiersText(item.tiers), item.date, today, shown, evidence);
  if (part === "other") return line(item.source, item.source === "providers.dev" ? "As corrected" : "As imported", item.date, today, shown, evidence);
  return line(item.source, dollars(item[part]), item.date, today, shown, evidence);
}

/** The lines of some parts of the price: under a heading per part where there are several. `other` is compared between providers.dev and models.dev only. */
function priceLines(price: SafePrice, parts: readonly PricePart[], today: Today): string {
  return parts
    .map((part) => {
      const items = price.sources.filter((item) => part !== "other" || item.source !== "pi.dev");
      const head = parts.length > 1 ? `<li class="warn-part">${PART_LABEL[part]}</li>` : "";
      return head + items.map((item) => partLine(item, part, item.source === price.source, today)).join("");
    })
    .join("");
}

/**
 * The warning of the price where its sources disagree on one of `parts` (the parts of `differs` a place shows), and
 * nothing elsewhere. Its list prints those parts of every source's price.
 */
export function priceWarning(price: SafePrice, parts: readonly PricePart[], what: string, id: string, today: Today): string {
  const shown = parts.filter((part) => price.differs.includes(part));
  if (price.agreement !== "differ" || shown.length === 0) return "";
  return warning(id, what, priceLines(price, shown, today));
}

/** The warning of the price as a whole, where `price` is in `differing`: every part of `differs`. A list's cell and the tile. */
export function wholePriceWarning(price: SafePrice, id: string, today: Today): string {
  return priceWarning(price, price.differs, QUANTITY_LABEL.price, id, today);
}
