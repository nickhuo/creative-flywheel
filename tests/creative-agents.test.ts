import {expect, test} from "bun:test";

import {
  EXPLOIT_PROMPT,
  EXPLORE_PROMPT,
  creativePromptForDecision,
} from "../src/agent/challenger";
import {createExperimentHistoryTools} from "../src/agent/history";
import {AgentLedger} from "../src/agent/ledger";
import {evaluateSnapshot} from "../src/agent/orchestrator";
import {createResultSnapshot} from "../src/experiment/evaluation";
import {prepareExperimentRun} from "../src/experiment/run";
import {renderableCreativeManifestSchema} from "../src/manifest";

test("creative decisions route to separate agents and prompt versions", async () => {
  expect(creativePromptForDecision("stop")).toBe(EXPLORE_PROMPT);
  expect(creativePromptForDecision("promote")).toBe(EXPLOIT_PROMPT);
  expect(EXPLORE_PROMPT.instructions).toContain("two or three coordinated layers");
  expect(EXPLOIT_PROMPT.instructions).toContain("exactly one layer");
  expect(createExperimentHistoryTools().map(({name}) => name)).toEqual([
    "search_experiment_runs",
    "get_experiment_trajectory",
  ]);

  for (const scenario of [
    {
      decision: "stop" as const,
      prompt: EXPLORE_PROMPT,
      treatmentMean: 0.01,
      effect: -0.01,
      interval: {lower: -0.018, upper: -0.002, level: 0.95},
    },
    {
      decision: "promote" as const,
      prompt: EXPLOIT_PROMPT,
      treatmentMean: 0.03,
      effect: 0.01,
      interval: {lower: 0.002, upper: 0.018, level: 0.95},
    },
  ]) {
    const controlManifest = renderableCreativeManifestSchema.parse({
      variant_id: `${scenario.decision}_control`,
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
      variant_id: `${scenario.decision}_treatment`,
      layers: {
        ...controlManifest.layers,
        subject_action: "casts_spell",
        hook_text: "The ruins are calling",
      },
    });
    const run = prepareExperimentRun({
      run_id: `${scenario.decision}_routing_test`,
      prepared_at: "2026-09-20T12:00:00.000Z",
      seed: 7,
      batch_size: 2,
      baseline_rate: 0.01,
      minimum_detectable_effect: 0.5,
      alpha: 0.05,
      power: 0.8,
      hypothesis: "Test prompt routing.",
      environment: "development",
      audience_model_path: "artifacts/audience/model.json",
      control_manifest_path: `manifests/${controlManifest.variant_id}.json`,
      control_manifest: controlManifest,
      treatment_manifest_path: `manifests/${treatmentManifest.variant_id}.json`,
      treatment_manifest: treatmentManifest,
    });
    const exposuresPerArm = run.statistical_design.required_users / 2;
    const observedAt = "2026-09-20T12:01:00.000Z";
    const snapshot = createResultSnapshot({
      schema_version: 1,
      run_id: run.run_id,
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
          mean: scenario.treatmentMean,
        },
        absolute_effect: scenario.effect,
        relative_effect: scenario.effect / 0.02,
        confidence_interval: scenario.interval,
        p_value: 0.01,
      },
      secondary_metrics: [
        {
          name: "ctr_user",
          status: "ready",
          control: {
            variant_id: controlManifest.variant_id,
            units: exposuresPerArm,
            mean: 0.05,
          },
          treatment: {
            variant_id: treatmentManifest.variant_id,
            units: exposuresPerArm,
            mean: 0.05,
          },
          absolute_effect: 0,
          relative_effect: 0,
          confidence_interval: {lower: -0.01, upper: 0.01, level: 0.95},
          p_value: 1,
        },
      ],
    });
    const champion = scenario.decision === "promote"
      ? treatmentManifest
      : controlManifest;
    const challengerLayers = scenario.decision === "promote"
      ? {...champion.layers, audio_style: "low_drums" as const}
      : {
          ...champion.layers,
          background: "storm_battlefield" as const,
          subject_character: "Rex" as const,
        };
    const ledger = new AgentLedger();
    let challengerAttempts = 0;
    try {
      const outcome = await evaluateSnapshot({
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
        propose_challenger: async (
          _run,
          _snapshot,
          _context,
          decision,
          config,
        ) => {
          challengerAttempts += 1;
          expect(decision).toBe(scenario.decision);
          if (scenario.decision === "stop" && challengerAttempts === 2) {
            expect(config.retryFeedback).toContain("received 4");
            expect(config.previousResponseId).toBe("response-1");
          }
          if (scenario.decision === "stop" && challengerAttempts === 3) {
            expect(config.retryFeedback).toContain("previously tested");
            expect(config.previousResponseId).toBe("response-2");
          }
          const layers = scenario.decision === "stop" && challengerAttempts === 1
            ? {
                ...champion.layers,
                background: "storm_battlefield" as const,
                subject_character: "Rex" as const,
                subject_action: "casts_spell" as const,
                audio_style: "low_drums" as const,
              }
            : scenario.decision === "stop" && challengerAttempts === 2
              ? treatmentManifest.layers
              : challengerLayers;
          return {
            challenger: {
              schema_version: 2,
              snapshot_id: snapshot.snapshot_id,
              evaluation: {
                interpretation: "The completed experiment informs the next test.",
                learning: "Use the routed creative strategy.",
              },
              hypothesis: {
                statement: "The proposed creative will improve install rate.",
                experiment_population: "Aggregate campaign traffic.",
                audience_motivation: "A campaign-brief motivation.",
                mechanism: "The changed layers clarify the proposition.",
              },
              tradeoffs: ["The change may narrow audience appeal."],
              rationale: "Test the routed strategy with a controlled change.",
              evidence: ["The current fixed-horizon snapshot."],
              layers,
            },
            lastResponseId: `response-${challengerAttempts}`,
          };
        },
      });
      expect(outcome.proposal).toMatchObject({
        policy_version: "experiment-policy-v7",
        prompt_version: scenario.prompt.version,
      });
      expect(challengerAttempts).toBe(scenario.decision === "stop" ? 3 : 1);
    } finally {
      ledger.close();
    }
  }
});
