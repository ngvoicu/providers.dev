// Nothing calls pi's code outside the fence (design/pi-source.md, section k, 5, test 3). Read from the sources: every
// .ts and .astro file under src/, scripts/ and worker/.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "./helpers.ts";

const PI = "src/core/pi.ts";
const PI_SYNC = "scripts/lib/pi-sync.ts";
const FENCE = "scripts/lib/pi-fence.ts";
const GUARD = "scripts/lib/fenced.ts";
/** The table of modules: who may import a value from pi's two modules. */
const ALLOWED: Record<string, string[]> = {
  [PI]: [PI_SYNC, FENCE],
  [PI_SYNC]: [FENCE],
};

function sources(): string[] {
  const out: string[] = [];
  for (const top of ["src", "scripts", "worker"]) {
    for (const entry of readdirSync(join(ROOT, top), { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && /\.(ts|astro)$/.test(entry.name)) out.push(relative(ROOT, join(entry.parentPath, entry.name)));
    }
  }
  return out.sort();
}

interface Reference {
  file: string;
  target: string;
  /** Only the form `import type …` (or `export type …`) is erased. Anything else loads the module, inline `type` names or not (verbatimModuleSyntax). */
  typeOnly: boolean;
  text: string;
}

/** Every import, dynamic import() and export … from of a file, with the repository path it names. */
function references(file: string): Reference[] {
  const text = readFileSync(join(ROOT, file), "utf8");
  const out: Reference[] = [];
  const target = (specifier: string): string => (specifier.startsWith(".") ? relative(ROOT, resolve(dirname(join(ROOT, file)), specifier)) : specifier);
  for (const match of text.matchAll(/\b(import|export)\s+(type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']/g)) {
    out.push({ file, target: target(match[4]!), typeOnly: match[2] !== undefined, text: match[0] });
  }
  for (const match of text.matchAll(/\bimport\s+["']([^"']+)["']/g)) out.push({ file, target: target(match[1]!), typeOnly: false, text: match[0] });
  for (const match of text.matchAll(/\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) out.push({ file, target: target(match[1]!), typeOnly: false, text: match[0] });
  return out;
}

describe("3. nothing calls pi's code outside the fence", () => {
  const files = sources();
  const all = files.flatMap(references);

  it("reads the files it should", () => {
    expect(files).toEqual(expect.arrayContaining([PI, PI_SYNC, FENCE, GUARD, "scripts/lib/publish.ts", "scripts/lib/sync.ts"]));
    expect(all.filter((reference) => reference.target === PI).length).toBeGreaterThan(2);
  });

  it("only the files the table of modules allows import a value from src/core/pi.ts or scripts/lib/pi-sync.ts", () => {
    const wrong = all.filter((reference) => !reference.typeOnly && ALLOWED[reference.target] && !ALLOWED[reference.target]!.includes(reference.file));
    expect(wrong.map((reference) => `${reference.file}: ${reference.text}`)).toEqual([]);
  });

  it("nothing leads back: pi's two modules import no value from sync.ts, publish.ts, pi-fence.ts or fenced.ts", () => {
    const across = ["scripts/lib/sync.ts", "scripts/lib/publish.ts", FENCE, GUARD];
    const back = [PI, PI_SYNC].flatMap(references).filter((reference) => !reference.typeOnly && across.includes(reference.target));
    expect(back.map((reference) => `${reference.file}: ${reference.text}`)).toEqual([]);
  });

  it("no cycle at the fence: scripts/lib/pi-fence.ts imports no value from scripts/lib/sync.ts", () => {
    const fromSync = references(FENCE).filter((reference) => !reference.typeOnly && reference.target === "scripts/lib/sync.ts");
    expect(fromSync.map((reference) => reference.text)).toEqual([]);
  });

  it("scripts/lib/fenced.ts imports nothing of pi's", () => {
    const own = references(GUARD).filter((reference) => /(^|\/)pi[-.]|pi\.ts$/.test(reference.target));
    expect(own).toEqual([]);
  });

  it("scripts/lib/pi-fence.ts exports piOfBuild, piOfSync and types, nothing else", () => {
    const text = readFileSync(join(ROOT, FENCE), "utf8");
    const exported = [...text.matchAll(/^export\s+(?!type\s|interface\s)(?:async\s+)?(?:function\*?|const|let|var|class|enum|default)\s*([A-Za-z_$][\w$]*)?/gm)].map((match) => match[1] ?? "default");
    const lists = [...text.matchAll(/^export\s+\{([^}]*)\}/gm)].flatMap((match) => match[1]!.split(",").map((item) => item.trim()).filter((item) => item && !item.startsWith("type ")));
    const reexports = references(FENCE).filter((reference) => reference.text.startsWith("export") && !reference.typeOnly);
    expect([...exported, ...lists, ...reexports.map((reference) => reference.text)].filter((name) => name !== "piOfBuild" && name !== "piOfSync")).toEqual([]);
  });

  it("piOfBuild( and piOfSync( are each called from one file", () => {
    for (const [name, caller] of [["piOfBuild", "scripts/lib/publish.ts"], ["piOfSync", "scripts/lib/sync.ts"]] as const) {
      const callers = files.filter((file) => {
        // A call, not the definition in pi-fence.ts.
        const text = readFileSync(join(ROOT, file), "utf8").replace(new RegExp(`function\\s+${name}\\s*\\(`, "g"), "");
        return new RegExp(`\\b${name}\\(`).test(text);
      });
      expect(callers.length, name).toBeLessThanOrEqual(1);
      if (callers.length === 1) expect(callers, name).toEqual([caller]);
    }
  });
});
