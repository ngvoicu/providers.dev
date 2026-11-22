// The input window record (design/usable-input-window.md, sections 2 to 4 and the worked examples of section 7), with
// its safe value by the rule of design/sources-side-by-side.md (2.3, 2.4): the most direct measurement first, then the
// documented value. Every limit and evaluation is written out here, as the published dataset 44f1435184e4b01c has it;
// nothing is read from data/.
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
import type { EntryAccess } from "../src/core/safe.ts";
import type { MeasuredLimit } from "../src/core/schema.ts";
import { finishWindow, inputWindowRuleBreaks } from "./helpers.ts";

type Evaluation = Omit<MeasuredLimit, "input_read"> & { input_read?: number | null };

const RESULTS = "https://github.com/ngvoicu/groundtruth/blob/main/results";
const CLIPROXY = { client: "cliproxyapi", client_label: "Requests sent through Provimux", client_kind: "proxy" } as const;
/** The worked examples on a login are on an entry whose access is subscription. */
const LOGIN: EntryAccess = "subscription";
const CODEX = { route: "codex-subscription", route_label: "ChatGPT plan through the Codex login" };

/** One limit evaluation: what it did not measure is null. */
function evaluation(more: Partial<Evaluation> = {}): Evaluation {
  return {
    route: "r", route_label: "R", client: "direct", client_label: "Direct",
    context: null, output: null, input_accepted: null, input_refused: null, output_accepted: null, input_read: null,
    note: null, date: "2026-11-08", source: `${RESULTS}/limits-2026-11-08/limits.jsonl`, client_kind: "direct", ...more,
  };
}

/** The models.dev import of 2026-11-15, as `resolve` passes it. */
const IMPORTED = (): { source: LimitSource; date: string | null } => ({ source: "models.dev", date: "2026-11-15" });

/** The record with its safe value, as the build makes it of an entry with no other source. */
const window = (limit: unknown, measured: Evaluation[] = [], fromMeasurement: string[] = [], access: EntryAccess = "api"): InputWindow =>
  finishWindow(inputWindow(limit, fromMeasurement, measured, IMPORTED, access));

/** The record and the rules of 2.6 together: every record built here keeps them. */
function checked(limit: unknown, measured: Evaluation[] = [], fromMeasurement: string[] = [], access: EntryAccess = "api"): InputWindow {
  const record = window(limit, measured, fromMeasurement, access);
  expect(inputWindowRuleBreaks(record, limit, fromMeasurement, measured, access)).toEqual([]);
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
    source: `${RESULTS}/limits-2026-11-08/limits.jsonl`, client_kind: "direct", chosen: false, ...more,
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
    expect(Object.keys(measured!)).toEqual(["client", "client_label", "route", "route_label", "date", "tokens", "bound", "kind", "accepted", "refused", "named", "read", "source", "client_kind", "chosen"]);
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
  it("1. openai-codex/gpt-6.1-sol: documented, a bracket around it: 915,011 measured, at least (the measurement comes first)", () => {
    const measured = [evaluation({ ...CLIPROXY, ...CODEX, date: "2026-11-13", source: `${RESULTS}/limits-2026-11-13/limits.jsonl`, input_accepted: 915011, input_refused: 922500, note: "Codex's own model list gives a 500K default window and an 872K maximum for this model" })];
    expect(checked({ context: 1050000, input: 922000, output: 128000 }, measured, [], LOGIN)).toEqual({
      tokens: 915011, basis: "measured", bound: "at_least", scope: "input",
      source: "providers.dev", date: "2026-11-13",
      documented_tokens: 922000, documented_field: "limit.input",
      documented_source: "models.dev", documented_date: "2026-11-15",
      documented_status: "not_contradicted",
      measured_tokens: 915011, measured_bound: "at_least", measured_kind: "bracket",
      measured_refused: 922500, measured_date: "2026-11-13",
      clients: 1, evaluations: 1,
      measurements: [
        { client: "cliproxyapi", client_label: "Requests sent through Provimux",
          route: "codex-subscription", route_label: "ChatGPT plan through the Codex login",
          date: "2026-11-13", tokens: 915011, bound: "at_least", kind: "bracket",
          accepted: 915011, refused: 922500, named: null, read: null,
          source: "https://github.com/ngvoicu/groundtruth/blob/main/results/limits-2026-11-13/limits.jsonl", client_kind: "proxy", chosen: true },
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
    const record = finishWindow(inputWindow(undefined, [], measured, sourceOf, LOGIN));
    expect(inputWindowRuleBreaks(record, undefined, [], measured, LOGIN)).toEqual([]);
    expect({ ...record, measurements: undefined }).toEqual({
      tokens: 915011, basis: "measured", bound: "at_least", scope: "input", source: "providers.dev", date: "2026-11-11",
      ...NOTHING_DOCUMENTED,
      measured_tokens: 915011, measured_bound: "at_least", measured_kind: "bracket", measured_refused: 922500, measured_date: "2026-11-11",
      clients: 1, evaluations: 1, measurements: undefined,
    });
    expect(record.measurements).toEqual([{ ...windowMeasurement(measured[0]!), chosen: true }]);
    // Nothing is documented, so nobody is asked who documents it.
    expect(sourceOf).not.toHaveBeenCalled();
  });

  it("5. devin/gpt-6-1-sol: nothing documented, a bracket: 915,390 measured, at least; Devin's list would be contradicted", () => {
    const measured = [evaluation({ ...CLIPROXY, route: "devin", route_label: "Devin subscription", input_accepted: 915390, input_refused: 925000, note: "Devin's own model list says 1,000,000" })];
    expect(checked(undefined, measured, [], LOGIN)).toMatchObject({
      tokens: 915390, basis: "measured", bound: "at_least", scope: "input", source: "providers.dev", date: "2026-11-08",
      ...NOTHING_DOCUMENTED,
      measured_tokens: 915390, measured_bound: "at_least", measured_kind: "bracket", measured_refused: 925000, measured_date: "2026-11-08", clients: 1, evaluations: 1,
    });
    // Had the provider file stated the list's 1,000,000 as limit.context: test c, the same 915,390.
    expect(checked({ context: 1000000 }, measured, [], LOGIN)).toMatchObject({ tokens: 915390, basis: "measured", documented_tokens: 1000000, documented_status: "contradicted" });
  });

  it("6. claude-subscription/claude-opus-5-5: the window the route names: 1,000,000 measured", () => {
    const measured = [evaluation({ ...CLIPROXY, route: "claude-subscription", route_label: "Claude login", context: 1000000, output: 128000 })];
    const record = checked({ context: 1000000, output: 128000 }, measured, ["context", "output"], LOGIN);
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
    const record = checked({ context: 1048576 }, measured, ["context"], LOGIN);
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

  it("12. openrouter/openai/gpt-6.1-sol: an input limit documented, a larger window named through the proxy: 922,000 documented, the proxy not counted", () => {
    const measured = [evaluation({ ...CLIPROXY, route: "openrouter", route_label: "OpenRouter API key", context: 1050000 })];
    const record = checked({ context: 1050000, input: 922000, output: 128000 }, measured);
    expect(record).toMatchObject({
      tokens: 922000, basis: "documented", scope: "input", source: "models.dev", documented_status: null,
      measured_tokens: null, measured_bound: null, measured_kind: null, clients: 0, evaluations: 0,
    });
    expect(record.measurements).toMatchObject([{ client_kind: "proxy", chosen: false, tokens: 1050000 }]);
    // Measured directly, the named window is first and the documented cap inside it is the safe value (2.4).
    expect(checked({ context: 1050000, input: 922000, output: 128000 }, [evaluation({ route: "openrouter", context: 1050000 })])).toMatchObject({
      tokens: 922000, basis: "documented", scope: "input", source: "models.dev", documented_status: "not_contradicted",
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

  it("c. a refusal at exactly 99 % contradicts (912,780 against 922,000), one token above does not; the measurement is the value either way", () => {
    expect(status(D, [bracket(900000, 912780)])).toEqual(["measured", "contradicted", 900000]);
    expect(status(D, [bracket(900000, 912781)])).toEqual(["measured", "not_contradicted", 900000]);
  });

  it("a refusal above the documented value does not contradict", () => {
    expect(status(D, [bracket(915011, 922500)])).toEqual(["measured", "not_contradicted", 915011]);
  });

  it("d. an accepted input at exactly 101 % contradicts (931,220), one token below does not", () => {
    expect(status(D, [bracket(931220, 940000)])).toEqual(["measured", "contradicted", 931220]);
    expect(status(D, [bracket(931219, 940000)])).toEqual(["measured", "not_contradicted", 931219]);
    // Read to the end, nothing refused: the same test.
    expect(status(D, [read(931220)])).toEqual(["measured", "contradicted", 931220]);
    expect(status(D, [read(931219)])).toEqual(["measured", "not_contradicted", 931219]);
    // An accepted size that does not count raises nothing.
    expect(status(D, [evaluation({ input_accepted: 1000000 })])).toEqual(["documented", null, 922000]);
  });

  it("raises the value above a documented one: the measured value, at least", () => {
    expect(checked(D, [read(960000)])).toMatchObject({ tokens: 960000, basis: "measured", bound: "at_least", scope: "input", source: "providers.dev", documented_tokens: 922000, documented_status: "contradicted" });
  });

  it("Terra's walk on the login (920,870 accepted, 921,875 refused, documented 922,000): at least 920,870 measured, not contradicted", () => {
    expect(checked(D, [bracket(920870, 921875, { ...CLIPROXY, ...CODEX })], [], LOGIN)).toMatchObject({
      tokens: 920870, basis: "measured", bound: "at_least", documented_status: "not_contradicted",
      measured_tokens: 920870, measured_bound: "at_least", measured_kind: "bracket", measured_refused: 921875,
    });
  });

  it("a. a named window below a documented limit.input contradicts; one above it does not, and the cap inside it is the value", () => {
    expect(status(D, [evaluation({ context: 900000 })])).toEqual(["measured", "contradicted", 900000]);
    expect(status(D, [evaluation({ context: 1050000 })])).toEqual(["documented", "not_contradicted", 922000]);
    expect(status(D, [evaluation({ context: 2000000 })])).toEqual(["documented", "not_contradicted", 922000]);
  });

  it("b. a named window other than a documented limit.context contradicts, above and below; the same window does not", () => {
    expect(status({ context: 1000000 }, [evaluation({ context: 1048576 })])).toEqual(["measured", "contradicted", 1048576]);
    expect(status({ context: 1000000 }, [evaluation({ context: 990000 })])).toEqual(["measured", "contradicted", 990000]);
    expect(status({ context: 1000000 }, [evaluation({ context: 1000000 })])).toEqual(["measured", "not_contradicted", 1000000]);
    // Even by one token: a named window has no margin.
    expect(status({ context: 1000000 }, [evaluation({ context: 1000001 })])).toEqual(["measured", "contradicted", 1000001]);
  });

  it("a named window below the documented value contradicts also where the evaluation is a bracket", () => {
    // The refusal is at or below the window, so the row is a bracket; its named window is still below D.
    expect(status(D, [evaluation({ context: 915000, input_accepted: 914000, input_refused: 915000 })])).toEqual(["measured", "contradicted", 914000]);
  });

  it("an accepted size far below the documented value does not contradict, and is the value: a lower bound", () => {
    expect(status(D, [bracket(400000, 1000000)])).toEqual(["measured", "not_contradicted", 400000]);
    expect(status(D, [read(400000)])).toEqual(["measured", "not_contradicted", 400000]);
  });

  it("two clients, one contradicting: measured, the lowest", () => {
    const record = checked(D, [bracket(915011, 922500, { client: "a" }), bracket(800000, 850000, { client: "b" })]);
    expect(record).toMatchObject({ basis: "measured", documented_status: "contradicted", tokens: 800000, measured_tokens: 800000, measured_refused: 850000, clients: 2, evaluations: 2 });
    expect(record.measurements.map((item) => item.client)).toEqual(["b", "a"]);
  });

  it("two clients of one kind, neither contradicting: measured, the lowest", () => {
    const record = checked(D, [evaluation({ client: "a", context: 1050000 }), bracket(915011, 922500, { client: "b" })]);
    expect(record).toMatchObject({ basis: "measured", documented_status: "not_contradicted", tokens: 915011, measured_tokens: 915011, measured_kind: "bracket", clients: 2, evaluations: 2 });
  });

  it("several evaluations of one client count as one client", () => {
    const record = checked(D, [bracket(915011, 922500, { date: "2026-11-11" }), bracket(920870, 921875, { date: "2026-11-08" })]);
    expect([record.clients, record.evaluations, record.measured_date]).toEqual([1, 2, "2026-11-11"]);
  });
});

describe("inputWindow: which kind of client counts (design/sources-side-by-side.md, 2.3)", () => {
  const D = { context: 1050000, input: 922000 };
  const bracket = (accepted: number, refused: number, more: Partial<Evaluation> = {}) => evaluation({ input_accepted: accepted, input_refused: refused, ...more });
  const OWN = { client: "codex-cli", client_label: "OpenAI's Codex CLI", client_kind: "own_client" } as const;

  it("on an API-key entry, only direct: a proxy beside it changes nothing, a proxy alone gives no measured value", () => {
    const both = checked(D, [bracket(800000, 850000, CLIPROXY), bracket(915011, 922500)]);
    expect(both).toMatchObject({ tokens: 915011, basis: "measured", measured_tokens: 915011, clients: 1, evaluations: 1 });
    expect(both.measurements.map((item) => [item.client_kind, item.chosen])).toEqual([["proxy", false], ["direct", true]]);
    for (const other of [CLIPROXY, OWN]) {
      expect(checked(D, [bracket(800000, 850000, other)])).toMatchObject({ tokens: 922000, basis: "documented", measured_tokens: null, documented_status: null, evaluations: 0 });
    }
    // Access unknown is read as an API key.
    expect(checked(D, [bracket(800000, 850000, CLIPROXY)], [], "unknown")).toMatchObject({ tokens: 922000, basis: "documented" });
  });

  it("on a login, the vendor's own client first, whichever is lower; then direct; then a proxy", () => {
    const own = checked(D, [bracket(800000, 850000, CLIPROXY), bracket(915011, 922500, OWN)], [], LOGIN);
    expect(own).toMatchObject({ tokens: 915011, measured_tokens: 915011, clients: 1 });
    expect(own.measurements.map((item) => [item.client_kind, item.chosen])).toEqual([["proxy", false], ["own_client", true]]);
    expect(checked(D, [bracket(800000, 850000, CLIPROXY), bracket(915011, 922500)], [], LOGIN)).toMatchObject({ tokens: 915011, measured_tokens: 915011 });
    expect(checked(D, [bracket(800000, 850000, CLIPROXY)], [], LOGIN)).toMatchObject({ tokens: 800000, basis: "measured", measured_tokens: 800000 });
  });

  it("feeds nothing with a client that has no kind", () => {
    const record = checked(D, [bracket(800000, 850000, { client: "other", client_kind: null })], [], LOGIN);
    expect(record).toMatchObject({ tokens: 922000, basis: "documented", measured_tokens: null });
    expect(record.measurements).toMatchObject([{ client_kind: null, chosen: false }]);
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
      const record = finishWindow(inputWindow(limit, [], [], sourceOf));
      expect(sourceOf.mock.calls).toEqual([[field]]);
      expect(record).toMatchObject({ basis: "documented", source: "providers.dev", date: "2026-11-02", documented_source: "providers.dev", documented_date: "2026-11-02" });
    }
    const sourceOf = vi.fn(IMPORTED);
    inputWindow({ context: 0 }, [], [evaluation({ context: 1000000 })], sourceOf);
    inputWindow({ context: 1000000 }, ["context"], [], sourceOf);
    expect(sourceOf).not.toHaveBeenCalled();
    // A source with no date publishes none.
    expect(finishWindow(inputWindow({ context: 1000000 }, [], [], () => ({ source: "models.dev", date: null })))).toMatchObject({ date: null, documented_date: null });
    // The record alone has no safe value: `safeValues` chooses it, `mirror` writes it.
    expect(inputWindow({ context: 1000000 }, [], [], IMPORTED)).toMatchObject({ tokens: null, basis: "none", documented_tokens: 1000000 });
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
