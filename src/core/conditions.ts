// A condition of the API, said in words. The API publishes a condition as a tree (policy-contract.ts); a page shows
// it as a phrase a person can read: "Mon–Fri, 01:00–04:00 and 06:00–10:00 UTC, except holidays (CN)".
// Formatting only: nothing here decides whether a condition holds. Runs in the Worker and in the browser.
import { duration, exact } from "./format.ts";
import type { Json } from "./merge.ts";
import type { Condition } from "./policy-contract.ts";

type Predicate = Extract<Condition, { kind: "predicate" }>;
/** A window of the day in UTC: from the first time up to, not including, the second. "24:00" is the end of the day. */
type Range = [start: string, end: string];

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const DAY_NAME: Record<string, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
const CACHE_MODE: Record<string, string> = { explicit: "manual caching", implicit: "automatic caching" };

const text = (value: Json): string => (typeof value === "string" ? value : typeof value === "number" ? exact(value) : JSON.stringify(value));
/** "a", "a or b", "a, b or c". */
const oneOf = (values: Json): string => {
  const items = (Array.isArray(values) ? values : [values]).map(text);
  return items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`;
};
const is = (condition: Condition, field: string): condition is Predicate => condition.kind === "predicate" && condition.field === field;

/** The windows of the day a condition names, where it is made of hours alone. Null = it is something else. */
function hourRanges(condition: Condition): Range[] | null {
  if (is(condition, "request.utc_hours")) {
    if (typeof condition.value !== "string") return null;
    return condition.op === "gte" ? [[condition.value, "24:00"]] : condition.op === "lt" ? [["00:00", condition.value]] : null;
  }
  if (condition.kind === "all") {
    // "From A" and "before B" together: one window, where A is before B.
    const from = condition.conditions.find((item): item is Predicate => is(item, "request.utc_hours") && item.op === "gte");
    const until = condition.conditions.find((item): item is Predicate => is(item, "request.utc_hours") && item.op === "lt");
    if (condition.conditions.length !== 2 || !from || !until || typeof from.value !== "string" || typeof until.value !== "string" || from.value >= until.value) return null;
    return [[from.value, until.value]];
  }
  if (condition.kind === "any") {
    const ranges: Range[] = [];
    for (const item of condition.conditions) {
      const own = hourRanges(item);
      if (!own) return null;
      ranges.push(...own);
    }
    // A window that runs over midnight is written by the source as "from 15:00 or before 01:00": one window again.
    const late = ranges.findIndex((range) => range[1] === "24:00");
    const early = ranges.findIndex((range) => range[0] === "00:00");
    if (late !== -1 && early !== -1 && late !== early) {
      const joined: Range = [ranges[late]![0], ranges[early]![1]];
      return [...ranges.filter((_, at) => at !== late && at !== early), joined];
    }
    return ranges;
  }
  return null;
}

function rangesText(ranges: Range[]): string {
  if (ranges.length === 1) {
    const [start, end] = ranges[0]!;
    if (end === "24:00") return `from ${start}`;
    if (start === "00:00") return `before ${end}`;
  }
  return ranges.map(([start, end]) => `${start}–${end}`).join(" and ");
}

const DAY = 24 * 60;
const WEEK = 7 * DAY;
/** "23:00" as minutes of the day; "24:00" is the end of the day. Null = not a time of day. */
const minutes = (time: string): number | null => {
  const match = /^(\d{2}):([0-5]\d)$/.exec(time);
  const value = match ? Number(match[1]) * 60 + Number(match[2]) : null;
  return value !== null && value <= DAY ? value : null;
};
const clock = (value: number): string => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
/** The days a predicate names, as indexes of DAYS. Null = it names something else. */
function dayIndexes(condition: Condition): number[] | null {
  if (!is(condition, "request.utc_days") || (condition.op !== "eq" && condition.op !== "in")) return null;
  const at = (Array.isArray(condition.value) ? condition.value : [condition.value]).map((day) => DAYS.indexOf(String(day) as (typeof DAYS)[number]));
  return at.length && !at.includes(-1) ? at : null;
}

/**
 * The stretches of the week, in minutes from Monday 00:00 UTC, that a condition made of days and hours alone covers:
 * each from its first minute up to, not including, its last. Null = the condition is something else.
 */
function weekSpans(condition: Condition): Array<[number, number]> | null {
  const spans = (days: number[], ranges: Range[]): Array<[number, number]> | null => {
    const out: Array<[number, number]> = [];
    for (const [start, end] of ranges) {
      const from = minutes(start);
      const until = minutes(end);
      if (from === null || until === null) return null;
      // A window over midnight, "15:00–01:00" on a day, is the evening and the early morning of that same day.
      const parts: Array<[number, number]> = from < until ? [[from, until]] : [[from, DAY], [0, until]];
      for (const day of days) for (const [a, b] of parts) if (a < b) out.push([day * DAY + a, day * DAY + b]);
    }
    return out;
  };
  const days = dayIndexes(condition);
  if (days) return spans(days, [["00:00", "24:00"]]);
  const ranges = hourRanges(condition);
  if (ranges) return spans([0, 1, 2, 3, 4, 5, 6], ranges);
  if (condition.kind === "all" && condition.conditions.length === 2) {
    const [a, b] = condition.conditions as [Condition, Condition];
    const first = dayIndexes(a);
    const [days, ranges] = first ? [first, hourRanges(b)] : [dayIndexes(b), hourRanges(a)];
    return days && ranges ? spans(days, ranges) : null;
  }
  if (condition.kind === "any") {
    const out: Array<[number, number]> = [];
    for (const item of condition.conditions) {
      const own = weekSpans(item);
      if (!own) return null;
      out.push(...own);
    }
    return out;
  }
  return null;
}

/**
 * Day and hour windows that run into each other, said as the one period they make: "Thu 23:00–Sun 23:00 UTC",
 * "Fri–Sun (UTC)". From the first time up to, not including, the second, as with hours. Null = not one period.
 */
function periodText(condition: Condition): string | null {
  const spans = weekSpans(condition)?.sort((a, b) => a[0] - b[0]);
  if (!spans?.length) return null;
  const merged: Array<[number, number]> = [];
  for (const [start, end] of spans) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  // Sunday evening runs into Monday morning.
  if (merged.length === 2 && merged[0]![0] === 0 && merged[1]![1] === WEEK) merged.splice(0, 2, [merged[1]![0], merged[0]![1] + WEEK]);
  if (merged.length !== 1) return null;
  const [start, end] = merged[0]!;
  if (end - start >= WEEK) return null;
  const name = (at: number): string => DAY_NAME[DAYS[Math.floor(at / DAY) % 7]!]!;
  // The end is said on the day it closes: "Sun 24:00", not "Mon 00:00".
  const last = end - 1;
  if (start % DAY === 0 && end % DAY === 0) return `${end - start === DAY ? name(start) : `${name(start)}–${name(last)}`} (UTC)`;
  if (end - start < DAY && name(start) === name(last)) return `${name(start)}, ${clock(start % DAY)}–${clock(last % DAY + 1)} UTC`;
  return `${name(start)} ${clock(start % DAY)}–${name(last)} ${clock(last % DAY + 1)} UTC`;
}

/**
 * A condition of time alone, said so that "outside" can stand before it: hours, days, days and hours, or one period.
 * Null = something else, or a window with holidays in it, where "outside … except holidays" would read both ways.
 */
function timeText(condition: Condition): string | null {
  const ranges = hourRanges(condition);
  if (ranges) return `${rangesText(ranges)} UTC`;
  if (dayIndexes(condition)) return predicate(condition as Predicate);
  if (condition.kind === "all") {
    const days = condition.conditions.filter((part) => dayIndexes(part));
    const hours = condition.conditions.filter((part) => hourRanges(part));
    if (days.length > 1 || hours.length > 1 || days.length + hours.length !== condition.conditions.length) return null;
    return windowText(condition.conditions).window;
  }
  return condition.kind === "any" ? periodText(condition) : null;
}

/** "Mon–Fri", "Sat–Sun", "Mon, Wed, Fri": days of the week in their order, runs of two or more joined. */
function daysText(values: Json): string {
  const wanted = (Array.isArray(values) ? values : [values]).map(String);
  const at = DAYS.map((day, index) => (wanted.includes(day) ? index : -1)).filter((index) => index !== -1);
  if (at.length !== wanted.length) return wanted.join(", ");
  const groups: number[][] = [];
  for (const index of at) {
    const last = groups.at(-1);
    if (last && last.at(-1) === index - 1) last.push(index);
    else groups.push([index]);
  }
  const name = (index: number): string => DAY_NAME[DAYS[index]!]!;
  return groups.map((group) => (group.length >= 2 ? `${name(group[0]!)}–${name(group.at(-1)!)}` : name(group[0]!))).join(", ");
}

const SIZE: Record<string, string> = { "request.context_tokens": "context", "request.input_tokens": "input" };
/** What a request for an image, a video, speech or a transcription asks for: the name of the setting, and for a switch what on and off are called. */
const SETTING: Record<string, string> = {
  "request.resolution": "resolution", "request.quality": "quality", "request.style": "style", "request.mode": "mode", "request.domain": "domain", "request.aspect_ratio": "aspect ratio",
  "request.search_context_size": "search context size", "request.duration": "duration", "request.megapixels": "megapixels", "request.input_images": "input images", "request.fps": "frames per second",
  "request.steps": "steps", "request.keyterms_prompt": "key terms",
};
/** A setting that counts things a request sends: above 0 is said as the things being there. */
const PRESENT: Record<string, string> = { "request.input_images": "with image input" };
const SWITCH: Record<string, [on: string, off: string]> = {
  "request.generate_audio": ["with generated audio", "without generated audio"], "request.input_video": ["with video input", "without video input"],
  "request.speaker_labels": ["with speaker labels", "without speaker labels"], "request.voice_control": ["with voice control", "without voice control"],
  "request.websocket": ["over a WebSocket", "not over a WebSocket"],
};

function predicate(condition: Predicate): string {
  const { field, op, value } = condition;
  const size = SIZE[field];
  if (size && typeof value === "number") {
    const tokens = `${exact(value)} tokens`;
    return op === "gt" ? `${size} above ${tokens}` : op === "gte" ? `${size} of ${tokens} or more` : op === "lt" ? `${size} below ${tokens}` : op === "lte" ? `${size} of ${tokens} or less` : `${size} of ${oneOf(value)} tokens`;
  }
  if (field === "request.service_tier" && (op === "eq" || op === "in")) return `service tier ${oneOf(value)}`;
  if (field === "request.region" && (op === "eq" || op === "in")) return `region ${oneOf(value)}`;
  if (field === "request.endpoint" && (op === "eq" || op === "in")) return `endpoint ${oneOf(value)}`;
  if (field === "request.date") return op === "gte" ? `from ${text(value)}` : op === "gt" ? `after ${text(value)}` : op === "lt" ? `before ${text(value)}` : op === "lte" ? `until ${text(value)}` : `on ${oneOf(value)}`;
  if (field === "request.utc_hours") {
    const ranges = hourRanges(condition);
    if (ranges) return `${rangesText(ranges)} UTC`;
  }
  if (field === "request.utc_days" && (op === "eq" || op === "in")) return `${daysText(value)} (UTC)`;
  if (field === "request.holiday" && op === "eq") return `holidays (${text(value)})`;
  if (field === "request.thinking" && op === "eq" && typeof value === "boolean") return value ? "thinking on" : "thinking off";
  const switched = SWITCH[field];
  if (switched && op === "eq" && typeof value === "boolean") return value ? switched[0] : switched[1];
  const present = PRESENT[field];
  if (present && op === "gt" && value === 0) return present;
  const setting = SETTING[field];
  if (setting) {
    if (op === "min_items") return `${text(value)} or more ${setting}`;
    if (op === "eq" || op === "in") return `${setting} ${oneOf(value)}`;
    return op === "gt" ? `${setting} above ${text(value)}` : op === "gte" ? `${setting} of ${text(value)} or more` : op === "lt" ? `${setting} below ${text(value)}` : `${setting} of ${text(value)} or less`;
  }
  if (field === "cache.retention_s" && op === "eq" && typeof value === "number") return `cache lifetime ${duration(value)}`;
  if (field === "cache.retention_value" && op === "eq") return `cache lifetime ${text(value)}`;
  if (field === "cache.mode" && op === "eq" && typeof value === "string" && CACHE_MODE[value]) return CACHE_MODE[value];
  const word = { eq: "is", in: "is one of", gt: "above", gte: "at least", lt: "below", lte: "at most", min_items: "has items, at least" }[op];
  return `${field} ${word} ${op === "in" ? oneOf(value) : text(value)}`;
}

/** Days, hours and holidays among the parts of an "all" read as one window: "Mon–Fri, 01:00–04:00 UTC, except holidays (CN)". */
function windowText(parts: Condition[]): { window: string; rest: Condition[] } {
  const rest: Condition[] = [];
  let days = "";
  let hours = "";
  let holidays = "";
  for (const part of parts) {
    const ranges = hourRanges(part);
    const outside = part.kind === "not" ? hourRanges(part.condition) : null;
    if (is(part, "request.utc_days") && (part.op === "eq" || part.op === "in") && !days) days = daysText(part.value);
    else if (ranges && !hours) hours = rangesText(ranges);
    else if (outside && !hours) hours = `outside ${rangesText(outside)}`;
    else if (is(part, "request.holiday") && part.op === "eq" && !holidays) holidays = `on holidays (${text(part.value)})`;
    else if (part.kind === "not" && is(part.condition, "request.holiday") && part.condition.op === "eq" && !holidays) holidays = `except holidays (${text(part.condition.value)})`;
    else rest.push(part);
  }
  const when = [days, hours].filter(Boolean).join(", ");
  const window = when ? `${when} UTC${holidays ? `, ${holidays}` : ""}` : holidays;
  return { window, rest };
}

function phrase(condition: Condition): string {
  if (condition.kind === "unknown") return `a condition this page cannot read: ${JSON.stringify(condition.raw)}`;
  if (condition.kind === "predicate") return predicate(condition);
  const ranges = hourRanges(condition);
  if (ranges) return `${rangesText(ranges)} UTC`;
  if (condition.kind === "any") {
    const period = periodText(condition);
    if (period) return period;
  }
  if (condition.kind === "not") {
    const inner = condition.condition;
    const outside = timeText(inner);
    if (outside) return `outside ${outside}`;
    if (is(inner, "request.holiday") && inner.op === "eq") return `except holidays (${text(inner.value)})`;
    if (is(inner, "request.region") && (inner.op === "eq" || inner.op === "in")) return `any region but ${oneOf(inner.value)}`;
    if (is(inner, "request.service_tier") && (inner.op === "eq" || inner.op === "in")) return `any service tier but ${oneOf(inner.value)}`;
    return `not (${phrase(inner)})`;
  }
  if (condition.kind === "any") return condition.conditions.map((item) => (item.kind === "all" || item.kind === "any" ? `(${phrase(item)})` : phrase(item))).join(" or ");
  const { window, rest } = windowText(condition.conditions);
  return [window, ...rest.map((item) => (item.kind === "any" ? `(${phrase(item)})` : phrase(item)))].filter(Boolean).join(" and ");
}

/** A condition as a phrase that starts with a capital: "Context above 272,000 tokens and cache lifetime 30 min". */
export function conditionText(condition: Condition): string {
  const said = phrase(condition);
  return said.charAt(0).toUpperCase() + said.slice(1);
}
