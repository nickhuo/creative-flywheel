import {z} from "zod";

import {CHALLENGER_LAYER_STRATEGY} from "../agent/challenger";
import {
  latestSnapshots,
  loadCreativeManifest,
  loadOptimizationArtifacts,
  type ExperimentHistorySource,
} from "../agent/history-store";
import {
  layerCombinationKey,
  scoreExposure,
  type AudienceModel,
} from "../audience/model";
import {
  decideExperimentAction,
  type ProposedAction,
  type ResultSnapshot,
} from "../experiment/evaluation";
import {type ExperimentRun} from "../experiment/run";
import {
  CREATIVE_LAYER_FIELDS,
  CREATIVE_LAYER_VALUES,
  renderableCreativeLayersSchema,
  type CreativeManifest,
  type RenderableCreativeManifest,
} from "../manifest";

export const DEFAULT_PROPOSAL_BUDGET = 10;

type CreativeLayers = CreativeManifest["layers"];
type RenderableLayers = RenderableCreativeManifest["layers"];

export type SearchRound = Readonly<{
  run: ExperimentRun;
  control: CreativeManifest;
  treatment: CreativeManifest;
  snapshot: ResultSnapshot | null;
  action: ProposedAction;
}>;

const rateSchema = z.number().min(0).max(1);
const scoredCreativeSchema = z
  .object({
    variant_id: z.string().trim().min(1),
    expected_install_rate: rateSchema,
  })
  .strict();

export const rewardSchema = z
  .object({
    schema_version: z.literal(1),
    optimization_run_id: z.string().trim().min(1),
    budget: z.number().int().positive(),
    valid: z.boolean(),
    violations: z.array(z.string().trim().min(1)),
    optimum: z
      .object({
        layers: renderableCreativeLayersSchema,
        expected_install_rate: rateSchema,
      })
      .strict(),
    start: scoredCreativeSchema,
    steps: z.array(
      z
        .object({
          proposal: z.number().int().positive(),
          challenger: scoredCreativeSchema,
          champion: scoredCreativeSchema,
          regret: z.number().nonnegative(),
        })
        .strict(),
    ),
    final_regret: z.number().nonnegative(),
    normalized_gain: z.number().finite(),
    mean_normalized_regret: z.number().nonnegative(),
    exposures: z.number().int().nonnegative(),
  })
  .strict();

export type Reward = z.infer<typeof rewardSchema>;

/** Probability-weighted install rate at first exposure; no sampled outcomes. */
export function expectedInstallRate(
  model: AudienceModel,
  layers: CreativeLayers,
): number {
  const totalWeight = model.audience_mix.reduce((sum, {weight}) => sum + weight, 0);
  if (Math.abs(totalWeight - 1) > 1e-9) {
    throw new Error(`Audience weights must sum to 1; received ${totalWeight}.`);
  }
  const manifest = {
    variant_id: "expected_rate",
    generation: 0,
    parent_id: null,
    layers,
  };
  return model.audience_mix.reduce((rate, {segment, os, weight}) => {
    const prediction = scoreExposure(model, manifest, {
      impression_id: "expected_rate",
      ts_utc: "1970-01-01T00:00:00.000Z",
      user_id: "expected_rate",
      segment,
      os,
      exposure_n: 1,
    });
    return rate + weight * (
      prediction.p_click * prediction.p_install_if_click +
      (1 - prediction.p_click) * prediction.p_install_if_no_click
    );
  }, 0);
}

export function findSimulatorOptimum(
  model: AudienceModel,
): {layers: RenderableLayers; expected_install_rate: number} {
  const combinations = CREATIVE_LAYER_FIELDS.reduce<Partial<RenderableLayers>[]>(
    (partials, field) =>
      partials.flatMap((partial) =>
        CREATIVE_LAYER_VALUES[field].map((value) => ({...partial, [field]: value}))
      ),
    [{}],
  ) as RenderableLayers[];
  let best = {layers: combinations[0]!, expected_install_rate: -1};
  for (const layers of combinations) {
    const rate = expectedInstallRate(model, layers);
    if (rate > best.expected_install_rate) best = {layers, expected_install_rate: rate};
  }
  return best;
}

/** Loads one optimization run in round order for `scoreSearch`. */
export async function loadSearchRounds(
  optimizationRunId: string,
  source: ExperimentHistorySource,
): Promise<SearchRound[]> {
  const artifacts = await loadOptimizationArtifacts(optimizationRunId, source);
  if (artifacts.trajectory.status !== "completed") {
    throw new Error(`Optimization run ${optimizationRunId} has not completed.`);
  }
  const actions = new Map(
    artifacts.trajectory.rounds.map(({round, action}) => [round, action]),
  );
  return Promise.all(artifacts.experiments.map(async (record, index) => {
    const action = actions.get(record.round_number);
    if (record.round_number !== index + 1 || action === undefined) {
      throw new Error(
        `Optimization run ${optimizationRunId} has no decision for round ${index + 1}.`,
      );
    }
    const run = record.experiment;
    const [controlArm, treatmentArm] = run.experiment.arms;
    const snapshot = latestSnapshots(run.run_id, artifacts.observations, new Map())
      .find(({snapshot_id}) => snapshot_id === action.snapshot_id) ?? null;
    return {
      run,
      control: await loadCreativeManifest(source, controlArm.manifest.path),
      treatment: await loadCreativeManifest(source, treatmentArm.manifest.path),
      snapshot,
      action,
    };
  }));
}

/** Verifies one terminated search and scores its champions against the optimum. */
export function scoreSearch(input: {
  optimization_run_id: string;
  rounds: readonly SearchRound[];
  model: AudienceModel;
  budget: number;
}): Reward {
  const {rounds, model, budget} = input;
  const finalAction = rounds.at(-1)?.action;
  if (finalAction?.action !== "terminate") {
    throw new Error(`Optimization run ${input.optimization_run_id} has not terminated.`);
  }

  const violations: string[] = [];
  if (rounds.length - 1 !== budget) {
    violations.push(`Expected ${budget} proposals; found ${rounds.length - 1}.`);
  }
  const tested: string[] = [];
  const champions: CreativeManifest[] = [];
  for (const [index, round] of rounds.entries()) {
    const label = `Round ${index + 1}`;
    const champion = champions.at(-1);
    if (champion !== undefined) {
      const strategy = CHALLENGER_LAYER_STRATEGY[
        rounds[index - 1]!.action.action === "promote" ? "promote" : "stop"
      ];
      const changedLayers = CREATIVE_LAYER_FIELDS.filter(
        (field) => round.treatment.layers[field] !== champion.layers[field],
      ).length;
      if (round.control.variant_id !== champion.variant_id) {
        violations.push(`${label} control is not champion ${champion.variant_id}.`);
      }
      if (round.treatment.parent_id !== champion.variant_id) {
        violations.push(`${label} challenger parent is not ${champion.variant_id}.`);
      }
      if (
        changedLayers < strategy.minimum_changed_layers ||
        changedLayers > strategy.maximum_changed_layers
      ) {
        violations.push(
          `${label} ${strategy.mode} challenger changed ${changedLayers} layer(s).`,
        );
      }
      if (!renderableCreativeLayersSchema.safeParse(round.treatment.layers).success) {
        violations.push(`${label} challenger uses layers outside the catalog.`);
      }
      if (tested.includes(layerCombinationKey(round.treatment.layers))) {
        violations.push(`${label} challenger repeats a tested creative.`);
      }
    }
    tested.push(
      layerCombinationKey(round.control.layers),
      layerCombinationKey(round.treatment.layers),
    );
    const recorded = round.action.action === "terminate"
      ? round.action.final_experiment_action
      : round.action.action;
    const decided = round.snapshot?.primary_metric.status === "ready"
      ? decideExperimentAction(round.run, round.snapshot)
      : null;
    if (decided !== recorded) {
      violations.push(
        `${label} recorded ${recorded}; the promotion rule gives ${decided ?? "no decision"}.`,
      );
    }
    champions.push(recorded === "promote" ? round.treatment : round.control);
  }
  if (finalAction.champion_variant_id !== champions.at(-1)!.variant_id) {
    violations.push(`Final champion is not ${champions.at(-1)!.variant_id}.`);
  }

  const optimum = findSimulatorOptimum(model);
  const scored = (manifest: CreativeManifest) => ({
    variant_id: manifest.variant_id,
    expected_install_rate: expectedInstallRate(model, manifest.layers),
  });
  const start = scored(champions[0]!);
  const startRegret = optimum.expected_install_rate - start.expected_install_rate;
  if (startRegret <= 0) {
    throw new Error(`Starting champion ${start.variant_id} is already optimal.`);
  }
  const steps = rounds.slice(1).map((round, index) => {
    const champion = scored(champions[index + 1]!);
    return {
      proposal: index + 1,
      challenger: scored(round.treatment),
      champion,
      regret: optimum.expected_install_rate - champion.expected_install_rate,
    };
  });
  const regrets = [startRegret, ...steps.map(({regret}) => regret)];
  const finalRegret = regrets.at(-1)!;

  return rewardSchema.parse({
    schema_version: 1,
    optimization_run_id: input.optimization_run_id,
    budget,
    valid: violations.length === 0,
    violations,
    optimum,
    start,
    steps,
    final_regret: finalRegret,
    normalized_gain: 1 - finalRegret / startRegret,
    mean_normalized_regret:
      regrets.reduce((sum, regret) => sum + regret, 0) /
      regrets.length /
      startRegret,
    exposures: rounds
      .slice(1)
      .reduce((sum, {run}) => sum + run.traffic.users, 0),
  });
}
