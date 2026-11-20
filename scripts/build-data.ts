// npm run data
// Resolve upstream + our additions + our overrides + our measurements into data/published/.
import { DATA, ROOT } from "./lib/files.ts";
import { publish } from "./lib/publish.ts";

const report = publish({ dataDir: DATA, rootDir: ROOT });
for (const issue of report.issues) console.log(`${issue.level}: [${issue.code}] ${issue.message}`);
if (!report.ok || !report.meta) {
  for (const error of report.errors) console.error(`error: ${error}`);
  console.error("Nothing was published. data/published/ still holds the last good snapshot.");
  process.exit(1);
}
const { counts, dataset_version } = report.meta;
console.log(
  `published ${dataset_version}: ${counts.providers} providers, ${counts.entries} entries ` +
    `(${counts.added_providers} providers and ${counts.added_entries} entries added, ${counts.corrected_entries} corrected, ${counts.evaluated_entries} evaluated)`,
);
const pi = report.meta.pi.counts;
console.log(`pi: ${pi.entries_with_block} entries with a pi block, ${pi.left_out_models} pi models left out, ${pi.unmatched_models} unmatched`);
