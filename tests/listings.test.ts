// The listings (src/core/listings.ts; Provimux's model-lists.md, sections 4.1 and 4.4): every source's list, each model
// once with the lists that name it (since 1.6.0), each field from the first source that states it, every key on every
// object.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { publish } from "../scripts/lib/publish.ts";
import { sync } from "../scripts/lib/sync.ts";
import { ListingSchema } from "../src/core/contract.ts";
import { buildListings, kinds, LISTED_PAGE, type ListingModel, type ListingsInput } from "../src/core/listings.ts";
import { matchPi, piLists, type PiCatalog, type PiModel } from "../src/core/pi.ts";
import { AuthoredListing, PiAliases, type Catalog, type PublishedModel } from "../src/core/schema.ts";
import { fetchReturning, fixtureUpstream, ROOT, tempDataDir, writeAuthored } from "./helpers.ts";

const evidence = [{ kind: "documented" as const, url: "https://example.com/models", date: "2026-11-20" }];

/** A published entry: the models.dev fields given, and a providers_dev record with what the listings read. */
function entry(id: string, fields: Record<string, unknown> = {}, own: { origin?: "upstream" | "added"; provenance?: { path: string; op: "set" | "unknown" | "delete" }[]; inherited?: { from: string; fields: string[] }; measured?: number } = {}): PublishedModel {
  const limits = { input_window: { measured_tokens: own.measured ?? null } };
  return { id, name: `Name of ${id}`, ...fields, providers_dev: { origin: own.origin ?? "upstream", provenance: own.provenance ?? [], inherited: own.inherited ?? null, limits } } as unknown as PublishedModel;
}
function catalogOf(providers: Record<string, PublishedModel[]>): Catalog {
  return Object.fromEntries(Object.entries(providers).map(([id, models]) => [id, { id, name: id, models: Object.fromEntries(models.map((model) => [model.id, model])) }])) as unknown as Catalog;
}
const build = (input: Partial<ListingsInput> & { catalog: Catalog }) => buildListings({ upstreamDate: "2026-11-21", authored: [], excluded: [], ...input });
const modelOf = (models: ListingModel[] | null, id: string): ListingModel => models!.find((model) => model.id === id)!;

describe("the models of a listing: every source's list, each model once, with the lists that name it (1.6.0)", () => {
  const catalog = catalogOf({ p: [entry("a", { limit: { context: 1000 } }), entry("b")], q: [entry("c")], r: [entry("own", {}, { origin: "added" })] });
  const listed = { providers: { p: { date: "2026-11-22", client: "provimux", models: [{ id: "new" }, { id: "a" }] } } };
  const pi = { date: "2026-11-20", lists: [{ provider: "q", pi_provider: "q", models: [{ id: "only-pi", name: "Only pi", context_window: 5, max_output: 0, input: ["text"], reasoning: false }] }, { provider: "r", pi_provider: "r2", models: [{ id: "x", name: "X", context_window: 0, max_output: 0, input: [], reasoning: true }] }] };
  const authored = [AuthoredListing.parse({ provider: "q", list: { models: ["c", "authored-only"], reason: "The vendor's page lists two.", evidence } })];
  const { listings, issues } = build({ catalog, listed, pi, authored });
  const of = (id: string) => listings.find((listing) => listing.provider === id)!;
  const ids = (id: string) => of(id).models!.map((model) => [model.id, model.listed_by]);

  it("discovery plus models.dev, where discovery lacks one model: the model stays, listed by models.dev, after the discovery's own", () => {
    expect(of("p")).toMatchObject({
      basis: "listed", listed_at: "2026-11-22", client: "provimux", client_label: "provimux", model_count: 3,
      lists: { listed: { listed_at: "2026-11-22", model_count: 2 }, "providers.dev": null, "models.dev": { listed_at: "2026-11-21", model_count: 2 }, "pi.dev": null },
      evidence: [{ kind: "listed", url: LISTED_PAGE, date: "2026-11-22", note: null }],
    });
    expect(ids("p")).toEqual([["new", ["listed"]], ["a", ["listed", "models.dev"]], ["b", ["models.dev"]]]);
    // b keeps everything models.dev states of it, and its entry.
    expect(modelOf(of("p").models, "b")).toMatchObject({ entry: { provider: "p", model: "b" }, name: "Name of b", sources: { name: "models.dev" } });
  });

  it("a listed model without an entry is listed with entry null; one with an entry names it and takes its fields after the discovery's", () => {
    // No source names it: its name is its id, from the list (no name is taken from the discovery file).
    expect(modelOf(of("p").models, "new")).toMatchObject({ entry: null, canonical: null, name: "new", context_window: null, sources: { name: "listed" } });
    expect(modelOf(of("p").models, "a")).toMatchObject({ entry: { provider: "p", model: "a" }, name: "Name of a", context_window: 1000, sources: { name: "models.dev", context_window: "models.dev" } });
  });

  it("an authored list, models.dev's entries and pi's models together: the authored list first, basis providers.dev", () => {
    expect(of("q")).toMatchObject({ basis: "providers.dev", listed_at: "2026-11-20", client: null, model_count: 3, lists: { listed: null, "providers.dev": { listed_at: "2026-11-20", model_count: 2 }, "models.dev": { listed_at: "2026-11-21", model_count: 1 }, "pi.dev": { listed_at: "2026-11-20", model_count: 1 } } });
    expect(ids("q")).toEqual([["c", ["providers.dev", "models.dev"]], ["authored-only", ["providers.dev"]], ["only-pi", ["pi.dev"]]]);
    // A model only a list names is named by its id, from that list.
    expect(modelOf(of("q").models, "authored-only")).toMatchObject({ name: "authored-only", sources: { name: "providers.dev" } });
    expect(issues).toEqual([]);
  });

  it("a provider with only pi.dev: pi's models, basis pi.dev, the import's date and no evidence", () => {
    // r has only an added entry: no models.dev list, so pi's alone.
    expect(of("r")).toMatchObject({ basis: "pi.dev", listed_at: "2026-11-20", evidence: [], model_count: 1, lists: { listed: null, "providers.dev": null, "models.dev": null, "pi.dev": { listed_at: "2026-11-20", model_count: 1 } } });
    expect(ids("r")).toEqual([["x", ["pi.dev"]]]);
    expect(modelOf(of("r").models, "x")).toMatchObject({ name: "X", entry: null, sources: { name: "pi.dev" } });
  });

  it("a provider with all four: every model once, in the order of the sources, each naming its lists, each field as before", () => {
    const all = build({
      catalog: catalogOf({ f: [entry("m1", { limit: { context: 200000, output: 64000 } }), entry("m3", { limit: { context: 100000 } })] }),
      listed: { providers: { f: { date: "2026-11-24", client: "provimux", models: [{ id: "m1", max_output: 32000 }, { id: "m0" }] } } },
      authored: [AuthoredListing.parse({ provider: "f", list: { models: ["m2", "m1"], reason: "The vendor's page.", evidence } })],
      pi: { date: "2026-11-23", lists: [{ provider: "f", pi_provider: "f", models: [{ id: "m4", name: "Pi m4", context_window: 128000, max_output: 8000, input: ["text"], reasoning: true }, { id: "m3", name: "Pi m3", context_window: 1, max_output: 0, input: [], reasoning: false }] }] },
    });
    expect(all.issues).toEqual([]);
    const f = all.listings[0]!;
    expect(f).toMatchObject({
      basis: "listed", listed_at: "2026-11-24", model_count: 5,
      lists: { listed: { listed_at: "2026-11-24", model_count: 2 }, "providers.dev": { listed_at: "2026-11-20", model_count: 2 }, "models.dev": { listed_at: "2026-11-21", model_count: 2 }, "pi.dev": { listed_at: "2026-11-23", model_count: 2 } },
    });
    expect(f.models!.map((model) => [model.id, model.listed_by])).toEqual([
      ["m1", ["listed", "providers.dev", "models.dev"]],
      ["m0", ["listed"]],
      ["m2", ["providers.dev"]],
      ["m3", ["models.dev", "pi.dev"]],
      ["m4", ["pi.dev"]],
    ]);
    // The evidence of the discovery and of the authored list, both.
    expect(f.evidence.map((item) => item.url)).toEqual([LISTED_PAGE, "https://example.com/models"]);
    // Fields keep their own rule: the first source that states each, whichever lists name the model.
    expect(modelOf(f.models, "m1")).toMatchObject({ max_output: 32000, context_window: 200000, sources: { max_output: "listed", context_window: "models.dev" } });
    expect(modelOf(f.models, "m3")).toMatchObject({ name: "Name of m3", context_window: 100000, reasoning: { supported: false }, sources: { name: "models.dev", context_window: "models.dev", reasoning: { supported: "pi.dev" } } });
    expect(modelOf(f.models, "m4")).toMatchObject({ name: "Pi m4", context_window: 128000, max_output: 8000, entry: null, sources: { context_window: "pi.dev" } });
    expect(ListingSchema.safeParse(f).error).toBeUndefined();
  });

  it("a model a list names twice is listed once, with one warning naming that list", () => {
    const twice = build({ catalog: catalogOf({ p: [entry("a")] }), listed: { providers: { p: { date: "2026-11-22", client: "provimux", models: [{ id: "a" }, { id: "a" }] } } } });
    expect(twice.listings[0]!.models!.map((model) => [model.id, model.listed_by])).toEqual([["a", ["listed", "models.dev"]]]);
    expect(twice.listings[0]!.lists.listed).toEqual({ listed_at: "2026-11-22", model_count: 1 });
    expect(twice.issues.map((issue) => [issue.code, issue.message])).toEqual([["listing-model-twice", "The listed list of p names a more than once. It is listed once."]]);
  });

  it("models.dev's list is the provider's imported entries, by id, dated by the import", () => {
    const { listings: only } = build({ catalog: catalogOf({ m: [entry("z"), entry("y"), entry("mine", {}, { origin: "added" })] }) });
    expect(only).toHaveLength(1);
    expect(only[0]).toMatchObject({ provider: "m", basis: "models.dev", listed_at: "2026-11-21", evidence: [], client: null, lists: { listed: null, "providers.dev": null, "models.dev": { listed_at: "2026-11-21", model_count: 2 }, "pi.dev": null } });
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

describe("a model an override leaves out with evidence: in no list of its provider (review of 8f24534)", () => {
  // The reviewer's case: Xiaomi's override leaves out mimo-v2.5 (retired); pi's catalog still names it.
  const catalog = catalogOf({ xiaomi: [entry("mimo-v2.6")], other: [entry("mimo-v2.5")] });
  const excluded = ["xiaomi/mimo-v2.5", "xiaomi/mimo-v2.5-pro"];
  const piModel = (id: string) => ({ id, name: `pi ${id}`, context_window: 32768, max_output: 4096, input: ["text"], reasoning: false });
  const pi = { date: "2026-11-23", lists: [{ provider: "xiaomi", pi_provider: "xiaomi", models: [piModel("mimo-v2.5"), piModel("mimo-v2.6")] }, { provider: "other", pi_provider: "other", models: [piModel("mimo-v2.5")] }] };

  it("pi naming an excluded model does not bring it back; the same id at another provider is not affected", () => {
    const { listings, issues } = build({ catalog, pi, excluded });
    const xiaomi = listings.find((listing) => listing.provider === "xiaomi")!;
    expect(xiaomi.models!.map((model) => [model.id, model.listed_by])).toEqual([["mimo-v2.6", ["models.dev", "pi.dev"]]]);
    expect(xiaomi.lists).toMatchObject({ "models.dev": { model_count: 1 }, "pi.dev": { model_count: 1 } });
    expect(listings.find((listing) => listing.provider === "other")!.models!.map((model) => model.id)).toEqual(["mimo-v2.5"]);
    expect(issues).toEqual([]);
    // Without the exclusion (the build before the fix), pi's list brought it back.
    expect(build({ catalog, pi }).listings.find((listing) => listing.provider === "xiaomi")!.models!.map((model) => model.id)).toEqual(["mimo-v2.6", "mimo-v2.5"]);
  });

  it("an authored list naming an excluded model does not bring it back", () => {
    const authored = [AuthoredListing.parse({ provider: "xiaomi", list: { models: ["mimo-v2.5-pro", "mimo-v2.6"], reason: "Two models.", evidence } })];
    const xiaomi = build({ catalog, authored, excluded }).listings.find((listing) => listing.provider === "xiaomi")!;
    expect(xiaomi.models!.map((model) => [model.id, model.listed_by])).toEqual([["mimo-v2.6", ["providers.dev", "models.dev"]]]);
    expect(xiaomi.lists["providers.dev"]).toEqual({ listed_at: "2026-11-20", model_count: 1 });
  });

  it("discovery naming an excluded model: left out, with a warning naming the provider and the id, once", () => {
    const listed = { providers: { xiaomi: { date: "2026-11-24", client: "provimux", models: [{ id: "mimo-v2.5" }, { id: "mimo-v2.6" }, { id: "mimo-v2.5" }] } } };
    const { listings, issues } = build({ catalog, pi, listed, excluded });
    const xiaomi = listings.find((listing) => listing.provider === "xiaomi")!;
    expect(xiaomi).toMatchObject({ basis: "listed", model_count: 1, lists: { listed: { listed_at: "2026-11-24", model_count: 1 } } });
    expect(xiaomi.models!.map((model) => [model.id, model.listed_by])).toEqual([["mimo-v2.6", ["listed", "models.dev", "pi.dev"]]]);
    expect(issues).toEqual([{ level: "warning", code: "listing-excluded-listed", target: "listings/xiaomi/mimo-v2.5", message: "The vendor's own list of xiaomi names mimo-v2.5, which an override in data/authored/overrides/ leaves out with evidence. It is left out of the listing; check whether the override still holds." }]);
    // A discovery naming only excluded models gives no list: the listing stands on the other sources.
    const only = build({ catalog, listed: { providers: { xiaomi: { date: "2026-11-24", client: "provimux", models: [{ id: "mimo-v2.5" }] } } }, excluded });
    const left = only.listings.find((listing) => listing.provider === "xiaomi")!;
    expect(left).toMatchObject({ basis: "models.dev", client: null, evidence: [], lists: { listed: null } });
    expect(only.issues.map((issue) => issue.code)).toEqual(["listing-excluded-listed"]);
  });

  it("the build passes the overrides' exclusions: the real Xiaomi override with a pi list naming mimo-v2.5", async () => {
    const dataDir = tempDataDir();
    await sync({ dataDir, fetch: fetchReturning(JSON.stringify(fixtureUpstream())) });
    writeAuthored(dataDir);
    mkdirSync(join(dataDir, "authored", "overrides"), { recursive: true });
    writeFileSync(join(dataDir, "authored", "overrides", "provider-03.yaml"), stringify({ provider: "provider-03", rules: [{ models: ["model-1"], exclude: true, reason: "Retired.", evidence }] }));
    mkdirSync(join(dataDir, "sources"), { recursive: true });
    writeFileSync(join(dataDir, "sources", "listed.json"), JSON.stringify({ schema: 1, providers: { "provider-03": { date: "2026-11-24", client: "provimux", models: [{ id: "model-1" }, { id: "model-2" }] } } }));
    const report = publish({ dataDir, rootDir: ROOT });
    expect(report.errors).toEqual([]);
    const file = JSON.parse(readFileSync(join(dataDir, "published", "site", "data", "listings", "provider-03.json"), "utf8")) as { data: { models: ListingModel[] } };
    expect(file.data.models.map((model) => model.id)).not.toContain("model-1");
    expect(report.meta!.issues.filter((issue) => issue.code === "listing-excluded-listed").map((issue) => issue.target)).toEqual(["listings/provider-03/model-1"]);
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
    const listed = { providers: { p: { date: "2026-11-22", client: "provimux", models: [{ id: "m", max_output: 32000, plans: ["plus", "pro"], hidden: false, reasoning: { levels: ["low", "medium", "high"] } }] } } };
    const authored = [AuthoredListing.parse({ provider: "p", rules: [{ models: ["m"], set: { max_output: 1, web_search: true, reasoning: { budget_max: 32000, levels: ["ignored"] } }, reason: "The vendor's page.", evidence }] })];
    const pi = { date: "2026-11-20", lists: [{ provider: "p", pi_provider: "p", models: [{ id: "m", name: "pi's name", context_window: 1, max_output: 2, input: ["text"], reasoning: false }] }] };
    const { listings } = build({ catalog: catalogOf({ p: [imported] }), listed, authored, pi });
    const model = listings[0]!.models![0]!;
    expect(model).toMatchObject({ max_output: 32000, plans: ["plus", "pro"], hidden: false, web_search: true, context_window: 200000, name: "Name of m" });
    expect(model.reasoning).toMatchObject({ levels: ["low", "medium", "high"], budget_max: 32000, supported: true });
    expect(model.sources).toMatchObject({ max_output: "listed", plans: "listed", hidden: "listed", web_search: "providers.dev", context_window: "models.dev", name: "models.dev", reasoning: { levels: "listed", budget_max: "providers.dev", supported: "models.dev" } });
    // The rule's evidence is in the listing's, after the discovery's.
    expect(listings[0]!.evidence.map((item) => item.url)).toEqual([LISTED_PAGE, "https://example.com/models"]);
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
    const listed = { providers: { s: { date: "2026-11-22", client: "provimux", models: [{ id: "own" }] } } };
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

describe("pi's lists (handed over by the fence)", () => {
  const piModel = (provider: string, id: string, more: Partial<PiModel> = {}): PiModel => ({ id, name: `Pi ${id}`, api: "openai-completions", provider, baseUrl: "", reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 0, type: "chat", ...more }) as PiModel;
  const pi: PiCatalog = {
    p: { a: piModel("p", "a"), "pi-only": piModel("p", "pi-only") },
    "p-alias": { a: piModel("p-alias", "a") },
    q2: { "q-model": piModel("q2", "q-model"), spelled: piModel("q2", "spelled") },
    nowhere: { z: piModel("nowhere", "z") },
  };
  const aliases = PiAliases.parse({
    providers: {
      "p-alias": { same_as: "p", reason: "same host", evidence },
      q2: { same_as: "q", reason: "same host", evidence, checked: "2026-11-22", models: { spelled: { same_as: "q-spelled" } } },
    },
  });
  const before = { providers: ["p", "q"], entries: [{ provider: "p", model: "a", base_urls: [] }, { provider: "q", model: "q-spelled", base_urls: [] }] };

  it("one list per catalog provider: its own pi provider before a paired one; a model of an entry takes the entry's id", () => {
    const lists = piLists(pi, matchPi(pi, aliases, before));
    expect(lists.map((list) => [list.provider, list.pi_provider, list.models.map((model) => model.id)])).toEqual([
      ["p", "p", ["a", "pi-only"]],
      ["q", "q2", ["q-model", "q-spelled"]],
    ]);
    expect(lists[0]!.models[0]).toEqual({ id: "a", name: "Pi a", context_window: 200000, max_output: 0, input: ["text", "image"], reasoning: true });
  });
});

describe("the review's findings 2 and 6: the Codex login", () => {
  // As the catalog has them: two models.dev entries, and the added entries providers.dev measured, which inherit
  // identity fields from openai/... and have a measured window (921,500) and no limit of their own.
  const inherits = (id: string) => ({ from: `openai/${id}`, fields: ["name", "description", "family", "type", "release_date", "canonical_id", "cost"] });
  const astra = entry("gpt-6-astra", { name: "GPT-6 Astra", release_date: "2026-09-04", canonical_id: "openai/gpt-6-astra" }, { origin: "added", inherited: inherits("gpt-6-astra"), measured: 921500 });
  const luna = entry("gpt-6-luna", { name: "GPT-6 Luna", release_date: "2026-09-22", canonical_id: "openai/gpt-6-luna" }, { origin: "added", inherited: inherits("gpt-6-luna"), measured: 921500 });
  const sol = entry("gpt-6.1-sol", { canonical_id: "openai/gpt-6.1-sol", limit: { context: 1050000, input: 922000, output: 128000 } }, { measured: 922000 });
  const catalog = catalogOf({ "openai-codex": [astra, luna, sol] });
  const piModel = (id: string, window: number) => ({ id, name: `pi ${id}`, context_window: window, max_output: 128000, input: ["text"], reasoning: true });
  const pi = { date: "2026-11-20", lists: [{ provider: "openai-codex", pi_provider: "openai-codex", models: [piModel("gpt-6-astra", 272000), piModel("gpt-6-luna", 272000), piModel("gpt-6.1-sol", 500000)] }] };
  const authored = [AuthoredListing.parse({ provider: "openai-codex", list: { models: ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"], reason: "Six models.", evidence } })];

  it("pi gives no limit to a model whose entry has a measured window: no 272,000 beside the measured 921,500 (finding 2)", () => {
    const { listings } = build({ catalog, pi, authored, upstreamSource: "https://models.dev/experimental/v2.0/api.json?include=openai-codex" });
    for (const id of ["gpt-6-astra", "gpt-6-luna"]) {
      const model = modelOf(listings[0]!.models, id);
      expect(model, id).toMatchObject({ context_window: null, max_input: null, max_output: null, sources: { context_window: null, max_output: null } });
      // pi still names what is not a limit, where no other source does.
      expect(model.sources.reasoning.supported).toBe("pi.dev");
    }
  });

  it("a lower source's max_input above the chosen window is dropped: 922,000 of models.dev against 400,000 listed (finding 2)", () => {
    const listed = { providers: { "openai-codex": { date: "2026-11-21", client: "provimux", models: [{ id: "gpt-6.1-sol", context_window: 400000 }] } } };
    const model = build({ catalog, listed }).listings[0]!.models![0]!;
    expect(model).toMatchObject({ context_window: 400000, max_input: null, max_output: 128000, sources: { context_window: "listed", max_input: null, max_output: "models.dev" } });
    // An output limit above the window from a lower source goes too; where one source states both, the window stays.
    const big = build({ catalog, listed: { ...listed, providers: { "openai-codex": { ...listed.providers["openai-codex"], models: [{ id: "gpt-6.1-sol", context_window: 100000 }] } } } }).listings[0]!.models![0]!;
    expect(big).toMatchObject({ context_window: 100000, max_input: null, max_output: null });
    const own = build({ catalog, listed: { ...listed, providers: { "openai-codex": { ...listed.providers["openai-codex"], models: [{ id: "gpt-6.1-sol", context_window: 100000, max_output: 200000 }] } } } }).listings[0]!.models![0]!;
    expect(own).toMatchObject({ context_window: 100000, max_output: null, sources: { context_window: "listed", max_output: null } });
  });

  it("an added entry's inherited name, owner and released are models.dev's, with models.dev's evidence in the listing (finding 6)", () => {
    const { listings } = build({ catalog, authored, upstreamSource: "https://models.dev/experimental/v2.0/api.json?include=openai-codex" });
    const model = modelOf(listings[0]!.models, "gpt-6-astra");
    expect(model).toMatchObject({ name: "GPT-6 Astra", owner: "openai", released: "2026-09-04", sources: { name: "models.dev", owner: "models.dev", released: "models.dev" } });
    expect(listings[0]!.evidence.at(-1)).toEqual({
      kind: "listed",
      url: "https://models.dev/experimental/v2.0/api.json?include=openai-codex",
      date: "2026-11-21",
      note: "models.dev's records of the models an added entry inherits name, owner and released from: gpt-6-astra from openai/gpt-6-astra, gpt-6-luna from openai/gpt-6-luna.",
    });
    // A field an added entry does not inherit stays providers.dev's.
    const measuredOnly = build({ catalog: catalogOf({ s: [entry("own", { name: "Own", limit: { context: 900000 } }, { origin: "added", inherited: { from: "x/own", fields: ["release_date"] } })] }), listed: { providers: { s: { date: "2026-11-22", client: "provimux", models: [{ id: "own" }] } } } }).listings[0]!.models![0]!;
    expect(measuredOnly.sources).toMatchObject({ name: "providers.dev", context_window: "providers.dev" });
  });
});

describe("openai-codex once the discovery lists it (1.6.0)", () => {
  // The catalog's openai-codex: models.dev's two entries and the four providers.dev added; the authored list of six;
  // a discovery file that names three of them and gpt-6.1-terra not.
  const inherits = (id: string) => ({ from: `openai/${id}`, fields: ["name", "release_date", "canonical_id", "cost"] });
  const added = (id: string) => entry(id, { name: id.toUpperCase(), canonical_id: `openai/${id}` }, { origin: "added", inherited: inherits(id), measured: 921500 });
  const catalog = catalogOf({ "openai-codex": [
    entry("gpt-6.1-sol", { canonical_id: "openai/gpt-6.1-sol", limit: { context: 1050000, input: 922000, output: 128000 } }),
    entry("gpt-6.1-terra", { canonical_id: "openai/gpt-6.1-terra", limit: { context: 1050000, input: 922000, output: 128000 } }),
    added("gpt-6-astra"), added("gpt-6-luna"), added("gpt-6.2-astra"), added("gpt-6.2-sol"),
  ] });
  const authored = [AuthoredListing.parse({ provider: "openai-codex", list: { models: ["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-astra", "gpt-6-luna", "gpt-6.2-astra", "gpt-6.2-sol"], reason: "Six models.", evidence } })];
  const listed = { providers: { "openai-codex": { date: "2026-11-24", client: "provimux", models: [{ id: "gpt-6.2-sol", plans: ["plus", "pro"] }, { id: "gpt-6.2-astra" }, { id: "gpt-6.1-sol" }] } } };

  it("keeps gpt-6.1-terra, which the discovery lacks, as listed by providers.dev and models.dev, with models.dev's fields", () => {
    const { listings, issues } = build({ catalog, authored, listed });
    expect(issues).toEqual([]);
    const codex = listings[0]!;
    expect(codex).toMatchObject({ basis: "listed", listed_at: "2026-11-24", model_count: 6, lists: { listed: { listed_at: "2026-11-24", model_count: 3 }, "providers.dev": { listed_at: "2026-11-20", model_count: 6 }, "models.dev": { listed_at: "2026-11-21", model_count: 2 }, "pi.dev": null } });
    expect(codex.models!.map((model) => [model.id, model.listed_by])).toEqual([
      ["gpt-6.2-sol", ["listed", "providers.dev"]],
      ["gpt-6.2-astra", ["listed", "providers.dev"]],
      ["gpt-6.1-sol", ["listed", "providers.dev", "models.dev"]],
      ["gpt-6.1-terra", ["providers.dev", "models.dev"]],
      ["gpt-6-astra", ["providers.dev"]],
      ["gpt-6-luna", ["providers.dev"]],
    ]);
    expect(modelOf(codex.models, "gpt-6.1-terra")).toMatchObject({ entry: { provider: "openai-codex", model: "gpt-6.1-terra" }, context_window: 1050000, max_output: 128000, plans: [], sources: { context_window: "models.dev" } });
    expect(modelOf(codex.models, "gpt-6.2-sol")).toMatchObject({ plans: ["plus", "pro"], sources: { plans: "listed" } });
  });
});

describe("the authored Codex listing (finding 5)", () => {
  it("lists the six models of the catalog's openai-codex: models.dev's two and the four providers.dev measured, each with evidence", () => {
    const file = AuthoredListing.parse(parse(readFileSync(join(ROOT, "data", "authored", "listings", "openai-codex.yaml"), "utf8")));
    expect(file.list!.models).toEqual(["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-astra", "gpt-6-luna", "gpt-6.2-astra", "gpt-6.2-sol"]);
    expect(file.list!.evidence.map((item) => item.kind)).toEqual(["listed", "measured", "measured", "measured", "measured"]);
    const upstream = Object.keys((JSON.parse(readFileSync(join(ROOT, "data", "upstream", "providers", "openai-codex.json"), "utf8")) as { models: object }).models).sort();
    expect(upstream).toEqual(["gpt-6.1-sol", "gpt-6.1-terra"]);
    expect(readFileSync(join(ROOT, "data", "authored", "listings", "openai-codex.yaml"), "utf8")).toContain("union of every source's list");
  });
});

describe("one rule against contradictions in a row (second review)", () => {
  const terra = entry("gpt-6.1-terra", { canonical_id: "openai/gpt-6.1-terra", limit: { context: 1050000, input: 922000, output: 128000 }, capabilities: { reasoning: { supported: true, effort: ["low", "medium", "high", "xhigh", "max"] } } });
  const sol = entry("gpt-6.1-sol", { canonical_id: "openai/gpt-6.1-sol", limit: { context: 1050000, input: 922000, output: 128000 }, capabilities: { reasoning: { supported: true, effort: ["low", "medium", "high", "xhigh", "max"] } } });
  const catalog = catalogOf({ "openai-codex": [sol, terra] });
  const rows = (models: Record<string, unknown>[]) => build({ catalog, listed: { providers: { "openai-codex": { date: "2026-11-22", client: "provimux", models: models as never } } } }).listings[0]!.models!;

  it("Terra: a listed 1,200,000 input and 1,100,000 output beside models.dev's 1,050,000 window: the lower source's window is dropped", () => {
    const row = modelOf(rows([{ id: "gpt-6.1-sol" }, { id: "gpt-6.1-terra", max_input: 1200000, max_output: 1100000 }]), "gpt-6.1-terra");
    expect(row).toMatchObject({ context_window: null, max_input: 1200000, max_output: 1100000, sources: { context_window: null, max_input: "listed", max_output: "listed" } });
  });

  it("Sol: a listed supported: false beside models.dev's five levels: the levels are dropped", () => {
    const row = modelOf(rows([{ id: "gpt-6.1-sol", context_window: 40000, reasoning: { supported: false } }, { id: "gpt-6.1-terra" }]), "gpt-6.1-sol");
    expect(row.reasoning).toMatchObject({ supported: false, levels: null });
    expect(row.sources.reasoning).toMatchObject({ supported: "listed", levels: null });
    // And the 40,000 window: models.dev's 922,000 input and 128,000 output above it go.
    expect(row).toMatchObject({ context_window: 40000, max_input: null, max_output: null });
  });

  it("levels from a higher source beside a lower source's supported: false: supported is dropped", () => {
    const off = entry("off", { capabilities: { reasoning: { supported: false } } });
    const row = build({ catalog: catalogOf({ p: [off] }), listed: { providers: { p: { date: "2026-11-22", client: "provimux", models: [{ id: "off", reasoning: { levels: ["low", "high"] } }] } } } }).listings[0]!.models![0]!;
    expect(row.reasoning).toMatchObject({ supported: null, levels: ["low", "high"] });
  });

  it("one source contradicting itself: the window (or supported) is kept, the other field dropped", () => {
    const row = modelOf(rows([{ id: "gpt-6.1-sol", context_window: 100000, max_input: 200000, max_output: 300000, reasoning: { supported: false, levels: ["low"] } }, { id: "gpt-6.1-terra" }]), "gpt-6.1-sol");
    expect(row).toMatchObject({ context_window: 100000, max_input: null, max_output: null, reasoning: { supported: false, levels: null } });
    const self = build({ catalog: catalogOf({ p: [entry("x", { limit: { context: 1000, input: 2000, output: 3000 } })] }) }).listings[0]!.models![0]!;
    expect(self).toMatchObject({ context_window: 1000, max_input: null, max_output: null });
  });
});

describe("attribution (second review): an override credits providers.dev, an inherited value models.dev", () => {
  it("gpt-6.2-astra with a providers.dev correction of its inherited name and release date", () => {
    const astra = entry("gpt-6.2-astra", { name: "GPT 6.2 Astra Review Correction", release_date: "2026-11-16", canonical_id: "openai/gpt-6.2-astra" }, {
      origin: "added",
      inherited: { from: "openai/gpt-6.2-astra", fields: ["name", "description", "family", "type", "open_weights", "knowledge", "release_date", "last_updated", "canonical_id", "cost"] },
      provenance: [{ path: "name", op: "set" }, { path: "release_date", op: "set" }],
    });
    const row = build({ catalog: catalogOf({ "openai-codex": [astra] }), listed: { providers: { "openai-codex": { date: "2026-11-22", client: "provimux", models: [{ id: "gpt-6.2-astra" }] } } } }).listings[0]!.models![0]!;
    expect(row).toMatchObject({ name: "GPT 6.2 Astra Review Correction", released: "2026-11-16", owner: "openai", sources: { name: "providers.dev", released: "providers.dev", owner: "models.dev" } });
  });
});
