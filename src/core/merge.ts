// The merge engine: one upstream value plus one patch gives one published value and a list of changes.
// Rules (see docs/methodology and tests/merge.test.ts for examples):
//   - a key missing from the patch      -> the upstream value stays (absent override)
//   - null                              -> explicitly unknown: the field is not published, and the change says so
//   - the string "$delete"              -> deletion: the field does not apply here and is not published
//   - an object                         -> merged key by key
//   - an array                          -> replaces the upstream array as a whole
//   - any other value, false and 0 too  -> replaces the upstream value

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export const DELETE = "$delete";

export type ChangeOp = "set" | "unknown" | "delete";

export interface Change {
  /** Dot path of the field, for example `limit.context`. */
  path: string;
  op: ChangeOp;
  /** True when upstream had a value at this path. */
  had_upstream: boolean;
  /** The upstream value that was replaced, hidden or removed. */
  upstream?: Json;
  /** The published value (only for `set`). */
  value?: Json;
  /** True when the patch asks for what upstream already says. */
  redundant?: boolean;
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => key in b && deepEqual(a[key], b[key]));
  }
  return false;
}

export function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

const join = (path: string, key: string): string => (path ? `${path}.${key}` : key);

/**
 * Apply `patch` to `base`. Returns the merged value, or undefined when the field ends up not published.
 * Neither argument is modified. Every leaf the patch touches is appended to `changes`.
 */
export function mergePatch(
  base: Json | undefined,
  patch: Json | undefined,
  changes: Change[] = [],
  path = "",
): Json | undefined {
  if (patch === undefined) return base === undefined ? undefined : clone(base);

  if (patch === DELETE || patch === null) {
    const op: ChangeOp = patch === null ? "unknown" : "delete";
    const change: Change = { path, op, had_upstream: base !== undefined };
    if (base !== undefined) change.upstream = clone(base);
    else if (op === "delete") change.redundant = true;
    changes.push(change);
    return undefined;
  }

  if (isObject(patch)) {
    if (base !== undefined && !isObject(base)) {
      // Upstream has a scalar or an array (for example `cache: false`) and the patch an object: replace as a whole.
      const value = stripMarkers(patch);
      changes.push({ path, op: "set", had_upstream: true, upstream: clone(base), value: clone(value) });
      return value;
    }
    const out: JsonObject = isObject(base) ? clone(base) : {};
    for (const [key, value] of Object.entries(patch)) {
      const merged = mergePatch(out[key], value, changes, join(path, key));
      if (merged === undefined) delete out[key];
      else out[key] = merged;
    }
    return out;
  }

  // Scalars (false and 0 included) and arrays replace the upstream value.
  const change: Change = { path, op: "set", had_upstream: base !== undefined, value: clone(patch) };
  if (base !== undefined) change.upstream = clone(base);
  if (deepEqual(base, patch)) change.redundant = true;
  changes.push(change);
  return clone(patch);
}

/** An object patch that replaces a non-object: unknown and deleted keys are simply left out. */
function stripMarkers(patch: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === DELETE) continue;
    out[key] = isObject(value) ? stripMarkers(value) : clone(value);
  }
  return out;
}
