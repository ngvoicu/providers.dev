// The results file of teamvssolo.providers.dev, read from the repository at build: data/teamvssolo/results.json. Only
// the build and the tests read it (the pages are static); the Worker never does and never bundles it. Until the first
// round is complete there is no such file: the pages then say that the round is being played, and no page of a test's
// results or of a run is built. A sample is never published: a file the benchmark did not build from a clean commit
// stops the build (isSample).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { boards, isSample, parseResults, shownRuns, type Board, type Results, type RunRecord } from "./teamvssolo.ts";

export const RESULTS_FILE = join("data", "teamvssolo", "results.json");

/** The file at a path, checked: the results it holds, or a thrown error naming what is wrong. A sample is refused. */
export function readResults(file: string): Results {
  const results = parseResults(JSON.parse(readFileSync(file, "utf8")));
  if (isSample(results)) throw new Error(`${RESULTS_FILE} is not results the benchmark built from a clean commit (a sample?): it is never published`);
  return results;
}

let read: { results: Results | null } | null = null;
/** The published results, read once, or null while there are none. `root` is the repository's folder. */
export function teamVsSoloResults(root: string = process.cwd()): Results | null {
  if (!read) {
    const file = join(root, RESULTS_FILE);
    read = { results: existsSync(file) ? readResults(file) : null };
  }
  return read.results;
}

/** Each test's board of the published results; none while there are no results. */
export const teamVsSoloBoards = (root?: string): Board[] => {
  const results = teamVsSoloResults(root);
  return results ? boards(results) : [];
};

/** The runs of the published results that have a page; none while there are no results. */
export const teamVsSoloRuns = (root?: string): RunRecord[] => {
  const results = teamVsSoloResults(root);
  return results ? shownRuns(results) : [];
};
