// Whether a run of the Publish workflow deploys. Every run deploys but one kind: a scheduled run whose import found
// nothing new, while the live site was built from the same commit and reports no failed import. Such a deploy would
// change nothing but the times of the check (and re-upload a few hundred files): it is left out. Everything else
// deploys: a push, a run started by hand, a run that committed a snapshot, a run with a failed part (the site must say
// so), a live site built from another commit (a push whose own run was replaced in the queue), a live site that still
// reports a failed import, and any case where the live state cannot be read.

/** What the workflow knows when it decides, and what it read of the live site. */
export interface GateInput {
  /** github.event_name. */
  event: string;
  /** The outcome of the import step: success, failure or skipped. */
  syncOutcome: string;
  /** The import step's outputs per part (upstream, measurements, pi, listed): updated, unchanged or failed. */
  parts: Record<string, string>;
  /** The run committed a snapshot. */
  committed: boolean;
  /** The commit whose tree this run built. */
  built: string;
  /** The commit the live Worker version was deployed from (its message `commit <sha>`); null = not known. */
  liveCommit: string | null;
  /** What /api/v1/meta of the live site says of the last imports; null = not read. */
  liveImports: { models: boolean | null; pi: boolean | null; listed: boolean | null } | null;
}

export interface GateDecision {
  deploy: boolean;
  reason: string;
}

/** The message a deploy gives its Worker version, and the one the gate reads back. */
export const deployMessage = (commit: string): string => `commit ${commit}`;
export const commitOfMessage = (message: unknown): string | null => {
  const match = typeof message === "string" ? /^commit ([0-9a-f]{40})$/.exec(message) : null;
  return match ? match[1]! : null;
};

export function deployDecision(input: GateInput): GateDecision {
  if (input.event !== "schedule") return { deploy: true, reason: `a ${input.event} run always deploys` };
  if (input.syncOutcome !== "success") return { deploy: true, reason: "the import failed: the site must say so" };
  const failed = Object.entries(input.parts).filter(([, status]) => status === "failed").map(([part]) => part);
  if (failed.length > 0) return { deploy: true, reason: `a part of the import failed (${failed.join(", ")}): the site must say so` };
  if (input.committed) return { deploy: true, reason: "the import committed new data" };
  if (input.liveCommit === null) return { deploy: true, reason: "the commit of the live site is not known" };
  if (input.liveCommit !== input.built) return { deploy: true, reason: `the live site was built from ${input.liveCommit.slice(0, 7)}, not from ${input.built.slice(0, 7)}` };
  const live = input.liveImports;
  if (live === null) return { deploy: true, reason: "the live /api/v1/meta could not be read" };
  if (live.models !== true || live.pi === false || live.listed === false) return { deploy: true, reason: "the live site reports a failed import that this run no longer has" };
  return { deploy: false, reason: `nothing new: the live site is ${input.built.slice(0, 7)} with the same data` };
}

/** The three import records of /api/v1/meta, as the gate reads them. Null where the answer is not the expected shape. */
export function liveImportsOf(body: unknown): GateInput["liveImports"] {
  const data = (body as { data?: Record<string, unknown> } | null)?.data;
  if (!data || typeof data !== "object") return null;
  const ok = (record: unknown): boolean | null => {
    const value = (record as { sync?: { last_attempt_ok?: unknown } } | undefined)?.sync?.last_attempt_ok;
    return typeof value === "boolean" ? value : null;
  };
  return { models: ok(data), pi: ok(data.pi), listed: ok(data.listings) };
}
