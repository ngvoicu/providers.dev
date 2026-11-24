// The listing: the model list of one provider and access method (design: Provimux's model-lists.md, section 4).
// What the vendor's own list said, read on a date through a named client, completed by sourced statements. It
// belongs to a provider of the catalog. It is not a set of entries: a listed model need not have one.
//
// The sources, in one fixed order: `listed` (groundtruth's discovery, listed.json), `providers.dev` (an authored list
// or statement, data/authored/listings/), `models.dev` (the imported entries of the provider), `pi.dev` (pi's models
// of the provider). The models of a listing are every model any of them lists for the provider (since 1.6.0; before,
// the first source's list was taken whole), and each model names the sources that list it (`listed_by`); each field of
// a model is from the first source that states it, and the model names that source per field.
//
// Nothing here is written into an entry: a listing is a resource of its own, and no value of it reaches an entry's
// `limit` or a safe value.

import { ext, type AuthoredListing, type Catalog, type Issue, type ListedFile, type ListedModel, type ListingFields, type PublishedModel } from "./schema.ts";

export const LISTING_SOURCES = ["listed", "providers.dev", "models.dev", "pi.dev"] as const;
export type ListingSource = (typeof LISTING_SOURCES)[number];

export interface ListingReasoning {
  /** The model reasons (thinks) at all. Null = no source says. */
  supported: boolean | null;
  /** The levels a request can ask for, in the source's order. Null = not stated; [] = the source states none. */
  levels: string[] | null;
  budget_min: number | null;
  budget_max: number | null;
  /** Thinking can be turned off. */
  can_disable: boolean | null;
  /** The model may choose its own budget. */
  dynamic: boolean | null;
  /** The vendor's word for "off" where it is not the usual one. */
  disable_with: string | null;
}

export type ListingReasoningSources = { [K in keyof ListingReasoning]: ListingSource | null };

export interface ListingSources {
  name: ListingSource | null;
  owner: ListingSource | null;
  released: ListingSource | null;
  context_window: ListingSource | null;
  max_input: ListingSource | null;
  max_output: ListingSource | null;
  input_modalities: ListingSource | null;
  output_modalities: ListingSource | null;
  reasoning: ListingReasoningSources;
  web_search: ListingSource | null;
  aliases: ListingSource | null;
  variants: ListingSource | null;
  plans: ListingSource | null;
  hidden: ListingSource | null;
}

export interface ListingModel {
  /** The id a request names on this access method. */
  id: string;
  name: string | null;
  /** The lab that makes the model. */
  owner: string | null;
  /** The catalog entry of this model on this provider. Null = listed, not evaluated or imported as an entry. */
  entry: { provider: string; model: string } | null;
  /** The canonical model of that entry. Null without an entry, or where the entry names none. */
  canonical: string | null;
  released: string | null;
  context_window: number | null;
  max_input: number | null;
  max_output: number | null;
  input_modalities: string[] | null;
  output_modalities: string[] | null;
  /** Null = no source says anything about reasoning. */
  reasoning: ListingReasoning | null;
  /** The access method runs the vendor's own web search for this model. */
  web_search: boolean | null;
  /** Other ids the access method accepts for the model. [] = none stated. */
  aliases: string[];
  /** The vendor's own ids where it has one id per reasoning level (Devin). [] where `id` is what a request names. */
  variants: string[];
  /** Plan names the vendor's list itself attaches to the model. [] = the list names none. No prices, allowances or quotas. */
  plans: string[];
  /** The vendor's list marks the model as not shown in pickers. Null = not stated. */
  hidden: boolean | null;
  /** The sources whose list names this model, in the fixed order of LISTING_SOURCES. Never empty. Since 1.6.0. */
  listed_by: ListingSource[];
  sources: ListingSources;
}

/** One source's list of a provider, in a listing: when it was read and how many models it names. */
export interface ListingList {
  /** The day the source was read: the discovery's date, the import's date, or the newest evidence of an authored list. */
  listed_at: string | null;
  /** How many models this source's list names. */
  model_count: number;
}

/** Per source, its list of the provider. Null = the source has no list for it. Since 1.6.0. */
export type ListingLists = { [K in ListingSource]: ListingList | null };

export interface ListingEvidence {
  kind: "documented" | "measured" | "listed";
  url: string;
  date: string;
  note: string | null;
}

export interface Listing {
  provider: string;
  /** The highest-ranked source that has a list for the provider. Since 1.6.0 not the only one: see `lists`. */
  basis: ListingSource;
  /** The date that source was read: the discovery's date, the import's date, or the newest evidence of an authored list. */
  listed_at: string | null;
  /** Every source's list, with its date. Since 1.6.0. */
  lists: ListingLists;
  /** For `listed`: the public id of the client that read the vendor's list. Null otherwise. */
  client: string | null;
  client_label: string | null;
  evidence: ListingEvidence[];
  model_count: number;
  /** Null in a list without view=full. */
  models: ListingModel[] | null;
}

export const emptyReasoningSources = (): ListingReasoningSources => ({
  supported: null,
  levels: null,
  budget_min: null,
  budget_max: null,
  can_disable: null,
  dynamic: null,
  disable_with: null,
});

// ---- the build: every listing, worked out once when the data is built (scripts/lib/publish.ts).

/** One provider's part of the discovery file (listed.json), as the build reads it. */
export interface ListedProvider {
  /** The day the vendor's list was read. */
  date: string;
  /** The raw client id, as in the file. */
  client: string;
  models: ListedModel[];
}

/**
 * The evidence link of a listed listing: groundtruth's discovery file on GitHub. A constant: nothing of the file, its
 * `repository` included, decides where a published link points.
 */
export const LISTED_PAGE = "https://github.com/ngvoicu/groundtruth/blob/main/listed.json";
/** The reasoning levels taken from a vendor's list; any other word is dropped from the row. */
export const LISTED_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
/** The kinds of input and output taken from a vendor's list; a media type is read as its kind first (kinds()). */
export const LISTED_MODALITIES = ["text", "image", "audio", "video", "pdf"] as const;
/**
 * The plan names taken from a vendor's list, single words (the values of Codex's `available_in_plans`, Claude's and
 * Kimi's plan names), compared in lower case. Anything else is dropped from the row: a plan name never carries a
 * figure, a price or a quota.
 */
export const LISTED_PLANS = ["free", "go", "plus", "pro", "team", "business", "enterprise", "edu", "education", "max"] as const;

/**
 * The discovery file as the sync stores it (data/sources/listed.json, committed): what the site reads of it and
 * nothing else. Per provider its date and client; per model the id and what takeListed takes, in the file's own shape.
 * Every other field (name, owner, released, aliases, variants, description, disable_with, repository, and any other)
 * is left out, so no text of the file is kept. Reading the stored copy gives what reading the file gives.
 */
export function storedListed(file: ListedFile): ListedFile {
  const model = (source: ListedModel): ListedModel => {
    const taken = takeListed(source);
    const out: Record<string, unknown> = { id: source.id };
    for (const key of ["context_window", "max_input", "max_output", "input_modalities", "output_modalities", "web_search", "plans", "hidden"] as const) if (key in taken) out[key] = taken[key];
    const reasoning: Record<string, unknown> = {};
    for (const key of ["supported", "levels", "budget_min", "budget_max", "can_disable", "dynamic"] as const) if (`reasoning.${key}` in taken) reasoning[key] = taken[`reasoning.${key}`];
    if (Object.keys(reasoning).length > 0) out.reasoning = reasoning;
    return out as ListedModel;
  };
  return {
    schema: 1,
    providers: Object.fromEntries(Object.entries(file.providers).map(([id, part]) => [id, { date: part.date, client: part.client, models: part.models.map(model) }])),
  };
}

/**
 * What the build takes from a model of the discovery file: only values that cannot carry text. Numbers and booleans as
 * they are; levels, modalities and plans from the fixed lists above, anything else dropped; no name, owner, release
 * date, alias, variant, description or word for "off".
 */
export function takeListed(model: ListedModel): Statement {
  const out: Statement = {};
  for (const key of ["context_window", "max_input", "max_output", "web_search", "hidden"] as const) if (model[key] !== undefined) out[key] = model[key];
  const only = (values: readonly string[] | undefined, allowed: readonly string[], read: (value: string) => string = (value) => value.toLowerCase()) =>
    values === undefined ? undefined : [...new Set(values.map(read).filter((value) => allowed.includes(value)))];
  const input = only(model.input_modalities, LISTED_MODALITIES, (value) => kinds([value])[0]!.toLowerCase());
  const output = only(model.output_modalities, LISTED_MODALITIES, (value) => kinds([value])[0]!.toLowerCase());
  const plans = only(model.plans, LISTED_PLANS);
  // A list that kept nothing of what the vendor wrote states nothing.
  if (input?.length) out.input_modalities = input;
  if (output?.length) out.output_modalities = output;
  if (plans !== undefined && (plans.length > 0 || model.plans!.length === 0)) out.plans = plans;
  const reasoning = model.reasoning;
  if (reasoning) {
    for (const key of ["supported", "budget_min", "budget_max", "can_disable", "dynamic"] as const) if (reasoning[key] !== undefined) out[`reasoning.${key}`] = reasoning[key];
    const levels = only(reasoning.levels, LISTED_LEVELS);
    if (levels !== undefined && (levels.length > 0 || reasoning.levels!.length === 0)) out["reasoning.levels"] = levels;
  }
  return out;
}

// pi's models of a provider come as plain facts, handed over by the fence (scripts/lib/pi-fence.ts). Their shape is
// pi's module's; this module imports only the types.
import type { PiList, PiListModel } from "./pi.ts";

export interface ListingsInput {
  /** The published catalog, after every override and exclusion. */
  catalog: Catalog;
  /** The day of the models.dev import. */
  upstreamDate: string;
  /**
   * The models.dev models a catalog rule leaves out of the catalog (an editorial choice: it says what providers.dev
   * lists as entries, not what a provider offers), by ref, with the model as imported. They stay in models.dev's list
   * of their provider, with no entry. A model an override excludes, with evidence, is not one of them.
   */
  ruledOut?: { ref: string; model: PublishedModel }[];
  authored: AuthoredListing[];
  /** The discovery file; undefined = there is none. */
  listed?: { providers: Record<string, ListedProvider> };
  /** The public id and label of a raw client id (data/authored/measurement-labels.yaml). */
  client?: (raw: string) => { id: string; label: string };
  /** The address models.dev is imported from: the evidence of a value an added entry inherits from models.dev. */
  upstreamSource?: string;
  /** pi's lists; undefined = no pi data in this dataset. */
  pi?: { date: string | null; lists: PiList[] };
  /**
   * The entries an override leaves out, with evidence, by ref (`provider/model`): providers.dev states that the
   * provider does not offer them. No source brings one back into its provider's listing. Required, so that no caller
   * builds the listings without them: [] = none.
   */
  excluded: string[];
}

const REASONING_KEYS = ["supported", "levels", "budget_min", "budget_max", "can_disable", "dynamic", "disable_with"] as const;
const PLAIN_KEYS = ["name", "owner", "released", "context_window", "max_input", "max_output", "input_modalities", "output_modalities", "web_search", "aliases", "variants", "plans", "hidden"] as const;
type PlainKey = (typeof PLAIN_KEYS)[number];
type ReasoningKey = (typeof REASONING_KEYS)[number];

/**
 * What one source states of one model: a field and its value. A key that is absent is not stated, and the next source
 * is asked. A key whose value is null is stated as unknown on purpose (a providers.dev correction that publishes a
 * field as unknown or removes it): the field is null, and no later source fills it.
 */
type Statement = Partial<Record<PlainKey | `reasoning.${ReasoningKey}`, unknown>>;

function statementOf(fields: ListingFields): Statement {
  const out: Statement = {};
  for (const key of PLAIN_KEYS) if (fields[key] !== undefined) out[key] = fields[key];
  if (fields.input_modalities) out.input_modalities = kinds(fields.input_modalities);
  if (fields.output_modalities) out.output_modalities = kinds(fields.output_modalities);
  for (const key of REASONING_KEYS) if (fields.reasoning?.[key] !== undefined) out[`reasoning.${key}`] = fields.reasoning[key];
  return out;
}

/**
 * The kinds of a list of modalities, in their order, each once: a media type is read as its kind (image/png is image,
 * application/pdf is pdf, text/csv is text); any other word stays as written.
 */
export function kinds(modalities: readonly string[]): string[] {
  const kind = (value: string): string => {
    const lower = value.toLowerCase();
    if (lower === "application/pdf") return "pdf";
    const slash = lower.indexOf("/");
    const head = slash < 0 ? lower : lower.slice(0, slash);
    return ["text", "image", "audio", "video"].includes(head) ? head : value;
  };
  return [...new Set(modalities.map(kind))];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const positive = (value: unknown): number | undefined => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined);

/** The fields of an entry, each with the path of the entry it is read from. */
const ENTRY_PATHS: Partial<Record<PlainKey | `reasoning.${ReasoningKey}`, string>> = {
  name: "name",
  owner: "canonical_id",
  released: "release_date",
  context_window: "limit.context",
  max_input: "limit.input",
  max_output: "limit.output",
  input_modalities: "modalities.input",
  output_modalities: "modalities.output",
  "reasoning.supported": "capabilities.reasoning.supported",
  "reasoning.levels": "capabilities.reasoning.effort",
  "reasoning.budget_min": "capabilities.reasoning.budget.min",
  "reasoning.budget_max": "capabilities.reasoning.budget.max",
  "reasoning.can_disable": "capabilities.reasoning.toggle",
};

/** What an entry of the catalog states, read from the entry as published. */
function entryStatement(model: PublishedModel): Statement {
  const limit = isRecord(model.limit) ? model.limit : {};
  const modalities = isRecord(model.modalities) ? model.modalities : {};
  const reasoning = isRecord(model.capabilities) && isRecord(model.capabilities.reasoning) ? model.capabilities.reasoning : {};
  const budget = isRecord(reasoning.budget) ? reasoning.budget : {};
  const strings = (value: unknown): string[] | undefined => (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string") ? (value as string[]) : undefined);
  const out: Statement = {};
  const put = (key: keyof Statement, value: unknown): void => {
    if (value !== undefined) out[key] = value;
  };
  put("name", typeof model.name === "string" && model.name ? model.name : undefined);
  put("owner", typeof model.canonical_id === "string" && model.canonical_id.includes("/") ? model.canonical_id.slice(0, model.canonical_id.indexOf("/")) : undefined);
  put("released", typeof model.release_date === "string" && model.release_date ? model.release_date : undefined);
  put("context_window", positive(limit.context));
  put("max_input", positive(limit.input));
  put("max_output", positive(limit.output));
  const input = strings(modalities.input);
  const output = strings(modalities.output);
  put("input_modalities", input ? kinds(input) : undefined);
  put("output_modalities", output ? kinds(output) : undefined);
  put("reasoning.supported", typeof reasoning.supported === "boolean" ? reasoning.supported : undefined);
  put("reasoning.levels", Array.isArray(reasoning.effort) && reasoning.effort.every((item) => typeof item === "string") ? reasoning.effort : undefined);
  put("reasoning.budget_min", typeof budget.min === "number" && Number.isSafeInteger(budget.min) && budget.min >= 0 ? budget.min : undefined);
  put("reasoning.budget_max", typeof budget.max === "number" && Number.isSafeInteger(budget.max) && budget.max >= 0 ? budget.max : undefined);
  put("reasoning.can_disable", typeof reasoning.toggle === "boolean" ? reasoning.toggle : undefined);
  return out;
}

/**
 * An entry's statement, split by who made each value: providers.dev for an entry it added and for a field it corrected
 * (a correction of the field, of a part of it, or of a field it is part of), models.dev for the rest. A field
 * providers.dev publishes as unknown or removed is stated as unknown by providers.dev.
 */
function entryStatements(model: PublishedModel): { providersDev: Statement; modelsDev: Statement } {
  const own = ext(model);
  const read = entryStatement(model);
  if (own.origin === "added") {
    // An added entry's values are providers.dev's, but for the identity fields it inherits from a models.dev entry
    // (`inherited.fields`): those are models.dev's, and say so.
    const inherited = new Set(own.inherited?.fields ?? []);
    const providersDev: Statement = {};
    const modelsDev: Statement = {};
    for (const [key, path] of Object.entries(ENTRY_PATHS) as [keyof Statement, string][]) {
      if (!(key in read)) continue;
      // A providers.dev override of the field credits providers.dev, inherited or not.
      const corrected = own.provenance.some((change) => change.path === path || change.path.startsWith(`${path}.`) || path.startsWith(`${change.path}.`));
      if (inherited.has(path.split(".")[0]!) && !corrected) modelsDev[key] = read[key];
      else providersDev[key] = read[key];
    }
    return { providersDev, modelsDev };
  }
  const providersDev: Statement = {};
  const modelsDev: Statement = {};
  for (const [key, path] of Object.entries(ENTRY_PATHS) as [keyof Statement, string][]) {
    const corrections = own.provenance.filter((change) => change.path === path || change.path.startsWith(`${path}.`) || path.startsWith(`${change.path}.`));
    if (corrections.length === 0) {
      if (key in read) modelsDev[key] = read[key];
    } else if (key in read) providersDev[key] = read[key];
    else if (corrections.some((change) => change.op !== "set")) providersDev[key] = null;
  }
  return { providersDev, modelsDev };
}

/** The first source that states each field, and the model it makes. */
function merged(id: string, listedBy: ListingSource[], statements: [ListingSource, Statement][], entry: { provider: string; model: string } | null, canonical: string | null): ListingModel {
  const pick = (key: keyof Statement): { value: unknown; source: ListingSource | null } => {
    for (const [source, statement] of statements) {
      if (!(key in statement)) continue;
      const value = statement[key];
      return value === null || value === undefined ? { value: null, source: null } : { value, source };
    }
    return { value: null, source: null };
  };
  const plain = Object.fromEntries(PLAIN_KEYS.map((key) => [key, pick(key)])) as Record<PlainKey, { value: unknown; source: ListingSource | null }>;
  const reasoning = Object.fromEntries(REASONING_KEYS.map((key) => [key, pick(`reasoning.${key}`)])) as Record<ReasoningKey, { value: unknown; source: ListingSource | null }>;
  // One rule against contradictions in a row, after merging: of two fields that contradict each other, the one from
  // the lower source is dropped; where one source states both, the window (or `supported`) is kept and the other
  // dropped. Two pairs can contradict: max_input or max_output above the window, and levels beside supported: false.
  const rank = (source: ListingSource | null): number => (source === null ? LISTING_SOURCES.length : LISTING_SOURCES.indexOf(source));
  const none = { value: null, source: null };
  const settle = (keep: { value: unknown; source: ListingSource | null }, other: { value: unknown; source: ListingSource | null }): "keep" | "other" => (rank(other.source) < rank(keep.source) ? "other" : "keep");
  for (const key of ["max_input", "max_output"] as const) {
    const window = plain.context_window;
    const limit = plain[key];
    if (window.source === null || limit.source === null || (limit.value as number) <= (window.value as number)) continue;
    if (settle(window, limit) === "keep") plain[key] = none;
    else plain.context_window = none;
  }
  const levels = reasoning.levels;
  if (reasoning.supported.value === false && levels.source !== null && (levels.value as string[]).length > 0) {
    if (settle(reasoning.supported, levels) === "keep") reasoning.levels = none;
    else reasoning.supported = none;
  }
  // A model no source names is named by its id, from the first list that has it: no name is ever taken from the
  // discovery file.
  if (plain.name.value === null) plain.name = { value: id, source: listedBy[0]! };
  const list = (key: "aliases" | "variants" | "plans"): string[] => (plain[key].value as string[] | null) ?? [];
  const anyReasoning = REASONING_KEYS.some((key) => reasoning[key].source !== null);
  return {
    id,
    name: plain.name.value as string | null,
    owner: plain.owner.value as string | null,
    entry,
    canonical,
    released: plain.released.value as string | null,
    context_window: plain.context_window.value as number | null,
    max_input: plain.max_input.value as number | null,
    max_output: plain.max_output.value as number | null,
    input_modalities: plain.input_modalities.value as string[] | null,
    output_modalities: plain.output_modalities.value as string[] | null,
    reasoning: anyReasoning ? (Object.fromEntries(REASONING_KEYS.map((key) => [key, reasoning[key].value])) as unknown as ListingReasoning) : null,
    web_search: plain.web_search.value as boolean | null,
    aliases: list("aliases"),
    variants: list("variants"),
    plans: list("plans"),
    hidden: plain.hidden.value as boolean | null,
    listed_by: listedBy,
    sources: {
      name: plain.name.source,
      owner: plain.owner.source,
      released: plain.released.source,
      context_window: plain.context_window.source,
      max_input: plain.max_input.source,
      max_output: plain.max_output.source,
      input_modalities: plain.input_modalities.source,
      output_modalities: plain.output_modalities.source,
      reasoning: Object.fromEntries(REASONING_KEYS.map((key) => [key, reasoning[key].source])) as unknown as ListingReasoningSources,
      web_search: plain.web_search.source,
      aliases: plain.aliases.source,
      variants: plain.variants.source,
      plans: plain.plans.source,
      hidden: plain.hidden.source,
    },
  };
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const evidenceOf = (item: { kind: ListingEvidence["kind"]; url: string; date: string; note?: string | undefined }): ListingEvidence => ({ kind: item.kind, url: item.url, date: item.date, note: item.note ?? null });

/**
 * Every listing of the dataset, by provider id, and what does not fit. A provider has a listing where any source has a
 * list for it: its models are every model any source lists, the highest source's first, in its order, then each next
 * source's models not yet named, in its order; each model names the sources that list it; each field is from the first
 * source that states it.
 */
export function buildListings(input: ListingsInput): { listings: Listing[]; issues: Issue[] } {
  const issues: Issue[] = [];
  const { catalog } = input;
  const authored = new Map<string, AuthoredListing>();
  for (const file of input.authored) {
    if (!Object.hasOwn(catalog, file.provider)) {
      issues.push({ level: "warning", code: "listing-provider-unknown", target: `listings/${file.provider}`, message: `data/authored/listings/${file.provider}.yaml names a provider the catalog does not have. Nothing of it is published.` });
      continue;
    }
    authored.set(file.provider, file);
  }
  const listed = input.listed?.providers ?? {};
  // Counted, not named: no key of the discovery file reaches /api/v1/meta.
  const unknown = Object.keys(listed).filter((id) => !Object.hasOwn(catalog, id)).length;
  if (unknown > 0) issues.push({ level: "warning", code: "listed-provider-unknown", target: "listed", message: `The discovery file lists ${unknown} provider${unknown === 1 ? "" : "s"} the catalog does not have. ${unknown === 1 ? "Its list is" : "Their lists are"} not published.` });
  const piLists = new Map((input.pi?.lists ?? []).map((list) => [list.provider, list]));
  const ruledOut = new Map<string, Map<string, PublishedModel>>();
  for (const { ref, model } of input.ruledOut ?? []) {
    const slash = ref.indexOf("/");
    const providerId = ref.slice(0, slash);
    (ruledOut.get(providerId) ?? ruledOut.set(providerId, new Map()).get(providerId)!).set(ref.slice(slash + 1), model);
  }

  const excludedBy = new Map<string, Set<string>>();
  for (const ref of input.excluded) {
    const slash = ref.indexOf("/");
    if (slash < 0) continue;
    const providerId = ref.slice(0, slash);
    (excludedBy.get(providerId) ?? excludedBy.set(providerId, new Set()).get(providerId)!).add(ref.slice(slash + 1));
  }

  const listings: Listing[] = [];
  for (const providerId of Object.keys(catalog).sort(byText)) {
    const provider = catalog[providerId]!;
    const file = authored.get(providerId);
    const discovery = Object.hasOwn(listed, providerId) ? listed[providerId] : undefined;
    const left = ruledOut.get(providerId) ?? new Map<string, PublishedModel>();
    const imported = [...Object.keys(provider.models).filter((id) => ext(provider.models[id]!).origin === "upstream"), ...[...left.keys()].filter((id) => !Object.hasOwn(provider.models, id))].sort(byText);
    const pi = piLists.get(providerId);

    // A model an override leaves out with evidence is left out whatever list names it. Where the vendor's own list
    // names one, a person should look at the override again: a warning names it (the id is the override's own).
    const excluded = excludedBy.get(providerId) ?? new Set<string>();
    const kept = (source: ListingSource, ids: string[]): string[] => {
      const named = new Set<string>();
      return ids.filter((id) => {
        if (!excluded.has(id)) return true;
        if (source === "listed" && !named.has(id)) {
          named.add(id);
          issues.push({ level: "warning", code: "listing-excluded-listed", target: `listings/${providerId}/${id}`, message: `The vendor's own list of ${providerId} names ${id}, which an override in data/authored/overrides/ leaves out with evidence. It is left out of the listing; check whether the override still holds.` });
        }
        return false;
      });
    };

    // Each source's list of the provider, in the fixed order, without the excluded models; a source with no list for
    // it, or whose list names only excluded models, is left out.
    const present: { source: ListingSource; ids: string[]; listedAt: string | null }[] = [];
    const evidence: ListingEvidence[] = [];
    let client: { id: string; label: string } | null = null;
    const fromDiscovery = discovery && discovery.models.length > 0 ? kept("listed", discovery.models.map((model) => model.id)) : [];
    if (discovery && fromDiscovery.length > 0) {
      present.push({ source: "listed", ids: fromDiscovery, listedAt: discovery.date });
      evidence.push({ kind: "listed", url: LISTED_PAGE, date: discovery.date, note: null });
      client = input.client ? input.client(discovery.client) : { id: discovery.client, label: discovery.client };
    }
    const authoredIds = file?.list ? kept("providers.dev", file.list.models) : [];
    if (file?.list && (authoredIds.length > 0 || file.list.models.length === 0)) {
      const own = file.list.evidence.map(evidenceOf);
      present.push({ source: "providers.dev", ids: authoredIds, listedAt: [...own.map((item) => item.date)].sort(byText).at(-1) ?? null });
      evidence.push(...own);
    }
    const importedIds = kept("models.dev", imported);
    if (importedIds.length > 0) present.push({ source: "models.dev", ids: importedIds, listedAt: input.upstreamDate });
    const piIds = pi ? kept("pi.dev", pi.models.map((model) => model.id)) : [];
    if (piIds.length > 0) present.push({ source: "pi.dev", ids: piIds, listedAt: input.pi?.date ?? null });
    if (present.length === 0) continue;
    const basis = present[0]!.source;

    // Every model any list names, once: the highest list's first, in its order, then each next list's new ones. Each
    // list counts a model once: the first time it names it.
    const listedBy = new Map<string, ListingSource[]>();
    const lists: ListingLists = { listed: null, "providers.dev": null, "models.dev": null, "pi.dev": null };
    for (const { source, ids, listedAt } of present) {
      const once = new Set<string>();
      for (const id of ids) {
        if (once.has(id)) {
          issues.push({ level: "warning", code: "listing-model-twice", target: `listings/${providerId}/${id}`, message: `The ${source} list of ${providerId} names ${id} more than once. It is listed once.` });
          continue;
        }
        once.add(id);
        (listedBy.get(id) ?? listedBy.set(id, []).get(id)!).push(source);
      }
      lists[source] = { listed_at: listedAt, model_count: once.size };
    }
    const unique = [...listedBy.keys()];
    const seen = new Set(unique);

    // The rules that apply, each one's evidence once in the listing's evidence.
    const rules = file?.rules ?? [];
    for (const rule of rules) {
      if (rule.models === "all") continue;
      for (const id of rule.models) {
        if (!seen.has(id)) issues.push({ level: "warning", code: "listing-rule-orphan", target: `listings/${providerId}/${id}`, message: `data/authored/listings/${providerId}.yaml has a rule for ${id}, which no list of ${providerId} names. The rule does nothing for it.` });
      }
    }
    const applied = new Set<number>();
    const inheritedFrom: string[] = [];
    const discovered = new Map((discovery?.models ?? []).map((model) => [model.id, model]));
    const piModels = new Map((pi?.models ?? []).map((model) => [model.id, model]));
    const models = unique.map((id) => {
      const statements: [ListingSource, Statement][] = [];
      const found = discovered.get(id);
      if (found) statements.push(["listed", takeListed(found)]);
      rules.forEach((rule, index) => {
        if (rule.models !== "all" && !rule.models.includes(id)) return;
        applied.add(index);
        statements.push(["providers.dev", statementOf(rule.set)]);
      });
      const entry = Object.hasOwn(provider.models, id) ? provider.models[id]! : undefined;
      if (entry) {
        const { providersDev, modelsDev } = entryStatements(entry);
        statements.push(["providers.dev", providersDev], ["models.dev", modelsDev]);
      } else if (left.has(id)) statements.push(["models.dev", entryStatement(left.get(id)!)]);
      const own = entry ? ext(entry) : undefined;
      if (own?.origin === "added" && own.inherited && Object.keys(entryStatements(entry!).modelsDev).length > 0) inheritedFrom.push(`${id} from ${own.inherited.from}`);
      // pi gives no limit to a model whose entry has a measured window: pi's figure would stand beside, and against,
      // what providers.dev measured.
      const measured = (own?.limits?.input_window?.measured_tokens ?? null) !== null;
      const fromPi = piModels.get(id);
      if (fromPi) statements.push(["pi.dev", piStatement(fromPi, measured)]);
      const canonical = entry && typeof entry.canonical_id === "string" ? entry.canonical_id : null;
      return merged(id, listedBy.get(id)!, statements, entry ? { provider: providerId, model: id } : null, canonical);
    });
    if (inheritedFrom.length > 0 && input.upstreamSource) {
      evidence.push({ kind: "listed", url: input.upstreamSource, date: input.upstreamDate, note: `models.dev's records of the models an added entry inherits name, owner and released from: ${inheritedFrom.join(", ")}.` });
    }
    for (const index of [...applied].sort((a, b) => a - b)) {
      for (const item of rules[index]!.evidence.map(evidenceOf)) {
        if (!evidence.some((known) => JSON.stringify(known) === JSON.stringify(item))) evidence.push(item);
      }
    }
    listings.push({ provider: providerId, basis, listed_at: lists[basis]!.listed_at, lists, client: client?.id ?? null, client_label: client?.label ?? null, evidence, model_count: models.length, models });
  }
  return { listings, issues };
}

/** What pi states of a model: its name, window, output limit, input kinds and whether it reasons. A 0 is no statement. */
function piStatement(model: PiListModel, noLimits = false): Statement {
  const out: Statement = { name: model.name, input_modalities: kinds(model.input), "reasoning.supported": model.reasoning };
  if (model.input.length === 0) delete out.input_modalities;
  if (noLimits) return out;
  if (Number.isSafeInteger(model.context_window) && model.context_window > 0) out.context_window = model.context_window;
  if (Number.isSafeInteger(model.max_output) && model.max_output > 0) out.max_output = model.max_output;
  return out;
}
