// One safe value per quantity (design/sources-side-by-side.md): the input window, the maximum output, the short and
// the long cache lifetime and the price, each from the first source in one order that states a value, with what every
// source states beside it. Worked out once, when the data is built; `mirror` copies it into the records that carried
// the safe values before (`limits.input_window`, `cache.lifetime`). A page prints `safe` and applies no rule.
// Pure: no file, no network, no clock. Imports nothing of pi's.
import { evaluationLifetime, byCharacters, type CacheEvaluation, type RetentionProfile } from "./cache.ts";
import { windowContradicts, type DocumentedField, type InputWindowMeasurement } from "./limits.ts";
import type { MeasuredLimit, ModelExtension } from "./schema.ts";

export const VALUE_SOURCES = ["measured", "providers.dev", "models.dev", "pi.dev"] as const;
export type ValueSource = (typeof VALUE_SOURCES)[number];
export const SAFE_QUANTITIES = ["input_window", "max_output", "cache_short", "cache_long", "price"] as const;
export type SafeQuantity = (typeof SAFE_QUANTITIES)[number];
export type Agreement = "agree" | "differ" | "single" | "none";
/** How a measurement's client reaches the provider (2.3). The labels file writes `own-client`. */
export const CLIENT_KINDS = ["direct", "own_client", "proxy"] as const;
export type ClientKind = (typeof CLIENT_KINDS)[number];
/** How an entry is reached, as `providers_dev.access` says. */
export type EntryAccess = "api" | "subscription" | "unknown";

/** What one source states of one quantity. */
export interface SourceValue {
  source: ValueSource;
  /** The number it states. Null exactly when `withheld`. */
  value: number | null;
  /** providers.dev publishes the value as unknown on purpose. False on every other source. */
  withheld: boolean;
  /** A measured lower bound: the real value is this or more. */
  at_least: boolean;
  /** Measured: the smallest value seen to fail (an input refused, an age with a miss). Null = none seen, and on every other source. */
  below: number | null;
  /** Input window only: a cap on the input, or a window input and output share. Null on every other quantity. */
  scope: "input" | "window" | null;
  date: string | null;
  /** providers.dev: the evidence it rests on. Measured: the raw result of the evaluation it names. Null on the two catalogs. */
  evidence_url: string | null;
  /** Measured: the public id of the client the evaluation went through. Null on every other source. */
  client: string | null;
  /** Measured: that client's public label. */
  client_label: string | null;
  /** Measured: that client's kind (2.3). */
  client_kind: ClientKind | null;
  /** Measured: the id of the cache evaluation that gives the value. Null for a limit evaluation, which has none, and on every other source. */
  evaluation_id: string | null;
}

/** The safe value of one quantity and every statement it was chosen from. */
export interface SafeValue {
  value: number | null;
  unit: "tokens" | "seconds";
  at_least: boolean;
  scope: "input" | "window" | null;
  /**
   * Input window only: the window the input shares with the answer, where the entry states one above `value` (its
   * published `limit.context`, not a measured one). Null where it states none or none larger, and on every other quantity.
   */
  window_tokens: number | null;
  source: ValueSource | null;
  date: string | null;
  agreement: Agreement;
  /** One item per source that states something, in the order of the sources. Empty = none does. */
  sources: SourceValue[];
}

export interface PriceTier {
  input_tokens_above: number;
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cache_write: number | null;
}
export const PRICE_PARTS = ["input", "output", "cache_read", "cache_write", "tiers", "other"] as const;
export type PricePart = (typeof PRICE_PARTS)[number];

/** What one source states of the price, in the parts sources are compared on (US dollars per million tokens). */
export interface PriceStatement {
  source: Exclude<ValueSource, "measured">;
  withheld: boolean;
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cache_write: number | null;
  /** Null = its tiers cannot be read as tiers, or withheld. Empty = it states a price and no tier. */
  tiers: PriceTier[] | null;
  date: string | null;
  evidence_url: string | null;
}

/** Whose price `pricing` is, and every source's price beside it. The price itself is `pricing`, whole. */
export interface SafePrice {
  source: Exclude<ValueSource, "measured"> | null;
  date: string | null;
  agreement: Agreement;
  /** The parts on which two sources contradict each other, in the order of PRICE_PARTS. Empty unless `differ`. */
  differs: PricePart[];
  sources: PriceStatement[];
}

export interface SafeValues {
  input_window: SafeValue;
  max_output: SafeValue;
  cache_short: SafeValue;
  cache_long: SafeValue;
  price: SafePrice;
  /** The quantities whose agreement is `differ`, in the order of SAFE_QUANTITIES. Empty = no warning on the entry. */
  differing: SafeQuantity[];
}

// ---- which measurement counts (2.3)

/** The kinds whose measurements count on an entry, in order. An API-key entry (and one of unknown access): direct only. */
export function kindOrder(access: EntryAccess): readonly ClientKind[] {
  return access === "subscription" ? ["own_client", "direct", "proxy"] : ["direct"];
}

/**
 * The kind of client whose measurements give the measured statement of one quantity (2.3): the first kind of the
 * entry's order among the kinds that gave the quantity a value. Null = none of them did: no measured statement.
 */
export function countingKind(access: EntryAccess, kinds: Iterable<ClientKind | null>): ClientKind | null {
  const present = new Set(kinds);
  return kindOrder(access).find((kind) => present.has(kind)) ?? null;
}

const statement = (source: ValueSource, more: Partial<SourceValue>): SourceValue => ({
  source,
  value: null,
  withheld: false,
  at_least: false,
  below: null,
  scope: null,
  date: null,
  evidence_url: null,
  client: null,
  client_label: null,
  client_kind: null,
  evaluation_id: null,
  ...more,
});

/** The measured statement of the input window, and the counted evaluations that give it (`chosen`). */
export interface MeasuredWindow {
  statement: SourceValue;
  items: InputWindowMeasurement[];
}

/**
 * The measured statement of the input window, from the items of `measurements` that are `chosen`: the first of them,
 * which is the lowest (the order of `measurements`). Null = none is chosen.
 */
export function measuredWindow(measurements: readonly InputWindowMeasurement[]): MeasuredWindow | null {
  const items = measurements.filter((item) => item.chosen);
  const first = items[0];
  if (!first) return null;
  return {
    statement: statement("measured", {
      value: first.tokens,
      at_least: first.bound === "at_least",
      below: first.kind === "bracket" ? first.refused : null,
      scope: first.kind === "window" ? "window" : "input",
      date: first.date,
      evidence_url: first.source,
      client: first.client,
      client_label: first.client_label,
      client_kind: first.client_kind,
    }),
    items,
  };
}

/**
 * The measured statement of the maximum output: the lowest `output` above 0 of the limit evaluations of the kind that
 * counts, exact; among equals the first in the order of `limits.measured`. Null = none gives one.
 */
export function measuredOutput(access: EntryAccess, limits: readonly MeasuredLimit[]): SourceValue | null {
  const giving = limits.filter((limit) => typeof limit.output === "number" && limit.output > 0);
  const kind = countingKind(access, giving.map((limit) => limit.client_kind));
  const counted = giving.filter((limit) => kind !== null && limit.client_kind === kind);
  const lowest = counted.reduce<MeasuredLimit | null>((best, limit) => (best === null || limit.output! < best.output! ? limit : best), null);
  if (!lowest) return null;
  return statement("measured", {
    value: lowest.output,
    date: lowest.date,
    evidence_url: lowest.source,
    client: lowest.client,
    client_label: lowest.client_label,
    client_kind: lowest.client_kind,
  });
}

/**
 * The measured statement of one lifetime profile: over the counted evaluations of the profile made with a client of
 * `kind`, the lowest strict value (`evaluationLifetime`), never a lower bound; `below` the youngest age with a miss
 * among them. It names the evaluation with the lowest value, among equals the newest, then the first by id. Null =
 * no kind, or no counted evaluation of it.
 */
export function measuredLifetime(evaluations: readonly CacheEvaluation[], profile: RetentionProfile, kind: ClientKind | null): SourceValue | null {
  if (kind === null) return null;
  const counted = evaluations.flatMap((evaluation) => {
    if (evaluation.retention_profile !== profile || evaluation.client_kind !== kind) return [];
    const lifetime = evaluationLifetime(evaluation);
    return lifetime ? [{ evaluation, lifetime }] : [];
  });
  if (counted.length === 0) return null;
  const named = [...counted].sort((a, b) => a.lifetime.safe_s - b.lifetime.safe_s || byCharacters(b.evaluation.date, a.evaluation.date) || byCharacters(a.evaluation.id, b.evaluation.id))[0]!;
  const misses = counted.map((member) => member.lifetime.first_miss_s).filter((age): age is number => age !== null);
  return statement("measured", {
    value: named.lifetime.safe_s,
    below: misses.length > 0 ? Math.min(...misses) : null,
    date: named.evaluation.date,
    evidence_url: named.evaluation.source,
    client: named.evaluation.client,
    client_label: named.evaluation.client_label,
    client_kind: named.evaluation.client_kind,
    evaluation_id: named.evaluation.id,
  });
}

// ---- what the two catalogs of the reference state (2.3): one reading of an entry, made twice

/** A price in the parts sources are compared on, and the rest of it (`other`), as plain data. */
export interface PriceParts {
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cache_write: number | null;
  tiers: PriceTier[] | null;
  /** Every rule of the price that is no base price and no tier of the four meters. Compared as a whole. */
  other: unknown[];
}

/** What one reading of an entry gives (2.3, the table of the reading). Null = it states nothing of the quantity. */
export interface EntryReading {
  input_window: { value: number; field: DocumentedField } | null;
  max_output: number | null;
  cache_short: number | null;
  cache_long: number | null;
  /** The price, and its rules whole, compared to tell the two readings apart. */
  price: { parts: PriceParts; rules: unknown } | null;
}

/** The date of a statement of providers.dev, and the evidence that gives it. */
export interface Dated {
  date: string | null;
  evidence_url: string | null;
}

/** Everything `safeValues` reads of one entry. Plain data, made by `resolve()`. */
export interface SafeFacts {
  access: EntryAccess;
  /**
   * The entry as imported from models.dev, read before any override. Every quantity null on an entry providers.dev
   * adds, except the price of a subscription entry, which is that of the API entry it refers to.
   */
  imported: EntryReading;
  /** The entry as published, read after every override. */
  published: EntryReading;
  /** providers.dev's date and evidence for each quantity it states (2.3). */
  own: Record<SafeQuantity, Dated>;
  /** The date of the models.dev import. */
  imported_date: string | null;
  measured: {
    input_window: MeasuredWindow | null;
    max_output: SourceValue | null;
    cache_short: SourceValue | null;
    cache_long: SourceValue | null;
  };
  /** The entry's published `limit.context` above 0 that is not a measured value. Null = none. */
  context: number | null;
}

type NumberQuantity = Exclude<SafeQuantity, "price">;

const sameReading = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The statements of providers.dev and models.dev of one number quantity, from the two readings (2.3). */
function catalogStatements(facts: SafeFacts, quantity: NumberQuantity): SourceValue[] {
  const read = (reading: EntryReading): { value: number; scope: "input" | "window" | null } | null => {
    if (quantity === "input_window") {
      const window = reading.input_window;
      return window ? { value: window.value, scope: window.field === "limit.input" ? "input" : "window" } : null;
    }
    const value = reading[quantity];
    return value === null ? null : { value, scope: null };
  };
  const imported = read(facts.imported);
  const published = read(facts.published);
  const out: SourceValue[] = [];
  if (!sameReading(imported, published)) {
    const own = facts.own[quantity];
    out.push(
      published
        ? statement("providers.dev", { value: published.value, scope: published.scope, date: own.date, evidence_url: own.evidence_url })
        : statement("providers.dev", { withheld: true, date: own.date, evidence_url: own.evidence_url }),
    );
  }
  if (imported) out.push(statement("models.dev", { value: imported.value, scope: imported.scope, date: facts.imported_date }));
  return out;
}

// ---- the rule (2.4) and agreement (2.5)

/** Whether two statements of one number quantity contradict each other (2.5). `a` comes before `b` in the order. */
function contradicts(quantity: NumberQuantity, a: SourceValue, b: SourceValue, chosen: readonly InputWindowMeasurement[]): boolean {
  if (a.withheld || b.withheld) {
    // Withholding contradicts every later stated value; a measurement does not contradict a withheld one.
    const withheld = a.withheld ? a : b;
    const other = a.withheld ? b : a;
    return other.source !== "measured" && !other.withheld && withheld === a;
  }
  const x = a.value!;
  const y = b.value!;
  if (quantity === "input_window") {
    const measured = a.source === "measured" ? a : b.source === "measured" ? b : null;
    if (measured) {
      const stated = measured === a ? b : a;
      const field: DocumentedField = stated.scope === "input" ? "limit.input" : "limit.context";
      return chosen.some((item) => windowContradicts(item, stated.value!, field));
    }
    if (a.scope === b.scope) return x !== y;
    // A cap and a window: the cap contradicts only where it is above the window.
    const cap = a.scope === "input" ? x : y;
    const window = a.scope === "input" ? y : x;
    return cap > window;
  }
  if (quantity === "cache_short" || quantity === "cache_long") {
    const measured = a.source === "measured" ? a : b.source === "measured" ? b : null;
    if (measured) {
      const stated = (measured === a ? b : a).value!;
      const m = measured.value!;
      const f = measured.below;
      return stated < m || (f !== null && stated >= f);
    }
  }
  return x !== y;
}

function agreementOf<T>(items: readonly T[], clash: (a: T, b: T) => boolean): Agreement {
  if (items.length === 0) return "none";
  if (items.length === 1) return "single";
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) if (clash(items[i]!, items[j]!)) return "differ";
  }
  return "agree";
}

/**
 * The safe value of one number quantity from its statements, in the order of the sources (2.4, 2.5). `chosen`: for a
 * measured input window, the counted evaluations of the kind that counts, which the test of agreement reads.
 */
export function safeNumber(quantity: NumberQuantity, sources: readonly SourceValue[], chosen: readonly InputWindowMeasurement[] = [], context: number | null = null): SafeValue {
  const list = [...sources].sort((a, b) => VALUE_SOURCES.indexOf(a.source) - VALUE_SOURCES.indexOf(b.source));
  let picked = list[0];
  // The refinement (2.4): a window first, and a later cap that is not above it: the cap.
  if (quantity === "input_window" && picked && !picked.withheld && picked.scope === "window") {
    const window = picked.value!;
    picked = list.slice(1).find((item) => !item.withheld && item.scope === "input" && item.value! <= window) ?? picked;
  }
  const value = picked && !picked.withheld ? picked.value : null;
  return {
    value,
    unit: quantity === "cache_short" || quantity === "cache_long" ? "seconds" : "tokens",
    at_least: value !== null && picked!.at_least,
    scope: value !== null ? picked!.scope : null,
    window_tokens: quantity === "input_window" && value !== null && context !== null && context > value ? context : null,
    source: picked?.source ?? null,
    date: picked?.date ?? null,
    agreement: agreementOf(list, (a, b) => contradicts(quantity, a, b, chosen)),
    sources: list,
  };
}

// ---- the price (2.4, 2.6)

/** The parts of two prices that contradict, in the order of PRICE_PARTS (2.6). */
function priceClash(a: PriceStatement & { other: unknown[] | null }, b: PriceStatement & { other: unknown[] | null }): PricePart[] {
  if (a.withheld || b.withheld) {
    const stated = a.withheld ? b : a;
    const out: PricePart[] = [];
    for (const part of ["input", "output", "cache_read", "cache_write"] as const) if (stated[part] !== null) out.push(part);
    if (stated.tiers !== null && stated.tiers.length > 0) out.push("tiers");
    if (stated.other !== null && stated.other.length > 0) out.push("other");
    return out;
  }
  const out: PricePart[] = [];
  for (const part of ["input", "output", "cache_read", "cache_write"] as const) {
    if (a[part] !== null && b[part] !== null && a[part] !== b[part]) out.push(part);
  }
  if (a.tiers !== null && b.tiers !== null && !tiersAgree(a.tiers, b.tiers)) out.push("tiers");
  if (a.other !== null && b.other !== null && !sameReading(a.other, b.other)) out.push("other");
  return out;
}

/** Two lists of tiers agree: the same thresholds, and every price both state equal. */
export function tiersAgree(a: readonly PriceTier[], b: readonly PriceTier[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((tier, index) => {
    const other = b[index]!;
    if (tier.input_tokens_above !== other.input_tokens_above) return false;
    return (["input", "output", "cache_read", "cache_write"] as const).every((part) => tier[part] === null || other[part] === null || tier[part] === other[part]);
  });
}

function safePrice(facts: SafeFacts): SafePrice {
  const imported = facts.imported.price;
  const published = facts.published.price;
  const of = (source: PriceStatement["source"], parts: PriceParts | null, dated: Dated): PriceStatement & { other: unknown[] | null } => ({
    source,
    withheld: parts === null,
    input: parts?.input ?? null,
    output: parts?.output ?? null,
    cache_read: parts?.cache_read ?? null,
    cache_write: parts?.cache_write ?? null,
    tiers: parts ? parts.tiers : null,
    date: dated.date,
    evidence_url: dated.evidence_url,
    other: parts?.other ?? null,
  });
  const items: (PriceStatement & { other: unknown[] | null })[] = [];
  if (!sameReading(imported?.rules ?? null, published?.rules ?? null)) items.push(of("providers.dev", published?.parts ?? null, facts.own.price));
  if (imported) items.push(of("models.dev", imported.parts, { date: facts.imported_date, evidence_url: null }));
  const differs = new Set<PricePart>();
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) for (const part of priceClash(items[i]!, items[j]!)) differs.add(part);
  }
  const first = items[0];
  return {
    source: first?.source ?? null,
    date: first?.date ?? null,
    agreement: items.length === 0 ? "none" : items.length === 1 ? "single" : differs.size > 0 ? "differ" : "agree",
    differs: PRICE_PARTS.filter((part) => differs.has(part)),
    sources: items.map(({ other: _other, ...item }) => item),
  };
}

/**
 * The safe values of one entry (2.3 to 2.6), from the three sources of the reference: what providers.dev measured,
 * what it states of its own, and models.dev. pi's statements are laid over them after the fence (section 4).
 */
export function safeValues(facts: SafeFacts): SafeValues {
  const numbers = (quantity: NumberQuantity): SafeValue => {
    const measured = quantity === "input_window" ? facts.measured.input_window?.statement ?? null : facts.measured[quantity];
    const sources = [...(measured ? [measured] : []), ...catalogStatements(facts, quantity)];
    return safeNumber(quantity, sources, facts.measured.input_window?.items ?? [], quantity === "input_window" ? facts.context : null);
  };
  const safe = {
    input_window: numbers("input_window"),
    max_output: numbers("max_output"),
    cache_short: numbers("cache_short"),
    cache_long: numbers("cache_long"),
    price: safePrice(facts),
  };
  return { ...safe, differing: SAFE_QUANTITIES.filter((quantity) => safe[quantity].agreement === "differ") };
}

// ---- the copies (5.2)

const basisOf = (safe: SafeValue): "measured" | "documented" | "none" => (safe.value === null ? "none" : safe.source === "measured" ? "measured" : "documented");
const recordSource = (safe: SafeValue): "providers.dev" | "models.dev" | "pi.dev" | null =>
  safe.value === null || safe.source === null ? null : safe.source === "measured" ? "providers.dev" : safe.source;

/**
 * Copy the safe values of an entry into the records that carried them (5.2): the input window and the two lifetime
 * profiles. Nothing else writes these keys. Returns the same object.
 */
export function mirror(extension: ModelExtension): ModelExtension {
  const { safe } = extension;
  const window = extension.limits.input_window;
  const input = safe.input_window;
  window.tokens = input.value;
  window.basis = basisOf(input);
  window.bound = input.value === null ? null : input.at_least ? "at_least" : "limit";
  window.scope = input.value === null ? null : input.scope;
  window.source = recordSource(input);
  window.date = input.value === null ? null : input.date;
  for (const [profile, key] of [["short", "cache_short"], ["long", "cache_long"]] as const) {
    const record = extension.cache.lifetime[profile];
    const value = safe[key];
    record.safe_s = value.value;
    record.basis = basisOf(value);
    record.source = recordSource(value);
    record.date = value.value === null ? null : value.date;
  }
  return extension;
}

/** The safe values of an entry no source states anything about. */
export function emptySafeValues(): SafeValues {
  const none = (unit: SafeValue["unit"]): SafeValue => ({ value: null, unit, at_least: false, scope: null, window_tokens: null, source: null, date: null, agreement: "none", sources: [] });
  return {
    input_window: none("tokens"),
    max_output: none("tokens"),
    cache_short: none("seconds"),
    cache_long: none("seconds"),
    price: { source: null, date: null, agreement: "none", differs: [], sources: [] },
    differing: [],
  };
}
