// The guard of the fence around pi's part (design/pi-source.md, section k): run code that may fail in any way, and
// take its result only as plain data that fits a schema. It knows nothing of pi and imports nothing of pi's.
import { z } from "zod";

/** What crosses the fence: the plain result, or why it was turned away. */
export type Fenced<T> = { ok: true; value: T } | { ok: false; why: string };

const NO_DESCRIPTION = "a fault without a description";

/**
 * Why a call into pi's code was turned away, as one short line of text. Total: it cannot throw. The `message` of an
 * `Error` where that is a string, the first issue's path and message for a misfit, else "a fault without a
 * description"; then every control character becomes a space and the text is cut to 300 characters.
 */
export function reasonOf(error: unknown): string {
  let text = NO_DESCRIPTION;
  try {
    if (error instanceof z.ZodError) {
      const first = error.issues[0];
      if (first) {
        const path = first.path.map((part) => String(part)).join(".");
        text = path ? `${path}: ${first.message}` : first.message;
      }
    } else if (error instanceof Error) {
      const message: unknown = error.message;
      if (typeof message === "string") text = message;
    }
  } catch {
    text = NO_DESCRIPTION;
  }
  try {
    return [...text.replace(/\p{Cc}/gu, " ")].slice(0, 300).join("");
  } catch {
    return NO_DESCRIPTION;
  }
}

/** The result made plain, checked; the plain copy, not zod's output, whose keys the schema would reorder. */
function plainChecked<T>(result: unknown, schema: z.ZodType<T>): Fenced<T> {
  // A getter, a prototype, an undefined, a function or a cycle does not survive this, and key order does.
  const plain: unknown = JSON.parse(JSON.stringify(result));
  const checked = schema.safeParse(plain);
  if (!checked.success) return { ok: false, why: reasonOf(checked.error) };
  return { ok: true, value: plain as T };
}

/** Run pi's code and take its result only as plain data that fits `schema`. Never throws. */
export function fenced<T>(compute: () => T, schema: z.ZodType<T>): Fenced<T> {
  try {
    return plainChecked(compute(), schema);
  } catch (error) {
    return { ok: false, why: reasonOf(error) };
  }
}

/** `fenced` for pi's code that is asynchronous. Never rejects. */
export async function fencedAsync<T>(compute: () => Promise<T>, schema: z.ZodType<T>): Promise<Fenced<T>> {
  try {
    return plainChecked(await compute(), schema);
  } catch (error) {
    return { ok: false, why: reasonOf(error) };
  }
}
