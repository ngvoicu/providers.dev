// The step of the Publish workflow that commits the imported data, run as GitHub runs it (bash -e) in a scratch
// repository with a bare remote. git commit and git push are real; nothing leaves the temporary folder.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { ROOT, tempDataDir } from "./helpers.ts";

const workflow = parse(readFileSync(join(ROOT, ".github", "workflows", "publish.yml"), "utf8")) as { jobs: { publish: { steps: { name?: string; run?: string }[] } } };
const keep = workflow.jobs.publish.steps.find((step) => step.name === "Keep the new snapshot")!.run!;

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

const runKeep = (dir: string) => spawnSync("bash", ["-e", "-c", keep], { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });

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

  it("still commits data/pi/ where it exists, and names what changed", () => {
    const dir = checkout(true);
    write(dir, "data/pi/providers/p.json", '{"changed":true}\n');
    const result = runKeep(dir);
    expect(result.status).toBe(0);
    expect(git(dir, "log", "-1", "--format=%s").trim()).toBe("sync: pi dd93eb2");
    expect(git(dir, "status", "--porcelain")).toBe("");
  });

  it("commits nothing when only a time moved", () => {
    const dir = checkout(false);
    write(dir, "data/upstream/meta.json", JSON.stringify({ commit: "e06a33eb4d", checked_at: "later" }));
    expect(runKeep(dir).status).toBe(0);
    expect(git(dir, "log", "-1", "--format=%s").trim()).toBe("start");
  });
});
