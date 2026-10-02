import {mkdir, readdir, rm, symlink} from "node:fs/promises";
import {relative, resolve} from "node:path";

import {
  optimizationRunPlanSchema,
  projectRoot,
  runsDirectory,
  writeJsonAtomic,
} from "../artifacts";
import {audienceModelSchema} from "../audience/model";
import {
  STRATEGIES,
  summarizeComparison,
  type Strategy,
  type TrialReward,
} from "../benchmark/comparison";
import {
  DEFAULT_PROPOSAL_BUDGET,
  loadSearchRounds,
  rewardSchema,
  scoreSearch,
} from "../benchmark/reward";

const STARTING_PAIRS = [
  ["g0_v00", "g0_v01"],
  ["g0_v02", "g0_v03"],
  ["g0_v04", "g0_v05"],
  ["g0_v06", "g0_v07"],
] as const;
const USAGE =
  "Usage: bun run benchmark --job <name> [--seeds 1-20] " +
  "[--strategies agent,random] [--concurrency 4]";

const arguments_ = Bun.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = arguments_.indexOf(name);
  return index === -1 ? undefined : arguments_[index + 1];
};
const job = flag("--job");
if (job === undefined || !/^[A-Za-z0-9_-]+$/.test(job)) throw new Error(USAGE);
const [firstSeed, lastSeed] = (flag("--seeds") ?? "1-20").split("-").map(Number);
const strategies = (flag("--strategies") ?? STRATEGIES.join(",")).split(",");
const concurrency = Number(flag("--concurrency") ?? "4");
if (
  !Number.isSafeInteger(firstSeed) ||
  !Number.isSafeInteger(lastSeed) ||
  firstSeed! > lastSeed! ||
  !Number.isSafeInteger(concurrency) ||
  concurrency < 1 ||
  strategies.some((strategy) => !STRATEGIES.includes(strategy as Strategy))
) {
  throw new Error(USAGE);
}

const jobDirectory = resolve(projectRoot, "artifacts/benchmark", job);
// Every trial starts from the same checked-in history and keeps its own afterwards.
const baseRunIds = (await readdir(runsDirectory, {withFileTypes: true}))
  .filter((entry) => entry.isDirectory())
  .map(({name}) => name);
const model = audienceModelSchema.parse(
  await Bun.file(resolve(projectRoot, "artifacts/audience/model.json")).json(),
);
const trials = (strategies as Strategy[]).flatMap((strategy) =>
  STARTING_PAIRS.flatMap(([control, treatment]) =>
    Array.from({length: lastSeed! - firstSeed! + 1}, (_, index) => {
      const seed = firstSeed! + index;
      const startingPair = `${control}_vs_${treatment}`;
      return {
        strategy,
        control,
        treatment,
        seed,
        starting_pair: startingPair,
        // Shared across strategies so both draw the same simulator randomness.
        run_id: `bench_${startingPair}_s${seed.toString().padStart(2, "0")}`,
        directory: resolve(jobDirectory, strategy, `${startingPair}_s${seed}`),
      };
    })
  )
);

const results: TrialReward[] = [];
const failures: string[] = [];
let completed = 0;
const queue = [...trials];
await Promise.all(Array.from({length: concurrency}, async () => {
  for (let trial = queue.shift(); trial !== undefined; trial = queue.shift()) {
    const label = `${trial.strategy}/${trial.starting_pair}/s${trial.seed}`;
    const rewardPath = resolve(trial.directory, "reward.json");
    if (!(await Bun.file(rewardPath).exists())) {
      await rm(trial.directory, {recursive: true, force: true});
      await mkdir(resolve(trial.directory, "runs"), {recursive: true});
      for (const runId of baseRunIds) {
        await symlink(resolve(runsDirectory, runId), resolve(trial.directory, "runs", runId));
      }
      const environment = {
        ...Bun.env,
        SIMULA_RUNS_DIR: relative(projectRoot, resolve(trial.directory, "runs")),
        SIMULA_AGENT_DB: relative(projectRoot, resolve(trial.directory, "state.sqlite")),
      };
      const child = Bun.spawn({
        cmd: [
          process.execPath, "run", resolve(projectRoot, "src/cli/agent.ts"), "run",
          "--seed-control", trial.control,
          "--seed-treatment", trial.treatment,
          "--seed", String(trial.seed),
          "--max-rounds", String(DEFAULT_PROPOSAL_BUDGET + 1),
          "--run-id", trial.run_id,
          "--strategy", trial.strategy,
          "--no-render", "--no-dashboard", "--quiet",
        ],
        cwd: projectRoot,
        env: environment,
        stdout: Bun.file(resolve(trial.directory, "log.txt")),
        stderr: "pipe",
      });
      const [exitCode, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      if (exitCode !== 0) {
        await Bun.write(resolve(trial.directory, "error.txt"), stderr);
        const reason = stderr.split("\n").find((line) => /^\w*Error: /.test(line)) ??
          stderr.split("\n").find((line) => line.startsWith("error:"));
        failures.push(`${label}: ${reason ?? `exit code ${exitCode}`}`);
        console.error(`failed     ${label}`);
        continue;
      }
      const source = {
        project_root: projectRoot,
        runs_directory: resolve(trial.directory, "runs"),
        ledger_path: resolve(trial.directory, "state.sqlite"),
      };
      const plan = optimizationRunPlanSchema.parse(
        await Bun.file(resolve(source.runs_directory, trial.run_id, "plan.json")).json(),
      );
      if (plan.audience_model.path !== "artifacts/audience/model.json") {
        throw new Error(`${label} used ${plan.audience_model.path}.`);
      }
      await writeJsonAtomic(rewardPath, scoreSearch({
        optimization_run_id: trial.run_id,
        rounds: await loadSearchRounds(trial.run_id, source),
        model,
        budget: DEFAULT_PROPOSAL_BUDGET,
      }));
    }
    const reward = rewardSchema.parse(await Bun.file(rewardPath).json());
    results.push({
      starting_pair: trial.starting_pair,
      seed: trial.seed,
      strategy: trial.strategy,
      reward,
    });
    completed += 1;
    console.error(
      `${String(completed).padStart(3)}/${trials.length}  ${label}  ` +
        `gain=${reward.normalized_gain.toFixed(3)}${reward.valid ? "" : "  INVALID"}`,
    );
  }
}));

const summary = {...summarizeComparison(results), failed_trials: failures};
await writeJsonAtomic(resolve(jobDirectory, "summary.json"), summary);
console.log(JSON.stringify(summary, null, 2));
