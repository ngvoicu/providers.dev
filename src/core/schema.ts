// Shapes of everything that enters or leaves the build: the upstream snapshot, our authored files,
// the measurements file, and the published catalog.
import { z } from "zod";
import type { EntryCache } from "./cache.ts";
import type { InputWindow } from "./limits.ts";
import { CacheRetentionDeclarationSchema } from "./cache-contract.ts";
import { ModelMetadataShape } from "./metadata-contract.ts";
import { PricingDeclarationSchema, RequestControlDeclarationsSchema, type Pricing, type RequestControls } from "./policy-contract.ts";
import type { Change, Json, JsonObject } from "./merge.ts";
import type { PiBlock } from "./pi.ts";
import type { ClientKind, SafeValues } from "./safe.ts";

export const UPSTREAM_SCHEMA = "models.dev v2 (experimental)";
/** Everything we add to a provider or model lives under this one key. */
export const NS = "providers_dev";

export const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]*$/;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-13");

// ---- upstream (models.dev v2). Lenient on purpose: we check identity and the fields we read, and keep the rest.
export const UpstreamModel = z.looseObject(ModelMetadataShape);

export const UpstreamProvider = z.looseObject({
  id: z.string().regex(PROVIDER_ID),
  name: z.string().min(1),
  doc: z.string().optional(),
  env: z.array(z.string()).optional(),
  models: z.record(z.string(), UpstreamModel),
});

export const UpstreamCatalog = z.record(z.string(), UpstreamProvider);
export type UpstreamCatalog = z.infer<typeof UpstreamCatalog>;

export interface UpstreamMeta {
  source: string;
  schema: string;
  fetched_at: string;
  checked_at: string;
  etag?: string;
  commit?: string;
  commit_date?: string;
  sha256: string;
  providers: number;
  models: number;
}

/** pi's model catalog, the second imported source (design/pi-source.md). */
export const PI_URL = "https://pi.dev/api/models";

/**
 * data/pi/meta.json: where the pi snapshot came from and when (design/pi-source.md, section a). One definition, checked
 * on what the sync writes and on what it and the build read back: a stored meta that does not fit it is not usable.
 */
export const PiMeta = z.strictObject({
  source: z.string(), // PI_URL, the address the snapshot was read from
  fetched_at: z.string(), // ISO time of the import that wrote the snapshot
  checked_at: z.string(), // ISO time of the last request that confirmed it (a 304 or an equal digest)
  etag: z.string().optional(), // the response's ETag
  last_modified: z.string().optional(), // the response's Last-Modified, as sent
  revision: z.string().optional(), // the response's x-pi-model-catalog-revision, as sent
  sha256: z.string(), // of the response body
  providers: z.int().min(0), // provider keys in the feed
  models: z.int().min(0), // models in the feed
});
export type PiMeta = z.infer<typeof PiMeta>;

/**
 * The `pi` key of data/sync-status.json: the last attempt to import pi's catalog. One definition, checked on what the
 * sync writes and on what the build reads: a record that does not fit counts as no attempt recorded.
 */
export const PiSyncRecord = z.strictObject({
  last_attempt_at: z.string(),
  status: z.enum(["updated", "unchanged", "failed"]),
  error: z.string().optional(),
});
export type PiSyncRecord = z.infer<typeof PiSyncRecord>;

// ---- authored: evidence
export const Evidence = z.strictObject({
  /** documented = the provider says so; measured = we ran it; listed = the provider's own model list reports it. */
  kind: z.enum(["documented", "measured", "listed"]),
  url: z.url(),
  date: isoDate,
  note: z.string().optional(),
});
export type Evidence = z.infer<typeof Evidence>;

export const Access = z.enum(["api", "subscription", "unknown"]);
export type Access = z.infer<typeof Access>;

// ---- authored: providers we add (data/authored/providers/<id>.yaml)
export const AuthoredModel = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  /** `provider/model` of an upstream entry to take identity fields from (never limits, cache or prices). */
  inherits: z.string().optional(),
  fields: z.record(z.string(), z.json()).optional(),
  cache_retention: CacheRetentionDeclarationSchema.optional(),
  pricing: PricingDeclarationSchema.optional(),
  request_controls: RequestControlDeclarationsSchema.optional(),
  evidence: z.array(Evidence).min(1),
});
export type AuthoredModel = z.infer<typeof AuthoredModel>;

export const AuthoredProvider = z.strictObject({
  id: z.string().regex(PROVIDER_ID),
  name: z.string().min(1),
  doc: z.url().optional(),
  access: Access,
  access_basis: z.string().min(1),
  note: z.string().optional(),
  evidence: z.array(Evidence).min(1),
  models: z.array(AuthoredModel).default([]),
});
export type AuthoredProvider = z.infer<typeof AuthoredProvider>;

// ---- authored: overrides on upstream entries (data/authored/overrides/<provider>.yaml)
/**
 * Which entries of the provider a rule is about, by what the source documents for them. For a statement about the
 * provider's API rather than about one model: "at this provider, a request sets the cache lifetime with this field".
 */
export const RuleSelect = z.strictObject({
  /** The way of caching the entry must be documented to support. */
  cache_mode: z.enum(["implicit", "explicit"]),
  /** Lifetimes the entry must document for that mode, all of them, as the source writes them ("5m", "1h"). Left out = any lifetime, or none. */
  cache_ttl: z.array(z.string().min(1)).min(1).optional(),
  /** Only among these model ids: where the provider's page names the models its statement holds for. Left out = every entry of the provider. */
  models: z.array(z.string().min(1)).min(1).optional(),
});
export type RuleSelect = z.infer<typeof RuleSelect>;

export const OverrideRule = z
  .strictObject({
    /** Model ids this rule applies to. */
    models: z.array(z.string().min(1)).min(1).optional(),
    /** Instead of `models`: every entry of the provider that documents this. Only for declaring request controls. */
    select: RuleSelect.optional(),
    /** Fields to merge over the upstream entry. null = explicitly unknown, "$delete" = remove. */
    set: z.record(z.string(), z.json()).optional(),
    cache_retention: CacheRetentionDeclarationSchema.optional(),
    pricing: PricingDeclarationSchema.optional(),
    request_controls: RequestControlDeclarationsSchema.optional(),
    /** True removes the entries from the published catalog (a tombstone). */
    exclude: z.boolean().optional(),
    reason: z.string().min(1),
    evidence: z.array(Evidence).min(1),
  })
  .superRefine((rule, ctx) => {
    if ((rule.models === undefined) === (rule.select === undefined)) ctx.addIssue({ code: "custom", message: "A rule names its entries with `models` or selects them with `select`: exactly one of the two." });
    // A correction changes what is published for an entry, so it names the entry. A selection follows the catalog.
    if (rule.select && (rule.set !== undefined || rule.exclude !== undefined || rule.pricing !== undefined || rule.cache_retention !== undefined)) ctx.addIssue({ code: "custom", path: ["select"], message: "A `select` rule declares `request_controls` only. A correction, an exclusion or a price names its entries with `models`." });
    if (rule.select && !rule.request_controls?.length) ctx.addIssue({ code: "custom", path: ["request_controls"], message: "A `select` rule needs `request_controls`." });
  });
export type OverrideRule = z.infer<typeof OverrideRule>;

export const OverrideFile = z.strictObject({
  provider: z.string().regex(PROVIDER_ID),
  /** Tombstone for the whole provider. */
  exclude: z
    .strictObject({ reason: z.string().min(1), evidence: z.array(Evidence).min(1) })
    .optional(),
  /** Fields to merge over the provider itself (not its models). */
  set: z.record(z.string(), z.json()).optional(),
  set_reason: z.string().optional(),
  set_evidence: z.array(Evidence).optional(),
  rules: z.array(OverrideRule).default([]),
});
export type OverrideFile = z.infer<typeof OverrideFile>;

// ---- authored: rules over the whole catalog (data/authored/catalog-rules.yaml)
/**
 * Leaves out the versions of a model family before a given one, at every provider, whoever added the entry. An
 * editorial choice of providers.dev, not a statement about a provider: it carries a reason and a date, no evidence.
 */
export const FamilyExclusion = z.strictObject({
  /** Names the rule in /api/v1/meta. */
  id: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/),
  /** The published `family` of the entries the rule looks at, exactly as models.dev writes it; or a list of families that one rule covers. */
  family: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  /**
   * The word next to which the version is written ("opus" in claude-opus-4-1, claude-3-opus), or several words (gpt,
   * chatgpt). The word stands alone: "opus" is not read in "opusdistill" or "magnum-opus".
   */
  word: z.union([z.string().regex(/^[a-z]+$/), z.array(z.string().regex(/^[a-z]+$/)).min(1)]),
  /** The first version that is kept: major, or major.minor. Every version below it is left out, every one from it on is kept. */
  before: z.string().regex(/^\d{1,2}(\.\d)?$/),
  /** Words that, written right after `word` in a model id instead of a version, make the entry an alias that is kept (claude-opus-latest). */
  aliases: z.array(z.string().regex(/^[a-z]+$/)).default([]),
  /** Where the version is read, in this order: the first that has one counts. */
  read: z.array(z.enum(["id", "canonical_id", "name"])).min(1).default(["id", "canonical_id", "name"]),
  /** True: two digits written together right after the word are major and minor (gpt-56 is 5.6, gpt-61 is 6.1). A version 10 or above cannot be told from them. */
  joined_digits: z.boolean().default(false),
  /** An entry of the family with no version where the rule reads: `report` publishes it and reports a dataset issue; `keep` publishes it, silently (a moving alias, a model with numbering of its own). */
  no_version: z.enum(["report", "keep"]).default("report"),
  /** What the rule leaves out, in words, as published. */
  leaves_out: z.string().min(1),
  reason: z.string().min(1),
  /** The day the rule was decided (YYYY-MM-DD). */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type FamilyExclusion = z.infer<typeof FamilyExclusion>;

/** A day (YYYY-MM-DD) that bounds a span of release dates. */
const SpanDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * Leaves out every entry whose published `release_date` falls in a span, at every provider, whatever its family or type.
 * Read from the published release date only. A date given to the month (2025-03) counts as the first day of that
 * month. An entry with no release date, or with one of the file's placeholder dates, is kept.
 */
export const ReleaseExclusion = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/),
    /** The first day of the span (inclusive). Left out = no lower bound. */
    from: SpanDay.optional(),
    /** The first day after the span (exclusive). Left out = no upper bound. */
    before: SpanDay.optional(),
    leaves_out: z.string().min(1),
    reason: z.string().min(1),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .superRefine((rule, ctx) => {
    if (rule.from === undefined && rule.before === undefined) ctx.addIssue({ code: "custom", message: "A release rule needs `from`, `before` or both." });
    if (rule.from !== undefined && rule.before !== undefined && rule.from >= rule.before) ctx.addIssue({ code: "custom", path: ["before"], message: "`before` must be after `from`." });
  });
export type ReleaseExclusion = z.infer<typeof ReleaseExclusion>;

export const CatalogRules = z
  .strictObject({
    exclude: z.array(FamilyExclusion).default([]),
    /** Rules by release date. They apply after every `exclude` rule, to what is still in the catalog. */
    exclude_released: z.array(ReleaseExclusion).default([]),
    /** Release dates that stand for "not known" rather than a date (1970-01-01): an entry with one is kept by every release rule. What the API publishes for it is not changed. */
    placeholder_release_dates: z.array(z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/)).default([]),
  })
  .superRefine((rules, ctx) => {
    const seen = new Set<string>();
    for (const [key, list] of [["exclude", rules.exclude], ["exclude_released", rules.exclude_released]] as const) {
      list.forEach((rule, index) => {
        if (seen.has(rule.id)) ctx.addIssue({ code: "custom", path: [key, index, "id"], message: `Two rules have the id "${rule.id}".` });
        seen.add(rule.id);
      });
    }
  });
export type CatalogRules = z.infer<typeof CatalogRules>;

// ---- authored: access classification (data/authored/access.yaml)
export const AccessRules = z.strictObject({
  default: Access,
  default_basis: z.string(),
  patterns: z.array(z.strictObject({ match: z.string(), access: Access, basis: z.string() })).default([]),
  providers: z.record(z.string(), z.strictObject({ access: Access, basis: z.string(), source: z.url().optional() })).default({}),
});
export type AccessRules = z.infer<typeof AccessRules>;

// ---- authored: where each measured route lands (data/authored/routes.yaml)
export const RouteMap = z.record(z.string(), z.strictObject({ provider: z.string().regex(PROVIDER_ID) }));
export type RouteMap = z.infer<typeof RouteMap>;

// ---- authored: data/authored/pi-aliases.yaml (design/pi-source.md, section c)
const PiModelLine = z.strictObject({
  /** The model id of the entry, at the catalog's provider, that is this pi model under another spelling. */
  same_as: z.string().min(1),
  note: z.string().optional(),
});

const PiProviderLine = z
  .strictObject({
    /** The provider of the catalog that this pi provider id is. Left out where the catalog has the pi id itself. */
    same_as: z.string().regex(PROVIDER_ID).optional(),
    reason: z.string().min(1).optional(),
    evidence: z.array(Evidence).min(1).optional(),
    /** The day the model lines were checked against the report. Required when `models` has a line. */
    checked: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    models: z.record(z.string().min(1), PiModelLine).default({}),
  })
  .superRefine((line, context) => {
    if (line.same_as !== undefined && line.reason === undefined) context.addIssue({ code: "custom", path: ["reason"], message: "A provider line with same_as needs a reason." });
    if (line.same_as !== undefined && line.evidence === undefined) context.addIssue({ code: "custom", path: ["evidence"], message: "A provider line with same_as needs evidence." });
    const lines = Object.keys(line.models).length;
    if (lines > 0 && line.checked === undefined) context.addIssue({ code: "custom", path: ["checked"], message: "A provider line with model lines needs checked, the day they were checked against the report." });
    if (line.same_as === undefined && lines === 0) context.addIssue({ code: "custom", path: [], message: "A provider line needs same_as or at least one model line." });
  });

/** data/authored/pi-aliases.yaml: the adapter between pi's spelling and the catalog's. Only `same_as`, nothing else. */
export const PiAliases = z
  .strictObject({ providers: z.record(z.string().regex(PROVIDER_ID), PiProviderLine).default({}) })
  .superRefine((file, context) => {
    const seen = new Map<string, string>();
    for (const [id, line] of Object.entries(file.providers)) {
      if (line.same_as === undefined) continue;
      const first = seen.get(line.same_as);
      if (first !== undefined) context.addIssue({ code: "custom", path: ["providers", id, "same_as"], message: `Two pi provider ids, ${first} and ${id}, have the same same_as ${line.same_as}. One provider of the catalog is one pi provider.` });
      else seen.set(line.same_as, id);
    }
  });
export type PiAliases = z.infer<typeof PiAliases>;

// ---- authored: public names for the measurement file's clients (data/authored/measurement-labels.yaml)
/** What a client the labels file does not describe is published as. */
export const OTHER_CLIENT = { id: "other", label: "Another client" } as const;

/**
 * The kind of a client as a file writes it (design/sources-side-by-side.md, 2.3): `direct`, `own-client` or `proxy`.
 * `own_client`, the spelling of groundtruth's `client_kinds`, is read the same. Published as `own_client`.
 */
export const ClientKindText = z.enum(["direct", "own-client", "own_client", "proxy"]).transform((kind): ClientKind => (kind === "own-client" ? "own_client" : kind));

// One public client id has one label and one kind: several raw clients may share an id only with the same label and
// kind. So the label and the kind of a published client are functions of its id, and nothing depends on which of its
// evaluations comes first. The id `other` is taken by OTHER_CLIENT and keeps its label.
export const MeasurementLabels = z
  .strictObject({
    clients: z.record(z.string(), z.strictObject({ id: z.string().min(1), label: z.string().min(1), kind: ClientKindText })),
    omit_note_parts_mentioning: z.array(z.string().min(1)).default([]),
  })
  .superRefine((file, ctx) => {
    const seen = new Map<string, { raw: string | null; label: string; kind: ClientKind | null }>([[OTHER_CLIENT.id, { raw: null, label: OTHER_CLIENT.label, kind: null }]]);
    for (const [raw, client] of Object.entries(file.clients)) {
      const before = seen.get(client.id);
      if (!before) {
        seen.set(client.id, { raw, label: client.label, kind: client.kind });
        continue;
      }
      // `other` is a label, not a client: it has no kind of its own.
      if (before.label === client.label && (before.raw === null || before.kind === client.kind)) continue;
      if (before.label === client.label) {
        ctx.addIssue({
          code: "custom",
          path: ["clients", raw, "kind"],
          message: `Public client id "${client.id}" has two kinds: "${before.raw}" (${before.kind}) and "${raw}" (${client.kind}). One public client id has one kind.`,
        });
        continue;
      }
      const first = before.raw === null ? `a client the file does not describe ("${before.label}")` : `"${before.raw}" ("${before.label}")`;
      ctx.addIssue({
        code: "custom",
        path: ["clients", raw, "label"],
        message: `Public client id "${client.id}" has two labels: ${first} and "${raw}" ("${client.label}"). One public client id has one label.`,
      });
    }
  });
export type MeasurementLabels = z.infer<typeof MeasurementLabels>;

// ---- listings (src/core/listings.ts). The fields a source can state of a listed model, written once: an authored
// statement (data/authored/listings/) and a model of the discovery file (listed.json) take the same. A field left out
// is not stated.
//
// Every string has a pattern and a length limit, and none may look like an e-mail address or a credential: what the
// discovery file holds is published as it is, and it is written from the owner's logins. A value that fails refuses
// the whole file (the sync keeps the last good copy).
const nonEmpty = z.string().min(1);
/** An e-mail address anywhere in the text. */
export const EMAIL_SHAPED = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
/**
 * A credential: a known token prefix (OpenAI and Anthropic sk-, GitHub ghp_ gho_ ghu_ ghs_ ghr_ github_pat_, Slack
 * xox., Google AIza and ya29., a JWT's eyJ), or 24 letters and digits in a row, which no model id or name has.
 */
export const TOKEN_SHAPED = /(^|[^a-z0-9])(sk-|gh[opusr]_|github_pat_|xox[a-z]-|aiza|ya29\.|eyj[a-z0-9_-]{8})|[a-z0-9]{24}/i;
const safe = (pattern: RegExp, max: number, what: string) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(pattern, `Not ${what}.`)
    .refine((value) => !EMAIL_SHAPED.test(value), "Looks like an e-mail address.")
    .refine((value) => !TOKEN_SHAPED.test(value), "Looks like a credential.");
/** A model id as a request names it: letters, digits and . _ : / @ + -, at most 128 characters. */
export const ListingModelId = safe(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/, 128, "a model id");
/** A short, plain display name: letters, digits, spaces and . , - _ / + ( ), at most 80 characters. */
const displayName = safe(/^[A-Za-z0-9][A-Za-z0-9 .,_/+()-]*$/, 80, "a plain display name");
/** A lab or a modality or a level: lower-case words. */
const word = (max: number) => safe(/^[a-z0-9][a-z0-9._/+-]*$/, max, "a lower-case word");
/** A plan name: a word or two, no figures with units, prices or quotas. */
const planName = safe(/^[A-Za-z][A-Za-z0-9 ._+-]*$/, 32, "a short plan name");
export const ListingFields = z.strictObject({
  name: displayName.optional(),
  owner: word(64).optional(),
  released: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/, "Use a date like 2026-11-13 or 2026-11.").optional(),
  context_window: z.int().positive().optional(),
  max_input: z.int().positive().optional(),
  max_output: z.int().positive().optional(),
  input_modalities: z.array(word(64)).max(32).optional(),
  output_modalities: z.array(word(64)).max(32).optional(),
  reasoning: z
    .strictObject({
      supported: z.boolean().optional(),
      levels: z.array(word(32)).max(16).optional(),
      budget_min: z.int().min(0).optional(),
      budget_max: z.int().min(0).optional(),
      can_disable: z.boolean().optional(),
      dynamic: z.boolean().optional(),
      disable_with: word(32).optional(),
    })
    .optional(),
  web_search: z.boolean().optional(),
  aliases: z.array(ListingModelId).max(32).optional(),
  variants: z.array(ListingModelId).max(32).optional(),
  plans: z.array(planName).max(16).optional(),
  hidden: z.boolean().optional(),
});
export type ListingFields = z.infer<typeof ListingFields>;

/**
 * data/authored/listings/<provider>.yaml: what providers.dev states of a provider's model list, each statement with a
 * reason and evidence. `list` is an authored list of the provider's models (the second source of a listing's models);
 * `rules` state fields of models, by id or for every model of the listing (`all`).
 */
export const AuthoredListing = z
  .strictObject({
    provider: z.string().regex(PROVIDER_ID),
    list: z
      .strictObject({
        models: z.array(ListingModelId).min(1),
        reason: nonEmpty,
        evidence: z.array(Evidence).min(1),
      })
      .optional(),
    rules: z
      .array(
        z.strictObject({
          models: z.union([z.literal("all"), z.array(ListingModelId).min(1)]),
          set: ListingFields.refine((fields) => Object.keys(fields).length > 0, "Set at least one field."),
          reason: nonEmpty,
          evidence: z.array(Evidence).min(1),
        }),
      )
      .default([]),
  })
  .superRefine((file, ctx) => {
    if (!file.list && file.rules.length === 0) ctx.addIssue({ code: "custom", message: "A listing file needs a list, a rule, or both." });
    if (file.list && new Set(file.list.models).size !== file.list.models.length) ctx.addIssue({ code: "custom", path: ["list", "models"], message: "A model is in the list twice." });
  });
export type AuthoredListing = z.infer<typeof AuthoredListing>;

/**
 * groundtruth's discovery file, listed.json (schema 1), at the root of its repository beside observed.json: per
 * provider of the catalog, the day each vendor's own model list was read, the client that read it, and the models.
 *
 * Only values that cannot carry text are taken from it (`takeListed` in src/core/listings.ts): the model id, with a
 * strict pattern; the numbers; the booleans; reasoning levels, modalities and plan names from fixed lists, anything
 * else in those lists dropped from the row. Text fields (name, owner, released, aliases, variants, description,
 * disable_with) and the file's `repository` are accepted and never read: a listed model's name comes from its entry,
 * else from the id, and the evidence link is a constant of the code. A key the file does not know refuses it.
 */
/** A model id from the discovery file: lower-case letters, digits and . _ : / -, at most 64, no file name. */
export const LISTED_MODEL_ID = /^[a-z0-9][a-z0-9._:/-]{0,63}$/;
const ignored = z.unknown().optional();
const listedId = z
  .string()
  .regex(LISTED_MODEL_ID, "Not a model id.")
  .refine((value) => !/\.(json|ya?ml|txt|env|key|pem)$/.test(value), "Looks like a file name.")
  .refine((value) => !TOKEN_SHAPED.test(value), "Looks like a credential.");
const count = z.int().positive();
const words = z.array(z.string().max(64)).max(64);
export const ListedModel = z.strictObject({
  id: listedId,
  context_window: count.optional(),
  max_input: count.optional(),
  max_output: count.optional(),
  input_modalities: words.optional(),
  output_modalities: words.optional(),
  reasoning: z
    .strictObject({
      supported: z.boolean().optional(),
      levels: words.optional(),
      budget_min: z.int().min(0).optional(),
      budget_max: z.int().min(0).optional(),
      can_disable: z.boolean().optional(),
      dynamic: z.boolean().optional(),
      disable_with: ignored,
    })
    .optional(),
  web_search: z.boolean().optional(),
  plans: words.optional(),
  hidden: z.boolean().optional(),
  // Accepted, never read.
  name: ignored,
  owner: ignored,
  released: ignored,
  aliases: ignored,
  variants: ignored,
  description: ignored,
});
export type ListedModel = z.infer<typeof ListedModel>;
export const ListedFile = z
  .strictObject({
    schema: z.literal(1),
    // Accepted, never read: the evidence link of a listed listing is LISTED_PAGE in src/core/listings.ts.
    repository: ignored,
    providers: z.record(
      z.string().regex(PROVIDER_ID),
      z.strictObject({
        date: isoDate,
        client: z.string().max(64).regex(/^[a-z0-9][a-z0-9+._-]*$/),
        models: z.array(ListedModel).min(1),
      }),
    ),
  })
  .superRefine((file, ctx) => {
    for (const [provider, part] of Object.entries(file.providers)) {
      const seen = new Set<string>();
      part.models.forEach((model, index) => {
        if (seen.has(model.id)) ctx.addIssue({ code: "custom", path: ["providers", provider, "models", index, "id"], message: "A model is listed twice for one provider." });
        seen.add(model.id);
      });
    }
  });
export type ListedFile = z.infer<typeof ListedFile>;

/** The last attempt to fetch the discovery file: the `listed` key of data/sync-status.json. */
export const ListedSyncRecord = z.strictObject({
  last_attempt_at: z.string(),
  /** absent: the repository has no listed.json (no discovery yet); nothing changed. */
  status: z.enum(["updated", "unchanged", "absent", "failed"]),
  error: z.string().optional(),
});
export type ListedSyncRecord = z.infer<typeof ListedSyncRecord>;

// ---- measurements (observed.json from groundtruth)
const check = z.looseObject({ age: z.string().optional(), age_s: z.number(), warm: z.number(), total: z.number() });
export const ObservedRun = z.looseObject({
  id: z.string(),
  route: z.string(),
  client: z.string(),
  model: z.string(),
  models_dev: z.string().nullable().optional(),
  base_model: z.string().nullable().optional(),
  options: z.record(z.string(), z.json()).optional(),
  date: isoDate,
  source: z.string(),
  control: z.looseObject({ warm: z.number(), total: z.number() }).optional(),
  checks: z.array(check).optional(),
  late_excluded: z.number().optional(),
  all_warm_through_s: z.number().nullable().optional(),
  last_warm_s: z.number().nullable().optional(),
  first_all_cold_s: z.number().nullable().optional(),
  latest: z.boolean().optional(),
  /** Set on runs taken with a client that lacked something the route needs; such runs are not published. */
  lacks: z.string().optional(),
  note: z.string().optional(),
})
  // A run has one check result per age: groundtruth keys a run's checks by age, also where one run continues another.
  // A file that holds an age twice is wrong, and is refused rather than read in an order-dependent way.
  .superRefine((run, ctx) => {
    const seen = new Set<number>();
    for (const [index, item] of (run.checks ?? []).entries()) {
      if (seen.has(item.age_s)) {
        ctx.addIssue({ code: "custom", path: ["checks", index, "age_s"], message: `Run "${run.id}" has two checks at age ${item.age_s} s. A run has one check result per age.` });
      }
      seen.add(item.age_s);
    }
  });
export type ObservedRun = z.infer<typeof ObservedRun>;

/** How a limits row is named in a refusal: its route, client and model, the three that make it one row. */
const limitRow = (row: { route: string; client: string; model: string }): string => `The limits row of route "${row.route}", client "${row.client}", model "${row.model}"`;

/** The fields of a limits row that count tokens. */
const LIMIT_TOKEN_FIELDS = ["context", "output", "input_accepted", "input_refused", "input_read", "output_accepted"] as const;

export const ObservedLimit = z
  .looseObject({
    route: z.string(),
    client: z.string(),
    model: z.string(),
    models_dev: z.string().nullable().optional(),
    base_model: z.string().nullable().optional(),
    context: z.number().nullable().optional(),
    output: z.number().nullable().optional(),
    input_accepted: z.number().optional(),
    input_refused: z.number().optional(),
    /** The largest input for which the reply showed it was read to the end. Absent or null = not checked. */
    input_read: z.number().nullable().optional(),
    output_accepted: z.number().optional(),
    note: z.string().optional(),
    /** The day the requests were sent. Absent = read from the folder name in `source`. */
    date: isoDate.nullable().optional(),
    source: z.string(),
  })
  // A row that contradicts itself is refused rather than read one way or another (design/usable-input-window.md, 6).
  .superRefine((row, ctx) => {
    // Every number of a row is a count of tokens: a whole number, 0 or more. A fraction would be published as it is.
    for (const field of LIMIT_TOKEN_FIELDS) {
      const value = row[field];
      if (value !== undefined && value !== null && !(Number.isInteger(value) && value >= 0)) {
        ctx.addIssue({ code: "custom", path: [field], message: `${limitRow(row)} has ${field} ${value}. A token count is a whole number, 0 or more.` });
      }
    }
    const accepted = row.input_accepted;
    const refused = row.input_refused;
    const named = row.context ?? undefined;
    const read = row.input_read ?? undefined;
    if (accepted !== undefined && refused !== undefined && !(accepted < refused)) {
      ctx.addIssue({ code: "custom", path: ["input_accepted"], message: `${limitRow(row)} has input_accepted ${accepted}, not below its input_refused ${refused}. An input accepted is below one refused.` });
    }
    if (accepted !== undefined && named !== undefined && accepted > named) {
      ctx.addIssue({ code: "custom", path: ["input_accepted"], message: `${limitRow(row)} has input_accepted ${accepted}, above its context ${named}. An input accepted fits in the window the route names.` });
    }
    if (read !== undefined && accepted === undefined) {
      ctx.addIssue({ code: "custom", path: ["input_read"], message: `${limitRow(row)} has input_read ${read} and no input_accepted. An input read to the end was accepted.` });
    }
    if (read !== undefined && accepted !== undefined && read > accepted) {
      ctx.addIssue({ code: "custom", path: ["input_read"], message: `${limitRow(row)} has input_read ${read}, above its input_accepted ${accepted}. An input read to the end was accepted.` });
    }
  });
export type ObservedLimit = z.infer<typeof ObservedLimit>;

export const ObservedKnown = z.looseObject({
  route: z.string(),
  client: z.string(),
  model: z.string(),
  ttl_s: z.number(),
  basis: z.string(),
  source: z.string(),
  when: z.record(z.string(), z.json()).optional(),
});

/**
 * A client of the measurements file: a text that describes it, as today, or an object that may state its kind
 * (design/sources-side-by-side.md, section 13, point 4). Both are read.
 */
export const ObservedClient = z.union([z.string(), z.looseObject({ kind: ClientKindText.optional() })]);

export const ObservedFile = z
  .looseObject({
    schema: z.number(),
    repository: z.url(),
    routes: z.record(z.string(), z.string()),
    clients: z.record(z.string(), ObservedClient),
    /** The kind of each client, beside `clients`. Absent in files written before groundtruth added it. */
    client_kinds: z.record(z.string(), ClientKindText).optional(),
    /** How each route is reached: with an API key or a login. Read and checked; the entry's own access decides which kind counts. */
    route_kinds: z.record(z.string(), z.enum(["api_key", "login"])).optional(),
    cache: z.array(ObservedRun),
    limits: z.array(ObservedLimit).default([]),
    known: z.array(ObservedKnown).default([]),
  })
  // One limits row per route, client and model: a new measurement of the same three replaces the row. A file with
  // two is refused rather than read in an order-dependent way, as a run with two checks at one age is.
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    for (const [index, row] of file.limits.entries()) {
      const key = JSON.stringify([row.route, row.client, row.model]);
      if (seen.has(key)) ctx.addIssue({ code: "custom", path: ["limits", index], message: `${limitRow(row)} is in the file twice. There is one limits row per route, client and model.` });
      seen.add(key);
    }
  });
export type ObservedFile = z.infer<typeof ObservedFile>;

export interface SourceMeta {
  source: string;
  fetched_at: string;
  checked_at: string;
  etag?: string;
  sha256: string;
}

// ---- published
// Everything providers.dev publishes of its own has a fixed set of keys: a value that is not known is null, a list
// with nothing in it is empty, and no key is ever left out. Only the models.dev part of a provider or an entry keeps
// models.dev's own shape, where an absent field means models.dev has no value.

/** The same object with every optional field made a required one that can be null. */
export type Nulled<T> = { [K in keyof T]-?: undefined extends T[K] ? Exclude<T[K], undefined> | null : T[K] };

/** Evidence as published: the note is always there, null where the author wrote none. */
export type PublishedEvidence = Nulled<Evidence>;

/** A correction as it is being worked out. */
export interface DraftProvenance extends Change {
  reason: string;
  evidence: Evidence[];
}

/** One correction to a field imported from models.dev. */
export interface Provenance {
  /** Dot path of the field, for example `limit.context`. */
  path: string;
  op: Change["op"];
  /** The published value. Null unless `op` is `set`. */
  value: Json | null;
  /** True when models.dev has a value at this path. */
  had_upstream: boolean;
  /** What models.dev says. Null unless `had_upstream`. */
  upstream: Json | null;
  reason: string;
  evidence: PublishedEvidence[];
}

export interface MeasuredLimit {
  route: string;
  route_label: string;
  client: string;
  client_label: string;
  /** Tokens. Null = this evaluation did not measure it. */
  context: number | null;
  output: number | null;
  input_accepted: number | null;
  input_refused: number | null;
  /** The largest input for which the reply showed it was read to the end. Null = not checked. */
  input_read: number | null;
  output_accepted: number | null;
  note: string | null;
  date: string | null;
  source: string;
  /** The kind of the client (design/sources-side-by-side.md, 2.3). Null = the client has none: the evaluation feeds no safe value. */
  client_kind: ClientKind | null;
}

export interface ModelExtension {
  origin: "upstream" | "added";
  access: Access;
  /** Corrections that replaced, hid or removed an upstream value. Empty = none. */
  provenance: Provenance[];
  /** Fields copied from another entry, for entries we add: identity, and `cost` where a subscription entry carries the API list price. Null = nothing is inherited. */
  inherited: { from: string; fields: string[] } | null;
  /** Prompt caching beyond what the source documents: what a request can ask for, and what evaluations measured. On every entry. */
  cache: EntryCache;
  pricing: Pricing;
  request_controls: RequestControls;
  limits: {
    /** Limit evaluations. Empty = none. */
    measured: MeasuredLimit[];
    /** On an entry we add: which of limit.context and limit.output are our measured values. */
    from_measurement: ("context" | "output")[];
    /** How much input a request can carry on this entry, and what that rests on (`inputWindow` in limits.ts). On every entry. */
    input_window: InputWindow;
  };
  /** The safe value of each quantity and what every source states (src/core/safe.ts). On every entry. */
  safe: SafeValues;
  evidence: PublishedEvidence[];
  /** The newest date among our evidence and measurements for this entry. Null = none. */
  verified: string | null;
  /** What pi's model catalog states for this entry, never merged into its own fields. Null = pi does not list it. */
  pi: PiBlock | null;
}

export interface ProviderExtension {
  origin: "upstream" | "added";
  access: Access;
  access_basis: string;
  access_reviewed: boolean;
  access_source: string | null;
  note: string | null;
  evidence: PublishedEvidence[];
  provenance: Provenance[];
}

export type PublishedModel = JsonObject & { id: string; name: string };
export type PublishedProvider = JsonObject & { id: string; name: string; models: Record<string, PublishedModel> };
export type Catalog = Record<string, PublishedProvider>;

export type IssueLevel = "error" | "warning" | "notice";
export interface Issue {
  level: IssueLevel;
  code:
    | "orphan-override"
    | "orphan-observation"
    | "excluded-observation"
    | "rule-version-unread"
    | "rule-date-unread"
    | "redundant-override"
    | "addition-collides"
    | "inherit-target-missing"
    | "unmapped-route"
    | "unmapped-client"
    | "client-kind-differs"
    | "invalid-authored"
    | "reserved-field"
    | "lifetime-differs"
    | "unparsed-lifetime"
    | "retention-lifetime-differs"
    | "limit-not-counted"
    | "pi-provider-collides"
    | "pi-alias-orphan"
    | "pi-alias-conflict"
    | "pi-alias-redundant"
    | "pi-snapshot-unreadable"
    | "pi-no-blocks"
    | "listing-provider-unknown"
    | "listing-rule-orphan"
    | "listing-model-twice"
    | "listed-provider-unknown"
    | "listed-sync-failed"
    | "unmapped-listing-client";
  target: string;
  message: string;
}

/**
 * What is left out of the catalog. `entry` and `provider`: an override's `exclude`, with its evidence. `rule`: a rule of
 * data/authored/catalog-rules.yaml, an editorial choice with no evidence, its target the rule id.
 */
export interface Exclusion {
  kind: "entry" | "provider" | "rule";
  target: string;
  /** What a rule leaves out, in words. Null for an entry or a provider: the target says it. */
  leaves_out: string | null;
  reason: string;
  /** The day a rule was decided. Null for an entry or a provider: the evidence carries the dates. */
  date: string | null;
  evidence: PublishedEvidence[];
  /** The entries it removed in this build. */
  entries: number;
}

export interface Meta {
  api_version: "v1";
  upstream_schema: string;
  dataset_version: string;
  generated_at: string;
  counts: {
    providers: number;
    /** Provider-model entries. */
    entries: number;
    /** Canonical models: the distinct `canonical_id` values of the entries. */
    models: number;
    added_providers: number;
    added_entries: number;
    corrected_entries: number;
    evaluated_entries: number;
    cache_evaluations: number;
    limit_evaluations: number;
  };
  /** The ages, in seconds, that every table of cache results by age has a column for, after the control at age 0. */
  cache_ages_s: number[];
  /**
   * providers.dev evidence (a correction, an evaluation, a measured lifetime) whose date is more than this many days
   * before today is shown as stale. The API publishes the dates and this number; a reader applies it to its own date.
   */
  stale_after_days: number;
  upstream: Nulled<UpstreamMeta>;
  /** The results repository the evaluations come from. Null = the dataset has none. */
  measurements: (Nulled<SourceMeta> & { repository: string }) | null;
  sync: { last_attempt_at: string | null; last_attempt_ok: boolean | null; last_error: string | null };
  exclusions: Exclusion[];
  issues: Issue[];
  license: { data: string; upstream: string; notice: string; pi: string; pi_notice: string };
  /** pi's model catalog, the second imported source. Always there: without a snapshot, `snapshot` is null and the counts 0. */
  pi: MetaPi;
  /** The listings (/api/v1/listings) and the discovery file they read. Since 1.5.0. */
  listings: MetaListings;
}

export interface MetaListings {
  /** Listings in this dataset. */
  count: number;
  /** Models in them, all listings together. */
  models: number;
  /** Listings by the source of their models. */
  by_basis: { listed: number; "providers.dev": number; "models.dev": number; "pi.dev": number };
  /** The address the discovery file (listed.json) is fetched from. */
  source: string;
  /** When the discovery file this dataset is built on was fetched. Null = there is none. */
  fetched_at: string | null;
  checked_at: string | null;
  /** The newest date a provider's list in that file was read. Null = there is none. */
  listed_at: string | null;
  /** The last attempt to fetch the discovery file. All null = none is recorded. */
  sync: { last_attempt_at: string | null; last_attempt_ok: boolean | null; last_error: string | null };
}

export interface MetaPi {
  source: string;
  /** The pi import this dataset is built on. Null = built without pi data. */
  snapshot: Omit<Nulled<PiMeta>, "source"> | null;
  /** The last attempt to import pi's catalog. All null = none is recorded. */
  sync: { last_attempt_at: string | null; last_attempt_ok: boolean | null; last_error: string | null };
  /** The three add up to snapshot.models. */
  counts: { entries_with_block: number; left_out_models: number; unmatched_models: number };
}

export function ext(model: JsonObject): ModelExtension {
  return model[NS] as unknown as ModelExtension;
}
export function providerExt(provider: JsonObject): ProviderExtension {
  return provider[NS] as unknown as ProviderExtension;
}
/** `meta.pi` of a dataset without pi data: one of the fixed values of "no pi data" (design/pi-source.md, section k). */
export const noPiMeta = (): Meta["pi"] => ({
  source: PI_URL,
  snapshot: null,
  sync: { last_attempt_at: null, last_attempt_ok: null, last_error: null },
  counts: { entries_with_block: 0, left_out_models: 0, unmatched_models: 0 },
});

export type { Json, JsonObject };
