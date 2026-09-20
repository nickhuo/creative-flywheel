import {z} from "zod";

import {
  createResultSnapshot,
  type MetricResult,
  type ResultSnapshot,
  type ResultSnapshotInput,
} from "./evaluation";
import {type ExperimentRun} from "./run";
import {type StatsigExperimentObservation} from "./statsig";

const cumulativeExposuresSchema = z
  .object({
    data: z.array(
      z
        .object({
          groupID: z.string().min(1),
          groupName: z.string().min(1),
          results: z.array(
            z
              .object({
                date: z.string().min(1),
                exposures: z.number().int().nonnegative(),
              })
              .passthrough(),
          ),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const experimentEnvelopeSchema = z
  .object({
    data: z
      .object({
        sequentialTesting: z.boolean(),
      })
      .passthrough(),
  })
  .passthrough();

const diagnosticsEnvelopeSchema = z
  .object({
    data: z
      .object({
        is_realtime: z.boolean(),
      })
      .passthrough(),
  })
  .passthrough();

const intervalSchema = z
  .object({
    lower: z.number().finite(),
    upper: z.number().finite(),
  })
  .strict();

const pulseMetricSchema = z
  .object({
    metricName: z.string().min(1),
    error: z.string().nullable().optional(),
    warnings: z.array(z.string()).optional(),
    absoluteChange: z.number().finite().nullish(),
    confidenceInterval: intervalSchema.nullish(),
    testMean: z.number().finite().nullish(),
    controlMean: z.number().finite().nullish(),
    testUnits: z.number().int().nonnegative().nullish(),
    controlUnits: z.number().int().nonnegative().nullish(),
    pValue: z.number().min(0).max(1).nullish(),
  })
  .passthrough();

const pulseMetricEnvelopeSchema = z
  .object({
    data: z
      .object({
        ds: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        dimensionResults: z.array(
          z
            .object({
              dimension: z.string(),
              dimension_value: z.string(),
              metric: pulseMetricSchema.nullable(),
            })
            .passthrough(),
        ),
      })
      .passthrough(),
  })
  .passthrough();

type HealthIssue = ResultSnapshotInput["health_issues"][number];

type NormalizedMetric = {
  metric: MetricResult;
  dataThrough: string | null;
  issues: HealthIssue[];
};

const pendingErrors = new Set(["no_data", "echidna_unripe"]);
const MIN_EXPECTED_EXPOSURES_FOR_SRM = 5;
const SRM_CHI_SQUARE_THRESHOLD = 10.827566; // df=1, p=0.001

export function normalizeStatsigObservation(
  run: ExperimentRun,
  observation: StatsigExperimentObservation,
  observedAt: string,
): ResultSnapshot {
  if (run.statsig_experiment === null) {
    throw new Error("Run has no Statsig experiment.");
  }
  const receipt = run.statsig_experiment;
  const [controlArm, treatmentArm] = run.experiment.arms;
  const issues: HealthIssue[] = [];
  const experiment = experimentEnvelopeSchema.safeParse(observation.experiment);
  if (!experiment.success) {
    issues.push({
      code: "experiment_response_invalid",
      level: "error",
      message: "Statsig returned an invalid experiment response.",
    });
  }

  let exposureRows: z.infer<typeof cumulativeExposuresSchema>["data"] = [];
  if (observation.cumulative_exposures === null) {
    issues.push({
      code: "exposures_unavailable",
      level: "warning",
      message: "Statsig has not published cumulative exposures yet.",
    });
  } else {
    const exposures = cumulativeExposuresSchema.safeParse(
      observation.cumulative_exposures,
    );
    if (exposures.success) {
      exposureRows = exposures.data.data;
    } else {
      issues.push({
        code: "exposure_response_invalid",
        level: "error",
        message: "Statsig returned invalid cumulative exposure data.",
      });
    }
  }

  if (observation.diagnostics_checks === null) {
    issues.push({
      code: "diagnostics_unavailable",
      level: "warning",
      message: "Statsig experiment diagnostics are not available.",
    });
  } else {
    const diagnostics = diagnosticsEnvelopeSchema.safeParse(
      observation.diagnostics_checks,
    );
    if (!diagnostics.success) {
      issues.push({
        code: "diagnostics_response_invalid",
        level: "error",
        message: "Statsig returned invalid experiment diagnostics.",
      });
    } else if (diagnostics.data.data.is_realtime) {
      issues.push({
        code: "diagnostics_include_partial_day",
        level: "warning",
        message: "The latest Statsig diagnostics include a partial day.",
      });
    }
  }

  const exposureGroups = [
    {
      group_id: receipt.control_group_id,
      variant_id: controlArm.variant_id,
      role: "control" as const,
      exposures: latestExposure(
        exposureRows.find(
          ({groupID}) => groupID === receipt.control_group_id,
        )?.results ?? [],
      ),
    },
    {
      group_id: receipt.treatment_group_id,
      variant_id: treatmentArm.variant_id,
      role: "treatment" as const,
      exposures: latestExposure(
        exposureRows.find(
          ({groupID}) => groupID === receipt.treatment_group_id,
        )?.results ?? [],
      ),
    },
  ];
  const observedGroupIds = new Set(exposureRows.map(({groupID}) => groupID));
  for (const group of exposureGroups) {
    if (!observedGroupIds.has(group.group_id)) {
      issues.push({
        code: "exposure_group_missing",
        level: "error",
        message: `Statsig exposure data is missing group ${group.group_id}.`,
      });
    }
  }
  const hasAllExposureGroups = exposureGroups.every((group) =>
    observedGroupIds.has(group.group_id),
  );
  const totalExposures = exposureGroups.reduce(
    (total, {exposures}) => total + exposures,
    0,
  );
  const expectedPerGroup = totalExposures / 2;
  if (
    hasAllExposureGroups &&
    expectedPerGroup >= MIN_EXPECTED_EXPOSURES_FOR_SRM
  ) {
    const chiSquare = exposureGroups.reduce(
      (total, {exposures}) =>
        total + (exposures - expectedPerGroup) ** 2 / expectedPerGroup,
      0,
    );
    if (chiSquare > SRM_CHI_SQUARE_THRESHOLD) {
      issues.push({
        code: "sample_ratio_mismatch",
        level: "error",
        message: "Observed experiment allocation fails the 50/50 SRM check.",
      });
    }
  }

  const normalizedMetrics = observation.metric_results.map((metric) => ({
    role: metric.role,
    result: normalizeMetric(run, metric.name, metric.response),
  }));
  for (const {result} of normalizedMetrics) issues.push(...result.issues);
  const primaryMetric = normalizedMetrics.find(
    ({role}) => role === "primary",
  )?.result;
  if (primaryMetric === undefined) {
    throw new Error("Statsig observation is missing the primary metric.");
  }
  const secondaryMetrics = normalizedMetrics.flatMap(
    ({role, result}) => role === "secondary" ? [result.metric] : [],
  );
  const dataDates = normalizedMetrics
    .map(({result}) => result.dataThrough)
    .filter((date): date is string => date !== null)
    .sort();

  return createResultSnapshot({
    schema_version: 1,
    run_id: run.run_id,
    observed_at: observedAt,
    data_through: dataDates[0] ?? null,
    source: {
      provider: "statsig",
      experiment_id: receipt.experiment_id,
    },
    analysis:
      experiment.success && experiment.data.data.sequentialTesting
        ? "sequential"
        : "fixed_horizon",
    exposure_groups: exposureGroups,
    health_issues: issues,
    primary_metric: primaryMetric.metric,
    secondary_metrics: secondaryMetrics,
  });
}

function normalizeMetric(
  run: ExperimentRun,
  metricName: string,
  response: unknown | null,
): NormalizedMetric {
  const pending = (reason: string, issues: HealthIssue[] = []): NormalizedMetric => ({
    metric: {name: metricName, status: "pending", reason},
    dataThrough: null,
    issues,
  });
  if (response === null) {
    return pending("Statsig has not published this metric result yet.");
  }
  const parsed = pulseMetricEnvelopeSchema.safeParse(response);
  if (!parsed.success) {
    return pending("Statsig returned an invalid metric result.", [
      {
        code: "metric_response_invalid",
        level: "error",
        message: `Statsig returned invalid data for metric ${metricName}.`,
      },
    ]);
  }
  const {dimensionResults, ds} = parsed.data.data;
  const metric = dimensionResults.find(
    ({dimension, dimension_value: dimensionValue}) =>
      dimension === "!statsig_topline" && dimensionValue === "!statsig_topline",
  )?.metric;
  if (metric === undefined) {
    return pending("Statsig has not published a topline metric result yet.");
  }
  if (metric === null) {
    return {
      ...pending("Statsig has not computed this metric result yet."),
      dataThrough: ds,
    };
  }
  if (metric.metricName !== metricName) {
    return {
      ...pending("Statsig returned a result for a different metric.", [
        {
          code: "metric_name_mismatch",
          level: "error",
          message: `Expected metric ${metricName}, received ${metric.metricName}.`,
        },
      ]),
      dataThrough: ds,
    };
  }
  const issues: HealthIssue[] = (metric.warnings ?? []).map((warning) => ({
    code: "statsig_metric_warning",
    level: "warning",
    message: `${metricName}: ${warning}`.slice(0, 500),
  }));
  if (metric.error !== undefined && metric.error !== null) {
    if (!pendingErrors.has(metric.error)) {
      issues.push({
        code: "statsig_metric_error",
        level: "error",
        message: `${metricName}: ${metric.error}`.slice(0, 500),
      });
    }
    return {
      metric: {
        name: metricName,
        status: "pending",
        reason: `Statsig metric result is unavailable: ${metric.error}`,
      },
      dataThrough: ds,
      issues,
    };
  }
  const {
    confidenceInterval,
    controlMean,
    controlUnits,
    pValue,
    testMean,
    testUnits,
  } = metric;
  if (
    confidenceInterval === null ||
    confidenceInterval === undefined ||
    controlMean === null ||
    controlMean === undefined ||
    controlUnits === null ||
    controlUnits === undefined ||
    pValue === null ||
    pValue === undefined ||
    testMean === null ||
    testMean === undefined ||
    testUnits === null ||
    testUnits === undefined
  ) {
    return {
      ...pending("Statsig metric statistics are not complete yet.", issues),
      dataThrough: ds,
    };
  }
  const absoluteEffect = metric.absoluteChange ?? testMean - controlMean;
  const [controlArm, treatmentArm] = run.experiment.arms;

  return {
    metric: {
      name: metricName,
      status: "ready",
      control: {
        variant_id: controlArm.variant_id,
        units: controlUnits,
        mean: controlMean,
      },
      treatment: {
        variant_id: treatmentArm.variant_id,
        units: testUnits,
        mean: testMean,
      },
      absolute_effect: absoluteEffect,
      relative_effect:
        controlMean === 0 ? null : absoluteEffect / controlMean,
      confidence_interval: {
        ...confidenceInterval,
        level: 0.95,
      },
      p_value: pValue,
    },
    dataThrough: ds,
    issues,
  };
}

function latestExposure(
  results: ReadonlyArray<{date: string; exposures: number}>,
): number {
  return [...results].sort((left, right) =>
    left.date.localeCompare(right.date),
  ).at(-1)?.exposures ?? 0;
}
