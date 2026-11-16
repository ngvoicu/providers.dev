// Write the record of the structure of /api/v1 (structure/api-v1.json) from the OpenAPI document the code generates.
// Run it on purpose, after a change of structure, and commit the record with the change: `npm run structure:update`.
// It never writes the baseline (structure/api-v1-1.0.0.json), which is never edited.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { openapi } from "../src/core/openapi.ts";
import { apiStructure, BASELINE_ABOUT, breaksMessage, readRecord, RECORD_ABOUT, recordFile, structureBreaks } from "./lib/api-structure.ts";
import { ROOT } from "./lib/files.ts";

const record = join(ROOT, "structure", "api-v1.json");
const baseline = join(ROOT, "structure", "api-v1-1.0.0.json");
const document = openapi();
const structure = apiStructure(document);
const before = existsSync(record) ? readFileSync(record, "utf8") : null;
const text = recordFile(structure, RECORD_ABOUT);
if (before === text) console.log("structure/api-v1.json: unchanged");
else {
  writeFileSync(record, text);
  console.log("structure/api-v1.json: written. Commit it with the change.");
}
if (!existsSync(baseline)) {
  console.log(`structure/api-v1-1.0.0.json is missing. It is written once, by hand, as a copy of the record at 1.0.0 (${BASELINE_ABOUT})`);
  process.exit(1);
}
const old = readRecord(readFileSync(baseline, "utf8"));
const breaks = structureBreaks(old, structure);
if (breaks.length) {
  console.error(breaksMessage(breaks));
  process.exit(1);
}
const version = (document.info as { version: string }).version;
if (!isDeepStrictEqual(old, structure)) console.log(`The structure has grown beyond 1.0.0. The version is ${version}: a release that adds something takes a minor step (1.1.0, 1.2.0, ...) in src/core/openapi.ts.`);
