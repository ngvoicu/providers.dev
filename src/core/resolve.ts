// resolve(): upstream snapshot + our additions + our overrides + our measurements -> the published catalog.
// Pure: no files, no network, no clock. The same inputs always give the same output.
import { clone, isObject, mergePatch, type Change, type Json, type JsonObject } from "./merge.ts";
import {
  NS,
  type AccessRules,
  type AuthoredProvider,
  type Catalog,
  type Evidence,
  type Exclusion,
  type Issue,
  type MeasuredLimit,
  type MeasurementLabels,
  type Measurement,
  type ModelExtension,
  type ObservedFile,
  type OverrideFile,
  type ProviderExtension,
  type Provenance,
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
}

export interface ResolveResult {
  catalog: Catalog;
  issues: Issue[];
  exclusions: Exclusion[];
}

/** What an entry we add may take from the upstream entry it names: who the model is, never how this access behaves. */
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

function modelExt(model: JsonObject): ModelExtension {
  return model[NS] as unknown as ModelExtension;
}
function provExt(provider: JsonObject): ProviderExtension {
  return provider[NS] as unknown as ProviderExtension;
}

/** `provider/model`: provider ids never contain a slash, model ids often do. */
export function splitRef(ref: string): { provider: string; model: string } | null {
  const at = ref.indexOf("/");
  if (at <= 0 || at === ref.length - 1) return null;
  return { provider: ref.slice(0, at), model: ref.slice(at + 1) };
}

function classify(id: string, rules: AccessRules): Pick<ProviderExtension, "access" | "access_basis" | "access_reviewed" | "access_source"> {
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
      exclusions.push({ target: file.provider, reason: file.exclude.reason, evidence: file.exclude.evidence });
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
      for (const id of rule.models) {
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
          exclusions.push({ target, reason: rule.reason, evidence: rule.evidence });
          continue;
        }
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

  // 5. Measurements land on the entry they were taken on. They never replace a documented value.
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
      const measurement: Measurement = {
        run: run.id.slice(run.id.lastIndexOf("/") + 1),
        route: run.route,
        route_label: routeLabel(run.route),
        ...clientOf(run.client),
        ...(run.options && Object.keys(run.options).length > 0 ? { options: run.options as JsonObject } : {}),
        date: run.date,
        ...(run.control ? { control: { warm: run.control.warm, total: run.control.total } } : {}),
        ...(run.checks ? { checks: run.checks.map((c) => ({ age_s: c.age_s, warm: c.warm, total: c.total })) } : {}),
        ...(run.late_excluded ? { late_excluded: run.late_excluded } : {}),
        all_warm_through_s: run.all_warm_through_s ?? null,
        last_warm_s: run.last_warm_s ?? null,
        first_all_cold_s: run.first_all_cold_s ?? null,
        ...(note ? { note } : {}),
        source: sourceUrl(run.source),
      };
      const extension = modelExt(model);
      extension.cache ??= {};
      (extension.cache.observed ??= []).push(measurement);
    }

    for (const limit of observed.limits) {
      const { ref, model } = targetOf(limit);
      if (!model) {
        orphan(ref, limit.route);
        continue;
      }
      const date = /(\d{4}-\d{2}-\d{2})/.exec(limit.source)?.[1];
      const limitNote = publicNote(limit.note);
      const measured: MeasuredLimit = {
        route: limit.route,
        route_label: routeLabel(limit.route),
        ...clientOf(limit.client),
        ...(typeof limit.context === "number" ? { context: limit.context } : {}),
        ...(typeof limit.output === "number" ? { output: limit.output } : {}),
        ...(limit.input_accepted !== undefined ? { input_accepted: limit.input_accepted } : {}),
        ...(limit.input_refused !== undefined ? { input_refused: limit.input_refused } : {}),
        ...(limit.output_accepted !== undefined ? { output_accepted: limit.output_accepted } : {}),
        ...(limitNote ? { note: limitNote } : {}),
        ...(date ? { date } : {}),
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
          if (value === undefined || limits[field] !== undefined) continue;
          limits[field] = value;
          (extension.limits.from_measurement ??= []).push(field);
        }
        if (Object.keys(limits).length === 0) delete model.limit;
      }
    }
  }

  // 6. Deterministic order, and the newest date of our own evidence per entry.
  const sorted: Catalog = {};
  for (const id of Object.keys(catalog).sort()) {
    const provider = catalog[id] as PublishedProvider;
    for (const model of Object.values(provider.models)) {
      const extension = modelExt(model);
      extension.cache?.observed?.sort((a, b) => b.date.localeCompare(a.date) || a.run.localeCompare(b.run));
      const verified = newestDate([
        ...(extension.evidence ?? []).map((e) => e.date),
        ...(extension.provenance ?? []).flatMap((p) => p.evidence.map((e) => e.date)),
        ...(extension.cache?.observed ?? []).map((m) => m.date),
        ...(extension.limits?.measured ?? []).map((m) => m.date),
      ]);
      if (verified) extension.verified = verified;
    }
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
  extension: { provenance?: Provenance[] },
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

export function isOurs(model: JsonObject): boolean {
  const extension = modelExt(model);
  return (
    extension.origin === "added" ||
    Boolean(extension.provenance?.length) ||
    Boolean(extension.cache?.observed?.length) ||
    Boolean(extension.limits?.measured?.length)
  );
}

export { isObject };
