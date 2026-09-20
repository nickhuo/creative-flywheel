import {describe, expect, test} from "bun:test";

import {assessEligibility} from "./evaluation";
import {experimentRunSchema} from "./run";
import {normalizeStatsigObservation} from "./statsig-results";
import {type StatsigExperimentObservation} from "./statsig";

const fingerprint = "a".repeat(64);
const observedAt = "2026-09-19T12:00:00.000Z";
const run = experimentRunSchema.parse({
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

function metricResponse(
  name: string,
  overrides: Record<string, unknown> = {},
): unknown {
  return {
    data: {
      ds: "2026-09-18",
      dimensionResults: [
        {
          dimension: "!statsig_topline",
          dimension_value: "!statsig_topline",
          metric: {
            metricID: `${name}::ratio`,
            metricName: name,
            directionality: "increase",
            error: null,
            warnings: [],
            absoluteChange: 0.04,
            confidenceInterval: {lower: 0.01, upper: 0.07},
            testMean: 0.14,
            controlMean: 0.1,
            testUnits: 50,
            controlUnits: 50,
            pValue: 0.02,
            ...overrides,
          },
        },
      ],
    },
  };
}

function observation(
  metricOverrides: Record<string, unknown> = {},
): StatsigExperimentObservation {
  return {
    experiment: {data: {sequentialTesting: false}},
    cumulative_exposures: {
      data: [
        {
          groupID: "control_group",
          groupName: "Control",
          results: [
            {date: "2026-09-17", exposures: 45},
            {date: "2026-09-18", exposures: 50},
          ],
        },
        {
          groupID: "treatment_group",
          groupName: "Treatment",
          results: [{date: "2026-09-18", exposures: 50}],
        },
      ],
    },
    diagnostics_checks: {data: {is_realtime: false}},
    metric_results: [
      {
        name: "install_rate",
        role: "primary",
        response: metricResponse("install_rate", metricOverrides),
      },
      {name: "ctr", role: "secondary", response: metricResponse("ctr")},
    ],
  };
}

describe("Statsig result normalization", () => {
  test("builds decision-ready fixed-horizon evidence", () => {
    const snapshot = normalizeStatsigObservation(
      run,
      observation(),
      observedAt,
    );

    expect(snapshot.data_through).toBe("2026-09-18");
    expect(snapshot.exposure_groups.map(({exposures}) => exposures)).toEqual([
      50,
      50,
    ]);
    expect(snapshot.primary_metric).toMatchObject({
      name: "install_rate",
      status: "ready",
      absolute_effect: 0.04,
    });
    if (snapshot.primary_metric.status !== "ready") {
      throw new Error("Expected a ready primary metric.");
    }
    expect(snapshot.primary_metric.relative_effect).toBeCloseTo(0.4);
    expect(
      assessEligibility(run, snapshot, {
        previousSnapshotId: null,
        hasPendingProposal: false,
        cooldownUntil: null,
        now: observedAt,
      }),
    ).toEqual({status: "ready", reason_codes: ["eligible"]});
  });

  test("keeps an unripe primary metric pending without inventing statistics", () => {
    const snapshot = normalizeStatsigObservation(
      run,
      observation({error: "echidna_unripe"}),
      observedAt,
    );

    expect(snapshot.primary_metric).toEqual({
      name: "install_rate",
      status: "pending",
      reason: "Statsig metric result is unavailable: echidna_unripe",
    });
    expect(snapshot.health_issues).toEqual([]);
  });

  test("fails closed on provider errors and missing exposure groups", () => {
    const raw = observation({
      error: "setup_incomplete",
      warnings: ["Metric source is partially loaded."],
    });
    raw.cumulative_exposures = {
      data: [
        {
          groupID: "control_group",
          groupName: "Control",
          results: [{date: "2026-09-18", exposures: 50}],
        },
      ],
    };

    const snapshot = normalizeStatsigObservation(run, raw, observedAt);

    expect(snapshot.health_issues.map(({code}) => code)).toEqual([
      "exposure_group_missing",
      "statsig_metric_warning",
      "statsig_metric_error",
    ]);
    expect(
      assessEligibility(run, snapshot, {
        previousSnapshotId: null,
        hasPendingProposal: false,
        cooldownUntil: null,
        now: observedAt,
      }).status,
    ).toBe("blocked");
  });

  test("marks a sequential provider result incompatible with this run", () => {
    const raw = observation();
    raw.experiment = {data: {sequentialTesting: true}};
    const snapshot = normalizeStatsigObservation(run, raw, observedAt);

    expect(snapshot.analysis).toBe("sequential");
    expect(
      assessEligibility(run, snapshot, {
        previousSnapshotId: null,
        hasPendingProposal: false,
        cooldownUntil: null,
        now: observedAt,
      }),
    ).toMatchObject({
      status: "blocked",
      reason_codes: ["analysis_method_mismatch"],
    });
  });

  test("blocks a statistically implausible 50/50 allocation", () => {
    const raw = observation();
    raw.cumulative_exposures = {
      data: [
        {
          groupID: "control_group",
          groupName: "Control",
          results: [{date: "2026-09-18", exposures: 80}],
        },
        {
          groupID: "treatment_group",
          groupName: "Treatment",
          results: [{date: "2026-09-18", exposures: 20}],
        },
      ],
    };

    const snapshot = normalizeStatsigObservation(run, raw, observedAt);

    expect(snapshot.health_issues).toContainEqual({
      code: "sample_ratio_mismatch",
      level: "error",
      message: "Observed experiment allocation fails the 50/50 SRM check.",
    });
  });
});
