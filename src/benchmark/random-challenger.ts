import {CHALLENGER_LAYER_STRATEGY} from "../agent/challenger";
import {type ChallengerRunner} from "../agent/orchestrator";
import {deterministicUniform, layerCombinationKey} from "../audience/model";
import {challengerProposalSchema} from "../experiment/evaluation";
import {
  CREATIVE_LAYER_FIELDS,
  CREATIVE_LAYER_VALUES,
  type CreativeLayerField,
} from "../manifest";

export const RANDOM_BASELINE_MODEL = "random-baseline";
const MAX_DRAWS = 1_000;

/**
 * Changes uniformly chosen layers to uniformly chosen other values, resampling
 * duplicates; the layer count follows the same explore/exploit rule as the agent.
 */
export const proposeRandomChallenger: ChallengerRunner = async (
  run,
  snapshot,
  context,
  decision,
) => {
  const champion = decision === "promote"
    ? context.treatment_manifest
    : context.control_manifest;
  const tested = new Set(
    [
      context.control_manifest,
      context.treatment_manifest,
      ...context.experiment_history.flatMap(
        ({control_manifest, treatment_manifest}) => [control_manifest, treatment_manifest],
      ),
    ].map(({layers}) => layerCombinationKey(layers)),
  );
  const strategy = CHALLENGER_LAYER_STRATEGY[decision];

  for (let draw = 0; draw < MAX_DRAWS; draw += 1) {
    const pick = <Value>(values: readonly Value[], label: string): Value =>
      values[
        Math.floor(
          deterministicUniform(`${run.seed}|random_challenger|${run.run_id}|${draw}|${label}`) *
            values.length,
        )
      ]!;
    const counts = Array.from(
      {length: strategy.maximum_changed_layers - strategy.minimum_changed_layers + 1},
      (_, index) => strategy.minimum_changed_layers + index,
    );
    const remaining: CreativeLayerField[] = [...CREATIVE_LAYER_FIELDS];
    const changed: CreativeLayerField[] = [];
    const count = pick(counts, "count");
    while (changed.length < count) {
      const field = pick(remaining, `field|${changed.length}`);
      remaining.splice(remaining.indexOf(field), 1);
      changed.push(field);
    }
    const layers: Record<CreativeLayerField, string> = {...champion.layers};
    for (const field of changed) {
      layers[field] = pick(
        CREATIVE_LAYER_VALUES[field].filter((value) => value !== champion.layers[field]),
        `value|${field}`,
      );
    }
    if (tested.has(layerCombinationKey(layers))) continue;

    const changes = changed.map((field) => `${field} to ${layers[field]}`).join(", ");
    return {
      challenger: challengerProposalSchema.parse({
        schema_version: 2,
        snapshot_id: snapshot.snapshot_id,
        evaluation: {
          interpretation: `The completed experiment resolved to ${decision}.`,
          learning: "The random baseline does not learn from experiment results.",
        },
        hypothesis: {
          statement: `Relative to champion ${champion.variant_id}, change ${changes}.`,
          experiment_population: "The simulated Rune Keepers audience.",
          audience_motivation: "Not modeled by the random baseline.",
          mechanism: "Uniform random replacement of champion layers.",
        },
        tradeoffs: ["The change ignores all experiment evidence."],
        rationale: `Random ${strategy.mode} baseline for paired evaluation.`,
        evidence: [`Changed ${changed.length} uniformly selected layer(s).`],
        layers,
      }),
      lastResponseId: undefined,
    };
  }
  throw new Error(`No untested random challenger near ${champion.variant_id}.`);
};
