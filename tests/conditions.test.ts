import { describe, expect, it } from "vitest";
import { conditionText } from "../src/core/conditions.ts";
import { conditionOf } from "../src/core/policies.ts";

/** A condition as models.dev writes it, said the way the pages say it. */
const said = (when: unknown): string => conditionText(conditionOf(when as never)!);

describe("a condition in words", () => {
  it("says sizes, tiers, regions, dates and cache settings plainly", () => {
    expect(said({ context: { gt: 272000 } })).toBe("Context above 272,000 tokens");
    expect(said({ context: { gte: 200000 } })).toBe("Context of 200,000 tokens or more");
    expect(said({ service_tier: { equals: "priority" } })).toBe("Service tier priority");
    expect(said({ region: { equals: "us" } })).toBe("Region us");
    expect(said({ region: { in: ["us", "eu"] } })).toBe("Region us or eu");
    expect(said({ not: { region: { equals: "global" } } })).toBe("Any region but global");
    expect(said({ date: { gte: "2026-12-01" } })).toBe("From 2026-12-01");
    expect(said({ thinking: { equals: true } })).toBe("Thinking on");
    expect(conditionText({ kind: "predicate", field: "cache.retention_s", op: "eq", value: 1800 })).toBe("Cache lifetime 30 min");
    expect(conditionText({ kind: "predicate", field: "cache.mode", op: "eq", value: "explicit" })).toBe("Manual caching");
    expect(said({ context: { gt: 272000 }, service_tier: { equals: "flex" } })).toBe("Context above 272,000 tokens and service tier flex");
  });

  it("reads days, hours and holidays as one window", () => {
    const working = { utc_days: { in: ["mon", "tue", "wed", "thu", "fri"] } };
    const two = { any: [{ all: [{ utc_hours: { gte: "01:00" } }, { utc_hours: { lt: "04:00" } }] }, { all: [{ utc_hours: { gte: "06:00" } }, { utc_hours: { lt: "10:00" } }] }] };
    expect(said({ ...working, ...two, not: { holiday: { equals: "CN" } } })).toBe("Mon–Fri, 01:00–04:00 and 06:00–10:00 UTC, except holidays (CN)");
    expect(said({ ...working, ...two })).toBe("Mon–Fri, 01:00–04:00 and 06:00–10:00 UTC");
    expect(said(two)).toBe("01:00–04:00 and 06:00–10:00 UTC");
    expect(said({ ...working, all: [{ utc_hours: { gte: "12:00" } }, { utc_hours: { lt: "18:00" } }] })).toBe("Mon–Fri, 12:00–18:00 UTC");
    // One bound is the rest of the day; "from 15:00 or before 01:00" is one window over midnight.
    expect(said({ utc_hours: { gte: "14:00" } })).toBe("From 14:00 UTC");
    expect(said({ utc_hours: { lt: "16:00" } })).toBe("Before 16:00 UTC");
    expect(said({ any: [{ utc_hours: { gte: "15:00" } }, { utc_hours: { lt: "01:00" } }] })).toBe("15:00–01:00 UTC");
    expect(said({ not: { all: [{ utc_hours: { gte: "01:00" } }, { utc_hours: { lt: "10:00" } }] } })).toBe("Outside 01:00–10:00 UTC");
    expect(said({ utc_days: { in: ["sat", "sun"] } })).toBe("Sat–Sun (UTC)");
    expect(said({ utc_days: { in: ["mon", "wed", "fri"] } })).toBe("Mon, Wed, Fri (UTC)");
  });

  it("says a negated time condition as outside it", () => {
    const working = { utc_days: { in: ["mon", "tue", "wed", "thu", "fri"] } };
    const two = { any: [{ all: [{ utc_hours: { gte: "01:00" } }, { utc_hours: { lt: "04:00" } }] }, { all: [{ utc_hours: { gte: "06:00" } }, { utc_hours: { lt: "10:00" } }] }] };
    expect(said({ not: { ...working, ...two } })).toBe("Outside Mon–Fri, 01:00–04:00 and 06:00–10:00 UTC");
    expect(said({ not: { ...working, utc_hours: { gte: "23:00" } } })).toBe("Outside Mon–Fri, from 23:00 UTC");
    expect(said({ not: { utc_days: { in: ["sat", "sun"] } } })).toBe("Outside Sat–Sun (UTC)");
    expect(said({ not: { any: [{ utc_days: { in: ["sat"] } }, { utc_days: { in: ["sun"] } }] } })).toBe("Outside Sat–Sun (UTC)");
    expect(said({ context: { gt: 1000 }, not: { ...working, ...two } })).toBe("Context above 1,000 tokens and outside Mon–Fri, 01:00–04:00 and 06:00–10:00 UTC");
  });

  it("keeps the general phrase for a negation that outside would not say exactly", () => {
    const working = { utc_days: { in: ["mon", "tue", "wed", "thu", "fri"] } };
    const hours = { all: [{ utc_hours: { gte: "01:00" } }, { utc_hours: { lt: "04:00" } }] };
    // "Outside …, except holidays" would read as outside the window and not on a holiday.
    expect(said({ not: { ...working, ...hours, not: { holiday: { equals: "CN" } } } })).toBe("Not (Mon–Fri, 01:00–04:00 UTC, except holidays (CN))");
    expect(said({ not: { ...working, context: { gt: 1000 } } })).toBe("Not (Mon–Fri UTC and context above 1,000 tokens)");
    // Two separate windows are not one period.
    expect(said({ not: { any: [{ utc_days: { in: ["mon"] } }, { utc_days: { in: ["wed"] } }] } })).toBe("Not (Mon (UTC) or Wed (UTC))");
  });

  it("says day and hour windows that run into each other as one period", () => {
    const weekend = { any: [{ utc_days: { in: ["fri", "sat"] } }, { utc_days: { in: ["thu"] }, utc_hours: { gte: "23:00" } }, { utc_days: { in: ["sun"] }, utc_hours: { lt: "23:00" } }] };
    expect(said(weekend)).toBe("Thu 23:00–Sun 23:00 UTC");
    expect(said({ not: weekend })).toBe("Outside Thu 23:00–Sun 23:00 UTC");
    // From the first time up to, not including, the second; a day's end is said as 24:00 on that day.
    expect(said({ any: [{ utc_days: { in: ["fri"] }, utc_hours: { gte: "10:00" } }, { utc_days: { in: ["sat"] } }] })).toBe("Fri 10:00–Sat 24:00 UTC");
    expect(said({ any: [{ utc_days: { in: ["fri"] } }, { utc_days: { in: ["sat"] }, utc_hours: { lt: "02:30" } }] })).toBe("Fri 00:00–Sat 02:30 UTC");
    // Sunday night into Monday morning.
    expect(said({ any: [{ utc_days: { in: ["sun"] }, utc_hours: { gte: "22:00" } }, { utc_days: { in: ["mon"] }, utc_hours: { lt: "02:00" } }] })).toBe("Sun 22:00–Mon 02:00 UTC");
    // Whole days, and windows within one day.
    expect(said({ any: [{ utc_days: { in: ["fri"] } }, { utc_days: { in: ["sat", "sun"] } }] })).toBe("Fri–Sun (UTC)");
    expect(said({ any: [{ utc_days: { in: ["sun"] } }, { utc_days: { in: ["mon"] } }] })).toBe("Sun–Mon (UTC)");
    expect(said({ any: [{ all: [{ utc_days: { in: ["thu"] } }, { all: [{ utc_hours: { gte: "10:00" } }, { utc_hours: { lt: "12:00" } }] }] }, { all: [{ utc_days: { in: ["thu"] } }, { all: [{ utc_hours: { gte: "12:00" } }, { utc_hours: { lt: "14:00" } }] }] }] })).toBe("Thu, 10:00–14:00 UTC");
  });

  it("keeps the general phrase for windows that are not one period", () => {
    // A minute apart: 23:59 on Thursday is in neither.
    expect(said({ any: [{ utc_days: { in: ["thu"] }, utc_hours: { lt: "23:59" } }, { utc_days: { in: ["fri"] } }] })).toBe("(Thu, before 23:59 UTC) or Fri (UTC)");
    expect(said({ any: [{ utc_days: { in: ["mon"] } }, { utc_days: { in: ["wed"] } }] })).toBe("Mon (UTC) or Wed (UTC)");
    // The whole week is not a period to name.
    expect(said({ any: [{ utc_days: { in: ["mon", "tue", "wed"] } }, { utc_days: { in: ["thu", "fri", "sat", "sun"] } }] })).toBe("Mon–Wed (UTC) or Thu–Sun (UTC)");
    // A holiday or another condition among the windows.
    expect(said({ any: [{ utc_days: { in: ["sat", "sun"] } }, { holiday: { equals: "CN" } }] })).toBe("Sat–Sun (UTC) or holidays (CN)");
    expect(said({ any: [{ utc_days: { in: ["sat"] } }, { utc_days: { in: ["sun"] }, context: { gt: 1000 } }] })).toBe("Sat (UTC) or (Sun UTC and context above 1,000 tokens)");
  });

  it("says what a request for an image, a video or a transcription asks for", () => {
    expect(said({ resolution: { equals: "720P" }, generate_audio: { equals: false } })).toBe("Resolution 720P and without generated audio");
    expect(said({ input_video: { equals: true } })).toBe("With video input");
    expect(said({ quality: { in: ["low", "medium"] } })).toBe("Quality low or medium");
    expect(said({ search_context_size: { equals: "high" } })).toBe("Search context size high");
    expect(said({ input_images: { gte: 1 } })).toBe("Input images of 1 or more");
    // A count above zero: the request sends images. Any other threshold, and a measure such as steps, keeps its number.
    expect(said({ input_images: { gt: 0 } })).toBe("With image input");
    expect(said({ input_images: { gt: 1 } })).toBe("Input images above 1");
    expect(said({ steps: { gt: 0 } })).toBe("Steps above 0");
    expect(said({ duration: { equals: 6 } })).toBe("Duration 6");
    expect(said({ keyterms_prompt: { min_items: 1 } })).toBe("1 or more key terms");
    expect(said({ websocket: { equals: true } })).toBe("Over a WebSocket");
  });

  it("still says something for a shape it has no words for, and never hides it", () => {
    expect(said({ future: { foo: 1 } })).toBe('A condition this page cannot read: {"future":{"foo":1}}');
    expect(conditionText({ kind: "predicate", field: "request.batch", op: "eq", value: "nightly" })).toBe("Request.batch is nightly");
    expect(conditionText({ kind: "not", condition: { kind: "predicate", field: "request.thinking", op: "eq", value: true } })).toBe("Not (thinking on)");
    expect(said({ any: [{ context: { gt: 1000 } }, { service_tier: { equals: "flex" } }] })).toBe("Context above 1,000 tokens or service tier flex");
  });
});
