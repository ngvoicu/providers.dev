import { describe, expect, it } from "vitest";
import { commitOfMessage, deployDecision, deployMessage, liveImportsOf, type GateInput } from "../scripts/lib/deploy-gate.ts";

const sha = "a".repeat(40);
const quiet: GateInput = {
  event: "schedule", syncOutcome: "success", parts: { upstream: "unchanged", measurements: "unchanged", pi: "unchanged", listed: "unchanged" },
  committed: false, built: sha, liveCommit: sha, liveImports: { models: true, pi: true, listed: true },
};

describe("whether a run deploys", () => {
  it("skips only a scheduled run that found nothing new, with the live site built from the same commit and no failed import", () => {
    expect(deployDecision(quiet)).toEqual({ deploy: false, reason: "nothing new: the live site is aaaaaaa with the same data" });
  });

  it("deploys every other run", () => {
    const cases: Partial<GateInput>[] = [
      { event: "push" },
      { event: "workflow_dispatch" },
      { syncOutcome: "failure" },
      { parts: { ...quiet.parts, pi: "failed" } },
      { parts: { ...quiet.parts, listed: "failed" } },
      { committed: true },
      { liveCommit: null },
      { liveCommit: "b".repeat(40) },
      { liveImports: null },
      { liveImports: { models: false, pi: true, listed: true } },
      { liveImports: { models: null, pi: true, listed: true } },
      { liveImports: { models: true, pi: false, listed: true } },
      { liveImports: { models: true, pi: true, listed: false } },
    ];
    for (const change of cases) expect(deployDecision({ ...quiet, ...change }).deploy, JSON.stringify(change)).toBe(true);
    // pi or the discovery file never imported: nothing to report, no reason to deploy.
    expect(deployDecision({ ...quiet, liveImports: { models: true, pi: null, listed: null } }).deploy).toBe(false);
  });

  it("reads the commit back from the version's message, and the imports from /api/v1/meta", () => {
    expect(commitOfMessage(deployMessage(sha))).toBe(sha);
    for (const message of [undefined, "", "commit abc", `commit ${sha} more`]) expect(commitOfMessage(message)).toBeNull();
    expect(liveImportsOf({ data: { sync: { last_attempt_ok: true }, pi: { sync: { last_attempt_ok: false } }, listings: { sync: { last_attempt_ok: true } } } })).toEqual({ models: true, pi: false, listed: true });
    expect(liveImportsOf({ data: { sync: {} } })).toEqual({ models: null, pi: null, listed: null });
    expect(liveImportsOf(null)).toBeNull();
    expect(liveImportsOf({ error: "x" })).toBeNull();
  });
});
