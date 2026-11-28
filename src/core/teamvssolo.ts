// Team vs Solo's results, as teamvssolo.providers.dev reads them: one file in the benchmark's published shape
// (team-vs-solo-results-v1, its runs records of team-vs-solo-record-v1), kept in data/teamvssolo/results.json once
// the first round is complete (until then there is none, and the pages say the round is being played). This
// module checks the part of that file the pages read, groups the runs into the boards the pages show, and holds the
// plain words for every fixed word of a record. It reads no file itself (src/core/teamvssolo-data.ts does), so the
// tests can give it any file.
//
// What a page works out, and nothing else: the middle run (median) of a setup's ranked runs, the order of the rows,
// and which teams passed at least as many cases as the best solo. A run that is not ranked is listed and never counted.
import { z } from "zod";
import { entryHref } from "./format.ts";

const count = z.number().int().nonnegative().nullable();
const amount = z.number().nonnegative().nullable();
const flag = z.boolean().nullable();
const TokensSchema = z.object({ fresh_input: count, cache_write: count, cache_write_1h: count, cache_read: count, output: count });
const RoleSchema = z.object({
  harness: z.string(), model: z.string(), family: z.string().nullable(), models_dev: z.string().nullable(), effort: z.string().nullable(), route: z.string(),
  count, sessions: count, calls: count, tokens: TokensSchema.nullable(), usd_at_list: amount, complete: flag,
});
const CheckSchema = z.object({
  name: z.string(), kind: z.string(), state: z.string(), passed: count, total: count,
  parts: z.array(z.object({ name: z.string(), passed: count, total: count })).nullable(),
  not_judged: count.optional(),
  scored_with: z.object({ suite_version: z.string().nullable(), scorer_version: z.string().nullable(), toolchain: z.array(z.object({ name: z.string().nullable(), version: z.string().nullable() })).nullable() }).optional(),
});
const WindowSchema = z.object({
  label: z.string(), role: z.string(), harness: z.string(), model: z.string(), started_at: amount, ended_at: amount, ended: z.string(), stopped_by: z.string().nullable(),
  turns: count, calls: count, tokens: TokensSchema.nullable(), usd_at_list: amount,
  answered_by: z.union([z.string(), z.array(z.object({ by: z.string(), answers: z.number() }))]).optional(),
});
export const RecordSchema = z.object({
  schema: z.literal("team-vs-solo-record-v1"),
  id: z.string().regex(/^[a-z0-9][a-z0-9._+-]*\/[a-z0-9][a-z0-9._+-]*\/[a-z0-9][a-z0-9._+-]*\/(solo|delegation|active)\/[1-9][0-9]*$/),
  round: z.string().nullable(),
  repeat: z.object({ n: z.number().int().positive(), of: z.number().int().positive().nullable() }),
  runner: z.object({ version: z.string().nullable() }),
  suite: z.object({ name: z.string(), version: z.string().nullable(), domain: z.string().nullable(), request: z.string() }),
  mode: z.enum(["solo", "delegation", "active"]),
  setup: z.object({ name: z.string(), parallel: count, time_limit_minutes: amount }),
  roles: z.object({ chief: RoleSchema, worker: RoleSchema.nullable(), reviewer: RoleSchema.nullable() }),
  versions: z.object({
    harnesses: z.array(z.object({ name: z.string(), before: z.string().nullable(), after: z.string().nullable() })),
    extensions: z.array(z.object({ name: z.string().nullable(), before: z.string().nullable(), after: z.string().nullable() })).nullable().optional(),
    prices: z.object({ version: count, fetched: z.string().nullable() }).nullable(),
    node: z.string().nullable(),
    machine: z.object({ chip: z.string().nullable(), cores: count, memory_gib: count, os: z.string().nullable() }).nullable(),
    toolchains: z.object({ tools: z.array(z.object({ name: z.string(), version: z.string().nullable() })), changed: flag }).nullable(),
  }),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  ended_by: z.string().nullable(),
  status: z.string(),
  status_why: z.string().nullable(),
  ranked: z.boolean(),
  unranked_why: z.string().nullable(),
  owner: z.object({ turns: count, max_turns: count }).nullable(),
  owner_change: z.object({ given: flag, read_at: amount, done_after_at: amount }).nullable(),
  quality: z.object({ checks: z.array(CheckSchema).nullable(), scored_again: z.array(z.string()) }),
  time: z.object({ wall_seconds: amount, to_first_task: amount, most_at_once: count }),
  cost: z.object({ usd_at_list: amount, complete: flag }),
  windows: z.array(WindowSchema),
  messages: z.object({ tasks: count, results: count, questions: count, answers: count, notes: count, tells: count, stops: count }).nullable(),
  validity: z.object({
    read_audit: z.object({ verdict: z.string(), complete: flag }).nullable(),
    look: z.object({ verdict: z.string(), at: z.string() }).nullable(),
    mode_kept: flag,
    lock: z.object({ on_every_session: flag, not_expected: count }),
    network: z.object({ complete: flag }),
  }),
});
export const ResultsSchema = z.object({
  schema: z.literal("team-vs-solo-results-v1"),
  built_at: z.string(),
  built_from: z.object({ commit: z.string().nullable(), dirty: flag }),
  suites: z.array(z.object({ name: z.string(), version: z.string().nullable(), domain: z.string().nullable(), checks: z.array(z.object({ name: z.string(), kind: z.string() })), runs: z.number() })),
  runs: z.array(RecordSchema),
});
export type RunRecord = z.infer<typeof RecordSchema>;
export type Results = z.infer<typeof ResultsSchema>;
export type RoleRow = z.infer<typeof RoleSchema>;
export type Mode = RunRecord["mode"];

/** The file, checked. An error names the key that is wrong: a page is never built from a file it cannot read. */
export function parseResults(value: unknown): Results {
  const parsed = ResultsSchema.safeParse(value);
  if (!parsed.success) throw new Error(`data/teamvssolo/results.json is not a results file the pages can read: ${parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  const ids = new Set<string>();
  for (const run of parsed.data.runs) {
    if (ids.has(run.id)) throw new Error(`data/teamvssolo/results.json has two runs with the id ${run.id}`);
    ids.add(run.id);
  }
  return parsed.data;
}

/**
 * Whether the file is a sample. It is taken as real results only when the benchmark built it from a commit and no
 * run's round is a sample's: anything else stops the build (src/core/teamvssolo-data.ts), so a sample is never
 * published.
 */
export function isSample(results: Results): boolean {
  return results.built_from.commit === null || results.built_from.dirty !== false || results.runs.some((run) => run.round === null || run.round.startsWith("sample"));
}

/** The tests whose runs are results. The benchmark's own trial suites (its smoke, proof and toy suites) are not shown. */
const SHOWN_DOMAINS = new Set(["backend", "fullstack", "frontend", "design"]);
export const shownRuns = (results: Results): RunRecord[] => results.runs.filter((run) => run.suite.domain !== null && SHOWN_DOMAINS.has(run.suite.domain));

// ---- words

export const MODE_NAME: Record<Mode, string> = { solo: "Solo", delegation: "Delegation", active: "Active" };
export const MODE_WORDS: Record<Mode, string> = {
  solo: "One model works alone.",
  delegation: "A chief model hands tasks to workers and reads their reports. A worker's question gets one fixed line back, and the chief never sees it.",
  active: "A chief hands out tasks, and the chief and its workers also talk while a worker works.",
};

const HARNESS: Record<string, string> = { claude: "Claude Code", codex: "Codex", pi: "Pi" };
export const toolName = (harness: string): string => HARNESS[harness] ?? harness;

const ROUTE: Record<string, string> = {
  "claude-subscription": "Claude subscription",
  "codex-subscription": "Codex subscription",
  "anthropic-api": "Anthropic API key",
  "openai-api": "OpenAI API key",
  "proxy-subscription-pool": "Gateway, subscription login first",
  "proxy-key": "Gateway, API key",
  unknown: "Not recorded",
};
export const routeWords = (route: string): string => ROUTE[route] ?? route;

const STATUS: Record<string, string> = { done: "Finished", cut: "Cut off", stopped: "Stopped by hand", failed: "Failed", void: "Void" };
export const statusWords = (status: string): string => STATUS[status] ?? status;

const ENDED_BY: Record<string, string> = {
  "done-word": "The model said it was done.",
  "chief-ended": "The model's one turn ended.",
  "owner-turns-used-up": "It stopped as often as allowed without saying it was done.",
  "time-up": "It reached its time limit.",
  "price-stop": "It reached its price limit.",
  "no-progress": "It changed no file for 60 minutes and was stopped.",
  "runaway-price": "It reached ten times its expected price and was stopped.",
  "chief-failed": "Its top session ended in an error.",
  aborted: "It was stopped by hand.",
  "runner-error": "The benchmark's own program failed.",
};
export const endedWords = (endedBy: string | null): string => (endedBy === null ? "How it ended is not known." : (ENDED_BY[endedBy] ?? endedBy));

const UNRANKED: Record<string, string> = {
  "no-audit": "Its records were not screened for reads outside the project.",
  "needs-look": "The screen flagged its records and no person has looked at them yet.",
  "change-unanswered": "It did not answer the change to the request.",
  "no-progress": ENDED_BY["no-progress"]!,
  "runaway-price": ENDED_BY["runaway-price"]!,
  "price-stop": ENDED_BY["price-stop"]!,
  "price-unknown": "Its price is not fully known.",
  "not-judged": "A check could not judge every case.",
  "suite-dirty": "The test's files had changes that were not committed when it ran.",
  "pin-not-matched": "An add-on of a tool was not the version named for the round.",
  "parts-missing": "Its record lacks parts a ranked run must have.",
  "model-mismatch": "A model other than the one asked for answered.",
  "extension-changed": "An add-on of a tool changed during the run.",
};
const VOID: Record<string, string> = {
  "read-outside": "It read a place a run must not read.",
  "mode-not-kept": "The team did not keep to its mode.",
  "owner-setup-seen": "Settings of the machine's owner got into a session.",
  "scoring-failed": "Its scoring failed.",
  "by-hand": "A person looked at it and voided it.",
};
/** Why a run is not ranked, in a sentence; null for a ranked run. */
export function whyNotRanked(run: RunRecord): string | null {
  if (run.ranked) return null;
  if (run.status === "void") return run.status_why === null ? "It is void." : (VOID[run.status_why] ?? run.status_why);
  if (run.unranked_why !== null) return UNRANKED[run.unranked_why] ?? run.unranked_why;
  return endedWords(run.ended_by);
}

const CHECK: Record<string, string> = { hidden: "Hidden tests", probes: "Probes", api: "API tests", browser: "Browser tests", own: "Extra tests" };
export const checkName = (name: string): string => CHECK[name] ?? name;
/** A part of a check, as the record names it: "first-part" is "First part". */
export const partName = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1).replace(/-/g, " ");

/** The models of the first round: a plain name, and the model's entry on providers.dev where it has one. */
const MODELS: Record<string, { name: string; short: string; entry: string | null }> = {
  "claude-fable-5-2": { name: "Claude Fable 5.2", short: "Fable 5.2", entry: "anthropic/claude-fable-5-2" },
  "claude-opus-5-5": { name: "Claude Opus 5.5", short: "Opus 5.5", entry: "anthropic/claude-opus-5-5" },
  "claude-sonnet-5-5": { name: "Claude Sonnet 5.5", short: "Sonnet 5.5", entry: "anthropic/claude-sonnet-5-5" },
  "claude-haiku-5-5": { name: "Claude Haiku 5.5", short: "Haiku 5.5", entry: "anthropic/claude-haiku-5-5" },
  "gpt-6.2-astra": { name: "GPT-6.2 Astra", short: "GPT-6.2 Astra", entry: "openai/gpt-6.2-astra" },
  "gpt-6.2-sol": { name: "GPT-6.2 Sol", short: "GPT-6.2 Sol", entry: "openai/gpt-6.2-sol" },
  "swe-2.1": { name: "SWE-2.1", short: "SWE-2.1", entry: null },
};
export const MODEL_ENTRIES: readonly string[] = Object.values(MODELS).flatMap((model) => (model.entry ? [model.entry] : []));

/** A model's id without the path a tool reaches it by: "provimux/claude-sonnet-5-5" is "claude-sonnet-5-5". */
export const plainModel = (model: string): string => model.split("/").pop()!;

export interface RoleView {
  /** The model's name, or its id where the site has no name for it. */
  name: string;
  /** The name a board uses: without the maker's family name where the model's own name is enough, and with the tool where that is Pi, which reaches a model other tools reach too. */
  short: string;
  model: string;
  /** Its entry on providers.dev, in full; null where there is none. */
  entry: string | null;
  effort: string | null;
  tool: string;
  /** How the tool reached the model. */
  route: string;
  /** Through the Provimux gateway: the model's id says so. */
  gateway: boolean;
  /** The effort and the tool in a few words: "high effort, Claude Code". */
  how: string;
  row: RoleRow;
}
export function roleView(row: RoleRow): RoleView {
  const plain = plainModel(row.model);
  const known = MODELS[plain];
  const ref = row.models_dev ?? known?.entry ?? null;
  const gateway = row.model.startsWith("provimux/");
  const tool = toolName(row.harness);
  return {
    name: known?.name ?? plain, short: `${known?.short ?? plain}${row.harness === "pi" ? " in Pi" : ""}`, model: row.model, entry: ref === null ? null : `https://providers.dev${entryHref(ref)}`, effort: row.effort, tool, route: routeWords(row.route), gateway,
    how: `${row.effort === null ? "effort not set" : `${row.effort} effort`}, ${tool}${gateway ? " through Provimux" : ""}`, row,
  };
}

// ---- figures

/** "$38.20". Prices are sums of list prices, shown to the cent. */
export const usd = (value: number): string => `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** "2 h 05 min", "48 min", "40 s". */
export function clock(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}
/** A count of cases: whole, or to one decimal where a median of two runs falls between them. */
export const cases = (value: number): string => (Number.isInteger(value) ? value.toLocaleString("en-US") : value.toFixed(1));
export const whole = (value: number): string => Math.round(value).toLocaleString("en-US");
export const day = (iso: string): string => iso.slice(0, 10);

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

// ---- boards

/** The address of a run's page on the site: its id, with the "+" of a team's setup written "--". */
export const runPath = (id: string): string => `/runs/${id.replace(/\+/g, "--")}/`;
export const suitePath = (suite: string): string => `/results/${suite}/`;

export interface BoardCheck { name: string; label: string; total: number | null }
export interface BoardRow {
  key: string;
  setup: string;
  mode: Mode;
  chief: RoleView;
  worker: RoleView | null;
  /** Every run of the setup in this mode, by repeat. */
  runs: RunRecord[];
  /** The runs that count. */
  ranked: RunRecord[];
  /** The middle run's cases passed, a check each, in the board's order; null with no ranked run or no number. */
  passed: (number | null)[];
  usd: number | null;
  seconds: number | null;
  /** The solo that the board's line is drawn from. */
  best: boolean;
  /** A team that passed at least as many cases as the best solo in every check. */
  matched: boolean;
}
export interface Board {
  suite: string;
  request: string;
  checks: BoardCheck[];
  solos: BoardRow[];
  teams: BoardRow[];
  best: BoardRow | null;
  /** The largest price and the longest time of a ranked run: the ends of the bars. */
  maxUsd: number;
  maxSeconds: number;
  /** The first and the last day a run of the board started (UTC). */
  from: string;
  to: string;
  runs: number;
  ranked: number;
  /** The price lists the runs were priced with: the day each was fetched. */
  priceDays: string[];
  answer: Answer | null;
}
/** The board in one sentence's figures: of the teams with a ranked run, how many matched the best solo, and of those how many were cheaper or faster. */
export interface Answer { teams: number; matched: number; cheaper: number; faster: number; both: number }

const passedOf = (run: RunRecord, check: string): number | null => run.quality.checks?.find((item) => item.name === check && (item.state === "scored" || item.state === "refused"))?.passed ?? null;

/** Rows in order: more cases passed in the first check, then in the next; then the lower price, then the shorter time. A row with no ranked run comes last. */
function byScore(a: BoardRow, b: BoardRow): number {
  if ((a.ranked.length === 0) !== (b.ranked.length === 0)) return a.ranked.length === 0 ? 1 : -1;
  for (let i = 0; i < a.passed.length; i++) {
    const difference = (b.passed[i] ?? -1) - (a.passed[i] ?? -1);
    if (difference !== 0) return difference;
  }
  return (a.usd ?? Infinity) - (b.usd ?? Infinity) || (a.seconds ?? Infinity) - (b.seconds ?? Infinity) || a.key.localeCompare(b.key);
}

/** The boards of the file: one a test and request, in the file's order of tests. */
export function boards(results: Results): Board[] {
  const groups = new Map<string, RunRecord[]>();
  for (const run of shownRuns(results)) {
    const key = `${run.suite.name}/${run.suite.request}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  const order = results.suites.map((suite) => suite.name);
  return [...groups.entries()]
    .sort(([a], [b]) => order.indexOf(a.split("/")[0]!) - order.indexOf(b.split("/")[0]!) || a.localeCompare(b))
    .map(([key, runs]) => {
      const [suite, request] = key.split("/") as [string, string];
      const names = results.suites.find((item) => item.name === suite)?.checks.map((check) => check.name) ?? [...new Set(runs.flatMap((run) => run.quality.checks?.map((check) => check.name) ?? []))];
      const checks: BoardCheck[] = names.map((name) => ({ name, label: checkName(name), total: runs.reduce<number | null>((total, run) => Math.max(total ?? 0, run.quality.checks?.find((check) => check.name === name)?.total ?? 0) || total, null) }));
      const bySetup = new Map<string, RunRecord[]>();
      for (const run of runs) {
        const row = `${run.setup.name}/${run.mode}`;
        bySetup.set(row, [...(bySetup.get(row) ?? []), run]);
      }
      const rows: BoardRow[] = [...bySetup.entries()].map(([row, own]) => {
        own.sort((a, b) => a.repeat.n - b.repeat.n);
        const ranked = own.filter((run) => run.ranked);
        const first = own[0]!;
        return {
          key: row, setup: first.setup.name, mode: first.mode, chief: roleView(first.roles.chief), worker: first.roles.worker ? roleView(first.roles.worker) : null, runs: own, ranked,
          passed: checks.map((check) => median(ranked.flatMap((run) => passedOf(run, check.name) ?? []))),
          usd: median(ranked.flatMap((run) => run.cost.usd_at_list ?? [])),
          seconds: median(ranked.flatMap((run) => run.time.wall_seconds ?? [])),
          best: false, matched: false,
        };
      });
      const solos = rows.filter((row) => row.mode === "solo").sort(byScore);
      const teams = rows.filter((row) => row.mode !== "solo").sort(byScore);
      const best = solos[0] && solos[0].ranked.length > 0 ? solos[0] : null;
      if (best) best.best = true;
      let answer: Answer | null = null;
      if (best) {
        const counted = teams.filter((row) => row.ranked.length > 0);
        for (const row of counted) row.matched = row.passed.every((passed, i) => passed !== null && best.passed[i] !== null && passed >= best.passed[i]!);
        const matched = counted.filter((row) => row.matched);
        const cheaper = matched.filter((row) => row.usd !== null && best.usd !== null && row.usd < best.usd);
        const faster = matched.filter((row) => row.seconds !== null && best.seconds !== null && row.seconds < best.seconds);
        answer = { teams: counted.length, matched: matched.length, cheaper: cheaper.length, faster: faster.length, both: cheaper.filter((row) => faster.includes(row)).length };
      }
      const rankedRuns = runs.filter((run) => run.ranked);
      const days = runs.map((run) => day(run.started_at)).sort();
      return {
        suite, request, checks, solos, teams, best,
        maxUsd: Math.max(0, ...rankedRuns.map((run) => run.cost.usd_at_list ?? 0)),
        maxSeconds: Math.max(0, ...rankedRuns.map((run) => run.time.wall_seconds ?? 0)),
        from: days[0]!, to: days.at(-1)!, runs: runs.length, ranked: rankedRuns.length,
        priceDays: [...new Set(runs.flatMap((run) => run.versions.prices?.fetched ?? []))].sort(),
        answer,
      };
    });
}

/** How many of a board's rows rest on one run only. */
export const singles = (board: Board): number => [...board.solos, ...board.teams].filter((row) => row.ranked.length === 1).length;

/** A setup in a few words: "Claude Fable 5.2 alone", "Claude Fable 5.2 with Claude Sonnet 5.5 workers". */
export function setupWords(chief: RoleView, worker: RoleView | null): string {
  return worker ? `${chief.short} with ${worker.short} workers` : `${chief.short} alone`;
}

// ---- the tests

export interface TestText {
  name: string;
  /** What the model is asked to build, in a line. */
  line: string;
  /** The test in a paragraph. HTML. */
  text: string;
}
/** The benchmark's tests, each in a paragraph. Only what the benchmark publishes of a test: never its request or its checks. */
export const TESTS: readonly TestText[] = [
  {
    name: "tally",
    line: "Extend an accounting tool from version 1.0 to 2.0.",
    text: "The model gets version 1.0 of a small double-entry accounting program for the command line, written in Node.js, and a written request for version 2.0. Then 440 hidden tests and 67 harder probes run the finished program.",
  },
  {
    name: "conduit",
    line: "Build a blog app: a Go server and a plain web front.",
    text: "The model builds Conduit, the RealWorld demo blog app: one Go program, standard library only, that serves its API and a web front written in plain HTML, CSS and JavaScript, with no framework. Hidden checks score it in three parts: 157 through the API, 139 in a browser and 13 more. About an hour in (sooner, if the model says it is done first), the request changes once; a run counts only if it finishes after the change.",
  },
  {
    name: "valkey",
    line: "Build a Valkey-compatible server in Go or Rust.",
    text: "The model builds a server that speaks the Redis and Valkey protocol, in Go or Rust, using the language's standard library only. Hidden checks score it on 1,707 cases.",
  },
  {
    name: "ferry",
    line: "Extend a message relay from version 1.0 to 2.0.",
    text: "The model gets version 1.0 of a small message relay written in Node.js and a written request for version 2.0. After the first request, the run can be given a scripted clarification and a changed requirement. Hidden checks then report the groups of behaviour held, out of the groups counted.",
  },
];
export const testText = (name: string): TestText | null => TESTS.find((test) => test.name === name) ?? null;
export const testName = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1);

/** A count of tokens in short: "19.5M", "182k", "640". The run's page gives each kind apart. */
export function tokens(value: number): string {
  if (value >= 1e6) return `${(value / 1e6).toFixed(value >= 1e8 ? 0 : 1)}M`;
  if (value >= 1e3) return `${Math.round(value / 1e3)}k`;
  return String(value);
}

/** The cases a run passed in a check, as a board's cell says them: "418", "Not judged", "No score". */
export function passedWords(run: RunRecord, check: string): string {
  const own = run.quality.checks?.find((item) => item.name === check);
  if (!own) return "No score";
  if (own.state === "not-judged") return "Not judged";
  if (own.passed === null) return "No score";
  return cases(own.passed);
}

const AUDIT: Record<string, string> = {
  clean: "Clean: no sign of a read outside the project.",
  outside: "It read outside its project, but no place that holds answers.",
  suspect: "Flagged, for a person to look at.",
  void: "It reached a place a run must not read.",
  incomplete: "The screen could not read every record.",
};
export const auditWords = (verdict: string | null): string => (verdict === null ? "Not screened." : (AUDIT[verdict] ?? verdict));
export const yesNo = (value: boolean | null, unknown = "Not known"): string => (value === null ? unknown : value ? "Yes" : "No");

/** Whether every case of every check of a run was judged, in a sentence. */
export function judgedInFull(run: RunRecord): { full: boolean; words: string } {
  const checks = run.quality.checks;
  if (checks === null || checks.length === 0) return { full: false, words: "No. The run was not scored." };
  const open = checks.filter((check) => check.state !== "scored" && check.state !== "refused" || (check.not_judged ?? 0) > 0 || check.passed === null);
  if (open.length === 0) return { full: true, words: "Yes. Every case of every check was judged." };
  return { full: false, words: `No. ${open.map((check) => `${checkName(check.name)}: ${check.not_judged ? `${cases(check.not_judged)} cases could not be judged` : check.state === "failed" ? "the scoring failed" : "not judged"}`).join("; ")}. A check that is not judged in full gets no number.` };
}
