// Normalize once at publication. Pages and API responses use these objects without interpreting source rules again.
import { durationSeconds, type CacheRetention } from "./cache.ts";
import { isObject, type Json, type JsonObject } from "./merge.ts";
import type { Condition, PolicyEvidence, Pricing, PricingRule, RequestControl, RequestControls } from "./policy-contract.ts";

const fields: Record<string, string> = { context: "request.context_tokens", service_tier: "request.service_tier", region: "request.region", date: "request.date", utc_hours: "request.utc_hours", utc_days: "request.utc_days", holiday: "request.holiday", thinking: "request.thinking" };
const operators = { equals: "eq", in: "in", gt: "gt", gte: "gte", lt: "lt", lte: "lte" } as const;
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

export function pricingOf(model: JsonObject, access: string, reference: string | null, evidence: PolicyEvidence[], declaration?: Pricing): Pricing {
  if (declaration) return structuredClone(declaration);
  const cost = isObject(model.cost) ? model.cost : null;
  const pricing: Pricing = {
    coverage: cost ? "partial" : access === "subscription" ? "not_applicable" : "unknown",
    billing: reference ? "reference" : access === "subscription" ? "not_applicable" : access === "api" && cost ? "per_use" : "unknown",
    reference_ref: reference, rules: cost ? [] : null, rule_order: null, unparsed: [], evidence: cost ? evidence : [],
  };
  if (!cost) return pricing;
  const unparsed = (path: string, value: Json): void => { pricing.unparsed.push({ path, value }); };
  const rate = (path: string, meter: string, amount: Json, when: Condition | null, unit: PricingRule["unit"], operation: PricingRule["operation"] = "set"): void => {
    if (typeof amount !== "number" || amount < 0 || !Number.isFinite(amount)) { unparsed(path, amount); return; }
    pricing.rules!.push({ id: path, when, meter, operation, amount, currency: operation === "set" ? "USD" : null, unit, applies_to: when === null && operation === "set" ? "all_usage" : null, source_path: path });
  };
  const cache = (value: Json, path: string, when: Condition | null, unit: PricingRule["unit"]): void => {
    if (!isObject(value)) { unparsed(path, value); return; }
    for (const [key, amount] of Object.entries(value)) {
      const here = `${path}.${key}`;
      if (key === "explicit") cache(amount, here, and(when, { kind: "predicate", field: "cache.mode", op: "eq", value: "explicit" }), unit);
      else if (key === "write" && isObject(amount)) {
        for (const [ttl, price] of Object.entries(amount)) {
          const seconds = durationSeconds(ttl);
          rate(`${here}.${ttl}`, "text.cache_write", price, and(when, { kind: "predicate", field: seconds === undefined ? "cache.retention_value" : "cache.retention_s", op: "eq", value: seconds ?? ttl }), unit);
        }
      } else if (["read", "write", "storage"].includes(key)) rate(here, `text.cache_${key}`, amount, when, key === "storage" ? null : unit);
      else unparsed(here, amount);
    }
  };
  const side = (value: Json, name: "input" | "output", path: string, when: Condition | null, inheritedUnit: PricingRule["unit"]): void => {
    if (!isObject(value)) { unparsed(path, value); return; }
    const unit = typeof value.unit === "string" ? { name: value.unit, quantity: null } : inheritedUnit;
    for (const [key, amount] of Object.entries(value)) {
      const here = `${path}.${key}`;
      if (key === "price" || (name === "output" && key === "reasoning")) rate(here, key === "reasoning" ? "text.reasoning_output" : `text.${name}`, amount, when, unit);
      else if (name === "input" && key === "cache") cache(amount, here, when, unit);
      else if (key === "overrides" && Array.isArray(amount)) {
        amount.forEach((override, index) => {
          if (!isObject(override) || override.when === undefined) { unparsed(`${here}[${index}]`, override); return; }
          const { when: rule, ...prices } = override;
          side(prices, name, `${here}[${index}]`, and(when, conditionOf(rule)), unit);
        });
      } else if (key !== "unit" || typeof amount !== "string") unparsed(here, amount);
    }
  };
  for (const [key, value] of Object.entries(cost)) {
    if (key === "text" && isObject(value)) {
      for (const [name, prices] of Object.entries(value)) {
        if (name === "input" || name === "output") side(prices, name, `cost.text.${name}`, null, { name: "token", quantity: 1000000 });
        else unparsed(`cost.text.${name}`, prices);
      }
    } else if (key === "multipliers" && Array.isArray(value)) {
      value.forEach((item, index) => {
        const path = `cost.multipliers[${index}]`;
        if (!isObject(item) || item.when === undefined) { unparsed(path, item); return; }
        const { factor, when, ...rest } = item;
        if (typeof factor === "number") rate(`${path}.factor`, "*", factor, conditionOf(when), null, "multiply");
        else if (isObject(factor) && typeof factor.text === "number") {
          rate(`${path}.factor.text`, "text.*", factor.text, conditionOf(when), null, "multiply");
          for (const [name, detail] of Object.entries(factor)) if (name !== "text") unparsed(`${path}.factor.${name}`, detail);
        } else if (factor !== undefined) unparsed(`${path}.factor`, factor);
        for (const [name, detail] of Object.entries(rest)) unparsed(`${path}.${name}`, detail);
      });
    } else unparsed(`cost.${key}`, value);
  }
  return pricing;
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
  return {
    support: control.support,
    parameter: binding && name ? { name, location: `${binding.location}${binding.scope ? ` (${binding.scope})` : ""}` } : null,
    accepted_values: control.options?.every((option) => typeof option.value === "string") ? control.options.map((option) => option.value as string) : null,
    default: typeof control.default?.value === "string" ? control.default.value : null,
    profiles: (control.options ?? []).flatMap((option) => {
      const profile = option.attributes?.profile;
      return (profile === "short" || profile === "long") && typeof option.value === "string" ? [{ profile, value: option.value }] : [];
    }),
    conditions: [...control.conditions, ...(control.when === null && !control.options?.some((option) => option.when !== null || (option.settings?.length ?? 0) > 1) ? [] : ["See the cache.retention request control for endpoint, option and companion-setting conditions."])],
    evidence: control.evidence,
  };
}
