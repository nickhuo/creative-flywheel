import {describe, expect, test} from "bun:test";

import {
  assessEligibility,
  createResultSnapshot,
  decideExperimentAction,
  proposedActionSchema,
  resultSnapshotSchema,
  shouldTerminateOptimization,
  type ProposedAction,
  type ResultSnapshot,
  type ResultSnapshotInput,
} from "./evaluation";
import {experimentRunSchema, type ExperimentRun} from "./run";

const fingerprint = "a".repeat(64);
const now = "2026-09-19T12:00:00.000Z";

const run: ExperimentRun = experimentRunSchema.parse({
  schema_version: 2,
  run_id: "smoke_001",
  status: "awaiting_results",
  prepared_at: "2026-09-18T12:00:00.000Z",
  seed: 42,
  audience_model: {path: "artifacts/audience/model.json", fingerprint},
  traffic: {
    users: 100,
    batch_size: 100,
    exposures_per_user: 1,
    stop_condition: "fixed_users",
  },
  statistical_design: {
    method: "two_proportion_normal_approximation",
    analysis: "fixed_horizon",
    baseline_rate: 0.01,
    minimum_detectable_effect: 0.2,
    alpha: 0.05,
    power: 0.8,
    test_sidedness: "two_sided",
    required_users: 100,
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
    permalink:
      "https://console.statsig.com/experiment/creative_flywheel_smoke_001",
    control_group_id: "control_group",
    treatment_group_id: "treatment_group",
    recorded_at: "2026-09-18T12:05:00.000Z",
    active_observed_at: "2026-09-18T12:10:00.000Z",
  },
});

const readyMetric = {
  name: "install_rate",
  status: "ready" as const,
  control: {variant_id: "g0_v00", units: 50, mean: 0.1},
  treatment: {variant_id: "g0_v01", units: 50, mean: 0.14},
  absolute_effect: 0.04,
  relative_effect: 0.4,
  confidence_interval: {lower: 0.01, upper: 0.07, level: 0.95},
  p_value: 0.02,
};

const snapshotInput: ResultSnapshotInput = {
  schema_version: 1,
  run_id: "smoke_001",
  observed_at: now,
  data_through: "2026-09-18",
  source: {
    provider: "statsig",
    experiment_id: "creative_flywheel_smoke_001",
    raw_fingerprint: "b".repeat(64),
  },
  analysis: "fixed_horizon",
  exposure_groups: [
    {
      group_id: "control_group",
      variant_id: "g0_v00",
      role: "control",
      exposures: 50,
    },
    {
      group_id: "treatment_group",
      variant_id: "g0_v01",
      role: "treatment",
      exposures: 50,
    },
  ],
  health_issues: [],
  primary_metric: readyMetric,
  secondary_metrics: [
    {
      ...readyMetric,
      name: "ctr",
      control: {...readyMetric.control, mean: 0.2},
      treatment: {...readyMetric.treatment, mean: 0.24},
    },
  ],
};

function snapshotWith(
  overrides: Partial<ResultSnapshotInput>,
): ResultSnapshot {
  return createResultSnapshot({...snapshotInput, ...overrides});
}

const eligibleContext = {
  previousSnapshotId: null,
  hasPendingProposal: false,
  cooldownUntil: null,
  now,
} as const;

function action(actionFields: Record<string, unknown>): ProposedAction {
  return proposedActionSchema.parse({
    schema_version: 4,
    snapshot_id: createResultSnapshot(snapshotInput).snapshot_id,
    summary: "Keep collecting evidence.",
    rationale: "The fixed-horizon result supports this action.",
    evidence: ["install_rate p=0.02"],
    ...actionFields,
  });
}

const nextChallenger = {
  schema_version: 1,
  snapshot_id: createResultSnapshot(snapshotInput).snapshot_id,
  hypothesis: "A shorter hook will improve message comprehension.",
  rationale: "The current hook underperformed while other layers stay fixed.",
  evidence: ["The current experiment changed only hook_text."],
  layers: {
    background: "moonlit_temple",
    subject_character: "Luna",
    subject_action: "draws_blade",
    hook_text: "Free gems every day",
    cta_text: "Install Now",
    audio_style: "warm_piano",
  },
} as const;

describe("ResultSnapshot", () => {
  test("creates an immutable, content-addressed normalized snapshot", () => {
    const snapshot = createResultSnapshot(snapshotInput);

    expect(snapshot.snapshot_id).toMatch(/^[a-f0-9]{64}$/);
    expect(createResultSnapshot(snapshotInput).snapshot_id).toBe(
      snapshot.snapshot_id,
    );
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.source)).toBe(true);
    expect(Object.isFrozen(snapshot.exposure_groups)).toBe(true);
    expect(Object.isFrozen(snapshot.primary_metric)).toBe(true);
  });

  test("rejects changed evidence under an old snapshot ID", () => {
    const snapshot = createResultSnapshot(snapshotInput);

    expect(
      resultSnapshotSchema.safeParse({
        ...snapshot,
        observed_at: "2026-09-19T12:01:00.000Z",
      }).success,
    ).toBe(false);
  });

  test("rejects extra fields and inconsistent normalized evidence", () => {
    expect(() =>
      createResultSnapshot({
        ...snapshotInput,
        unexpected: true,
      } as ResultSnapshotInput),
    ).toThrow();
    expect(() =>
      snapshotWith({
        exposure_groups: [
          snapshotInput.exposure_groups[0],
          {...snapshotInput.exposure_groups[1], role: "control"},
        ],
      }),
    ).toThrow("exactly one control group");
    expect(() =>
      snapshotWith({
        primary_metric: {
          ...readyMetric,
          confidence_interval: {lower: 0.2, upper: 0.1, level: 0.95},
        },
      }),
    ).toThrow("lower bound");
    expect(() =>
      snapshotWith({
        primary_metric: {
          ...readyMetric,
          treatment: {...readyMetric.treatment, variant_id: "other"},
        },
      }),
    ).toThrow("must match the snapshot exposure groups");
  });
});

describe("eligibility", () => {
  test("marks complete fixed-horizon evidence ready", () => {
    expect(
      assessEligibility(run, createResultSnapshot(snapshotInput), eligibleContext),
    ).toEqual({status: "ready", reason_codes: ["eligible"]});
  });

  test("reports every waiting gate in deterministic order", () => {
    const pendingSnapshot = snapshotWith({
      exposure_groups: snapshotInput.exposure_groups.map((group) => ({
        ...group,
        exposures: 20,
      })) as ResultSnapshotInput["exposure_groups"],
      primary_metric: {
        name: "install_rate",
        status: "pending",
        reason: "Statsig has not computed the metric yet.",
      },
    });
    const servingRun = experimentRunSchema.parse({...run, status: "serving"});

    expect(
      assessEligibility(servingRun, pendingSnapshot, {
        previousSnapshotId: pendingSnapshot.snapshot_id,
        hasPendingProposal: true,
        cooldownUntil: "2026-09-19T13:00:00.000Z",
        now,
      }),
    ).toEqual({
      status: "waiting",
      reason_codes: [
        "run_not_awaiting_results",
        "unchanged_snapshot",
        "pending_proposal",
        "cooldown_active",
        "insufficient_exposures",
        "primary_metric_pending",
      ],
    });
  });

  test("treats an expired cooldown and health warnings as eligible", () => {
    const snapshot = snapshotWith({
      health_issues: [
        {
          code: "low_power_warning",
          level: "warning",
          message: "Power is lower than recommended but results are available.",
        },
      ],
    });

    expect(
      assessEligibility(run, snapshot, {
        ...eligibleContext,
        cooldownUntil: "2026-09-19T11:59:59.000Z",
      }),
    ).toEqual({status: "ready", reason_codes: ["eligible"]});
  });

  test("blocks errors and evidence that does not belong to the run", () => {
    const mismatched = snapshotWith({
      run_id: "smoke_002",
      source: {
        ...snapshotInput.source,
        experiment_id: "creative_flywheel_smoke_002",
      },
      analysis: "sequential",
      exposure_groups: [
        {
          ...snapshotInput.exposure_groups[0],
          group_id: "other_control",
          variant_id: "g1_v00",
        },
        {
          ...snapshotInput.exposure_groups[1],
          group_id: "other_treatment",
          variant_id: "g1_v01",
        },
      ],
      health_issues: [
        {
          code: "sample_ratio_mismatch",
          level: "error",
          message: "Observed allocation differs from the configured split.",
        },
      ],
      primary_metric: {
        name: "other_primary",
        status: "pending",
        reason: "Not ready.",
      },
      secondary_metrics: [],
    });

    expect(assessEligibility(run, mismatched, eligibleContext)).toEqual({
      status: "blocked",
      reason_codes: [
        "snapshot_run_mismatch",
        "source_experiment_mismatch",
        "analysis_method_mismatch",
        "experiment_arms_mismatch",
        "metric_definition_mismatch",
        "health_check_failed",
      ],
    });
  });

  test("rejects invalid evaluation timestamps", () => {
    const snapshot = createResultSnapshot(snapshotInput);

    expect(() =>
      assessEligibility(run, snapshot, {...eligibleContext, now: "invalid"}),
    ).toThrow("now must be a valid timestamp");
    expect(() =>
      assessEligibility(run, snapshot, {
        ...eligibleContext,
        cooldownUntil: "invalid",
      }),
    ).toThrow("cooldownUntil must be a valid timestamp");
  });
});

describe("ProposedAction policy", () => {
  test("accepts the complete fixed-horizon action space", () => {
    const actions = [
      action({action: "stop", next_challenger: nextChallenger}),
      action({
        action: "promote",
        variant_id: "g0_v01",
        next_challenger: nextChallenger,
      }),
      action({
        action: "terminate",
        final_experiment_action: "stop",
        champion_variant_id: "g0_v00",
      }),
    ];

    expect(actions.map(({action}) => action)).toEqual([
      "stop",
      "promote",
      "terminate",
    ]);
  });

  test("strictly rejects missing, extra, and action-specific fields", () => {
    const common = {
      schema_version: 4,
      snapshot_id: createResultSnapshot(snapshotInput).snapshot_id,
      summary: "Promote the treatment.",
      rationale: "The primary metric improved.",
      evidence: ["install_rate p=0.02"],
    };

    expect(
      proposedActionSchema.safeParse({
        ...common,
        action: "promote",
        variant_id: "g0_v01",
      }).success,
    ).toBe(false);
    expect(
      proposedActionSchema.safeParse({
        ...common,
        action: "stop",
        variant_id: "g0_v01",
      }).success,
    ).toBe(false);
    expect(
      proposedActionSchema.safeParse({
        ...common,
        action: "terminate",
        final_experiment_action: "stop",
        champion_variant_id: "g0_v00",
        next_challenger: nextChallenger,
      }).success,
    ).toBe(false);
    expect(
      proposedActionSchema.safeParse({
        ...common,
        action: "stop",
        next_challenger: nextChallenger,
        unexpected: true,
      }).success,
    ).toBe(false);
  });
});

describe("fixed-horizon experiment decision", () => {
  test("promotes only a significant positive treatment", () => {
    const positive = createResultSnapshot(snapshotInput);
    const inconclusive = snapshotWith({
      primary_metric: {
        ...readyMetric,
        absolute_effect: 0.01,
        confidence_interval: {lower: -0.02, upper: 0.04, level: 0.95},
        p_value: 0.5,
      },
    });

    expect(decideExperimentAction(run, positive)).toBe("promote");
    expect(decideExperimentAction(run, inconclusive)).toBe("stop");
  });

  test("terminates the optimization only after the configured final round", () => {
    expect(shouldTerminateOptimization(2, 3)).toBe(false);
    expect(shouldTerminateOptimization(3, 3)).toBe(true);
  });
});
