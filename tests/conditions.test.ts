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

  it("says what a request for an image, a video or a transcription asks for", () => {
    expect(said({ resolution: { equals: "720P" }, generate_audio: { equals: false } })).toBe("Resolution 720P and without generated audio");
    expect(said({ input_video: { equals: true } })).toBe("With video input");
    expect(said({ quality: { in: ["low", "medium"] } })).toBe("Quality low or medium");
    expect(said({ search_context_size: { equals: "high" } })).toBe("Search context size high");
    expect(said({ input_images: { gte: 1 } })).toBe("Input images of 1 or more");
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
