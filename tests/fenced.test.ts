// The guard of the fence around pi's part (design/pi-source.md, section k).
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fenced, fencedAsync, reasonOf } from "../scripts/lib/fenced.ts";

/** An object whose `message` is a number and whose `toString` throws. */
const hostile = (): unknown => ({
  message: 503,
  toString() {
    throw new Error("toString");
  },
});

describe("the guard", () => {
  const Shape = z.strictObject({ a: z.number(), b: z.string() });

  it("returns the plain copy, in the result's own key order, not zod's output", () => {
    const Loose = z.object({ a: z.number(), b: z.string() });
    const result = fenced(() => ({ b: "x", a: 1 }), Loose);
    expect(result).toEqual({ ok: true, value: { b: "x", a: 1 } });
    expect(result.ok && Object.keys(result.value)).toEqual(["b", "a"]);
  });

  it("makes the result plain: a getter becomes its value, a prototype and a function do not survive", () => {
    class Box {
      b = "x";
      get a(): number {
        return 1;
      }
    }
    const withGetter = { b: "x", get a() { return 1; } };
    expect(fenced(() => withGetter, Shape)).toEqual({ ok: true, value: { a: 1, b: "x" } });
    expect(fenced(() => new Box() as unknown as z.infer<typeof Shape>, Shape)).toMatchObject({ ok: false });
    const withFunction = fenced(() => ({ a: 1, b: "x", c: () => 1 }) as z.infer<typeof Shape>, Shape);
    expect(withFunction).toEqual({ ok: true, value: { a: 1, b: "x" } });
    expect(Object.getPrototypeOf(withFunction.ok && withFunction.value)).toBe(Object.prototype);
  });

  it("turns away undefined, a cycle, a getter that throws, and a misfit", () => {
    expect(fenced(() => undefined as unknown as z.infer<typeof Shape>, Shape)).toMatchObject({ ok: false });
    const cycle: Record<string, unknown> = { a: 1, b: "x" };
    cycle.self = cycle;
    expect(fenced(() => cycle as z.infer<typeof Shape>, Shape)).toMatchObject({ ok: false });
    const throwing = { b: "x", get a(): number { throw new Error("no a"); } };
    expect(fenced(() => throwing, Shape)).toEqual({ ok: false, why: "no a" });
    expect(fenced(() => ({ a: "1", b: "x" }) as unknown as z.infer<typeof Shape>, Shape)).toEqual({ ok: false, why: "a: Invalid input: expected number, received string" });
  });

  it("turns away anything thrown, of any shape", () => {
    for (const thrown of [new Error("broken"), hostile(), null, undefined, 7, "text", Symbol("s")]) {
      const result = fenced(() => {
        throw thrown;
      }, Shape);
      expect(result.ok).toBe(false);
      expect(typeof (!result.ok && result.why)).toBe("string");
    }
  });

  it("the async twin never rejects: a rejection, a throw before the promise, a misfit", async () => {
    expect(await fencedAsync(async () => ({ a: 1, b: "x" }), Shape)).toEqual({ ok: true, value: { a: 1, b: "x" } });
    expect(await fencedAsync(() => Promise.reject(hostile()), Shape)).toEqual({ ok: false, why: "a fault without a description" });
    expect(
      await fencedAsync(() => {
        throw new Error("at once");
      }, Shape),
    ).toEqual({ ok: false, why: "at once" });
    expect(await fencedAsync(async () => ({ a: 1 }) as z.infer<typeof Shape>, Shape)).toMatchObject({ ok: false, why: expect.stringMatching(/^b: /) });
  });
});

describe("the reason", () => {
  it("is the message of an Error, the first issue of a misfit, else a fault without a description", () => {
    expect(reasonOf(new Error("pi.dev answered HTTP 503"))).toBe("pi.dev answered HTTP 503");
    expect(reasonOf(new z.ZodError([{ code: "custom", path: ["blocks", 0, "ref"], message: "bad", input: 1 }]))).toBe("blocks.0.ref: bad");
    const numeric = new Error("x");
    Object.defineProperty(numeric, "message", { value: 503 });
    expect(reasonOf(numeric)).toBe("a fault without a description");
    for (const thrown of [hostile(), null, undefined, 7, "text", Symbol("s"), { message: "not an Error" }]) expect(reasonOf(thrown)).toBe("a fault without a description");
  });

  it("cannot throw itself, whatever it is given", () => {
    const trap = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("trap");
        },
      },
    );
    const getter = new Error("x");
    Object.defineProperty(getter, "message", {
      get() {
        throw new Error("message");
      },
    });
    expect(reasonOf(trap)).toBe("a fault without a description");
    expect(reasonOf(getter)).toBe("a fault without a description");
  });

  it("is one line of at most 300 characters", () => {
    expect(reasonOf(new Error("one\ntwo\r\tthree\u0000\u007f"))).toBe("one two  three  ");
    const long = reasonOf(new Error("x".repeat(1000)));
    expect(long).toHaveLength(300);
  });
});
