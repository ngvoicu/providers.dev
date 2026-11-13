import { describe, expect, it } from "vitest";
import { DELETE, mergePatch, type Change, type Json } from "../src/core/merge.ts";

const upstream: Json = {
  name: "Model",
  limit: { context: 200000, output: 64000 },
  capabilities: { cache: { explicit: { ttl: ["5m", "1h"], max_breakpoints: 4 } }, temperature: true, tools: { supported: true } },
  modalities: { input: ["text", "image/png"], output: ["text"] },
};

function merge(patch: Json): { value: Json | undefined; changes: Change[] } {
  const changes: Change[] = [];
  return { value: mergePatch(upstream, patch, changes), changes };
}

describe("mergePatch", () => {
  it("merges objects field by field and leaves the rest alone", () => {
    const { value, changes } = merge({ limit: { context: 1000000 } });
    expect(value).toMatchObject({ name: "Model", limit: { context: 1000000, output: 64000 } });
    expect(changes).toEqual([{ path: "limit.context", op: "set", had_upstream: true, upstream: 200000, value: 1000000 }]);
  });

  it("replaces arrays as a whole", () => {
    const { value, changes } = merge({ capabilities: { cache: { explicit: { ttl: ["30m"] } } } });
    expect(value).toMatchObject({ capabilities: { cache: { explicit: { ttl: ["30m"], max_breakpoints: 4 } } } });
    expect(changes[0]).toMatchObject({ path: "capabilities.cache.explicit.ttl", upstream: ["5m", "1h"], value: ["30m"] });
  });

  it("keeps false and zero as real values", () => {
    const { value, changes } = merge({ capabilities: { temperature: false }, limit: { output: 0 } });
    expect(value).toMatchObject({ capabilities: { temperature: false }, limit: { output: 0, context: 200000 } });
    expect(changes.map((change) => [change.path, change.value])).toEqual([
      ["capabilities.temperature", false],
      ["limit.output", 0],
    ]);
  });

  it("tells an absent override, an unknown and a deletion apart", () => {
    const absent = merge({});
    expect(absent.value).toEqual(upstream);
    expect(absent.changes).toEqual([]);

    const unknown = merge({ limit: { context: null } });
    expect((unknown.value as { limit: object }).limit).toEqual({ output: 64000 });
    expect(unknown.changes).toEqual([{ path: "limit.context", op: "unknown", had_upstream: true, upstream: 200000 }]);

    const deleted = merge({ limit: { context: DELETE } });
    expect((deleted.value as { limit: object }).limit).toEqual({ output: 64000 });
    expect(deleted.changes).toEqual([{ path: "limit.context", op: "delete", had_upstream: true, upstream: 200000 }]);
  });

  it("records an unknown even where upstream had nothing", () => {
    const { value, changes } = merge({ limit: { input: null } });
    expect((value as { limit: object }).limit).toEqual({ context: 200000, output: 64000 });
    expect(changes).toEqual([{ path: "limit.input", op: "unknown", had_upstream: false }]);
  });

  it("adds fields upstream does not have", () => {
    const { value, changes } = merge({ limit: { input: 922000 } });
    expect(value).toMatchObject({ limit: { context: 200000, input: 922000, output: 64000 } });
    expect(changes).toEqual([{ path: "limit.input", op: "set", had_upstream: false, value: 922000 }]);
  });

  it("replaces a non-object with an object in one step", () => {
    const changes: Change[] = [];
    const value = mergePatch({ capabilities: { cache: false } }, { capabilities: { cache: { implicit: true } } }, changes);
    expect(value).toEqual({ capabilities: { cache: { implicit: true } } });
    expect(changes).toEqual([{ path: "capabilities.cache", op: "set", had_upstream: true, upstream: false, value: { implicit: true } }]);
  });

  it("marks a patch that repeats upstream as redundant", () => {
    const { changes } = merge({ limit: { context: 200000 } });
    expect(changes).toEqual([{ path: "limit.context", op: "set", had_upstream: true, upstream: 200000, value: 200000, redundant: true }]);
  });

  it("does not modify its arguments and is deterministic", () => {
    const before = JSON.stringify(upstream);
    const patch: Json = { limit: { context: 1 }, modalities: { input: ["text"] } };
    const first = merge(patch).value;
    const second = merge(patch).value;
    expect(JSON.stringify(upstream)).toBe(before);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
