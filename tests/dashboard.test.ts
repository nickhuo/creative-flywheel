import {expect, test} from "bun:test";
import {mkdtemp, mkdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";

import {audienceModelSchema} from "../src/audience/model";
import {loadDashboardData} from "../src/dashboard/data";
import {createResultSnapshot} from "../src/experiment/evaluation";
import {prepareExperimentRun, type ExperimentRun} from "../src/experiment/run";
import {creativeManifestSchema} from "../src/manifest";

const projectRoot = resolve(import.meta.dir, "..");

test("dashboard loads a multi-variant optimization trajectory", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "simula-dashboard-"));
  const optimizationRunId = "dashboard_multi";
  const runDirectory = join(temporaryDirectory, optimizationRunId);

  try {
    const audienceModel = audienceModelSchema.parse(
      await Bun.file(resolve(projectRoot, "artifacts/audience/model.json")).json(),
    );
    const controlManifest = creativeManifestSchema.parse(
      await Bun.file(resolve(projectRoot, "manifests/g0_v00.json")).json(),
    );
    const firstTreatment = creativeManifestSchema.parse(
      await Bun.file(resolve(projectRoot, "manifests/g0_v01.json")).json(),
    );
    const secondTreatment = creativeManifestSchema.parse(
      await Bun.file(resolve(projectRoot, "manifests/g0_v02.json")).json(),
    );
    const firstRun = prepareExperimentRun({
      run_id: optimizationRunId,
      prepared_at: "2026-09-19T12:00:00.000Z",
      seed: 42,
      batch_size: 2,
      baseline_rate: 0.01,
      minimum_detectable_effect: 0.5,
      alpha: 0.05,
      power: 0.8,
      hypothesis: "Change the opening hook.",
      environment: "development",
      audience_model_path: "artifacts/audience/model.json",
      control_manifest_path: "manifests/g0_v00.json",
      control_manifest: controlManifest,
      treatment_manifest_path: "manifests/g0_v01.json",
      treatment_manifest: firstTreatment,
    });
    const secondRun = prepareExperimentRun({
      run_id: `${optimizationRunId}_round_02`,
      prepared_at: "2026-09-19T12:02:00.000Z",
      seed: 43,
      batch_size: 2,
      baseline_rate: 0.012,
      minimum_detectable_effect: 0.5,
      alpha: 0.05,
      power: 0.8,
      hypothesis: "Change the character while retaining the winning hook.",
      environment: "development",
      audience_model_path: "artifacts/audience/model.json",
      control_manifest_path: "manifests/g0_v01.json",
      control_manifest: firstTreatment,
      treatment_manifest_path: "manifests/g0_v02.json",
      treatment_manifest: secondTreatment,
    });
    const firstSnapshot = snapshot(firstRun, "2026-09-19T12:01:00.000Z", {
      control: 0.01,
      treatment: 0.013,
      effect: 0.003,
      lower: 0.001,
      upper: 0.005,
      pValue: 0.01,
    });
    const secondSnapshot = snapshot(secondRun, "2026-09-19T12:03:00.000Z", {
      control: 0.013,
      treatment: 0.012,
      effect: -0.001,
      lower: -0.003,
      upper: 0.001,
      pValue: 0.31,
    });
    await mkdir(runDirectory, {recursive: true});
    await mkdir(
      join(runDirectory, "creatives", secondTreatment.variant_id),
      {recursive: true},
    );
    await writeFile(
      join(
        runDirectory,
        "creatives",
        secondTreatment.variant_id,
        "video.mp4",
      ),
      new Uint8Array([0, 1, 2, 3]),
    );
    await writeFile(
      join(runDirectory, "plan.json"),
      JSON.stringify({
        schema_version: 1,
        optimization_run_id: optimizationRunId,
        created_at: firstRun.prepared_at,
        initial_experiment_run_id: firstRun.run_id,
        audience_model: firstRun.audience_model,
        initial_variants: [
          {role: "control", variant_id: controlManifest.variant_id},
          {role: "treatment", variant_id: firstTreatment.variant_id},
        ],
      }),
    );
    await writeFile(
      join(runDirectory, "experiments.json"),
      JSON.stringify([
        experimentRecord(optimizationRunId, 1, firstRun),
        experimentRecord(optimizationRunId, 2, secondRun),
      ]),
    );
    await writeFile(
      join(runDirectory, "observations.json"),
      JSON.stringify([
        observationRecord(optimizationRunId, 1, firstSnapshot),
        observationRecord(optimizationRunId, 2, secondSnapshot),
      ]),
    );
    await writeFile(
      join(runDirectory, "trajectory.json"),
      JSON.stringify({
        schema_version: 1,
        optimization_run_id: optimizationRunId,
        source: "simulator",
        status: "completed",
        max_rounds: 2,
        termination: "max_rounds",
        rounds: [
          {
            round: 1,
            run_id: firstRun.run_id,
            action: {
              schema_version: 5,
              snapshot_id: firstSnapshot.snapshot_id,
              action: "promote",
              variant_id: firstTreatment.variant_id,
              summary: "Promote the treatment and test the next challenger.",
              rationale: "The primary metric improved significantly.",
              evidence: ["The confidence interval is above zero."],
              next_challenger: {
                schema_version: 2,
                snapshot_id: firstSnapshot.snapshot_id,
                evaluation: {
                  interpretation: "The direct hook improved acquisition intent.",
                  learning: "Retain the direct hook in the next creative.",
                },
                hypothesis: {
                  statement: "Changing the character may improve trust.",
                  experiment_population: "All exposed users.",
                  audience_motivation: "Trust in a recognizable guide.",
                  mechanism: "A warmer character makes the invitation credible.",
                },
                tradeoffs: ["Character preference may vary by segment."],
                rationale: "Test one new layer while retaining the winner.",
                evidence: ["The opening hook won in round one."],
                layers: secondTreatment.layers,
              },
            },
            proposal: {status: "approved"},
          },
          {
            round: 2,
            run_id: secondRun.run_id,
            action: {
              schema_version: 5,
              snapshot_id: secondSnapshot.snapshot_id,
              action: "terminate",
              final_experiment_action: "stop",
              champion_variant_id: firstTreatment.variant_id,
              summary: "Record the final outcome and terminate optimization.",
              rationale: "Round two reached max_rounds=2.",
              evidence: ["The treatment confidence interval crosses zero."],
            },
            proposal: {status: "approved"},
          },
        ],
      }),
    );

    const dashboard = await loadDashboardData({
      project_root: projectRoot,
      runs_directory: temporaryDirectory,
      ledger_path: join(temporaryDirectory, "missing.sqlite"),
      now: () => new Date("2026-09-19T12:04:00.000Z"),
    });

    expect(dashboard).toMatchObject({
      generated_at: "2026-09-19T12:04:00.000Z",
      source: "optimization_artifacts_and_statsig",
      tracks: [
        {
          optimization_run_id: optimizationRunId,
          status: "completed",
          max_rounds: 2,
        },
      ],
    });
    expect(dashboard.tracks[0]?.rounds).toHaveLength(2);
    expect(dashboard.tracks[0]?.rounds[0]).toMatchObject({
      round: 1,
      parent_run_id: null,
      next_run_id: secondRun.run_id,
      evidence_source: "simulator",
      required_users: firstRun.statistical_design.required_users,
      batch_size: 2,
      alpha: 0.05,
      power: 0.8,
      minimum_detectable_effect: 0.5,
      decision: {
        status: "approved",
        action: {
          action: "promote",
          next_challenger: {
            evaluation: {
              learning: "Retain the direct hook in the next creative.",
            },
          },
        },
      },
    });
    expect(dashboard.tracks[0]?.rounds[1]).toMatchObject({
      round: 2,
      parent_run_id: firstRun.run_id,
      next_run_id: null,
      decision: {action: {action: "terminate"}},
    });
    expect(dashboard.tracks[0]?.rounds[1]?.arms[1]?.video_url).toBe(
      `/media/${optimizationRunId}/${secondTreatment.variant_id}.mp4`,
    );
    expect(
      new Set(
        dashboard.tracks[0]?.rounds.flatMap(({arms}) =>
          arms.map(({variant_id: variantId}) => variantId)
        ),
      ).size,
    ).toBe(3);
  } finally {
    await rm(temporaryDirectory, {recursive: true, force: true});
  }
});

function snapshot(
  run: ExperimentRun,
  observedAt: string,
  metric: {
    control: number;
    treatment: number;
    effect: number;
    lower: number;
    upper: number;
    pValue: number;
  },
) {
  const [control, treatment] = run.experiment.arms;
  return createResultSnapshot({
    schema_version: 1,
    run_id: run.run_id,
    observed_at: observedAt,
    data_through: null,
    source: {provider: "simulator", experiment_id: run.experiment.name},
    analysis: "fixed_horizon",
    exposure_groups: [
      {
        group_id: "simulator_control",
        variant_id: control.variant_id,
        role: "control",
        exposures: 50,
      },
      {
        group_id: "simulator_treatment",
        variant_id: treatment.variant_id,
        role: "treatment",
        exposures: 50,
      },
    ],
    health_issues: [],
    primary_metric: {
      name: run.experiment.primary_metric.name,
      status: "ready",
      control: {variant_id: control.variant_id, units: 50, mean: metric.control},
      treatment: {
        variant_id: treatment.variant_id,
        units: 50,
        mean: metric.treatment,
      },
      absolute_effect: metric.effect,
      relative_effect: metric.effect / metric.control,
      confidence_interval: {
        lower: metric.lower,
        upper: metric.upper,
        level: 0.95,
      },
      p_value: metric.pValue,
    },
    secondary_metrics: [],
  });
}

function experimentRecord(
  optimizationRunId: string,
  roundNumber: number,
  experiment: ExperimentRun,
) {
  return {
    schema_version: 1,
    optimization_run_id: optimizationRunId,
    experiment_run_id: experiment.run_id,
    round_number: roundNumber,
    recorded_at: experiment.prepared_at,
    experiment,
  };
}

function observationRecord(
  optimizationRunId: string,
  roundNumber: number,
  resultSnapshot: ReturnType<typeof snapshot>,
) {
  return {
    schema_version: 1,
    optimization_run_id: optimizationRunId,
    experiment_run_id: resultSnapshot.run_id,
    round_number: roundNumber,
    type: "simulator_result",
    recorded_at: resultSnapshot.observed_at,
    payload: {summary: {}, snapshot: resultSnapshot},
  };
}
