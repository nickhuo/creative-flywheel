import {resolve} from "node:path";

import {defaultHistorySource} from "../agent/history-store";
import {
  optimizationRunPlanSchema,
  projectRoot,
  runArtifactPaths,
} from "../artifacts";
import {audienceModelSchema} from "../audience/model";
import {
  DEFAULT_PROPOSAL_BUDGET,
  loadSearchRounds,
  scoreSearch,
} from "../benchmark/reward";
import {experimentRunIdSchema} from "../experiment/run";

const USAGE = "Usage: bun run reward --run-id <optimization-run-id> [--budget 10]";

const arguments_ = Bun.argv.slice(2);
const runIdIndex = arguments_.indexOf("--run-id");
const budgetIndex = arguments_.indexOf("--budget");
if (runIdIndex === -1 || arguments_[runIdIndex + 1] === undefined) {
  throw new Error(USAGE);
}
const optimizationRunId = experimentRunIdSchema.parse(arguments_[runIdIndex + 1]);
const budget = budgetIndex === -1
  ? DEFAULT_PROPOSAL_BUDGET
  : Number(arguments_[budgetIndex + 1]);
if (!Number.isSafeInteger(budget) || budget < 1) {
  throw new RangeError("--budget must be a positive integer.");
}

const plan = optimizationRunPlanSchema.parse(
  await Bun.file(runArtifactPaths(optimizationRunId).plan).json(),
);
const model = audienceModelSchema.parse(
  await Bun.file(resolve(projectRoot, plan.audience_model.path)).json(),
);
const reward = scoreSearch({
  optimization_run_id: optimizationRunId,
  rounds: await loadSearchRounds(optimizationRunId, defaultHistorySource),
  model,
  budget,
});
console.log(JSON.stringify(reward, null, 2));
