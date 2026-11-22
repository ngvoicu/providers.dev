// The listing: the model list of one provider and access method (design: Provimux's model-lists.md, section 4).
// What the vendor's own list said, read on a date through a named client, completed by sourced statements. It
// belongs to a provider of the catalog. It is not a set of entries: a listed model need not have one.
//
// The sources, in one fixed order: `listed` (groundtruth's discovery, listed.json), `providers.dev` (an authored list
// or statement, data/authored/listings/), `models.dev` (the imported entries of the provider), `pi.dev` (pi's models
// of the provider). The models of a listing are taken whole from the first source that has a list for the provider;
// each field of a model from the first source that states it, and the model names that source.
//
// Nothing here is written into an entry: a listing is a resource of its own, and no value of it reaches an entry's
// `limit` or a safe value.

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
  sources: ListingSources;
}

export interface ListingEvidence {
  kind: "documented" | "measured" | "listed";
  url: string;
  date: string;
  note: string | null;
}

export interface Listing {
  provider: string;
  /** The source of the listing's models. */
  basis: ListingSource;
  /** The date that source was read: the discovery's date, the import's date, or the newest evidence of an authored list. */
  listed_at: string | null;
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
