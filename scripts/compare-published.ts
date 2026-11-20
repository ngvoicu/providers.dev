// npm run compare:published -- <before> <after>
// Compare two data/published/ directories built from the same models.dev snapshot and measurements: they must be the
// same in everything once what the pi work adds is taken off (design/pi-source.md, section j). Exits 1 on any
// difference, and when the two cannot be compared.
import { comparePublished } from "./lib/compare-published.ts";

const [before, after] = process.argv.slice(2);
if (!before || !after) {
  console.error("Usage: npm run compare:published -- <before data/published> <after data/published>");
  process.exit(1);
}
const result = comparePublished(before, after);
for (const line of result.lines) console.log(line);
process.exit(result.ok ? 0 : 1);
