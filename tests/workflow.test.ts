// The step of the Publish workflow that commits the imported data, run as GitHub runs it (bash -e) in a scratch
// repository with a bare remote. git commit and git push are real; nothing leaves the temporary folder.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { ROOT, tempDataDir } from "./helpers.ts";

type Step = { name?: string; id?: string; if?: string; run?: string; env?: Record<string, string> };
const workflow = parse(readFileSync(join(ROOT, ".github", "workflows", "publish.yml"), "utf8")) as { jobs: { publish: { steps: Step[] } } };
const steps = workflow.jobs.publish.steps;
const keepStep = steps.find((step) => step.name === "Keep the new snapshot")!;
const keep = keepStep.run!;

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
}
const write = (dir: string, path: string, content: string) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
};

/** A checkout like the job's, with data/upstream, data/sources and data/sync-status.json committed, and data/pi if asked. */
function checkout(withPi: boolean): string {
  const root = tempDataDir();
  const remote = join(root, "remote.git");
  const dir = join(root, "work");
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", remote]);
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "test");
  git(dir, "config", "user.email", "test");
  git(dir, "config", "commit.gpgsign", "false");
  write(dir, "data/upstream/meta.json", JSON.stringify({ commit: "e06a33eb4d" }));
  write(dir, "data/upstream/providers/a.json", "{}\n");
  write(dir, "data/sources/observed.json", "{}\n");
  write(dir, "data/sync-status.json", "{}\n");
  if (withPi) {
    write(dir, "data/pi/meta.json", JSON.stringify({ revision: "sha256-dd93eb2741d05a80" }));
    write(dir, "data/pi/providers/p.json", "{}\n");
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "start");
  git(dir, "remote", "add", "origin", remote);
  git(dir, "push", "-q", "-u", "origin", "main");
  return dir;
}

/** The step as GitHub runs it; `revision7` is the import step's output pi_revision7, absent where it gave none. */
const runKeep = (dir: string, revision7?: string) => {
  const env: Record<string, string | undefined> = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", PI_REVISION7: revision7 ?? "" };
  return spawnSync("bash", ["-e", "-c", keep], { cwd: dir, encoding: "utf8", env });
};

describe("Keep the new snapshot (release review, blocker 3)", () => {
  it("commits a changed models.dev in a repository that never held data/pi/", () => {
    const dir = checkout(false);
    write(dir, "data/upstream/providers/a.json", '{"changed":true}\n');
    write(dir, "data/sync-status.json", '{"pi":{"status":"failed"}}\n');
    const result = runKeep(dir);
    expect(result.stderr).not.toContain("fatal");
    expect(result.status).toBe(0);
    expect(git(dir, "log", "-1", "--format=%s").trim()).toBe("sync: models.dev e06a33e");
    expect(git(dir, "status", "--porcelain")).toBe("");
    expect(git(dir, "rev-parse", "HEAD")).toBe(git(dir, "rev-parse", "origin/main"));
  });

  it("still commits data/pi/ where it exists, and names what changed from the import step's output", () => {
    const dir = checkout(true);
    write(dir, "data/pi/providers/p.json", '{"changed":true}\n');
    const result = runKeep(dir, "dd93eb2");
    expect(result.status).toBe(0);
    expect(git(dir, "log", "-1", "--format=%s").trim()).toBe("sync: pi dd93eb2");
    expect(git(dir, "status", "--porcelain")).toBe("");
  });

  it("without the step output the message says snapshot, whatever data/pi/meta.json holds", () => {
    const dir = checkout(true);
    write(dir, "data/pi/providers/p.json", '{"changed":true}\n');
    const result = runKeep(dir);
    expect(result.status).toBe(0);
    expect(git(dir, "log", "-1", "--format=%s").trim()).toBe("sync: pi snapshot");
  });

  it("reads no file of pi's: no path under data/pi/ but in git status and git add; the revision from the import step", () => {
    expect(keepStep.env).toEqual({ PI_REVISION7: "${{ steps.sync.outputs.pi_revision7 }}" });
    expect(keep).toContain('revision7="${PI_REVISION7:-snapshot}"');
    expect(keep).not.toContain("node -p \"require('./data/pi");
    // Comments read nothing.
    const named = keep.split("\n").filter((line) => /data\/pi\//.test(line) && !line.trim().startsWith("#"));
    expect(named.length).toBeGreaterThan(0);
    for (const line of named) expect(line, line).toMatch(/git (status|add)\b/);
  });

  it("commits a new or changed discovery file, data/sources/listed.json, as sync: listed; a changed measurements file stays sync: measurements", () => {
    const dir = checkout(false);
    write(dir, "data/sources/listed.json", '{"schema":1}\n');
    write(dir, "data/sources/listed.meta.json", '{"fetched_at":"now"}\n');
    const result = runKeep(dir);
    expect(result.status).toBe(0);
    expect(git(dir, "log", "-1", "--format=%s").trim()).toBe("sync: listed");
    expect(git(dir, "status", "--porcelain")).toBe("");
    write(dir, "data/sources/observed.json", '{"changed":true}\n');
    write(dir, "data/sources/listed.json", '{"schema":1,"changed":true}\n');
    expect(runKeep(dir).status).toBe(0);
    expect(git(dir, "log", "-1", "--format=%s").trim()).toBe("sync: measurements");
  });

  it("commits nothing when only a time moved", () => {
    const dir = checkout(false);
    write(dir, "data/upstream/meta.json", JSON.stringify({ commit: "e06a33eb4d", checked_at: "later" }));
    expect(runKeep(dir).status).toBe(0);
    expect(git(dir, "log", "-1", "--format=%s").trim()).toBe("start");
  });
});

describe("the warning about an unreadable discovery file", () => {
  it("follows the import step's listed output, with fixed text", () => {
    const step = steps.find((item) => item.name === "Warn about an unreadable discovery file")!;
    expect(step.if).toBe("steps.sync.outputs.listed == 'failed'");
    expect(step.run).toMatch(/^echo "::warning title=The discovery file could not be read::[^"$`]*"$/);
  });
});

describe("the warning about pi data missing from the build", () => {
  it("stands directly after the build step, which has the id build, with its condition", () => {
    const build = steps.findIndex((step) => step.name === "Build the dataset and the site");
    expect(steps[build]!.id).toBe("build");
    expect(steps[build + 1]).toMatchObject({ name: "Warn about pi data missing from the build", if: "steps.build.outputs.pi == 'turned_away' || steps.build.outputs.pi == 'published_without_blocks'" });
    // Fixed text: nothing that came from pi is printed as a workflow command.
    expect(steps[build + 1]!.run).toBe(`echo "::warning title=pi data missing from the build::The dataset is built and deployed without pi's data, with pi's data but no pi block on any entry, or without the record of the last pi import. /api/v1/meta lists which and why, under issues (pi-snapshot-unreadable, pi-no-blocks). The models.dev part is as usual; the safe values only pi states are published as unknown."`);
  });
});
