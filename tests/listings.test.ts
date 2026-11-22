// The listings (src/core/listings.ts; Provimux's model-lists.md, sections 4.1 and 4.4): the whole list from the first
// source that has one, each field from the first source that states it, every key on every object.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { publish } from "../scripts/lib/publish.ts";
import { sync } from "../scripts/lib/sync.ts";
import { ListingSchema } from "../src/core/contract.ts";
import { buildListings, kinds, type ListingModel, type ListingsInput } from "../src/core/listings.ts";
import { AuthoredListing, type Catalog, type PublishedModel } from "../src/core/schema.ts";
import { fetchReturning, fixtureUpstream, ROOT, tempDataDir, writeAuthored } from "./helpers.ts";

const evidence = [{ kind: "documented" as const, url: "https://example.com/models", date: "2026-11-20" }];

/** A published entry: the models.dev fields given, and a providers_dev record with what the listings read. */
function entry(id: string, fields: Record<string, unknown> = {}, own: { origin?: "upstream" | "added"; provenance?: { path: string; op: "set" | "unknown" | "delete" }[] } = {}): PublishedModel {
  return { id, name: `Name of ${id}`, ...fields, providers_dev: { origin: own.origin ?? "upstream", provenance: own.provenance ?? [] } } as unknown as PublishedModel;
}
function catalogOf(providers: Record<string, PublishedModel[]>): Catalog {
  return Object.fromEntries(Object.entries(providers).map(([id, models]) => [id, { id, name: id, models: Object.fromEntries(models.map((model) => [model.id, model])) }])) as unknown as Catalog;
}
const build = (input: Partial<ListingsInput> & { catalog: Catalog }) => buildListings({ upstreamDate: "2026-11-21", authored: [], ...input });
const modelOf = (models: ListingModel[] | null, id: string): ListingModel => models!.find((model) => model.id === id)!;

describe("the models of a listing: whole, from the first source that has a list", () => {
  const catalog = catalogOf({ p: [entry("a", { limit: { context: 1000 } }), entry("b")], q: [entry("c")], r: [entry("own", {}, { origin: "added" })] });
  const listed = { page: "https://github.com/ngvoicu/groundtruth/blob/main/listed.json", providers: { p: { date: "2026-11-22", client: "provimux", models: [{ id: "new" }, { id: "a" }] } } };
  const pi = { date: "2026-11-20", lists: [{ provider: "q", pi_provider: "q", models: [{ id: "only-pi", name: "Only pi", context_window: 5, max_output: 0, input: ["text"], reasoning: false }] }, { provider: "r", pi_provider: "r2", models: [{ id: "x", name: "X", context_window: 0, max_output: 0, input: [], reasoning: true }] }] };
  const authored = [AuthoredListing.parse({ provider: "q", list: { models: ["c", "authored-only"], reason: "The vendor's page lists two.", evidence } })];
  const { listings, issues } = build({ catalog, listed, pi, authored });
  const of = (id: string) => listings.find((listing) => listing.provider === id)!;

  it("listed first: the discovery's models only, in its order, with its date, client and evidence", () => {
    expect(of("p")).toMatchObject({ basis: "listed", listed_at: "2026-11-22", client: "provimux", client_label: "provimux", model_count: 2, evidence: [{ kind: "listed", url: listed.page, date: "2026-11-22", note: null }] });
    expect(of("p").models!.map((model) => model.id)).toEqual(["new", "a"]);
  });

  it("a listed model without an entry is listed with entry null; one with an entry names it and takes its fields after the discovery's", () => {
    expect(modelOf(of("p").models, "new")).toMatchObject({ entry: null, canonical: null, name: null, context_window: null });
    expect(modelOf(of("p").models, "a")).toMatchObject({ entry: { provider: "p", model: "a" }, name: "Name of a", context_window: 1000, sources: { name: "models.dev", context_window: "models.dev" } });
  });

  it("then an authored list, then models.dev's entries, then pi's models; never a mix of two lists", () => {
    expect(of("q")).toMatchObject({ basis: "providers.dev", listed_at: "2026-11-20", client: null });
    expect(of("q").models!.map((model) => model.id)).toEqual(["c", "authored-only"]);
    // r has only an added entry: no models.dev list, so pi's.
    expect(of("r")).toMatchObject({ basis: "pi.dev", listed_at: "2026-11-20", evidence: [] });
    expect(of("r").models!.map((model) => model.id)).toEqual(["x"]);
    expect(issues).toEqual([]);
  });

  it("models.dev's list is the provider's imported entries, by id, dated by the import", () => {
    const { listings: only } = build({ catalog: catalogOf({ m: [entry("z"), entry("y"), entry("mine", {}, { origin: "added" })] }) });
    expect(only).toHaveLength(1);
    expect(only[0]).toMatchObject({ provider: "m", basis: "models.dev", listed_at: "2026-11-21", evidence: [], client: null });
    expect(only[0]!.models!.map((model) => model.id)).toEqual(["y", "z"]);
  });

  it("a model a catalog rule leaves out is still offered: in models.dev's list, as imported, with no entry", () => {
    const old = { id: "old", name: "Old", limit: { context: 8000 }, canonical_id: "lab/old" } as unknown as PublishedModel;
    const { listings } = build({ catalog: catalogOf({ m: [entry("new")], gone: [] }), ruledOut: [{ ref: "m/old", model: old }, { ref: "gone/older", model: { ...old, id: "older" } as unknown as PublishedModel }] });
    expect(listings.map((listing) => [listing.provider, listing.basis, listing.models!.map((model) => model.id)])).toEqual([["gone", "models.dev", ["older"]], ["m", "models.dev", ["new", "old"]]]);
    expect(modelOf(listings[1]!.models, "old")).toMatchObject({ entry: null, canonical: null, owner: "lab", context_window: 8000, sources: { context_window: "models.dev" } });
  });

  it("a provider no source has a list for has no listing", () => {
    expect(build({ catalog: catalogOf({ empty: [], added: [entry("own", {}, { origin: "added" })] }) }).listings).toEqual([]);
  });

  it("every listing fits the contract, and every model, reasoning and sources record has the same keys", () => {
    for (const listing of listings) expect(ListingSchema.safeParse(listing).error).toBeUndefined();
    const models = listings.flatMap((listing) => listing.models!);
    expect(new Set(models.map((model) => Object.keys(model).join(","))).size).toBe(1);
    expect(new Set(models.map((model) => Object.keys(model.sources).join(","))).size).toBe(1);
    expect(new Set(models.map((model) => Object.keys(model.sources.reasoning).join(","))).size).toBe(1);
  });
});

describe("the fields of a model: each from the first source that states it", () => {
  const imported = entry("m", {
    canonical_id: "lab/m",
    release_date: "2026-01-01",
    limit: { context: 200000, input: 0, output: 64000 },
    modalities: { input: ["text", "image/png", "image/jpeg", "application/pdf"], output: ["text"] },
    capabilities: { reasoning: { supported: true, effort: ["low", "high"], budget: { min: 1024 }, toggle: true } },
  });

  it("reads an imported entry as models.dev's: window, output, kinds of input, reasoning; 0 is not stated", () => {
    const model = build({ catalog: catalogOf({ p: [imported] }) }).listings[0]!.models![0]!;
    expect(model).toMatchObject({
      name: "Name of m", owner: "lab", canonical: "lab/m", released: "2026-01-01", context_window: 200000, max_input: null, max_output: 64000,
      input_modalities: ["text", "image", "pdf"], output_modalities: ["text"],
      reasoning: { supported: true, levels: ["low", "high"], budget_min: 1024, budget_max: null, can_disable: true, dynamic: null, disable_with: null },
      web_search: null, aliases: [], variants: [], plans: [], hidden: null,
    });
    expect(model.sources).toMatchObject({ context_window: "models.dev", max_input: null, max_output: "models.dev", reasoning: { supported: "models.dev", levels: "models.dev", budget_max: null, dynamic: null }, plans: null });
  });

  it("listed beats an authored rule beats models.dev beats pi, field by field", () => {
    const listed = { page: "https://example.com/listed.json", providers: { p: { date: "2026-11-22", client: "provimux", models: [{ id: "m", max_output: 32000, plans: ["plus", "pro"], hidden: false, reasoning: { levels: ["low", "medium", "high"] } }] } } };
    const authored = [AuthoredListing.parse({ provider: "p", rules: [{ models: ["m"], set: { max_output: 1, web_search: true, reasoning: { budget_max: 32000, levels: ["ignored"] } }, reason: "The vendor's page.", evidence }] })];
    const pi = { date: "2026-11-20", lists: [{ provider: "p", pi_provider: "p", models: [{ id: "m", name: "pi's name", context_window: 1, max_output: 2, input: ["text"], reasoning: false }] }] };
    const { listings } = build({ catalog: catalogOf({ p: [imported] }), listed, authored, pi });
    const model = listings[0]!.models![0]!;
    expect(model).toMatchObject({ max_output: 32000, plans: ["plus", "pro"], hidden: false, web_search: true, context_window: 200000, name: "Name of m" });
    expect(model.reasoning).toMatchObject({ levels: ["low", "medium", "high"], budget_max: 32000, supported: true });
    expect(model.sources).toMatchObject({ max_output: "listed", plans: "listed", hidden: "listed", web_search: "providers.dev", context_window: "models.dev", name: "models.dev", reasoning: { levels: "listed", budget_max: "providers.dev", supported: "models.dev" } });
    // The rule's evidence is in the listing's, after the discovery's.
    expect(listings[0]!.evidence.map((item) => item.url)).toEqual(["https://example.com/listed.json", "https://example.com/models"]);
  });

  it("pi fills only what no other source states", () => {
    const pi = { date: "2026-11-20", lists: [{ provider: "p", pi_provider: "p", models: [{ id: "bare", name: "pi's name", context_window: 128000, max_output: 0, input: ["text", "image"], reasoning: true }] }] };
    const model = build({ catalog: catalogOf({ p: [entry("bare", { name: "" })] }), pi }).listings[0]!.models![0]!;
    expect(model).toMatchObject({ name: "pi's name", context_window: 128000, max_output: null, input_modalities: ["text", "image"], reasoning: { supported: true, levels: null } });
    expect(model.sources).toMatchObject({ name: "pi.dev", context_window: "pi.dev", max_output: null, reasoning: { supported: "pi.dev" } });
  });

  it("a corrected field is providers.dev's, an added entry's fields are providers.dev's, and a field published as unknown stays unknown", () => {
    const corrected = entry("c", { limit: { context: 5000000 } }, { provenance: [{ path: "limit.context", op: "set" }, { path: "limit.output", op: "unknown" }] });
    const pi = { date: "2026-11-20", lists: [{ provider: "p", pi_provider: "p", models: [{ id: "c", name: "C", context_window: 1, max_output: 999, input: [], reasoning: false }] }] };
    const { listings } = build({ catalog: catalogOf({ p: [corrected] }), pi });
    expect(listings[0]!.models![0]).toMatchObject({ context_window: 5000000, max_output: null, sources: { context_window: "providers.dev", max_output: null } });
    const listed = { page: "https://example.com/listed.json", providers: { s: { date: "2026-11-22", client: "provimux", models: [{ id: "own" }] } } };
    const own = build({ catalog: catalogOf({ s: [entry("own", { limit: { context: 900000 } }, { origin: "added" })] }), listed }).listings[0]!.models![0]!;
    expect(own).toMatchObject({ entry: { provider: "s", model: "own" }, context_window: 900000, sources: { context_window: "providers.dev", name: "providers.dev" } });
  });

  it("reasoning is null where no source says anything about it", () => {
    expect(build({ catalog: catalogOf({ p: [entry("plain")] }) }).listings[0]!.models![0]!.reasoning).toBeNull();
  });
});

describe("authored statements", () => {
  it("a rule for every model, a rule for a model the list does not name, an authored file for a provider the catalog lacks", () => {
    const authored = [
      AuthoredListing.parse({ provider: "p", rules: [{ models: "all", set: { web_search: false }, reason: "None of them.", evidence }, { models: ["gone"], set: { hidden: true }, reason: "Hidden.", evidence: [{ ...evidence[0]!, url: "https://example.com/other" }] }] }),
      AuthoredListing.parse({ provider: "nobody", rules: [{ models: "all", set: { hidden: true }, reason: "x", evidence }] }),
    ];
    const { listings, issues } = build({ catalog: catalogOf({ p: [entry("a"), entry("b")] }), authored });
    expect(listings[0]!.models!.map((model) => [model.web_search, model.sources.web_search])).toEqual([[false, "providers.dev"], [false, "providers.dev"]]);
    // Only the evidence of a rule that applied.
    expect(listings[0]!.evidence.map((item) => item.url)).toEqual(["https://example.com/models"]);
    expect(issues.map((issue) => [issue.code, issue.target])).toEqual([["listing-provider-unknown", "listings/nobody"], ["listing-rule-orphan", "listings/p/gone"]]);
  });

  it("the schema refuses a statement without evidence or reason, an empty rule, an unknown field and an empty file", () => {
    const rule = { models: ["a"], set: { max_output: 1 }, reason: "r", evidence };
    expect(AuthoredListing.safeParse({ provider: "p", rules: [rule] }).success).toBe(true);
    expect(AuthoredListing.safeParse({ provider: "p", rules: [{ ...rule, evidence: [] }] }).success).toBe(false);
    expect(AuthoredListing.safeParse({ provider: "p", rules: [{ ...rule, evidence: [{ kind: "documented", url: "https://example.com" }] }] }).success).toBe(false);
    expect(AuthoredListing.safeParse({ provider: "p", rules: [{ models: ["a"], set: { max_output: 1 }, evidence }] }).success).toBe(false);
    expect(AuthoredListing.safeParse({ provider: "p", rules: [{ ...rule, set: {} }] }).success).toBe(false);
    expect(AuthoredListing.safeParse({ provider: "p", rules: [{ ...rule, set: { price: 3 } }] }).success).toBe(false);
    expect(AuthoredListing.safeParse({ provider: "p" }).success).toBe(false);
    expect(AuthoredListing.safeParse({ provider: "p", list: { models: ["a", "a"], reason: "r", evidence } }).success).toBe(false);
    expect(AuthoredListing.safeParse({ provider: "p", list: { models: ["a"], reason: "r" } }).success).toBe(false);
  });

  it("a statement without evidence fails the build; a good file is published", async () => {
    const dataDir = tempDataDir();
    await sync({ dataDir, fetch: fetchReturning(JSON.stringify(fixtureUpstream())) });
    writeAuthored(dataDir);
    mkdirSync(join(dataDir, "authored", "listings"), { recursive: true });
    const file = join(dataDir, "authored", "listings", "provider-03.yaml");
    writeFileSync(file, stringify({ provider: "provider-03", rules: [{ models: ["model-1"], set: { max_output: 7 }, reason: "no source" }] }));
    const failed = publish({ dataDir, rootDir: ROOT });
    expect(failed.ok).toBe(false);
    expect(failed.errors.join("\n")).toContain("provider-03.yaml: rules.0.evidence");
    writeFileSync(file, stringify({ provider: "provider-03", rules: [{ models: ["model-1"], set: { max_output: 7 }, reason: "The page says 7.", evidence }] }));
    const report = publish({ dataDir, rootDir: ROOT });
    expect(report.errors).toEqual([]);
    expect(report.meta!.listings).toMatchObject({ count: 30, by_basis: { listed: 0, "providers.dev": 0, "models.dev": 30, "pi.dev": 0 } });
  });
});

describe("kinds of modalities", () => {
  it("reads a media type as its kind, keeps other words, each once in order", () => {
    expect(kinds(["text", "image/png", "image/jpeg", "application/pdf", "audio/wav", "video/mp4", "text/csv", "embedding", "image"])).toEqual(["text", "image", "pdf", "audio", "video", "embedding"]);
  });
});
