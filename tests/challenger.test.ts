import {expect, test} from "bun:test";
import {readdir} from "node:fs/promises";
import {join, resolve} from "node:path";

import {CHALLENGER_LAYER_STRATEGY} from "../src/agent/challenger";
import {AgentLedger} from "../src/agent/ledger";
import {evaluateSnapshot} from "../src/agent/orchestrator";
import {createResultSnapshot} from "../src/experiment/evaluation";
import {
  prepareExperimentRun,
  SIMULATOR_CONTROL_GROUP_ID,
  SIMULATOR_TREATMENT_GROUP_ID,
} from "../src/experiment/run";
import {
  CREATIVE_LAYER_FIELDS,
  renderableCreativeManifestSchema,
} from "../src/manifest";

const projectRoot = resolve(import.meta.dir, "..");

test("generation zero has eight renderable variants across at least three layers", async () => {
  const manifestNames = (await readdir(join(projectRoot, "manifests")))
    .filter((name) => /^g0_v\d+\.json$/.test(name))
    .sort();
  const manifests = await Promise.all(
    manifestNames.map(async (name) =>
      renderableCreativeManifestSchema.parse(
        await Bun.file(join(projectRoot, "manifests", name)).json(),
      )
    ),
  );

  expect(manifests.length).toBeGreaterThanOrEqual(8);
  expect(new Set(manifests.map(({variant_id}) => variant_id)).size).toBe(
    manifests.length,
  );
  expect(
    manifests.every(
      ({generation, parent_id}) => generation === 0 && parent_id === null,
    ),
  ).toBe(true);
  const varyingLayers = CREATIVE_LAYER_FIELDS.filter(
    (layer) => new Set(manifests.map(({layers}) => layers[layer])).size > 1,
  );
  expect(varyingLayers.length).toBeGreaterThanOrEqual(3);
});

test("challenger strategy explores after stop and exploits after promote", () => {
  expect(CHALLENGER_LAYER_STRATEGY.stop).toMatchObject({
    mode: "explore",
    minimum_changed_layers: 2,
    maximum_changed_layers: 3,
  });
  expect(CHALLENGER_LAYER_STRATEGY.promote).toMatchObject({
    mode: "exploit",
    minimum_changed_layers: 1,
    maximum_changed_layers: 1,
  });
});

test("orchestrator rejects a single-layer exploration after stop", async () => {
  const controlManifest = renderableCreativeManifestSchema.parse(
    await Bun.file(join(projectRoot, "manifests/g0_v00.json")).json(),
  );
  const treatmentManifest = renderableCreativeManifestSchema.parse(
    await Bun.file(join(projectRoot, "manifests/g0_v01.json")).json(),
  );
  const observedAt = "2026-09-20T00:00:00.000Z";
  const run = prepareExperimentRun({
    run_id: "challenger_strategy_test",
    prepared_at: observedAt,
    seed: 42,
    batch_size: 2,
    baseline_rate: 0.01,
    minimum_detectable_effect: 0.5,
    alpha: 0.05,
    power: 0.8,
    hypothesis: "Test a new hook.",
    environment: "development",
    audience_model_path: "artifacts/audience/model.json",
    control_manifest_path: "manifests/g0_v00.json",
    control_manifest: controlManifest,
    treatment_manifest_path: "manifests/g0_v01.json",
    treatment_manifest: treatmentManifest,
  });
  const exposuresPerArm = run.traffic.users / 2;
  const snapshot = createResultSnapshot({
    schema_version: 1,
    run_id: run.run_id,
    observed_at: observedAt,
    data_through: null,
    source: {provider: "simulator", experiment_id: run.experiment.name},
    analysis: "fixed_horizon",
    exposure_groups: [
      {
        group_id: SIMULATOR_CONTROL_GROUP_ID,
        variant_id: controlManifest.variant_id,
        role: "control",
        exposures: exposuresPerArm,
      },
      {
        group_id: SIMULATOR_TREATMENT_GROUP_ID,
        variant_id: treatmentManifest.variant_id,
        role: "treatment",
        exposures: exposuresPerArm,
      },
    ],
    health_issues: [],
    primary_metric: {
      name: "install_rate_user",
      status: "ready",
      control: {
        variant_id: controlManifest.variant_id,
        units: exposuresPerArm,
        mean: 0.1,
      },
      treatment: {
        variant_id: treatmentManifest.variant_id,
        units: exposuresPerArm,
        mean: 0.05,
      },
      absolute_effect: -0.05,
      relative_effect: -0.5,
      confidence_interval: {lower: -0.1, upper: 0, level: 0.95},
      p_value: 0.2,
    },
    secondary_metrics: [
      {name: "ctr_user", status: "pending", reason: "Not needed for test."},
    ],
  });
  const ledger = new AgentLedger();

  try {
    await expect(
      evaluateSnapshot({
        run,
        snapshot,
        trigger: "manual",
        observed_at: observedAt,
        model: "test-model",
        ledger,
        challenger_context: {
          round: 1,
          max_rounds: 2,
          control_manifest: controlManifest,
          treatment_manifest: treatmentManifest,
          experiment_history: [],
        },
        propose_challenger: async () => ({
          challenger: {
            schema_version: 2,
            snapshot_id: snapshot.snapshot_id,
            evaluation: {
              interpretation: "The treatment was not promoted.",
              learning: "A different creative direction is needed.",
            },
            hypothesis: {
              statement: "A different hook will improve install rate.",
              experiment_population: "Rune Keepers ad viewers.",
              audience_motivation: "Challenge and mastery.",
              mechanism: "A direct challenge creates urgency.",
            },
            tradeoffs: ["The hook may narrow audience appeal."],
            rationale: "Test a clearer challenge.",
            evidence: ["The previous treatment was not promoted."],
            layers: treatmentManifest.layers,
          },
          lastResponseId: undefined,
        }),
      }),
    ).rejects.toThrow("explore challenger must change 2-3 layer(s)");
  } finally {
    ledger.close();
  }
});
