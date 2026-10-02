import {expect, test} from "bun:test";
import {resolve} from "node:path";

import {CHALLENGER_LAYER_STRATEGY} from "../src/agent/challenger";
import {defaultHistorySource} from "../src/agent/history-store";
import {projectRoot} from "../src/artifacts";
import {audienceModelSchema, layerCombinationKey} from "../src/audience/model";
import {summarizeComparison, type TrialReward} from "../src/benchmark/comparison";
import {proposeRandomChallenger} from "../src/benchmark/random-challenger";
import {loadSearchRounds, scoreSearch, type Reward} from "../src/benchmark/reward";
import {CREATIVE_LAYER_FIELDS, renderableCreativeManifestSchema} from "../src/manifest";

const runId = "seed_g0_v02_vs_g0_v03_20260921011211447";
const rounds = await loadSearchRounds(runId, defaultHistorySource);
const model = audienceModelSchema.parse(
  await Bun.file(resolve(projectRoot, "artifacts/audience/model.json")).json(),
);
const baseReward = scoreSearch({optimization_run_id: runId, rounds, model, budget: 9});

test("random challengers follow the layer rule, avoid tested creatives, and replay", async () => {
  const [controlManifest, treatmentManifest] = [rounds[2]!.control, rounds[2]!.treatment]
    .map((manifest) => renderableCreativeManifestSchema.parse(manifest));
  const history = rounds.slice(0, 2).map(({run, control, treatment, snapshot, action}) => ({
    run_id: run.run_id,
    hypothesis: run.experiment.hypothesis.statement,
    control_manifest: renderableCreativeManifestSchema.parse(control),
    treatment_manifest: renderableCreativeManifestSchema.parse(treatment),
    primary_metric: snapshot!.primary_metric,
    secondary_metrics: snapshot!.secondary_metrics,
    decision: action,
  }));
  const tested = new Set(
    [controlManifest!, treatmentManifest!, ...history.flatMap(
      ({control_manifest, treatment_manifest}) => [control_manifest, treatment_manifest],
    )].map(({layers}) => layerCombinationKey(layers)),
  );

  for (const decision of ["stop", "promote"] as const) {
    const champion = decision === "promote" ? treatmentManifest! : controlManifest!;
    const counts = new Set<number>();
    for (let seed = 0; seed < 40; seed += 1) {
      const run = {...rounds[2]!.run, seed};
      const propose = () => proposeRandomChallenger(
        run,
        rounds[2]!.snapshot!,
        {
          round: 3,
          max_rounds: 11,
          control_manifest: controlManifest!,
          treatment_manifest: treatmentManifest!,
          experiment_history: history,
        },
        decision,
        {model: "random-baseline"},
      );
      const {challenger} = await propose();
      const changed = CREATIVE_LAYER_FIELDS.filter(
        (field) => challenger.layers[field] !== champion.layers[field],
      ).length;
      counts.add(changed);

      expect(changed).toBeGreaterThanOrEqual(
        CHALLENGER_LAYER_STRATEGY[decision].minimum_changed_layers,
      );
      expect(changed).toBeLessThanOrEqual(
        CHALLENGER_LAYER_STRATEGY[decision].maximum_changed_layers,
      );
      expect(tested.has(layerCombinationKey(challenger.layers))).toBe(false);
      expect(challenger.snapshot_id).toBe(rounds[2]!.snapshot!.snapshot_id);
      expect((await propose()).challenger.layers).toEqual(challenger.layers);
    }
    expect([...counts].sort()).toEqual(decision === "promote" ? [1] : [2, 3]);
  }
});

function trial(
  startingPair: string,
  seed: number,
  strategy: TrialReward["strategy"],
  finalRegret: number,
): TrialReward {
  const reward: Reward = {...baseReward, final_regret: finalRegret};
  return {starting_pair: startingPair, seed, strategy, reward};
}

test("paired advantage averages starting-pair strata with equal weight", () => {
  const summary = summarizeComparison([
    trial("a", 1, "agent", 0.001),
    trial("a", 1, "random", 0.002),
    trial("a", 2, "agent", 0.001),
    trial("a", 2, "random", 0.004),
    trial("b", 1, "agent", 0.003),
    trial("b", 1, "random", 0.003),
    trial("b", 2, "agent", 0.003),
    trial("b", 2, "random", 0.003),
    trial("b", 3, "agent", 0.003),
    trial("b", 3, "random", 0.003),
    trial("b", 4, "agent", 0.002),
  ]);

  expect(summary.comparisons).toBe(5);
  expect(summary.advantage.by_starting_pair.a!.mean).toBeCloseTo(0.002, 12);
  expect(summary.advantage.by_starting_pair.b!.mean).toBeCloseTo(0, 12);
  expect(summary.advantage.mean).toBeCloseTo(0.001, 12);
  expect(summary.advantage.agent_wins).toBe(2);
  expect(summary.advantage.ties).toBe(3);
  // Stratum a has variance 2e-6 over 2 comparisons; stratum b has none.
  const standardError = Math.sqrt(2e-6 / 2) / 2;
  expect(summary.advantage.confidence_interval.upper - summary.advantage.mean)
    .toBeCloseTo(1.959963984540054 * standardError, 8);
});
