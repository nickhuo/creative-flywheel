import {z} from "zod";

import {sha256} from "../audience/model";
import {renderableCreativeLayersSchema} from "../manifest";
import {
  experimentRunIdSchema,
  SIMULATOR_CONTROL_GROUP_ID,
  SIMULATOR_TREATMENT_GROUP_ID,
  type ExperimentRun,
} from "./run";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const conciseTextSchema = z.string().trim().min(1);

const exposureGroupSchema = z
  .object({
    group_id: conciseTextSchema,
    variant_id: identifierSchema,
    role: z.enum(["control", "treatment"]),
    exposures: z.number().int().nonnegative(),
  })
  .strict()
  .readonly();

const healthIssueSchema = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_]*$/),
    level: z.enum(["warning", "error"]),
    message: conciseTextSchema.max(500),
  })
  .strict()
  .readonly();

const metricArmSchema = z
  .object({
    variant_id: identifierSchema,
    units: z.number().int().nonnegative(),
    mean: z.number().finite(),
  })
  .strict()
  .readonly();

const pendingMetricResultSchema = z
  .object({
    name: identifierSchema,
    status: z.literal("pending"),
    reason: conciseTextSchema.max(500),
  })
  .strict();

const readyMetricResultSchema = z
  .object({
    name: identifierSchema,
    status: z.literal("ready"),
    control: metricArmSchema,
    treatment: metricArmSchema,
    absolute_effect: z.number().finite(),
    relative_effect: z.number().finite().nullable(),
    confidence_interval: z
      .object({
        lower: z.number().finite(),
        upper: z.number().finite(),
        level: z.number().positive().lt(1),
      })
      .strict()
      .readonly(),
    p_value: z.number().min(0).max(1),
  })
  .strict()
  .superRefine((metric, context) => {
    if (metric.control.variant_id === metric.treatment.variant_id) {
      context.addIssue({
        code: "custom",
        message: "Metric arms must use different variants.",
        path: ["treatment", "variant_id"],
      });
    }
    if (metric.confidence_interval.lower > metric.confidence_interval.upper) {
      context.addIssue({
        code: "custom",
        message: "Confidence interval lower bound cannot exceed its upper bound.",
        path: ["confidence_interval"],
      });
    }
  });

export const metricResultSchema = z
  .discriminatedUnion("status", [
    pendingMetricResultSchema,
    readyMetricResultSchema,
  ])
  .readonly();

const resultSnapshotContentShape = {
  schema_version: z.literal(1),
  run_id: experimentRunIdSchema,
  observed_at: z.string().datetime(),
  data_through: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  source: z
    .object({
      provider: z.enum(["simulator", "statsig"]),
      experiment_id: conciseTextSchema,
    })
    .strict()
    .readonly(),
  analysis: z.enum(["fixed_horizon", "sequential"]),
  exposure_groups: z.array(exposureGroupSchema).length(2).readonly(),
  health_issues: z.array(healthIssueSchema).readonly(),
  primary_metric: metricResultSchema,
  secondary_metrics: z.array(metricResultSchema).readonly(),
};

const resultSnapshotContentSchema = z
  .object(resultSnapshotContentShape)
  .strict();

export const resultSnapshotSchema = z
  .object({
    snapshot_id: sha256Schema,
    ...resultSnapshotContentShape,
  })
  .strict()
  .superRefine((snapshot, context) => {
    const roles = snapshot.exposure_groups.map(({role}) => role);
    if (roles.filter((role) => role === "control").length !== 1) {
      context.addIssue({
        code: "custom",
        message: "A snapshot must contain exactly one control group.",
        path: ["exposure_groups"],
      });
    }
    if (roles.filter((role) => role === "treatment").length !== 1) {
      context.addIssue({
        code: "custom",
        message: "A snapshot must contain exactly one treatment group.",
        path: ["exposure_groups"],
      });
    }
    if (
      new Set(snapshot.exposure_groups.map(({variant_id}) => variant_id)).size !==
      snapshot.exposure_groups.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Exposure groups must use different variants.",
        path: ["exposure_groups"],
      });
    }

    const metricNames = [
      snapshot.primary_metric.name,
      ...snapshot.secondary_metrics.map(({name}) => name),
    ];
    if (new Set(metricNames).size !== metricNames.length) {
      context.addIssue({
        code: "custom",
        message: "Primary and secondary metric names must be unique.",
        path: ["secondary_metrics"],
      });
    }

    const controlVariant = snapshot.exposure_groups.find(
      ({role}) => role === "control",
    )?.variant_id;
    const treatmentVariant = snapshot.exposure_groups.find(
      ({role}) => role === "treatment",
    )?.variant_id;
    for (const [index, metric] of [
      snapshot.primary_metric,
      ...snapshot.secondary_metrics,
    ].entries()) {
      if (
        metric.status === "ready" &&
        (metric.control.variant_id !== controlVariant ||
          metric.treatment.variant_id !== treatmentVariant)
      ) {
        context.addIssue({
          code: "custom",
          message: "Ready metric arms must match the snapshot exposure groups.",
          path:
            index === 0 ? ["primary_metric"] : ["secondary_metrics", index - 1],
        });
      }
    }
  })
  .readonly();

const proposedActionCommonShape = {
  schema_version: z.literal(5),
  snapshot_id: sha256Schema,
  summary: conciseTextSchema.max(160),
  rationale: conciseTextSchema.max(1200),
  evidence: z.array(conciseTextSchema.max(240)).min(1).max(5).readonly(),
};

export const challengerProposalSchema = z
  .object({
    schema_version: z.literal(2),
    snapshot_id: sha256Schema,
    evaluation: z
      .object({
        interpretation: conciseTextSchema.max(800),
        learning: conciseTextSchema.max(500),
      })
      .strict()
      .readonly(),
    hypothesis: z
      .object({
        statement: conciseTextSchema.max(500),
        experiment_population: conciseTextSchema.max(300),
        audience_motivation: conciseTextSchema.max(300),
        mechanism: conciseTextSchema.max(500),
      })
      .strict()
      .readonly(),
    tradeoffs: z.array(conciseTextSchema.max(240)).min(1).max(3).readonly(),
    rationale: conciseTextSchema.max(1200),
    evidence: z.array(conciseTextSchema.max(240)).min(1).max(5).readonly(),
    layers: renderableCreativeLayersSchema,
  })
  .strict()
  .readonly();

export const proposedActionSchema = z
  .discriminatedUnion("action", [
    z
      .object({
        ...proposedActionCommonShape,
        action: z.literal("stop"),
        next_challenger: challengerProposalSchema,
      })
      .strict(),
    z
      .object({
        ...proposedActionCommonShape,
        action: z.literal("promote"),
        variant_id: identifierSchema,
        next_challenger: challengerProposalSchema,
      })
      .strict(),
    z
      .object({
        ...proposedActionCommonShape,
        action: z.literal("terminate"),
        final_experiment_action: z.enum(["stop", "promote"]),
        champion_variant_id: identifierSchema,
      })
      .strict(),
  ])
  .readonly();

export type MetricResult = z.infer<typeof metricResultSchema>;
export type ResultSnapshotInput = z.infer<typeof resultSnapshotContentSchema>;
export type ResultSnapshot = z.infer<typeof resultSnapshotSchema>;
export type ChallengerProposal = z.infer<typeof challengerProposalSchema>;
export type ProposedAction = z.infer<typeof proposedActionSchema>;

export type EligibilityReasonCode =
  | "eligible"
  | "run_not_awaiting_results"
  | "unchanged_snapshot"
  | "pending_proposal"
  | "cooldown_active"
  | "insufficient_exposures"
  | "primary_metric_pending"
  | "snapshot_run_mismatch"
  | "source_experiment_mismatch"
  | "analysis_method_mismatch"
  | "experiment_arms_mismatch"
  | "metric_definition_mismatch"
  | "health_check_failed";

export type EligibilityAssessment = Readonly<
  | {status: "ready"; reason_codes: readonly ["eligible"]}
  | {
      status: "waiting";
      reason_codes: readonly EligibilityReasonCode[];
    }
  | {
      status: "blocked";
      reason_codes: readonly EligibilityReasonCode[];
    }
>;

export type EligibilityContext = Readonly<{
  previousSnapshotId: string | null;
  hasPendingProposal: boolean;
  cooldownUntil: string | null;
  now: string;
}>;

export function createResultSnapshot(
  input: ResultSnapshotInput,
): ResultSnapshot {
  const content = resultSnapshotContentSchema.parse(input);
  return resultSnapshotSchema.parse({
    snapshot_id: sha256(
      JSON.stringify({...content, observed_at: undefined}),
    ),
    ...content,
  });
}

export function assessEligibility(
  run: ExperimentRun,
  snapshot: ResultSnapshot,
  context: EligibilityContext,
): EligibilityAssessment {
  const blocked: EligibilityReasonCode[] = [];
  const controlGroup = snapshot.exposure_groups.find(
    ({role}) => role === "control",
  );
  const treatmentGroup = snapshot.exposure_groups.find(
    ({role}) => role === "treatment",
  );
  const [controlArm, treatmentArm] = run.experiment.arms;

  if (snapshot.run_id !== run.run_id) blocked.push("snapshot_run_mismatch");
  const expectedExperimentId = snapshot.source.provider === "statsig"
    ? run.statsig_experiment?.experiment_id
    : run.experiment.name;
  if (snapshot.source.experiment_id !== expectedExperimentId) {
    blocked.push("source_experiment_mismatch");
  }
  if (snapshot.analysis !== run.statistical_design.analysis) {
    blocked.push("analysis_method_mismatch");
  }
  const expectedControlGroupId = snapshot.source.provider === "statsig"
    ? run.statsig_experiment?.control_group_id
    : SIMULATOR_CONTROL_GROUP_ID;
  const expectedTreatmentGroupId = snapshot.source.provider === "statsig"
    ? run.statsig_experiment?.treatment_group_id
    : SIMULATOR_TREATMENT_GROUP_ID;
  if (
    controlGroup?.variant_id !== controlArm.variant_id ||
    treatmentGroup?.variant_id !== treatmentArm.variant_id ||
    controlGroup?.group_id !== expectedControlGroupId ||
    treatmentGroup?.group_id !== expectedTreatmentGroupId
  ) {
    blocked.push("experiment_arms_mismatch");
  }
  if (
    snapshot.primary_metric.name !== run.experiment.primary_metric.name ||
    snapshot.secondary_metrics.length !==
      run.experiment.secondary_metrics.length ||
    snapshot.secondary_metrics.some(
      (metric, index) =>
        metric.name !== run.experiment.secondary_metrics[index]?.name,
    )
  ) {
    blocked.push("metric_definition_mismatch");
  }
  if (snapshot.health_issues.some(({level}) => level === "error")) {
    blocked.push("health_check_failed");
  }
  if (blocked.length > 0) {
    return Object.freeze({
      status: "blocked",
      reason_codes: Object.freeze(blocked),
    });
  }

  const now = Date.parse(context.now);
  if (Number.isNaN(now)) throw new RangeError("now must be a valid timestamp.");
  const waiting: EligibilityReasonCode[] = [];
  if (
    snapshot.source.provider === "statsig" &&
    run.status !== "awaiting_results"
  ) {
    waiting.push("run_not_awaiting_results");
  }
  if (context.previousSnapshotId === snapshot.snapshot_id) {
    waiting.push("unchanged_snapshot");
  }
  if (context.hasPendingProposal) waiting.push("pending_proposal");
  if (context.cooldownUntil !== null) {
    const cooldownUntil = Date.parse(context.cooldownUntil);
    if (Number.isNaN(cooldownUntil)) {
      throw new RangeError("cooldownUntil must be a valid timestamp.");
    }
    if (cooldownUntil > now) waiting.push("cooldown_active");
  }
  const totalExposures = snapshot.exposure_groups.reduce(
    (total, group) => total + group.exposures,
    0,
  );
  if (totalExposures < run.statistical_design.required_users) {
    waiting.push("insufficient_exposures");
  }
  if (snapshot.primary_metric.status !== "ready") {
    waiting.push("primary_metric_pending");
  }
  if (waiting.length > 0) {
    return Object.freeze({
      status: "waiting",
      reason_codes: Object.freeze(waiting),
    });
  }

  return Object.freeze({
    status: "ready" as const,
    reason_codes: Object.freeze(["eligible"] as const),
  });
}

export function decideExperimentAction(
  run: ExperimentRun,
  snapshot: ResultSnapshot,
): "stop" | "promote" {
  if (snapshot.primary_metric.status !== "ready") {
    throw new Error("A fixed-horizon decision requires a ready primary metric.");
  }

  return snapshot.primary_metric.absolute_effect > 0 &&
    snapshot.primary_metric.p_value <= run.statistical_design.alpha &&
    snapshot.primary_metric.confidence_interval.lower > 0
    ? "promote"
    : "stop";
}
