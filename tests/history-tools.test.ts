import {expect, test} from "bun:test";
import {randomUUID} from "node:crypto";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {EXPLORE_PROMPT} from "../src/agent/challenger";
import {
  getExperimentTrajectory,
  searchExperimentRuns,
} from "../src/agent/history";
import {AgentLedger} from "../src/agent/ledger";
import {createResultSnapshot} from "../src/experiment/evaluation";
import {prepareExperimentRun} from "../src/experiment/run";
import {renderableCreativeManifestSchema} from "../src/manifest";

test("history tools search compact evidence and expand one trajectory", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "simula-history-"));
  const runId = `history_${randomUUID().replaceAll("-", "")}`;
  const runDirectory = join(temporaryRoot, "artifacts", "runs", runId);
  const ledgerPath = join(temporaryRoot, "artifacts", "state.sqlite");
  const controlManifest = renderableCreativeManifestSchema.parse({
    variant_id: "g0_v00",
    generation: 0,
    parent_id: null,
    layers: {
      background: "moonlit_temple",
      subject_character: "Luna",
      subject_action: "draws_blade",
      hook_text: "Your party is waiting.",
      cta_text: "Install Now",
      audio_style: "warm_piano",
    },
  });
  const treatmentManifest = renderableCreativeManifestSchema.parse({
    ...controlManifest,
    variant_id: "g0_v01",
    layers: {...controlManifest.layers, hook_text: "The ruins are calling"},
  });
  const controlPath =
    `artifacts/runs/${runId}/creatives/${controlManifest.variant_id}/manifest.json`;
  const treatmentPath =
    `artifacts/runs/${runId}/creatives/${treatmentManifest.variant_id}/manifest.json`;
  const observedAt = "2026-09-20T12:00:00.000Z";
  const run = prepareExperimentRun({
    run_id: runId,
    prepared_at: "2026-09-20T11:59:00.000Z",
    seed: 42,
    batch_size: 2,
    baseline_rate: 0.01,
    minimum_detectable_effect: 0.5,
    alpha: 0.05,
    power: 0.8,
    hypothesis:
      "Test whether an exploration hook (探索钩子) improves install rate.",
    environment: "development",
    audience_model_path: "artifacts/audience/model.json",
    control_manifest_path: controlPath,
    control_manifest: controlManifest,
    treatment_manifest_path: treatmentPath,
    treatment_manifest: treatmentManifest,
  });
  const exposuresPerArm = run.statistical_design.required_users / 2;
  const snapshot = createResultSnapshot({
    schema_version: 1,
    run_id: runId,
    observed_at: observedAt,
    data_through: "2026-09-20",
    source: {provider: "simulator", experiment_id: run.experiment.name},
    analysis: "fixed_horizon",
    exposure_groups: [
      {
        group_id: "simulator_control",
        variant_id: controlManifest.variant_id,
        role: "control",
        exposures: exposuresPerArm,
      },
      {
        group_id: "simulator_treatment",
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
        mean: 0.02,
      },
      treatment: {
        variant_id: treatmentManifest.variant_id,
        units: exposuresPerArm,
        mean: 0.01,
      },
      absolute_effect: -0.01,
      relative_effect: -0.5,
      confidence_interval: {lower: -0.018, upper: -0.002, level: 0.95},
      p_value: 0.01,
    },
    secondary_metrics: [],
  });
  const action = {
    schema_version: 5 as const,
    snapshot_id: snapshot.snapshot_id,
    summary: "Retain control and terminate.",
    rationale: "The treatment did not meet the promotion rule.",
    evidence: ["The install-rate confidence interval is below zero."],
    action: "terminate" as const,
    final_experiment_action: "stop" as const,
    champion_variant_id: controlManifest.variant_id,
  };
  const proposalId = `proposal_${randomUUID().replaceAll("-", "")}`;
  const source = {
    project_root: temporaryRoot,
    runs_directory: join(temporaryRoot, "artifacts", "runs"),
    ledger_path: ledgerPath,
  };

  try {
    await mkdir(join(runDirectory, "creatives", controlManifest.variant_id), {
      recursive: true,
    });
    await mkdir(join(runDirectory, "creatives", treatmentManifest.variant_id), {
      recursive: true,
    });
    await writeJson(join(temporaryRoot, controlPath), controlManifest);
    await writeJson(join(temporaryRoot, treatmentPath), treatmentManifest);
    await writeJson(join(runDirectory, "plan.json"), {
      schema_version: 1,
      optimization_run_id: runId,
      created_at: run.prepared_at,
      initial_experiment_run_id: runId,
      audience_model: run.audience_model,
      initial_variants: [
        {role: "control", variant_id: controlManifest.variant_id},
        {role: "treatment", variant_id: treatmentManifest.variant_id},
      ],
    });
    await writeJson(join(runDirectory, "experiments.json"), [
      {
        schema_version: 1,
        optimization_run_id: runId,
        experiment_run_id: runId,
        round_number: 1,
        recorded_at: run.prepared_at,
        experiment: run,
      },
    ]);
    await writeJson(join(runDirectory, "observations.json"), [
      {
        schema_version: 1,
        optimization_run_id: runId,
        experiment_run_id: runId,
        round_number: 1,
        type: "simulator_result",
        recorded_at: observedAt,
        payload: {snapshot},
      },
    ]);
    await writeJson(join(runDirectory, "trajectory.json"), {
      schema_version: 1,
      optimization_run_id: runId,
      status: "completed",
      max_rounds: 1,
      rounds: [
        {
          round: 1,
          run_id: runId,
          action,
          proposal: {
            proposal_id: proposalId,
            policy_version: "experiment-policy-v6",
            prompt_version: EXPLORE_PROMPT.version,
            model: "deterministic",
            status: "approved",
            reviewed_by: "test",
          },
        },
      ],
    });

    await mkdir(join(temporaryRoot, "artifacts"), {recursive: true});
    const ledger = new AgentLedger(ledgerPath);
    ledger.registerOptimizationRun({
      optimization_run_id: runId,
      status: "completed",
      plan_path: `artifacts/runs/${runId}/plan.json`,
      current_round: 1,
      champion_variant_id: controlManifest.variant_id,
      created_at: run.prepared_at,
      updated_at: observedAt,
    });
    ledger.upsertExperimentRound({
      experiment_run_id: runId,
      optimization_run_id: runId,
      round_number: 1,
      experiment_path: `artifacts/runs/${runId}/experiments.json`,
      status: run.status,
      control_variant_id: controlManifest.variant_id,
      treatment_variant_id: treatmentManifest.variant_id,
      created_at: run.prepared_at,
      updated_at: observedAt,
    });
    ledger.recordSnapshot({
      snapshot_id: snapshot.snapshot_id,
      run_id: runId,
      trigger: "manual",
      observed_at: observedAt,
      recorded_at: observedAt,
      payload: snapshot,
    });
    ledger.recordProposal({
      proposal_id: proposalId,
      snapshot_id: snapshot.snapshot_id,
      action_type: action.action,
      policy_version: "experiment-policy-v6",
      prompt_version: EXPLORE_PROMPT.version,
      model: "deterministic",
      created_at: observedAt,
      payload: {proposal: action, decision_source: "deterministic"},
    });
    ledger.approveProposal(proposalId, {
      reviewed_at: observedAt,
      reviewed_by: "test",
    });
    ledger.close();

    const search = await searchExperimentRuns(
      {
        track: "seed",
        decision: "stop",
        workflow_action: "terminate",
        metric_outcome: "negative_significant",
        observed_after: "2026-09-20T05:00:00.000-07:00",
        observed_before: "2026-09-20T05:00:00.000-07:00",
        concept_query: "exploration hook",
        changed_layers: ["hook_text"],
        control_variant_id: controlManifest.variant_id,
        treatment_variant_id: treatmentManifest.variant_id,
        winner_variant_id: controlManifest.variant_id,
        evaluation_prompt_version: EXPLORE_PROMPT.version,
        policy_version: "experiment-policy-v6",
        limit: 5,
      },
      source,
    );
    expect(search).toMatchObject({
      has_more: false,
      matches: [
        {
          run_id: runId,
          track: "seed",
          changed_layers: ["hook_text"],
          decision: "stop",
          workflow_action: "terminate",
          winner_variant_id: controlManifest.variant_id,
          metric: {outcome: "negative_significant", absolute_effect: -0.01},
        },
      ],
    });
    const localizedSearch = await searchExperimentRuns(
      {concept_query: "探索钩子", limit: 1},
      source,
    );
    expect(localizedSearch.matches[0]?.run_id).toBe(runId);

    const trajectory = await getExperimentTrajectory({run_id: runId}, source);
    expect(trajectory).toMatchObject({
      optimization_run_id: runId,
      selected_run_id: runId,
      selected_round: 1,
      status: "completed",
      rounds: [
        {
          selected: true,
          track: "seed",
          decision: {action: "terminate", final_experiment_action: "stop"},
          manifests: {
            control: {variant_id: controlManifest.variant_id},
            treatment: {variant_id: treatmentManifest.variant_id},
          },
        },
      ],
      lineage: [
        {variant_id: controlManifest.variant_id, generation: 0, parent_id: null},
        {variant_id: treatmentManifest.variant_id, generation: 0, parent_id: null},
      ],
    });
  } finally {
    await rm(temporaryRoot, {recursive: true, force: true});
  }
});

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
