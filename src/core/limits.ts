// The input window of an entry (design/usable-input-window.md): how much input a request can carry on this provider
// and access method, worked out once when the data is built and published with what it rests on. A page prints it.
// Pure: no file, no network, no clock. No dependencies beyond the JSON helpers: this file also runs in the browser.
import { byCharacters } from "./cache.ts";
import { isObject } from "./merge.ts";
import type { MeasuredLimit } from "./schema.ts";

export type LimitSource = "providers.dev" | "models.dev";
export type DocumentedField = "limit.input" | "limit.context";
export type WindowKind = "window" | "bracket" | "accepted";
export type WindowBound = "limit" | "at_least";

/** One counted limit evaluation, read for the input window. */
export interface InputWindowMeasurement {
  client: string;
  client_label: string;
  route: string;
  route_label: string;
  date: string | null;
  /** The value this evaluation gives (section 3.3). */
  tokens: number;
  /** `limit` for kind `window`; `at_least` for `bracket` and `accepted`. */
  bound: WindowBound;
  kind: WindowKind;
  /** `input_accepted` of the evaluation. Null = none recorded. */
  accepted: number | null;
  /** `input_refused` of the evaluation. Null = none. */
  refused: number | null;
  /** `context` of the evaluation: the window the route names. Null = it named none. */
  named: number | null;
  /** `input_read` of the evaluation. Null = not checked. */
  read: number | null;
  source: string;
}

/** `providers_dev.limits.input_window` of an entry and `input_window` of a summary. */
export interface InputWindow {
  tokens: number | null;
  basis: "documented" | "measured" | "none";
  bound: WindowBound | null;
  scope: "input" | "window" | null;
  source: LimitSource | null;
  date: string | null;
  documented_tokens: number | null;
  documented_field: DocumentedField | null;
  documented_source: LimitSource | null;
  documented_date: string | null;
  documented_status: "contradicted" | "not_contradicted" | null;
  measured_tokens: number | null;
  measured_bound: WindowBound | null;
  measured_kind: WindowKind | null;
  measured_refused: number | null;
  measured_date: string | null;
  clients: number;
  evaluations: number;
  measurements: InputWindowMeasurement[];
}

/**
 * The margin of "clearly" in the test for a contradicted documented value (section 4.2): a refusal contradicts at
 * or below 99 % of it (c), an accepted input at or above 101 % of it (d). Percent, compared in whole numbers. Used
 * by `windowContradicts` and by nothing else. A window the route names is exact and has no margin.
 */
export const REFUSED_AT_MOST_PCT = 99;
export const ACCEPTED_AT_LEAST_PCT = 101;

/** A limit evaluation as read here: `input_read` may be absent on one made before the key existed. */
type LimitEvaluation = Omit<MeasuredLimit, "input_read"> & { input_read?: number | null };

const positive = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null);
const known = (value: number | null | undefined): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/**
 * The documented input of an entry (section 3.1), read from its own published `limit`: `limit.input` where it is a
 * number above 0, else `limit.context` where it is one and is not a measured value (`limits.from_measurement`), else
 * null. 0 means "none stated" and is skipped; nothing is read from another entry.
 */
export function documentedInput(limit: unknown, fromMeasurement: readonly string[]): { tokens: number; field: DocumentedField } | null {
  if (!isObject(limit)) return null;
  const input = positive(limit.input);
  if (input !== null) return { tokens: input, field: "limit.input" };
  const context = positive(limit.context);
  if (context !== null && !fromMeasurement.includes("context")) return { tokens: context, field: "limit.context" };
  return null;
}

/**
 * What one limit evaluation gives for the input window (section 3.3). Null = it does not count: a refusal with
 * nothing accepted, an accepted size with no refusal, no named window and no read check, or the output alone.
 */
export function windowMeasurement(evaluation: LimitEvaluation): InputWindowMeasurement | null {
  const named = known(evaluation.context);
  const accepted = known(evaluation.input_accepted);
  const refused = known(evaluation.input_refused);
  const read = known(evaluation.input_read);
  let value: { kind: WindowKind; tokens: number; bound: WindowBound } | null = null;
  if (named !== null && (refused === null || refused > named)) value = { kind: "window", tokens: named, bound: "limit" };
  else if (accepted !== null && refused !== null) value = { kind: "bracket", tokens: accepted, bound: "at_least" };
  else if (read !== null && refused === null) value = { kind: "accepted", tokens: read, bound: "at_least" };
  if (!value || !(value.tokens > 0)) return null;
  return {
    client: evaluation.client,
    client_label: evaluation.client_label,
    route: evaluation.route,
    route_label: evaluation.route_label,
    date: evaluation.date,
    tokens: value.tokens,
    bound: value.bound,
    kind: value.kind,
    accepted,
    refused,
    named,
    read,
    source: evaluation.source,
  };
}

/** The order of `measurements` (section 2.4): by tokens, `limit` before `at_least`, then client, route, date, source. */
export function byWindow(a: InputWindowMeasurement, b: InputWindowMeasurement): number {
  return (
    a.tokens - b.tokens ||
    (a.bound === b.bound ? 0 : a.bound === "limit" ? -1 : 1) ||
    byCharacters(a.client, b.client) ||
    byCharacters(a.route, b.route) ||
    byCharacters(a.date, b.date) ||
    byCharacters(a.source, b.source)
  );
}

/** Whether one counted evaluation clearly contradicts the documented value `documented` (section 4.2, tests a to d). */
export function windowContradicts(item: InputWindowMeasurement, documented: number, field: DocumentedField): boolean {
  // a. The route names a window below the documented value.
  if (item.named !== null && item.named < documented) return true;
  // b. The route names another window than the documented one.
  if (item.kind === "window" && field === "limit.context" && item.named !== documented) return true;
  // c. An input clearly below the documented value was refused.
  if (item.kind === "bracket" && item.refused !== null && 100 * item.refused <= REFUSED_AT_MOST_PCT * documented) return true;
  // d. An input clearly above the documented value was accepted (below a refusal, or read to the end).
  if ((item.kind === "bracket" || item.kind === "accepted") && 100 * item.tokens >= ACCEPTED_AT_LEAST_PCT * documented) return true;
  return false;
}

/** The record of an entry nothing is known about. */
export function emptyInputWindow(): InputWindow {
  return {
    tokens: null,
    basis: "none",
    bound: null,
    scope: null,
    source: null,
    date: null,
    documented_tokens: null,
    documented_field: null,
    documented_source: null,
    documented_date: null,
    documented_status: null,
    measured_tokens: null,
    measured_bound: null,
    measured_kind: null,
    measured_refused: null,
    measured_date: null,
    clients: 0,
    evaluations: 0,
    measurements: [],
  };
}

/**
 * The input window of an entry (section 4): the documented value unless a counted evaluation clearly contradicts it,
 * else the measured value (the lowest over the counted evaluations), else null. `sourceOf` says who documents the
 * field read and on which date (section 3.2); it is asked only where a value is documented, with the field read.
 */
export function inputWindow(
  limit: unknown,
  fromMeasurement: readonly string[],
  measured: readonly LimitEvaluation[],
  sourceOf: (field: DocumentedField) => { source: LimitSource; date: string | null },
): InputWindow {
  const record = emptyInputWindow();
  const documented = documentedInput(limit, fromMeasurement);
  const measurements = measured.flatMap((evaluation) => windowMeasurement(evaluation) ?? []).sort(byWindow);
  const lowest = measurements[0];

  record.measurements = measurements;
  record.evaluations = measurements.length;
  record.clients = new Set(measurements.map((item) => item.client)).size;
  if (lowest) {
    record.measured_tokens = lowest.tokens;
    record.measured_bound = lowest.bound;
    record.measured_kind = lowest.kind;
    record.measured_refused = lowest.kind === "bracket" ? lowest.refused : null;
    record.measured_date = lowest.date;
  }

  let contradicted = false;
  if (documented) {
    const { source, date } = sourceOf(documented.field);
    record.documented_tokens = documented.tokens;
    record.documented_field = documented.field;
    record.documented_source = source;
    record.documented_date = date;
    // The test, applied once: basis and documented_status are both set from this one result.
    contradicted = measurements.some((item) => windowContradicts(item, documented.tokens, documented.field));
    if (lowest) record.documented_status = contradicted ? "contradicted" : "not_contradicted";
  }

  if (documented && !contradicted) {
    Object.assign(record, { tokens: documented.tokens, basis: "documented", bound: "limit", scope: documented.field === "limit.input" ? "input" : "window", source: record.documented_source, date: record.documented_date });
  } else if (lowest) {
    Object.assign(record, { tokens: lowest.tokens, basis: "measured", bound: lowest.bound, scope: lowest.kind === "window" ? "window" : "input", source: "providers.dev", date: lowest.date });
  }
  return record;
}
