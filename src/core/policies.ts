// Normalize once at publication. Pages and API responses use these objects without interpreting source rules again.
import { durationSeconds, type CacheRetention } from "./cache.ts";
import { isObject, type Json, type JsonObject } from "./merge.ts";
import type { Condition, PolicyEvidence, Pricing, PricingInput, PricingRule, PricingRuleInput, RequestControl, RequestControls, ResultingRate } from "./policy-contract.ts";

// The condition keys of models.dev's cost schema (`CostConditionKeyV2Values`), as fields of a request.
const fields: Record<string, string> = {
  context: "request.context_tokens", service_tier: "request.service_tier", region: "request.region", date: "request.date", utc_hours: "request.utc_hours", utc_days: "request.utc_days", holiday: "request.holiday", thinking: "request.thinking",
  // What a request for an image, a video, speech or a transcription can ask for, and a web search with it.
  ...Object.fromEntries(["duration", "megapixels", "input_images", "resolution", "quality", "aspect_ratio", "generate_audio", "mode", "input_video", "fps", "steps", "search_context_size", "speaker_labels", "keyterms_prompt", "domain", "websocket", "style", "voice_control"].map((key) => [key, `request.${key}`])),
};
const operators = { equals: "eq", in: "in", gt: "gt", gte: "gte", lt: "lt", lte: "lte", min_items: "min_items" } as const;
const unknown = (raw: Json): Condition => ({ kind: "unknown", raw });
const and = (...values: (Condition | null)[]): Condition | null => {
  const conditions = values.filter((value): value is Condition => value !== null);
  return conditions.length === 0 ? null : conditions.length === 1 ? conditions[0]! : { kind: "all", conditions };
};

export function conditionOf(value: Json | undefined): Condition | null {
  if (value === undefined) return null;
  if (!isObject(value) || Object.keys(value).length === 0) return unknown(value);
  const conditions: Condition[] = [];
  for (const [key, detail] of Object.entries(value)) {
    if ((key === "all" || key === "any") && Array.isArray(detail) && detail.length > 0) {
      conditions.push({ kind: key, conditions: detail.map((item) => conditionOf(item) ?? unknown(item)) });
    } else if (key === "not") {
      conditions.push({ kind: "not", condition: conditionOf(detail) ?? unknown(detail) });
    } else if (fields[key] && isObject(detail) && Object.keys(detail).length > 0) {
      for (const [operator, operand] of Object.entries(detail)) {
        const op = operators[operator as keyof typeof operators];
        const valid = op === "in" ? Array.isArray(operand) : operand !== null && ["string", "number", "boolean"].includes(typeof operand);
        conditions.push(op && valid ? { kind: "predicate", field: fields[key]!, op, value: operand } : unknown({ [key]: { [operator]: operand } }));
      }
    } else conditions.push(unknown({ [key]: detail }));
  }
  return and(...conditions);
}

/** A product of a price and a factor without the noise of binary fractions: 0.1 * 1.1 is 0.11. */
const product = (price: number, factor: number): number => Number((price * factor).toPrecision(12));

function reads(condition: Condition | null, fields: ReadonlySet<string>): boolean {
  if (condition === null || condition.kind === "unknown") return false;
  if (condition.kind === "predicate") return fields.has(condition.field);
  if (condition.kind === "not") return reads(condition.condition, fields);
  return condition.conditions.some((item) => reads(item, fields));
}
const TIME_FIELDS: ReadonlySet<string> = new Set(["request.utc_hours", "request.utc_days"]);

/** Whether a multiplier with this scope scales the charge: `*` every charge, `text.*` every text charge, or the charge itself. */
const covers = (scope: string, meter: string): boolean => scope === "*" || scope === meter || (scope.endsWith(".*") && meter.startsWith(scope.slice(0, -1)));

/**
 * Add to each rule what follows from the rules together: the name of a time rule (peak or off-peak) and, for a
 * multiplier, the prices it makes of the base rates. Worked out once, here, so that no page multiplies anything.
 */
export function derivePricing(pricing: PricingInput): Pricing {
  const rules = pricing.rules;
  if (rules === null) return { coverage: pricing.coverage, billing: pricing.billing, reference_ref: pricing.reference_ref, rules: null, rule_order: pricing.rule_order, unparsed: pricing.unparsed, evidence: pricing.evidence };
  const unconditional = rules.filter((rule) => rule.when === null && rule.operation === "set");
  // One base rate per charge: the only one, or the last listed where the record says rules apply in listed order.
  const baseOf = (meter: string): PricingRuleInput | undefined => {
    const own = unconditional.filter((rule) => rule.meter === meter);
    return own.length === 1 ? own[0] : pricing.rule_order === "listed" ? own.at(-1) : undefined;
  };
  const meters = [...new Set(unconditional.map((rule) => rule.meter))];
  const derived = rules.map((rule): PricingRule => {
    let resulting: ResultingRate[] | null = null;
    if (rule.operation === "multiply") {
      const rates = meters.filter((meter) => covers(rule.meter, meter)).flatMap((meter) => {
        const base = baseOf(meter);
        return base ? [{ meter, amount: product(base.amount, rule.amount), currency: base.currency, unit: base.unit }] : [];
      });
      resulting = rates.length > 0 ? rates : null;
    }
    let period: PricingRule["period"] = null;
    if (reads(rule.when, TIME_FIELDS)) {
      // The base rate is the price outside the window, so a rule that raises it marks the peak and one that lowers it the off-peak.
      const before = rule.operation === "multiply" ? 1 : baseOf(rule.meter)?.amount;
      if (before !== undefined) period = rule.amount > before ? "peak" : rule.amount < before ? "off_peak" : null;
    }
    return { ...rule, period, resulting_rates: resulting };
  });
  return { coverage: pricing.coverage, billing: pricing.billing, reference_ref: pricing.reference_ref, rules: derived, rule_order: pricing.rule_order, unparsed: pricing.unparsed, evidence: pricing.evidence };
}

/** What models.dev prices by: text, and the other kinds of content a request can carry or return. */
const MODALITIES: readonly string[] = ["text", "image", "audio", "video"];
const inputMeters = (modality: string): string[] => [`${modality}.input`, `${modality}.cache_read`, `${modality}.cache_write`, `${modality}.cache_storage`];
const outputMeters = (modality: string): string[] => [`${modality}.output`, `${modality}.reasoning_output`];
/** models.dev: "Prices are USD per 1M for `token` and `character`, and per 1 unit otherwise." */
const unitOf = (name: string): NonNullable<PricingRuleInput["unit"]> => ({ name, quantity: name === "token" || name === "character" ? 1000000 : 1 });
/** models.dev: "USD per 1,000 web searches (or search requests, as the host bills them)." */
const WEB_SEARCH = "web_search";
const SEARCH_UNIT = { name: "search", quantity: 1000 };

/**
 * The pricing record of an entry, from the `cost` of `model` as models.dev records it.
 *
 * `access` and `reference` say what the rates are to the entry. An API entry is billed by them. A subscription entry
 * is not paid per token: with a `reference` the rates are the API list prices of that entry (pass the reference
 * entry as `model`); without one, a listed price of zero means only that, and the record is not applicable.
 *
 * The rules come out in the order models.dev applies them: base prices, then its overrides in their order ("matching
 * overrides merge field by field in order"), then its multipliers ("then every matching multiplier applies"). Each
 * holds for the whole request that matches its condition, which is how models.dev evaluates one.
 *
 * Every kind of content is read the same way, since models.dev records them the same way: the charges of `cost.audio`
 * are `audio.input`, `audio.cache_read` and so on, each with the unit the source gives (a second, an image, a
 * megapixel; a token where it gives none). A web search is the charge `web_search`, per 1,000 searches.
 */
export function pricingOf(model: JsonObject, access: string, reference: string | null, evidence: PolicyEvidence[], declaration?: PricingInput): Pricing {
  if (declaration) return derivePricing(structuredClone(declaration));
  const cost = isObject(model.cost) ? model.cost : null;
  const subscription = access === "subscription";
  const none = (): Pricing => ({ coverage: subscription ? "not_applicable" : "unknown", billing: subscription ? "not_applicable" : "unknown", reference_ref: null, rules: null, rule_order: null, unparsed: [], evidence: [] });
  if (!cost) return none();
  const base: PricingRuleInput[] = [];
  const overrides: PricingRuleInput[] = [];
  const multipliers: PricingRuleInput[] = [];
  const unparsedFields: Pricing["unparsed"] = [];
  const unparsed = (path: string, value: Json): void => { unparsedFields.push({ path, value }); };
  const rate = (path: string, meter: string, amount: Json, when: Condition | null, unit: PricingRuleInput["unit"], operation: PricingRuleInput["operation"] = "set", id = path): boolean => {
    if (typeof amount !== "number" || amount < 0 || !Number.isFinite(amount)) { unparsed(path, amount); return false; }
    (operation === "multiply" ? multipliers : when === null ? base : overrides).push({ id, when, meter, operation, amount, currency: operation === "set" ? "USD" : null, unit, applies_to: "all_usage", source_path: path });
    return true;
  };
  const explicitMode: Condition = { kind: "predicate", field: "cache.mode", op: "eq", value: "explicit" };
  const lifetime = (ttl: string): Condition => {
    const seconds = durationSeconds(ttl);
    return { kind: "predicate", field: seconds === undefined ? "cache.retention_value" : "cache.retention_s", op: "eq", value: seconds ?? ttl };
  };
  const cache = (modality: string, value: Json, path: string, when: Condition | null, unit: PricingRuleInput["unit"]): void => {
    if (!isObject(value)) { unparsed(path, value); return; }
    for (const [key, amount] of Object.entries(value)) {
      const here = `${path}.${key}`;
      if (key === "explicit") cache(modality, amount, here, and(when, explicitMode), unit);
      else if (key === "write" && isObject(amount)) {
        for (const [ttl, price] of Object.entries(amount)) rate(`${here}.${ttl}`, `${modality}.cache_write`, price, and(when, lifetime(ttl)), unit);
      } else if (["read", "write", "storage"].includes(key)) rate(here, `${modality}.cache_${key}`, amount, when, key === "storage" ? null : unit);
      else unparsed(here, amount);
    }
  };
  const side = (modality: string, value: Json, name: "input" | "output", path: string, when: Condition | null, inheritedUnit: PricingRuleInput["unit"]): void => {
    if (!isObject(value)) { unparsed(path, value); return; }
    const unit = typeof value.unit === "string" ? unitOf(value.unit) : inheritedUnit;
    for (const [key, amount] of Object.entries(value)) {
      const here = `${path}.${key}`;
      if (key === "price" || (name === "output" && key === "reasoning")) rate(here, key === "reasoning" ? `${modality}.reasoning_output` : `${modality}.${name}`, amount, when, unit);
      else if (name === "input" && key === "cache") cache(modality, amount, here, when, unit);
      else if (key === "overrides" && Array.isArray(amount)) {
        amount.forEach((override, index) => {
          if (!isObject(override) || override.when === undefined) { unparsed(`${here}[${index}]`, override); return; }
          const { when: rule, ...prices } = override;
          side(modality, prices, name, `${here}[${index}]`, and(when, conditionOf(rule)), unit);
        });
      } else if (key !== "unit" || typeof amount !== "string") unparsed(here, amount);
    }
  };
  const webSearch = (value: JsonObject, path: string, when: Condition | null): void => {
    for (const [key, amount] of Object.entries(value)) {
      const here = `${path}.${key}`;
      if (key === "price") rate(here, WEB_SEARCH, amount, when, SEARCH_UNIT);
      else if (key === "overrides" && Array.isArray(amount)) {
        amount.forEach((override, index) => {
          if (!isObject(override) || override.when === undefined) { unparsed(`${here}[${index}]`, override); return; }
          const { when: rule, ...prices } = override;
          webSearch(prices, `${here}[${index}]`, and(when, conditionOf(rule)));
        });
      } else unparsed(here, amount);
    }
  };
  const multiplierEntries: { path: string; factor: Json; when: Condition | null }[] = [];
  for (const [key, value] of Object.entries(cost)) {
    if (MODALITIES.includes(key) && isObject(value)) {
      for (const [name, prices] of Object.entries(value)) {
        if (name === "input" || name === "output") side(key, prices, name, `cost.${key}.${name}`, null, unitOf("token"));
        else unparsed(`cost.${key}.${name}`, prices);
      }
    } else if (key === WEB_SEARCH && isObject(value)) webSearch(value, `cost.${WEB_SEARCH}`, null);
    else if (key === "multipliers" && Array.isArray(value)) {
      value.forEach((item, index) => {
        const path = `cost.multipliers[${index}]`;
        if (!isObject(item) || item.when === undefined) { unparsed(path, item); return; }
        const { factor, when, ...rest } = item;
        if (factor !== undefined) multiplierEntries.push({ path: `${path}.factor`, factor, when: conditionOf(when) });
        for (const [name, detail] of Object.entries(rest)) unparsed(`${path}.${name}`, detail);
      });
    } else unparsed(`cost.${key}`, value);
  }

  // Factors, after every price is known. models.dev: "A plain number multiplies every price in the cost; an object
  // multiplies only the prices it names." A number part-way down the tree therefore scales every price under it,
  // which here is one rule per charge that has a price.
  const priced = new Set([...base, ...overrides].map((rule) => rule.meter));
  const each = (path: string, meters: readonly string[], factor: number, when: Condition | null): void => {
    const present = meters.filter((meter) => priced.has(meter));
    if (present.length === 0) { unparsed(path, factor); return; }
    for (const meter of present) rate(path, meter, factor, when, null, "multiply", present.length === 1 ? path : `${path}:${meter}`);
  };
  const cacheFactor = (modality: string, value: Json, path: string, when: Condition | null): void => {
    if (typeof value === "number") { each(path, inputMeters(modality).slice(1), value, when); return; }
    if (!isObject(value)) { unparsed(path, value); return; }
    for (const [key, detail] of Object.entries(value)) {
      const here = `${path}.${key}`;
      if (key === "explicit") cacheFactor(modality, detail, here, and(when, explicitMode));
      else if (key === "write" && isObject(detail)) {
        for (const [ttl, factor] of Object.entries(detail)) rate(`${here}.${ttl}`, `${modality}.cache_write`, factor, and(when, lifetime(ttl)), null, "multiply");
      } else if (["read", "write", "storage"].includes(key)) rate(here, `${modality}.cache_${key}`, detail, when, null, "multiply");
      else unparsed(here, detail);
    }
  };
  const sideFactor = (modality: string, value: Json, name: "input" | "output", path: string, when: Condition | null): void => {
    if (typeof value === "number") { each(path, name === "input" ? inputMeters(modality) : outputMeters(modality), value, when); return; }
    if (!isObject(value)) { unparsed(path, value); return; }
    for (const [key, detail] of Object.entries(value)) {
      const here = `${path}.${key}`;
      if (key === "price") rate(here, `${modality}.${name}`, detail, when, null, "multiply");
      else if (name === "output" && key === "reasoning") rate(here, `${modality}.reasoning_output`, detail, when, null, "multiply");
      else if (name === "input" && key === "cache") cacheFactor(modality, detail, here, when);
      else unparsed(here, detail);
    }
  };
  for (const { path, factor, when } of multiplierEntries) {
    if (typeof factor === "number") { rate(path, "*", factor, when, null, "multiply"); continue; }
    if (!isObject(factor)) { unparsed(path, factor); continue; }
    for (const [modality, value] of Object.entries(factor)) {
      const here = `${path}.${modality}`;
      if (modality === WEB_SEARCH) {
        // A factor for the web search alone: a number, or the price it names.
        const own = isObject(value) && Object.keys(value).length === 1 ? value.price : value;
        if (typeof own === "number") rate(here, WEB_SEARCH, own, when, null, "multiply");
        else unparsed(here, value);
      } else if (!MODALITIES.includes(modality)) unparsed(here, value);
      else if (typeof value === "number") rate(here, `${modality}.*`, value, when, null, "multiply");
      else if (isObject(value)) {
        for (const [name, detail] of Object.entries(value)) {
          if (name === "input" || name === "output") sideFactor(modality, detail, name, `${here}.${name}`, when);
          else unparsed(`${here}.${name}`, detail);
        }
      } else unparsed(here, value);
    }
  }

  const rules = [...base, ...overrides, ...multipliers];
  // A subscription entry with no API entry to refer to: a listed zero is the plan, not a price per token. The
  // record says where that comes from, and publishes no rate.
  if (subscription && !reference && rules.every((rule) => rule.operation !== "set" || rule.amount === 0)) {
    return { ...none(), evidence: evidence.map((source) => ({ ...source, note: "The source lists a price of 0 for this entry, which is a subscription: no price per token is published." })) };
  }
  return derivePricing({
    coverage: "partial",
    billing: reference ? "reference" : access === "api" ? "per_use" : "unknown",
    reference_ref: reference,
    rules,
    rule_order: "listed",
    unparsed: unparsedFields,
    evidence,
  });
}

function blankControl(id: string): RequestControl {
  return { id, support: "unknown", when: null, bindings: null, options: null, default: null, conditions: [], evidence: [] };
}

export function controlsOf(model: JsonObject, retention: CacheRetention, evidence: PolicyEvidence[], declarations: RequestControl[] = []): RequestControls {
  const cache: RequestControl = {
    ...blankControl("cache.retention"), support: retention.support,
    options: retention.accepted_values?.map((value) => {
      const seconds = durationSeconds(value);
      const profiles = retention.profiles.filter((profile) => profile.value === value).map((profile) => profile.profile);
      return { value, attributes: { ...(seconds === undefined ? {} : { retention_s: seconds }), ...(profiles.length === 1 ? { profile: profiles[0]! } : {}) }, settings: null, when: null };
    }) ?? null,
    default: retention.default === null ? null : { value: retention.default }, conditions: retention.conditions, evidence: retention.evidence,
  };
  // A legacy parameter's free-text location is not sufficient to invent a body/header binding.
  const service = blankControl("service_tier");
  const capabilities = isObject(model.capabilities) ? model.capabilities : {};
  if (Array.isArray(capabilities.service_tier) && capabilities.service_tier.length > 0) {
    service.support = "supported";
    service.options = capabilities.service_tier.map((value) => ({ value, attributes: null, settings: null, when: null }));
    service.evidence = evidence;
  }
  const byId = new Map([cache, service].map((control) => [control.id, control]));
  for (const control of declarations) byId.set(control.id, structuredClone(control));
  const items = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  return { coverage: items.some((item) => item.support !== "unknown") ? "partial" : "unknown", items };
}

/** Keep the existing cache API as a projection of an authored, richer cache control, not a competing claim. */
export function retentionFromControl(control: RequestControl): CacheRetention {
  const binding = control.bindings?.[0];
  const name = binding?.location === "body" ? binding.path.slice(1).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~")).join(".") : binding?.path;
  const place = { body: "Request body", header: "Request header", query: "Query string" } as const;
  const scope = { content_block: ", on a content block", request: ", top level" } as const;
  // An option with value null is "leave the field out": a profile of its own, and not a value a request sends.
  const values = (control.options ?? []).map((option) => option.value).filter((value): value is string => typeof value === "string");
  return {
    support: control.support,
    parameter: binding && name ? { name, location: `${place[binding.location]}${binding.location === "body" && binding.scope ? scope[binding.scope] : ""}` } : null,
    accepted_values: values.length > 0 ? values : null,
    default: typeof control.default?.value === "string" ? control.default.value : null,
    profiles: (control.options ?? []).flatMap((option) => {
      const profile = option.attributes?.profile;
      return (profile === "short" || profile === "long") && (typeof option.value === "string" || option.value === null) ? [{ profile, value: option.value }] : [];
    }),
    // A condition the control holds as a tree cannot be said in this flat record: point to it. A companion field of
    // an option (`type: ephemeral` next to `ttl`) is part of how the value is sent, not a condition.
    conditions: [...control.conditions, ...(control.when === null && !control.options?.some((option) => option.when !== null) ? [] : ["See the cache.retention request control for the conditions of the control and of its options."])],
    evidence: control.evidence,
  };
}
