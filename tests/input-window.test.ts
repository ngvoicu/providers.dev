// The input window record (design/usable-input-window.md, sections 2 to 4 and the worked examples of section 7).
// Every limit and evaluation is written out here, as the published dataset 44f1435184e4b01c has it; nothing is read
// from data/.
import { describe, expect, it, vi } from "vitest";
import {
  ACCEPTED_AT_LEAST_PCT,
  documentedInput,
  emptyInputWindow,
  inputWindow,
  REFUSED_AT_MOST_PCT,
  windowMeasurement,
  type DocumentedField,
  type InputWindow,
  type InputWindowMeasurement,
  type LimitSource,
} from "../src/core/limits.ts";
import type { MeasuredLimit } from "../src/core/schema.ts";
import { inputWindowRuleBreaks } from "./helpers.ts";

type Evaluation = Omit<MeasuredLimit, "input_read"> & { input_read?: number | null };

const RESULTS = "https://github.com/ngvoicu/groundtruth/blob/main/results";
const CLIPROXY = { client: "cliproxyapi", client_label: "Requests sent through CLIProxyAPI" };
const CODEX = { route: "codex-subscription", route_label: "ChatGPT plan through the Codex login" };

/** One limit evaluation: what it did not measure is null. */
function evaluation(more: Partial<Evaluation> = {}): Evaluation {
  return {
    route: "r", route_label: "R", client: "direct", client_label: "Direct",
    context: null, output: null, input_accepted: null, input_refused: null, output_accepted: null, input_read: null,
    note: null, date: "2026-11-08", source: `${RESULTS}/limits-2026-11-08/limits.jsonl`, ...more,
  };
}

/** The models.dev import of 2026-11-15, as `resolve` passes it. */
const IMPORTED = (): { source: LimitSource; date: string | null } => ({ source: "models.dev", date: "2026-11-15" });

const window = (limit: unknown, measured: Evaluation[] = [], fromMeasurement: string[] = []): InputWindow => inputWindow(limit, fromMeasurement, measured, IMPORTED);

/** The record and the rules of 2.6 together: every record built here keeps them. */
function checked(limit: unknown, measured: Evaluation[] = [], fromMeasurement: string[] = []): InputWindow {
  const record = window(limit, measured, fromMeasurement);
  expect(inputWindowRuleBreaks(record, limit, fromMeasurement, measured)).toEqual([]);
  return record;
}

const NOTHING_DOCUMENTED = { documented_tokens: null, documented_field: null, documented_source: null, documented_date: null, documented_status: null } as const;
const NOTHING_MEASURED = { measured_tokens: null, measured_bound: null, measured_kind: null, measured_refused: null, measured_date: null, clients: 0, evaluations: 0, measurements: [] } as const;

describe("documentedInput (3.1)", () => {
  it.each<[string, unknown, string[], { tokens: number; field: DocumentedField } | null]>([
    ["input and context: the input", { context: 1050000, input: 922000, output: 128000 }, [], { tokens: 922000, field: "limit.input" }],
    ["context alone", { context: 1000000, output: 128000 }, [], { tokens: 1000000, field: "limit.context" }],
    ["input equal to context: the input", { context: 400000, input: 400000 }, [], { tokens: 400000, field: "limit.input" }],
    ["context 0 and input 4,500", { context: 0, input: 4500, output: 0 }, [], { tokens: 4500, field: "limit.input" }],
    ["context 0 alone", { context: 0, output: 0 }, [], null],
    ["input 0 and context 0", { context: 0, input: 0 }, [], null],
    ["input 0 and a context: the context", { context: 200000, input: 0 }, [], { tokens: 200000, field: "limit.context" }],
    ["no limit", undefined, [], null],
    ["a limit that is not an object", 1000000, [], null],
    ["a limit that is a list", [1000000], [], null],
    ["an input published as unknown", { context: 200000, input: null }, [], { tokens: 200000, field: "limit.context" }],
    ["context named in from_measurement", { context: 1000000, output: 128000 }, ["context", "output"], null],
    ["input, with context named in from_measurement", { context: 1000000, input: 900000 }, ["context"], { tokens: 900000, field: "limit.input" }],
  ])("%s", (_name, limit, fromMeasurement, expected) => {
    expect(documentedInput(limit, fromMeasurement)).toEqual(expected);
  });
});

describe("windowMeasurement (3.3)", () => {
  const item = (more: Partial<InputWindowMeasurement>): InputWindowMeasurement => ({
    client: "direct", client_label: "Direct", route: "r", route_label: "R", date: "2026-11-08",
    tokens: 0, bound: "at_least", kind: "bracket", accepted: null, refused: null, named: null, read: null,
    source: `${RESULTS}/limits-2026-11-08/limits.jsonl`, ...more,
  });

  it("reads the four kinds of row of today", () => {
    // The Claude login: a window named, nothing accepted beside it.
    expect(windowMeasurement(evaluation({ context: 1000000, output: 128000 }))).toEqual(item({ tokens: 1000000, bound: "limit", kind: "window", named: 1000000 }));
    // Muse Wonder: a window named, with an accepted input beside it.
    expect(windowMeasurement(evaluation({ context: 1048576, input_accepted: 1047604, output_accepted: 1000000 }))).toEqual(item({ tokens: 1048576, bound: "limit", kind: "window", named: 1048576, accepted: 1047604 }));
    // The Codex login: accepted below a refusal.
    expect(windowMeasurement(evaluation({ input_accepted: 915011, input_refused: 922500 }))).toEqual(item({ tokens: 915011, kind: "bracket", accepted: 915011, refused: 922500 }));
    // Devin's numbers.
    expect(windowMeasurement(evaluation({ input_accepted: 915390, input_refused: 925000 }))).toEqual(item({ tokens: 915390, kind: "bracket", accepted: 915390, refused: 925000 }));
  });

  it("keeps who, where, when and the source of the evaluation", () => {
    const measured = windowMeasurement(evaluation({ ...CLIPROXY, ...CODEX, date: "2026-11-13", source: `${RESULTS}/limits-2026-11-13/limits.jsonl`, input_accepted: 915011, input_refused: 922500, note: "a note" }));
    expect(measured).toMatchObject({ ...CLIPROXY, ...CODEX, date: "2026-11-13", source: `${RESULTS}/limits-2026-11-13/limits.jsonl` });
    expect(Object.keys(measured!)).toEqual(["client", "client_label", "route", "route_label", "date", "tokens", "bound", "kind", "accepted", "refused", "named", "read", "source"]);
  });

  it("reads a window with a refusal above it as the window", () => {
    expect(windowMeasurement(evaluation({ context: 1000000, input_accepted: 990000, input_refused: 1010190 }))).toMatchObject({ kind: "window", tokens: 1000000, bound: "limit", refused: 1010190 });
  });

  it("reads a refusal at or below a named window, with an accepted input, as a bracket", () => {
    expect(windowMeasurement(evaluation({ context: 1050000, input_accepted: 915011, input_refused: 922500 }))).toMatchObject({ kind: "bracket", tokens: 915011, bound: "at_least", named: 1050000 });
    expect(windowMeasurement(evaluation({ context: 1000000, input_accepted: 990000, input_refused: 1000000 }))).toMatchObject({ kind: "bracket", tokens: 990000 });
  });

  it("gives an accepted input read to the end its read size, and nothing for an accepted input alone", () => {
    expect(windowMeasurement(evaluation({ input_accepted: 930000, input_read: 250000 }))).toMatchObject({ kind: "accepted", tokens: 250000, bound: "at_least", accepted: 930000, read: 250000, refused: null, named: null });
    // Devin's swe-2: 930,000 answered, nothing refused, no read check.
    expect(windowMeasurement(evaluation({ input_accepted: 930000 }))).toBeNull();
    // A row made before input_read existed.
    const { input_read: _absent, ...older } = evaluation({ input_accepted: 930000 });
    expect(windowMeasurement(older)).toBeNull();
  });

  it("does not count a refusal alone, the output alone, or a refusal under a named window with nothing accepted", () => {
    expect(windowMeasurement(evaluation({ input_refused: 250000 }))).toBeNull();
    expect(windowMeasurement(evaluation({ output: 128000, output_accepted: 100000 }))).toBeNull();
    expect(windowMeasurement(evaluation({ context: 1000000, input_refused: 900000 }))).toBeNull();
    expect(windowMeasurement(evaluation())).toBeNull();
  });
});

describe("inputWindow: the worked examples of section 7", () => {
  it("1. openai-codex/gpt-6.1-sol: documented, a bracket around it: 922,000 documented", () => {
    const measured = [evaluation({ ...CLIPROXY, ...CODEX, date: "2026-11-13", source: `${RESULTS}/limits-2026-11-13/limits.jsonl`, input_accepted: 915011, input_refused: 922500, note: "Codex's own model list gives a 500K default window and an 872K maximum for this model" })];
    expect(checked({ context: 1050000, input: 922000, output: 128000 }, measured)).toEqual({
      tokens: 922000, basis: "documented", bound: "limit", scope: "input",
      source: "models.dev", date: "2026-11-15",
      documented_tokens: 922000, documented_field: "limit.input",
      documented_source: "models.dev", documented_date: "2026-11-15",
      documented_status: "not_contradicted",
      measured_tokens: 915011, measured_bound: "at_least", measured_kind: "bracket",
      measured_refused: 922500, measured_date: "2026-11-13",
      clients: 1, evaluations: 1,
      measurements: [
        { client: "cliproxyapi", client_label: "Requests sent through CLIProxyAPI",
          route: "codex-subscription", route_label: "ChatGPT plan through the Codex login",
          date: "2026-11-13", tokens: 915011, bound: "at_least", kind: "bracket",
          accepted: 915011, refused: 922500, named: null, read: null,
          source: "https://github.com/ngvoicu/groundtruth/blob/main/results/limits-2026-11-13/limits.jsonl" },
      ],
    });
  });

  it("2. openai-codex/gpt-6.1-terra: documented, no evaluation: 922,000 documented, status null", () => {
    expect(checked({ context: 1050000, input: 922000, output: 128000 })).toEqual({
      tokens: 922000, basis: "documented", bound: "limit", scope: "input", source: "models.dev", date: "2026-11-15",
      documented_tokens: 922000, documented_field: "limit.input", documented_source: "models.dev", documented_date: "2026-11-15", documented_status: null,
      ...NOTHING_MEASURED,
    });
  });

  it("3 and 4. openai-codex/gpt-6-astra and gpt-6-luna: nothing documented, a bracket: 915,011 measured, at least", () => {
    const measured = [evaluation({ ...CLIPROXY, ...CODEX, date: "2026-11-11", source: `${RESULTS}/gpt6-2026-11-11/limits.jsonl`, input_accepted: 915011, input_refused: 922500 })];
    const sourceOf = vi.fn(IMPORTED);
    const record = inputWindow(undefined, [], measured, sourceOf);
    expect(inputWindowRuleBreaks(record, undefined, [], measured)).toEqual([]);
    expect({ ...record, measurements: undefined }).toEqual({
      tokens: 915011, basis: "measured", bound: "at_least", scope: "input", source: "providers.dev", date: "2026-11-11",
      ...NOTHING_DOCUMENTED,
      measured_tokens: 915011, measured_bound: "at_least", measured_kind: "bracket", measured_refused: 922500, measured_date: "2026-11-11",
      clients: 1, evaluations: 1, measurements: undefined,
    });
    expect(record.measurements).toEqual([windowMeasurement(measured[0]!)]);
    // Nothing is documented, so nobody is asked who documents it.
    expect(sourceOf).not.toHaveBeenCalled();
  });

  it("5. devin/gpt-6-1-sol: nothing documented, a bracket: 915,390 measured, at least; Devin's list would be contradicted", () => {
    const measured = [evaluation({ ...CLIPROXY, route: "devin", route_label: "Devin subscription", input_accepted: 915390, input_refused: 925000, note: "Devin's own model list says 1,000,000" })];
    expect(checked(undefined, measured)).toMatchObject({
      tokens: 915390, basis: "measured", bound: "at_least", scope: "input", source: "providers.dev", date: "2026-11-08",
      ...NOTHING_DOCUMENTED,
      measured_tokens: 915390, measured_bound: "at_least", measured_kind: "bracket", measured_refused: 925000, measured_date: "2026-11-08", clients: 1, evaluations: 1,
    });
    // Had the provider file stated the list's 1,000,000 as limit.context: test c, the same 915,390.
    expect(checked({ context: 1000000 }, measured)).toMatchObject({ tokens: 915390, basis: "measured", documented_tokens: 1000000, documented_status: "contradicted" });
  });

  it("6. claude-subscription/claude-opus-5-5: the window the route names: 1,000,000 measured", () => {
    const measured = [evaluation({ ...CLIPROXY, route: "claude-subscription", route_label: "Claude login", context: 1000000, output: 128000 })];
    const record = checked({ context: 1000000, output: 128000 }, measured, ["context", "output"]);
    expect({ ...record, measurements: [] }).toEqual({
      tokens: 1000000, basis: "measured", bound: "limit", scope: "window", source: "providers.dev", date: "2026-11-08",
      ...NOTHING_DOCUMENTED,
      measured_tokens: 1000000, measured_bound: "limit", measured_kind: "window", measured_refused: null, measured_date: "2026-11-08",
      clients: 1, evaluations: 1, measurements: [],
    });
    expect(record.measurements[0]).toMatchObject({ kind: "window", tokens: 1000000, named: 1000000, accepted: null });
  });

  it("7. meta-subscription/muse-wonder-1.0: a named window with an accepted input beside it: 1,048,576 measured", () => {
    const measured = [evaluation({ ...CLIPROXY, route: "meta-subscription", route_label: "Muse Code", context: 1048576, input_accepted: 1047604, output_accepted: 1000000 })];
    const record = checked({ context: 1048576 }, measured, ["context"]);
    expect(record).toMatchObject({ tokens: 1048576, basis: "measured", bound: "limit", scope: "window", ...NOTHING_DOCUMENTED, measured_kind: "window", measured_refused: null });
    expect(record.measurements[0]).toMatchObject({ accepted: 1047604, named: 1048576, refused: null });
  });

  it("8. openai/gpt-6.1-sol: documented, not measured: 922,000 documented", () => {
    expect(checked({ context: 1050000, input: 922000, output: 128000 })).toEqual({
      tokens: 922000, basis: "documented", bound: "limit", scope: "input", source: "models.dev", date: "2026-11-15",
      documented_tokens: 922000, documented_field: "limit.input", documented_source: "models.dev", documented_date: "2026-11-15", documented_status: null,
      ...NOTHING_MEASURED,
    });
  });

  it("9. anthropic/claude-opus-5-5: a window documented, no input limit: 1,000,000 documented, scope window", () => {
    expect(checked({ context: 1000000, output: 128000 })).toEqual({
      tokens: 1000000, basis: "documented", bound: "limit", scope: "window", source: "models.dev", date: "2026-11-15",
      documented_tokens: 1000000, documented_field: "limit.context", documented_source: "models.dev", documented_date: "2026-11-15", documented_status: null,
      ...NOTHING_MEASURED,
    });
  });

  it("10. aihubmix/gpt-image-2: a window of 0: null; Qwen Image 3.0 Pro: 4,500 from limit.input", () => {
    expect(checked({ context: 0, output: 0 })).toEqual(emptyInputWindow());
    expect(checked({ context: 0, input: 4500, output: 0 })).toMatchObject({ tokens: 4500, basis: "documented", scope: "input", documented_field: "limit.input" });
  });

  it("11. devin/claude-opus-5-5: nothing known: null", () => {
    const record = checked(undefined);
    expect(record).toEqual(emptyInputWindow());
    expect(record).toEqual({ tokens: null, basis: "none", bound: null, scope: null, source: null, date: null, ...NOTHING_DOCUMENTED, ...NOTHING_MEASURED });
  });

  it("12. openrouter/openai/gpt-6.1-sol: an input limit documented, a larger window named: 922,000 documented", () => {
    const measured = [evaluation({ ...CLIPROXY, route: "openrouter", route_label: "OpenRouter API key", context: 1050000 })];
    expect(checked({ context: 1050000, input: 922000, output: 128000 }, measured)).toMatchObject({
      tokens: 922000, basis: "documented", scope: "input", documented_status: "not_contradicted",
      measured_tokens: 1050000, measured_bound: "limit", measured_kind: "window", measured_refused: null,
    });
  });
});

describe("inputWindow: the test of 4.2", () => {
  const D = { context: 1050000, input: 922000 };
  const bracket = (accepted: number, refused: number, more: Partial<Evaluation> = {}) => evaluation({ input_accepted: accepted, input_refused: refused, ...more });
  const read = (tokens: number, more: Partial<Evaluation> = {}) => evaluation({ input_accepted: tokens, input_read: tokens, ...more });
  const status = (limit: unknown, measured: Evaluation[]) => {
    const record = checked(limit, measured);
    return [record.basis, record.documented_status, record.tokens];
  };

  it("has a margin of 1 %", () => {
    expect([REFUSED_AT_MOST_PCT, ACCEPTED_AT_LEAST_PCT]).toEqual([99, 101]);
  });

  it("c. a refusal at exactly 99 % contradicts (912,780 against 922,000), one token above does not", () => {
    expect(status(D, [bracket(900000, 912780)])).toEqual(["measured", "contradicted", 900000]);
    expect(status(D, [bracket(900000, 912781)])).toEqual(["documented", "not_contradicted", 922000]);
  });

  it("a refusal above the documented value does not contradict", () => {
    expect(status(D, [bracket(915011, 922500)])).toEqual(["documented", "not_contradicted", 922000]);
  });

  it("d. an accepted input at exactly 101 % contradicts (931,220), one token below does not", () => {
    expect(status(D, [bracket(931220, 940000)])).toEqual(["measured", "contradicted", 931220]);
    expect(status(D, [bracket(931219, 940000)])).toEqual(["documented", "not_contradicted", 922000]);
    // Read to the end, nothing refused: the same test.
    expect(status(D, [read(931220)])).toEqual(["measured", "contradicted", 931220]);
    expect(status(D, [read(931219)])).toEqual(["documented", "not_contradicted", 922000]);
    // An accepted size that does not count raises nothing.
    expect(status(D, [evaluation({ input_accepted: 1000000 })])).toEqual(["documented", null, 922000]);
  });

  it("raises the value above a documented one: the measured value, at least", () => {
    expect(checked(D, [read(960000)])).toMatchObject({ tokens: 960000, basis: "measured", bound: "at_least", scope: "input", source: "providers.dev", documented_tokens: 922000, documented_status: "contradicted" });
  });

  it("Terra's walk (920,870 accepted, 921,875 refused, documented 922,000): documented, not contradicted", () => {
    expect(checked(D, [bracket(920870, 921875, { ...CLIPROXY, ...CODEX })])).toMatchObject({
      tokens: 922000, basis: "documented", documented_status: "not_contradicted",
      measured_tokens: 920870, measured_bound: "at_least", measured_kind: "bracket", measured_refused: 921875,
    });
  });

  it("a. a named window below a documented limit.input contradicts; one above it does not", () => {
    expect(status(D, [evaluation({ context: 900000 })])).toEqual(["measured", "contradicted", 900000]);
    expect(status(D, [evaluation({ context: 1050000 })])).toEqual(["documented", "not_contradicted", 922000]);
    expect(status(D, [evaluation({ context: 2000000 })])).toEqual(["documented", "not_contradicted", 922000]);
  });

  it("b. a named window other than a documented limit.context contradicts, above and below; the same window does not", () => {
    expect(status({ context: 1000000 }, [evaluation({ context: 1048576 })])).toEqual(["measured", "contradicted", 1048576]);
    expect(status({ context: 1000000 }, [evaluation({ context: 990000 })])).toEqual(["measured", "contradicted", 990000]);
    expect(status({ context: 1000000 }, [evaluation({ context: 1000000 })])).toEqual(["documented", "not_contradicted", 1000000]);
    // Even by one token: a named window has no margin.
    expect(status({ context: 1000000 }, [evaluation({ context: 1000001 })])).toEqual(["measured", "contradicted", 1000001]);
  });

  it("a named window below the documented value contradicts also where the evaluation is a bracket", () => {
    // The refusal is at or below the window, so the row is a bracket; its named window is still below D.
    expect(status(D, [evaluation({ context: 915000, input_accepted: 914000, input_refused: 915000 })])).toEqual(["measured", "contradicted", 914000]);
  });

  it("an accepted size far below the documented value does not contradict", () => {
    expect(status(D, [bracket(400000, 1000000)])).toEqual(["documented", "not_contradicted", 922000]);
    expect(status(D, [read(400000)])).toEqual(["documented", "not_contradicted", 922000]);
  });

  it("two clients, one contradicting: measured, the lowest", () => {
    const record = checked(D, [bracket(915011, 922500, { client: "a" }), bracket(800000, 850000, { client: "b" })]);
    expect(record).toMatchObject({ basis: "measured", documented_status: "contradicted", tokens: 800000, measured_tokens: 800000, measured_refused: 850000, clients: 2, evaluations: 2 });
    expect(record.measurements.map((item) => item.client)).toEqual(["b", "a"]);
  });

  it("two clients, neither contradicting: documented, measured_tokens the lowest", () => {
    const record = checked(D, [evaluation({ client: "a", context: 1050000 }), bracket(915011, 922500, { client: "b" })]);
    expect(record).toMatchObject({ basis: "documented", documented_status: "not_contradicted", tokens: 922000, measured_tokens: 915011, measured_kind: "bracket", clients: 2, evaluations: 2 });
  });

  it("several evaluations of one client count as one client", () => {
    const record = checked(D, [bracket(915011, 922500, { date: "2026-11-11" }), bracket(920870, 921875, { date: "2026-11-08" })]);
    expect([record.clients, record.evaluations, record.measured_date]).toEqual([1, 2, "2026-11-11"]);
  });
});

describe("inputWindow: order, sources and what does not count", () => {
  it("orders the items by tokens, limit before at_least, then client, route, date and source, null first, whatever the input order", () => {
    const measured = [
      evaluation({ client: "b", context: 900000 }),
      evaluation({ client: "a", input_accepted: 900000, input_refused: 950000 }),
      evaluation({ client: "a", context: 900000, route: "r2" }),
      evaluation({ client: "a", context: 900000, route: "r1", date: "2026-11-09" }),
      evaluation({ client: "a", context: 900000, route: "r1", date: null }),
      evaluation({ client: "a", context: 900000, route: "r1", date: "2026-11-09", source: "https://example.com/a" }),
      evaluation({ client: "z", input_accepted: 100000, input_refused: 950000 }),
    ];
    const expected = [
      ["z", "r", "2026-11-08", 100000, "at_least"],
      ["a", "r1", null, 900000, "limit"],
      ["a", "r1", "2026-11-09", 900000, "limit"],
      ["a", "r1", "2026-11-09", 900000, "limit"],
      ["a", "r2", "2026-11-08", 900000, "limit"],
      ["b", "r", "2026-11-08", 900000, "limit"],
      ["a", "r", "2026-11-08", 900000, "at_least"],
    ];
    for (const order of [measured, [...measured].reverse(), [measured[3]!, measured[0]!, measured[6]!, measured[1]!, measured[5]!, measured[2]!, measured[4]!]]) {
      const record = checked(undefined, order);
      expect(record.measurements.map((item) => [item.client, item.route, item.date, item.tokens, item.bound])).toEqual(expected);
      expect(record.measurements[2]!.source).toBe("https://example.com/a");
      expect(record).toMatchObject({ tokens: 100000, basis: "measured", bound: "at_least", clients: 3, evaluations: 7 });
    }
  });

  it("asks sourceOf with the field read, once, and publishes its source and date", () => {
    for (const [limit, field] of [[{ context: 1050000, input: 922000 }, "limit.input"], [{ context: 1000000 }, "limit.context"]] as const) {
      const sourceOf = vi.fn((): { source: LimitSource; date: string | null } => ({ source: "providers.dev", date: "2026-11-02" }));
      const record = inputWindow(limit, [], [], sourceOf);
      expect(sourceOf.mock.calls).toEqual([[field]]);
      expect(record).toMatchObject({ basis: "documented", source: "providers.dev", date: "2026-11-02", documented_source: "providers.dev", documented_date: "2026-11-02" });
    }
    const sourceOf = vi.fn(IMPORTED);
    inputWindow({ context: 0 }, [], [evaluation({ context: 1000000 })], sourceOf);
    inputWindow({ context: 1000000 }, ["context"], [], sourceOf);
    expect(sourceOf).not.toHaveBeenCalled();
    // A source with no date publishes none.
    expect(inputWindow({ context: 1000000 }, [], [], () => ({ source: "models.dev", date: null }))).toMatchObject({ date: null, documented_date: null });
  });

  it("gives none, with evaluations 0, to an entry with only evaluations that do not count", () => {
    const record = checked(undefined, [evaluation({ input_accepted: 930000 }), evaluation({ input_refused: 250000 }), evaluation({ output: 128000 })]);
    expect(record).toEqual(emptyInputWindow());
    // Beside a documented value, they change nothing and set no status.
    expect(checked({ context: 262000 }, [evaluation({ input_accepted: 930000 })])).toMatchObject({ basis: "documented", tokens: 262000, documented_status: null, evaluations: 0, measurements: [] });
  });

  it("returns a fresh empty record each time", () => {
    const first = emptyInputWindow();
    first.measurements.push({} as InputWindowMeasurement);
    expect(emptyInputWindow().measurements).toEqual([]);
  });
});
