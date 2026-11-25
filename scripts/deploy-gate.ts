// node scripts/deploy-gate.ts: the Publish workflow's step "Decide whether to deploy". It writes deploy=true|false to
// GITHUB_OUTPUT and says why (scripts/lib/deploy-gate.ts). It reads the live site only for a scheduled run that found
// nothing new; any error while reading means deploy.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { commitOfMessage, deployDecision, liveImportsOf, type GateInput } from "./lib/deploy-gate.ts";

const env = process.env;
const parts: Record<string, string> = {};
for (const part of ["upstream", "measurements", "pi", "listed"]) {
  const value = env[`PART_${part.toUpperCase()}`];
  if (value) parts[part] = value;
}
const built = env.BUILT || execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const input: GateInput = { event: env.EVENT ?? "", syncOutcome: env.SYNC_OUTCOME ?? "", parts, committed: env.COMMITTED === "true", built, liveCommit: null, liveImports: null };

const wrangler = (...args: string[]): unknown => JSON.parse(execFileSync("npx", ["wrangler", ...args, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 60_000 }));

// Only a run that could skip reads the live state.
if (deployDecision({ ...input, liveCommit: built, liveImports: { models: true, pi: true, listed: true } }).deploy === false) {
  try {
    const status = wrangler("deployments", "status") as { versions?: { version_id: string; percentage: number }[] };
    const versions = status.versions ?? [];
    // One version serves everything: its message names the commit it was built from.
    if (versions.length === 1) {
      const version = wrangler("versions", "view", versions[0]!.version_id) as { annotations?: Record<string, unknown> };
      input.liveCommit = commitOfMessage(version.annotations?.["workers/message"]);
    }
  } catch (error) {
    console.log(`The live Worker version could not be read: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }
  try {
    const response = await fetch(env.SITE_META_URL ?? "https://providers.dev/api/v1/meta", { signal: AbortSignal.timeout(20_000) });
    if (response.ok) input.liveImports = liveImportsOf(await response.json());
  } catch (error) {
    console.log(`The live /api/v1/meta could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const decision = deployDecision(input);
console.log(`${decision.deploy ? "Deploy" : "No deploy"}: ${decision.reason}.`);
if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `deploy=${decision.deploy}\nbuilt=${built}\n`);
