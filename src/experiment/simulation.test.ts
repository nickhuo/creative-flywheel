import {describe, expect, test} from "bun:test";

import {audienceModelSchema} from "../audience/model";
import {renderableCreativeManifestSchema} from "../manifest";
import {assessEligibility, proposedActionSchema} from "./evaluation";
import {
  experimentRunSchema,
  experimentSummarySchema,
  prepareExperimentRun,
  summarizeExperimentEvents,
} from "./run";
import {
  createNextSimulationRun,
  createSimulatedResultSnapshot,
  simulateExperimentBatch,
} from "./simulation";

const fingerprint = "a".repeat(64);
const run = experimentRunSchema.parse({
  schema_version: 2,
  run_id: "smoke_001",
  status: "awaiting_results",
  prepared_at: "2026-09-18T12:00:00.000Z",
  seed: 42,
  audience_model: {path: "artifacts/audience/model.json", fingerprint},
  traffic: {
    users: 2000,
    batch_size: 500,
    exposures_per_user: 1,
    stop_condition: "fixed_users",
  },
  statistical_design: {
    method: "two_proportion_normal_approximation",
    analysis: "fixed_horizon",
    baseline_rate: 0.003888736389422637,
    minimum_detectable_effect: 0.01275,
    alpha: 0.05,
    power: 0.8,
    test_sidedness: "two_sided",
    required_users: 2000,
  },
  experiment: {
    name: "creative_flywheel_smoke_001",
    hypothesis: {
      statement: "A new opening hook increases installs.",
      expected_direction: "increase",
      changes: [
        {
          layer: "hook_text",
          control_value: "Your party is waiting.",
          treatment_value: "The ruins are calling",
        },
      ],
    },
    environment: "development",
    assignment_unit: "userID",
    parameter: "variant_id",
    arms: [
      {
        role: "control",
        variant_id: "g0_v00",
        manifest: {path: "manifests/g0_v00.json", fingerprint},
        allocation_percent: 50,
      },
      {
        role: "treatment",
        variant_id: "g0_v01",
        manifest: {path: "manifests/g0_v01.json", fingerprint},
        allocation_percent: 50,
      },
    ],
    primary_metric: {name: "install_rate", type: "ratio"},
    secondary_metrics: [{name: "ctr", type: "ratio"}],
  },
  statsig_experiment: {
    experiment_id: "creative_flywheel_smoke_001",
    permalink: "https://console.statsig.com/experiments/smoke_001",
    control_group_id: "control_group",
    treatment_group_id: "treatment_group",
    recorded_at: "2026-09-18T12:05:00.000Z",
    active_observed_at: "2026-09-18T12:10:00.000Z",
  },
});

describe("simulated result snapshot", () => {
  test("produces a reproducible exact 50/50 batch", async () => {
    const audienceModel = audienceModelSchema.parse(
      await Bun.file(
        new URL("../../artifacts/audience/model.json", import.meta.url),
      ).json(),
    );
    const controlManifest = renderableCreativeManifestSchema.parse(
      await Bun.file(
        new URL("../../manifests/g0_v00.json", import.meta.url),
      ).json(),
    );
    const treatmentManifest = renderableCreativeManifestSchema.parse(
      await Bun.file(
        new URL("../../manifests/g0_v01.json", import.meta.url),
      ).json(),
    );
    const batchRun = prepareExperimentRun({
      run_id: "batch_001",
      prepared_at: "2026-09-18T12:00:00.000Z",
      seed: 42,
      batch_size: 50,
      baseline_rate: 0.01,
      minimum_detectable_effect: 0.2,
      alpha: 0.05,
      power: 0.8,
      hypothesis: "A new opening hook increases installs.",
      environment: "development",
      audience_model_path: "artifacts/audience/model.json",
      audience_model: audienceModel,
      control_manifest_path: "manifests/g0_v00.json",
      control_manifest: controlManifest,
      treatment_manifest_path: "manifests/g0_v01.json",
      treatment_manifest: treatmentManifest,
    });
    const observedAt = "2026-09-18T12:01:00.000Z";
    const first = simulateExperimentBatch(
      batchRun,
      audienceModel,
      controlManifest,
      treatmentManifest,
      0,
      50,
      observedAt,
    );
    const second = simulateExperimentBatch(
      batchRun,
      audienceModel,
      controlManifest,
      treatmentManifest,
      0,
      50,
      observedAt,
    );

    expect(first).toEqual(second);
    expect(summarizeExperimentEvents(batchRun, first).arms).toEqual([
      expect.objectContaining({variant_id: "g0_v00", impressions: 25}),
      expect.objectContaining({variant_id: "g0_v01", impressions: 25}),
    ]);
    const firstSnapshot = createSimulatedResultSnapshot(
      batchRun,
      summarizeExperimentEvents(batchRun, first),
      observedAt,
    );
    expect(
      assessEligibility(batchRun, firstSnapshot, {
        previousSnapshotId: null,
        hasPendingProposal: false,
        cooldownUntil: null,
        now: observedAt,
      }),
    ).toEqual({status: "waiting", reason_codes: ["insufficient_exposures"]});

    const completedAt = "2026-09-18T12:02:00.000Z";
    const completed = first.concat(
      simulateExperimentBatch(
        batchRun,
        audienceModel,
        controlManifest,
        treatmentManifest,
        50,
        50,
        completedAt,
      ),
    );
    const finalSnapshot = createSimulatedResultSnapshot(
      batchRun,
      summarizeExperimentEvents(batchRun, completed),
      completedAt,
    );
    expect(
      assessEligibility(batchRun, finalSnapshot, {
        previousSnapshotId: null,
        hasPendingProposal: false,
        cooldownUntil: null,
        now: completedAt,
      }),
    ).toEqual({status: "ready", reason_codes: ["eligible"]});
  });

  test("normalizes the two-arm summary into decision evidence", () => {
    const summary = experimentSummarySchema.parse({
      run_id: "smoke_001",
      note: "Local reconciliation only; Statsig remains the result source.",
      users: 2000,
      impressions: 2000,
      clicks: 181,
      installs: 21,
      arms: [
        {variant_id: "g0_v00", impressions: 981, clicks: 78, installs: 8},
        {variant_id: "g0_v01", impressions: 1019, clicks: 103, installs: 13},
      ],
    });

    const snapshot = createSimulatedResultSnapshot(
      run,
      summary,
      "2026-09-19T12:00:00.000Z",
    );

    expect(snapshot.source.provider).toBe("simulator");
    expect(snapshot.exposure_groups.map(({exposures}) => exposures)).toEqual([
      981,
      1019,
    ]);
    expect(snapshot.primary_metric).toMatchObject({
      name: "install_rate",
      status: "ready",
      p_value: 0.31272738811069756,
    });
    expect(snapshot.secondary_metrics[0]).toMatchObject({
      name: "ctr",
      status: "ready",
      p_value: 0.0928087700654916,
    });
  });

  test("uses the deterministic action to select the next champion", async () => {
    const audienceModel = audienceModelSchema.parse(
      await Bun.file(
        new URL("../../artifacts/audience/model.json", import.meta.url),
      ).json(),
    );
    const controlManifest = renderableCreativeManifestSchema.parse(
      await Bun.file(
        new URL("../../manifests/g0_v00.json", import.meta.url),
      ).json(),
    );
    const treatmentManifest = renderableCreativeManifestSchema.parse(
      await Bun.file(
        new URL("../../manifests/g0_v01.json", import.meta.url),
      ).json(),
    );
    const common = {
      schema_version: 4,
      snapshot_id: "a".repeat(64),
      summary: "Prepare the next experiment.",
      rationale: "The fixed-horizon policy made this decision.",
      evidence: ["The primary metric is ready."],
      next_challenger: {
        schema_version: 1,
        snapshot_id: "a".repeat(64),
        hypothesis: "A challenge-oriented hook increases install rate.",
        rationale: "The next experiment isolates the hook layer.",
        evidence: ["The prior experiment changed only hook_text."],
        layers: {
          ...controlManifest.layers,
          hook_text: "Can you beat level 3?" as const,
        },
      },
    } as const;

    const stopAction = proposedActionSchema.parse({...common, action: "stop"});
    const promoteAction = proposedActionSchema.parse({
      ...common,
      action: "promote",
      variant_id: treatmentManifest.variant_id,
    });
    if (stopAction.action !== "stop" || promoteAction.action !== "promote") {
      throw new Error("Test actions did not preserve their discriminants.");
    }
    const stopped = createNextSimulationRun({
      next_run_id: "stop_loop_round_02",
      prepared_at: "2026-09-19T12:01:00.000Z",
      challenger_manifest_path:
        "artifacts/experiments/stop_loop_round_02/challenger.json",
      current_run: run,
      audience_model: audienceModel,
      control_manifest: controlManifest,
      treatment_manifest: treatmentManifest,
      champion_baseline_rate: 0.007,
      action: stopAction,
    });
    const promoted = createNextSimulationRun({
      next_run_id: "promote_loop_round_02",
      prepared_at: "2026-09-19T12:01:00.000Z",
      challenger_manifest_path:
        "artifacts/experiments/promote_loop_round_02/challenger.json",
      current_run: run,
      audience_model: audienceModel,
      control_manifest: controlManifest,
      treatment_manifest: treatmentManifest,
      champion_baseline_rate: 0.013,
      action: promoteAction,
    });

    expect(stopped.run.experiment.arms[0].variant_id).toBe("g0_v00");
    expect(stopped.run.statistical_design.baseline_rate).toBe(0.007);
    expect(stopped.challenger_manifest.variant_id).toBe("g1_v00");
    expect(stopped.challenger_manifest.parent_id).toBe("g0_v00");
    expect(promoted.run.experiment.arms[0].variant_id).toBe("g0_v01");
    expect(promoted.run.statistical_design.baseline_rate).toBe(0.013);
    expect(promoted.challenger_manifest.variant_id).toBe("g1_v00");
    expect(promoted.challenger_manifest.parent_id).toBe("g0_v01");
  });
});
