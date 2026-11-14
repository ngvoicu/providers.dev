// resolve(): upstream snapshot + our additions + our overrides + our measurements -> the published catalog.
// Pure: no files, no network, no clock. The same inputs always give the same output.
import { cacheResult, documentedCache, lifetimeAsked, profileOf, retentionOf, summarizeCache, type CacheEvaluation, type CacheRetention, type EntryCache, type RetentionEvidence } from "./cache.ts";
import { clone, isObject, mergePatch, type Change, type Json, type JsonObject } from "./merge.ts";
import { controlsOf, pricingOf, retentionFromControl } from "./policies.ts";
import {
  NS,
  type AccessRules,
  type AuthoredModel,
  type AuthoredProvider,
  type Catalog,
  type DraftProvenance,
  type Evidence,
  type Exclusion,
  type Issue,
  type MeasuredLimit,
  type MeasurementLabels,
  type ModelExtension,
  type ObservedFile,
  type OverrideFile,
  type ProviderExtension,
  type Provenance,
  type PublishedEvidence,
  type PublishedModel,
  type PublishedProvider,
  type RouteMap,
  type UpstreamCatalog,
} from "./schema.ts";

export interface ResolveInput {
  upstream: UpstreamCatalog;
  additions: AuthoredProvider[];
  overrides: OverrideFile[];
  access: AccessRules;
  routes: RouteMap;
  labels?: MeasurementLabels;
  observed?: ObservedFile;
  /** The date of the models.dev import (YYYY-MM-DD): the date of what is taken from its documentation. */
  upstreamDate?: string;
}

export interface ResolveResult {
  catalog: Catalog;
  issues: Issue[];
  exclusions: Exclusion[];
}

/**
 * What an entry we add may take from the upstream entry it names: who the model is, never how this access behaves.
 * One more field is copied, and only by a subscription entry from an API entry: `cost`, the API list price (step 5b).
 */
export const IDENTITY_FIELDS = [
  "name",
  "description",
  "family",
  "type",
  "open_weights",
  "knowledge",
  "release_date",
  "last_updated",
  "canonical_id",
] as const;

const RESERVED = new Set(["id", "models", NS]);

/**
 * The providers_dev records while the catalog is being put together: only the classification is there from the
 * start, and the steps below add to it. Step 6 publishes each record with every key (`publishModel`, `publishProvider`).
 */
type DraftModel = Pick<ModelExtension, "origin" | "access"> & {
  provenance?: DraftProvenance[];
  inherited?: { from: string; fields: string[] };
  limits?: { measured?: MeasuredLimit[]; from_measurement?: ("context" | "output")[] };
  evidence?: Evidence[];
};
type DraftProvider = Pick<ProviderExtension, "origin" | "access" | "access_basis" | "access_reviewed"> & {
  access_source?: string;
  note?: string;
  evidence?: Evidence[];
  provenance?: DraftProvenance[];
};

function modelExt(model: JsonObject): DraftModel {
  return model[NS] as unknown as DraftModel;
}
function provExt(provider: JsonObject): DraftProvider {
  return provider[NS] as unknown as DraftProvider;
}

/** Published evidence always has its note, null where none was written. */
function publishEvidence(items: readonly Evidence[] | undefined): PublishedEvidence[] {
  return (items ?? []).map((item) => ({ kind: item.kind, url: item.url, date: item.date, note: item.note ?? null }));
}

/** A published correction always has `value` and `upstream`: null where the operation or models.dev has none. */
function publishProvenance(items: readonly DraftProvenance[] | undefined): Provenance[] {
  return (items ?? []).map((change) => ({
    path: change.path,
    op: change.op,
    value: change.value ?? null,
    had_upstream: change.had_upstream,
    upstream: change.upstream ?? null,
    reason: change.reason,
    evidence: publishEvidence(change.evidence),
  }));
}

/** `provider/model`: provider ids never contain a slash, model ids often do. */
export function splitRef(ref: string): { provider: string; model: string } | null {
  const at = ref.indexOf("/");
  if (at <= 0 || at === ref.length - 1) return null;
  return { provider: ref.slice(0, at), model: ref.slice(at + 1) };
}

function classify(id: string, rules: AccessRules): Pick<DraftProvider, "access" | "access_basis" | "access_reviewed" | "access_source"> {
  const named = rules.providers[id];
  if (named) {
    return { access: named.access, access_basis: named.basis, access_reviewed: true, ...(named.source ? { access_source: named.source } : {}) };
  }
  for (const pattern of rules.patterns) {
    if (new RegExp(pattern.match).test(id)) return { access: pattern.access, access_basis: pattern.basis, access_reviewed: false };
  }
  return { access: rules.default, access_basis: rules.default_basis, access_reviewed: false };
}

function sortKeys<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key] as T]));
}

function newestDate(dates: (string | undefined)[]): string | undefined {
  return dates.filter((date): date is string => Boolean(date)).sort().at(-1);
}

export function resolve(input: ResolveInput): ResolveResult {
  const issues: Issue[] = [];
  const exclusions: Exclusion[] = [];
  const catalog: Catalog = {};
  const retentionDeclarations = new Map<PublishedModel, CacheRetention>();
  const pricingDeclarations = new Map<PublishedModel, NonNullable<AuthoredModel["pricing"]>>();
  const controlDeclarations = new Map<PublishedModel, NonNullable<AuthoredModel["request_controls"]>>();

  // 1. The upstream baseline, untouched except for our namespaced block.
  for (const [id, upstream] of Object.entries(input.upstream)) {
    const provider = clone(upstream) as unknown as PublishedProvider;
    const access = classify(id, input.access);
    provider[NS] = { origin: "upstream", ...access } as unknown as Json;
    for (const model of Object.values(provider.models)) {
      model[NS] = { origin: "upstream", access: access.access } as unknown as Json;
    }
    catalog[id] = provider;
  }

  const lookup = (ref: string | null | undefined): PublishedModel | undefined => {
    const parts = ref ? splitRef(ref) : null;
    return parts ? catalog[parts.provider]?.models[parts.model] : undefined;
  };

  const inherit = (model: PublishedModel, from: string, target: string): void => {
    const source = lookup(from);
    if (!source) {
      issues.push({ level: "warning", code: "inherit-target-missing", target, message: `Nothing to inherit: ${from} is not in the catalog.` });
      return;
    }
    const fields: string[] = [];
    for (const field of IDENTITY_FIELDS) {
      if (source[field] !== undefined && model[field] === undefined) {
        (model as JsonObject)[field] = clone(source[field] as Json);
        fields.push(field);
      }
    }
    // An upstream entry at the lab itself is its own canonical model.
    if (model.canonical_id === undefined && source.canonical_id === undefined) {
      model.canonical_id = from;
      fields.push("canonical_id");
    }
    modelExt(model).inherited = { from, fields };
  };

  // 2. Providers and models we add.
  for (const addition of input.additions) {
    const access = {
      access: addition.access,
      access_basis: addition.access_basis,
      access_reviewed: true,
    };
    let provider = catalog[addition.id];
    if (provider) {
      issues.push({
        level: "warning",
        code: "addition-collides",
        target: addition.id,
        message: `Upstream now has a provider "${addition.id}". Our entry was merged over it; review and turn it into an override or rename it.`,
      });
      provider.name = addition.name;
      if (addition.doc) provider.doc = addition.doc;
      Object.assign(provExt(provider), access);
    } else {
      provider = { id: addition.id, name: addition.name, ...(addition.doc ? { doc: addition.doc } : {}), models: {} } as PublishedProvider;
      provider[NS] = { origin: "added", ...access } as unknown as Json;
      catalog[addition.id] = provider;
    }
    const extension = provExt(provider);
    extension.evidence = addition.evidence;
    if (addition.note) extension.note = addition.note;

    for (const authored of addition.models) {
      const target = `${addition.id}/${authored.id}`;
      const reserved = Object.keys(authored.fields ?? {}).filter((key) => RESERVED.has(key));
      if (reserved.length > 0) {
        issues.push({ level: "error", code: "reserved-field", target, message: `Fields ${reserved.join(", ")} cannot be set by hand.` });
        continue;
      }
      const model = { id: authored.id, ...(clone(authored.fields ?? {}) as JsonObject) } as PublishedModel;
      if (authored.name) model.name = authored.name;
      model[NS] = { origin: "added", access: addition.access, evidence: authored.evidence } as unknown as Json;
      if (authored.inherits) inherit(model, authored.inherits, target);
      if (!model.name) model.name = authored.id;
      provider.models[authored.id] = model;
      if (authored.cache_retention) retentionDeclarations.set(model, authored.cache_retention);
      if (authored.pricing) pricingDeclarations.set(model, authored.pricing);
      if (authored.request_controls) controlDeclarations.set(model, authored.request_controls);
    }
  }

  // 3. Models that exist only because we measured them on a route upstream does not list.
  const observed = input.observed;
  const sourceUrl = (path: string): string => (observed ? `${observed.repository}/blob/main/${path}` : path);
  const unmapped = new Set<string>();
  const ensureMeasuredModel = (route: string, id: string, base: string | null | undefined, evidence: Evidence): string | null => {
    const mapped = input.routes[route];
    const provider = mapped ? catalog[mapped.provider] : undefined;
    if (!mapped || !provider) {
      if (!unmapped.has(route)) {
        unmapped.add(route);
        issues.push({
          level: "warning",
          code: "unmapped-route",
          target: route,
          message: `Measurements on route "${route}" have no provider to land on. Add it to data/authored/routes.yaml and data/authored/providers/.`,
        });
      }
      return null;
    }
    const ref = `${mapped.provider}/${id}`;
    if (!provider.models[id]) {
      const model = { id } as PublishedModel;
      model[NS] = { origin: "added", access: provExt(provider).access, evidence: [evidence] } as unknown as Json;
      if (base && lookup(base)) inherit(model, base, ref);
      if (!model.name) model.name = id;
      provider.models[id] = model;
    }
    return ref;
  };

  if (observed) {
    for (const run of observed.cache) {
      if (!run.latest || run.lacks || run.models_dev) continue;
      ensureMeasuredModel(run.route, run.model, run.base_model, { kind: "measured", url: sourceUrl(run.source), date: run.date });
    }
    for (const limit of observed.limits) {
      if (limit.models_dev) continue;
      const date = /(\d{4}-\d{2}-\d{2})/.exec(limit.source)?.[1];
      if (date) ensureMeasuredModel(limit.route, limit.model, limit.base_model, { kind: "measured", url: sourceUrl(limit.source), date });
    }
  }

  // 4. Our overrides and tombstones.
  for (const file of input.overrides) {
    const provider = catalog[file.provider];
    if (!provider) {
      issues.push({
        level: "warning",
        code: "orphan-override",
        target: file.provider,
        message: `Overrides for provider "${file.provider}" were not applied: it is not in the upstream snapshot or our additions.`,
      });
      continue;
    }
    if (file.exclude) {
      delete catalog[file.provider];
      exclusions.push({ target: file.provider, reason: file.exclude.reason, evidence: publishEvidence(file.exclude.evidence) });
      continue;
    }
    if (file.set) {
      const reserved = Object.keys(file.set).filter((key) => RESERVED.has(key));
      if (reserved.length > 0 || !file.set_reason || !file.set_evidence?.length) {
        issues.push({
          level: "error",
          code: reserved.length > 0 ? "reserved-field" : "invalid-authored",
          target: file.provider,
          message: reserved.length > 0 ? `Fields ${reserved.join(", ")} cannot be overridden.` : "A provider-level `set` needs `set_reason` and `set_evidence`.",
        });
      } else {
        applyPatch(provider, file.set as JsonObject, file.set_reason, file.set_evidence, file.provider, provExt(provider), issues);
      }
    }
    for (const rule of file.rules) {
      for (const id of rule.models ?? []) {
        const target = `${file.provider}/${id}`;
        const model = provider.models[id];
        if (!model) {
          issues.push({
            level: "warning",
            code: "orphan-override",
            target,
            message: `An override for ${target} was not applied: the entry is not in the upstream snapshot. Reason on file: ${rule.reason}`,
          });
          continue;
        }
        if (rule.exclude) {
          delete provider.models[id];
          exclusions.push({ target, reason: rule.reason, evidence: publishEvidence(rule.evidence) });
          continue;
        }
        if (rule.cache_retention) retentionDeclarations.set(model, rule.cache_retention);
        if (rule.pricing) pricingDeclarations.set(model, rule.pricing);
        if (rule.request_controls) controlDeclarations.set(model, [...new Map([...(controlDeclarations.get(model) ?? []), ...rule.request_controls].map((control) => [control.id, control])).values()]);
        if (!rule.set) continue;
        const reserved = Object.keys(rule.set).filter((key) => RESERVED.has(key));
        if (reserved.length > 0) {
          issues.push({ level: "error", code: "reserved-field", target, message: `Fields ${reserved.join(", ")} cannot be overridden.` });
          continue;
        }
        applyPatch(model, rule.set as JsonObject, rule.reason, rule.evidence, target, modelExt(model), issues);
      }
    }
  }

  // 4b. Rules that select their entries by what is documented for them, after every correction is in. Such a rule
  // is a statement about the provider's API ("a request sets the cache lifetime with this field"), applied to each
  // entry that documents the lifetimes. It is not evidence about any one entry: the control carries its source, and
  // the entry is not marked as corrected or evaluated because of it. An entry named by a rule of its own keeps that.
  const providerWide = new Map<PublishedModel, Set<string>>();
  for (const file of input.overrides) {
    const provider = catalog[file.provider];
    if (!provider) continue;
    for (const rule of file.rules) {
      const select = rule.select;
      if (!select || !rule.request_controls) continue;
      const matched = Object.values(provider.models).filter((model) => {
        const mode = documentedCache(model).modes[select.cache_mode];
        return mode.support === "supported" && (select.cache_ttl ?? []).every((ttl) => mode.ttl?.includes(ttl));
      });
      if (matched.length === 0) {
        issues.push({
          level: "warning",
          code: "orphan-override",
          target: `${file.provider}#select`,
          message: `A rule for ${file.provider} selects no entry (${select.cache_mode} caching${select.cache_ttl ? ` with ${select.cache_ttl.join(", ")}` : ""}). Reason on file: ${rule.reason}`,
        });
      }
      for (const model of matched) {
        const named = controlDeclarations.get(model) ?? [];
        const fresh = rule.request_controls.filter((control) => !named.some((item) => item.id === control.id));
        if (fresh.length === 0) continue;
        controlDeclarations.set(model, [...named, ...fresh]);
        const wide = providerWide.get(model) ?? providerWide.set(model, new Set()).get(model)!;
        for (const control of fresh) wide.add(control.id);
      }
    }
  }

  // A richer cache control is also the source for the legacy cache representation and evaluation profiles.
  for (const [model, controls] of controlDeclarations) {
    const cache = controls.find((control) => control.id === "cache.retention");
    if (cache) retentionDeclarations.set(model, retentionFromControl(cache));
  }

  // 5. Measurements land on the entry they were taken on. They never replace a documented value.
  const evaluations = new Map<PublishedModel, CacheEvaluation[]>();
  if (observed) {
    const routeLabel = (route: string): string => observed.routes[route] ?? route;
    const unknownClients = new Set<string>();
    const clientOf = (client: string): { client: string; client_label: string } => {
      const named = input.labels?.clients[client];
      if (named) return { client: named.id, client_label: named.label };
      if (!unknownClients.has(client)) {
        unknownClients.add(client);
        issues.push({
          level: "warning",
          code: "unmapped-client",
          target: client,
          message: `Measurements name a client "${client}" that data/authored/measurement-labels.yaml does not describe. It is published as "other".`,
        });
      }
      return { client: "other", client_label: "Another client" };
    };
    const omit = (input.labels?.omit_note_parts_mentioning ?? []).map((word) => word.toLowerCase());
    const publicNote = (note: string | undefined): string | undefined => {
      if (!note) return undefined;
      const kept = note
        .split(";")
        .map((part) => part.trim())
        .filter((part) => part && !omit.some((word) => part.toLowerCase().includes(word)));
      return kept.length > 0 ? kept.join("; ") : undefined;
    };
    const targetOf = (record: { route: string; model: string; models_dev?: string | null }): { ref: string; model?: PublishedModel } => {
      const mapped = input.routes[record.route];
      const ref = record.models_dev ?? (mapped ? `${mapped.provider}/${record.model}` : `${record.route}/${record.model}`);
      return { ref, model: lookup(ref) };
    };
    const orphaned = new Set<string>();
    const orphan = (ref: string, route: string): void => {
      if (unmapped.has(route) || orphaned.has(ref)) return;
      orphaned.add(ref);
      issues.push({
        level: "warning",
        code: "orphan-observation",
        target: ref,
        message: `Measurements for ${ref} were not published: the entry is no longer in the catalog.`,
      });
    };

    for (const run of observed.cache) {
      // A run taken with a client that lacked what the route needs says nothing about the provider.
      if (!run.latest || run.lacks) continue;
      const { ref, model } = targetOf(run);
      if (!model) {
        orphan(ref, run.route);
        continue;
      }
      const note = publicNote(run.note);
      const settings = (run.options ?? {}) as JsonObject;
      const asked = lifetimeAsked(settings);
      const declared = retentionDeclarations.get(model);
      const declaredProfile = (!asked || declared?.parameter?.name === asked.parameter)
        ? declared?.profiles.find((profile) => profile.value === (asked?.value ?? null))?.profile
        : undefined;
      const evaluation: CacheEvaluation = {
        id: run.id,
        route: run.route,
        route_label: routeLabel(run.route),
        ...clientOf(run.client),
        date: run.date,
        request_settings: settings,
        retention_profile: declaredProfile ?? profileOf(asked?.value ?? null, model),
        parameter: asked?.parameter ?? null,
        value: asked?.value ?? null,
        // One result per exact age, the control first. An age with no check made has no result.
        results: [
          ...(run.control && run.control.total > 0 ? [cacheResult("control", 0, run.control.warm, run.control.total)] : []),
          ...(run.checks ?? []).filter((c) => c.total > 0).sort((a, b) => a.age_s - b.age_s).map((c) => cacheResult("timed", c.age_s, c.warm, c.total)),
        ],
        late_excluded: typeof run.late_excluded === "number" ? run.late_excluded : null,
        note: note ?? null,
        source: sourceUrl(run.source),
      };
      (evaluations.get(model) ?? evaluations.set(model, []).get(model)!).push(evaluation);
    }

    for (const limit of observed.limits) {
      const { ref, model } = targetOf(limit);
      if (!model) {
        orphan(ref, limit.route);
        continue;
      }
      const date = /(\d{4}-\d{2}-\d{2})/.exec(limit.source)?.[1];
      const limitNote = publicNote(limit.note);
      const tokens = (value: number | null | undefined): number | null => (typeof value === "number" ? value : null);
      const measured: MeasuredLimit = {
        route: limit.route,
        route_label: routeLabel(limit.route),
        ...clientOf(limit.client),
        context: tokens(limit.context),
        output: tokens(limit.output),
        input_accepted: tokens(limit.input_accepted),
        input_refused: tokens(limit.input_refused),
        output_accepted: tokens(limit.output_accepted),
        note: limitNote ?? null,
        date: date ?? null,
        source: sourceUrl(limit.source),
      };
      const extension = modelExt(model);
      extension.limits ??= {};
      (extension.limits.measured ??= []).push(measured);
      // On an entry we add there is no documented limit to keep apart from the measurement: the measured value is
      // the published one, and it is marked as measured. On an upstream entry the documented value stays.
      if (extension.origin === "added") {
        const limits = (isObject(model.limit) ? model.limit : (model.limit = {})) as JsonObject;
        for (const field of ["context", "output"] as const) {
          const value = measured[field];
          if (value === null || limits[field] !== undefined) continue;
          limits[field] = value;
          (extension.limits.from_measurement ??= []).push(field);
        }
        if (Object.keys(limits).length === 0) delete model.limit;
      }
    }
  }

  // 5b. A subscription entry we add is not paid per token, so it has no price of its own. It takes the API list price
  // of the entry it names, marked as inherited, so that a client can work out what the usage is worth. Done after the
  // overrides, so that it carries our corrections. An entry with a price of its own keeps it.
  for (const provider of Object.values(catalog)) {
    for (const model of Object.values(provider.models)) {
      const extension = modelExt(model);
      const inherited = extension.inherited;
      if (!inherited || extension.origin !== "added" || extension.access !== "subscription" || model.cost !== undefined) continue;
      const parts = splitRef(inherited.from);
      const source = lookup(inherited.from);
      const sourceProvider = parts ? catalog[parts.provider] : undefined;
      if (!source || !sourceProvider || source.cost === undefined || provExt(sourceProvider).access !== "api") continue;
      (model as JsonObject).cost = clone(source.cost as Json);
      inherited.fields.push("cost");
    }
  }

  /**
   * The API entry of a lab's own provider for the canonical model of `model`: the entry with that very id, else the
   * first by id. Null where the lab is not in the catalog, is not reached by API key, or lists no price for it.
   */
  const labEntry = (model: PublishedModel): string | null => {
    const canonical = typeof model.canonical_id === "string" ? model.canonical_id : null;
    const parts = canonical ? splitRef(canonical) : null;
    const provider = parts ? catalog[parts.provider] : undefined;
    if (!parts || !provider || provExt(provider).access !== "api") return null;
    const serving = Object.values(provider.models).filter((item) => item !== model && isObject(item.cost) && (typeof item.canonical_id === "string" ? item.canonical_id : `${parts.provider}/${item.id}`) === canonical);
    const chosen = serving.find((item) => item.id === parts.model) ?? serving.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
    return chosen ? `${parts.provider}/${chosen.id}` : null;
  };

  // 6. Deterministic order, and every record published with all of its keys.
  const sorted: Catalog = {};
  for (const id of Object.keys(catalog).sort()) {
    const provider = catalog[id] as PublishedProvider;
    for (const model of Object.values(provider.models)) {
      const extension = modelExt(model);
      // Every entry gets the same cache record: what a request can ask for, the summary table, and the evaluations
      // under it. The sums and percentages are made here, once; pages and API answers only pass them on.
      const own = (evaluations.get(model) ?? []).sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
      const declaration = retentionDeclarations.get(model);
      const documented = documentedCache(model);
      const cacheSources = [
        ...(extension.origin === "added" ? extension.evidence ?? [] : []),
        ...(extension.provenance ?? []).filter((change) => change.path === "capabilities" || change.path === "capabilities.cache" || change.path.startsWith("capabilities.cache.")).flatMap((change) => change.evidence),
      ];
      const cacheEvidence: RetentionEvidence[] = cacheSources.flatMap((source) => source.kind === "listed" ? [] : [{ ...source, kind: source.kind, note: source.note ?? "Source for this entry's cache capabilities." }]);
      if (extension.origin === "upstream") cacheEvidence.unshift({ kind: "documented", url: "https://models.dev", date: input.upstreamDate ?? null, note: "Cache capabilities imported from models.dev; any corrections are recorded in provenance." });
      const cache: EntryCache = { documented, retention: retentionOf(documented, cacheEvidence, declaration), results: summarizeCache(own), evaluations: own };
      /** Where a field of `owner` comes from: the models.dev import, or providers.dev's own sources for it. */
      const sourcesOf = (owner: PublishedModel, field: string, imported: string): RetentionEvidence[] => {
        const ownerExtension = modelExt(owner);
        const sources: RetentionEvidence[] = [
          ...(ownerExtension.origin === "added" ? ownerExtension.evidence ?? [] : []),
          ...(ownerExtension.provenance ?? []).filter((change) => change.path === field || change.path.startsWith(`${field}.`) || field.startsWith(`${change.path}.`)).flatMap((change) => change.evidence),
        ].flatMap((source) => source.kind === "listed" ? [] : [{ kind: source.kind, url: source.url, date: source.date, note: source.note ?? `Source for ${field}.` }]);
        if (ownerExtension.origin === "upstream") sources.unshift({ kind: "documented", url: "https://models.dev", date: input.upstreamDate ?? null, note: imported });
        return sources;
      };
      // What the entry's rates are. A subscription entry is not paid per token, so it has no price of its own: it
      // shows the API list price of the same model, and says whose it is (`reference_ref`). That is the entry it
      // inherits from (step 5b), or the lab's own API entry for its canonical model. One rule for every subscription
      // entry, imported or added. An entry providers.dev added with a price of its own keeps that price.
      const named = extension.inherited?.fields.includes("cost") ? extension.inherited.from : null;
      const ownPrice = extension.origin === "added" && model.cost !== undefined && named === null;
      const reference = extension.access !== "subscription" || ownPrice ? null : named ?? labEntry(model);
      const priced = (reference ? lookup(reference) : undefined) ?? model;
      const sourceDeclaration = reference ? pricingDeclarations.get(priced) : undefined;
      const priceDeclaration = pricingDeclarations.get(model) ?? (sourceDeclaration ? { ...sourceDeclaration, billing: "reference" as const, reference_ref: reference } : undefined);
      const priceNote = reference
        ? `The cost models.dev records for ${reference}: the API list price this subscription entry refers to. Rules are in the order models.dev applies them.`
        : "The cost models.dev records for this entry. Rules are in the order models.dev applies them: base prices, overrides in their order, then multipliers.";
      const pricing = pricingOf(priced, extension.access, reference, sourcesOf(priced, "cost", priceNote), priceDeclaration);
      const requestControls = controlsOf(model, cache.retention, sourcesOf(model, "capabilities", "Imported capabilities; corrections are recorded in providers_dev.provenance."), controlDeclarations.get(model));
      // A declaration made for this entry by name is evidence about the entry. One that reached it through a
      // provider-wide selection is not: its source stays with the control.
      const wide = providerWide.get(model);
      const declared = [
        ...(declaration && !wide?.has("cache.retention") ? declaration.evidence : []),
        ...(pricingDeclarations.get(model)?.evidence ?? []),
        ...(controlDeclarations.get(model) ?? []).filter((control) => !wide?.has(control.id)).flatMap((control) => control.evidence),
      ].flatMap((source): Evidence[] => (source.date === null ? [] : [{ kind: source.kind, url: source.url, date: source.date, note: source.note }]));
      const evidence: Evidence[] = [...(extension.evidence ?? [])];
      for (const source of declared) {
        if (!evidence.some((item) => item.kind === source.kind && item.url === source.url && item.date === source.date && (item.note ?? null) === (source.note ?? null))) evidence.push(source);
      }
      const verified = newestDate([
        ...evidence.map((e) => e.date),
        ...(extension.provenance ?? []).flatMap((p) => p.evidence.map((e) => e.date)),
        ...own.map((m) => m.date),
        ...(extension.limits?.measured ?? []).map((m) => m.date ?? undefined),
      ]);
      // One fixed set of keys, in one order, on every entry.
      const published: ModelExtension = {
        origin: extension.origin,
        access: extension.access,
        provenance: publishProvenance(extension.provenance),
        inherited: extension.inherited ?? null,
        cache,
        pricing,
        request_controls: requestControls,
        limits: { measured: extension.limits?.measured ?? [], from_measurement: extension.limits?.from_measurement ?? [] },
        evidence: publishEvidence(evidence),
        verified: verified ?? null,
      };
      model[NS] = published as unknown as Json;
    }
    const draft = provExt(provider);
    const publishedProvider: ProviderExtension = {
      origin: draft.origin,
      access: draft.access,
      access_basis: draft.access_basis,
      access_reviewed: draft.access_reviewed,
      access_source: draft.access_source ?? null,
      note: draft.note ?? null,
      evidence: publishEvidence(draft.evidence),
      provenance: publishProvenance(draft.provenance),
    };
    provider[NS] = publishedProvider as unknown as Json;
    provider.models = sortKeys(provider.models);
    sorted[id] = provider;
  }

  for (const [id, provider] of Object.entries(sorted)) {
    if (provider.id !== id) issues.push({ level: "error", code: "invalid-authored", target: id, message: `Provider key "${id}" does not match its id "${provider.id}".` });
    for (const [modelId, model] of Object.entries(provider.models)) {
      if (model.id !== modelId || typeof model.name !== "string" || !model.name) {
        issues.push({ level: "error", code: "invalid-authored", target: `${id}/${modelId}`, message: "Every entry needs an id that matches its key and a name." });
      }
    }
  }

  return { catalog: sorted, issues, exclusions };
}

function applyPatch(
  target: JsonObject,
  patch: JsonObject,
  reason: string,
  evidence: Evidence[],
  ref: string,
  extension: { provenance?: DraftProvenance[] },
  issues: Issue[],
): void {
  const changes: Change[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const merged = mergePatch(target[key], value, changes, key);
    if (merged === undefined) delete target[key];
    else target[key] = merged;
  }
  for (const change of changes) {
    if (change.redundant) {
      issues.push({
        level: "notice",
        code: "redundant-override",
        target: `${ref}#${change.path}`,
        message: `Upstream now agrees with our override of ${change.path} on ${ref}. The override can be removed.`,
      });
      continue;
    }
    (extension.provenance ??= []).push({ ...change, reason, evidence });
  }
}

export { isObject };
