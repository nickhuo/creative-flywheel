import {z} from "zod";

import {
  deterministicUniform,
  exposureContextSchema,
  impressionOutcomeSchema,
  modelFingerprint,
  sha256,
  type AudienceModel,
  type ExposureContext,
} from "../audience/model";
import {creativeManifestSchema, type CreativeManifest} from "../manifest";

export const INSTALL_RATE_METRIC = "install_rate";
export const CTR_METRIC = "ctr";
export const IMPRESSION_EVENT = "ad_impression";
export const CLICK_EVENT = "ad_click";
export const INSTALL_EVENT = "ad_install";

const safeIdSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, {
    message: "Use only letters, numbers, underscores, and hyphens.",
  });

export const experimentRunIdSchema = safeIdSchema;

const artifactReferenceSchema = z
  .object({
    path: z.string().trim().min(1),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const armSchema = z
  .object({
    role: z.enum(["control", "treatment"]),
    variant_id: safeIdSchema,
    manifest: artifactReferenceSchema,
    allocation_percent: z.literal(50),
  })
  .strict();

const statsigExperimentReceiptSchema = z
  .object({
    experiment_id: z.string().trim().min(1),
    permalink: z.string().url(),
    control_group_id: z.string().trim().min(1),
    treatment_group_id: z.string().trim().min(1),
    recorded_at: z.string().trim().min(1),
    active_observed_at: z.string().trim().min(1).nullable(),
  })
  .strict();

export const experimentRunSchema = z
  .object({
    schema_version: z.literal(1),
    run_id: safeIdSchema,
    status: z.enum([
      "prepared",
      "created",
      "serving",
      "served",
      "awaiting_results",
    ]),
    prepared_at: z.string().trim().min(1),
    seed: z.number().int().safe(),
    audience_model: artifactReferenceSchema,
    traffic: z
      .object({
        users: z.number().int().positive(),
        exposures_per_user: z.literal(1),
        stop_condition: z.literal("fixed_users"),
      })
      .strict(),
    experiment: z
      .object({
        name: z
          .string()
          .min(3)
          .max(100)
          .regex(/^[A-Za-z0-9_-]+$/),
        hypothesis: z.string().trim().min(1),
        environment: z.string().trim().min(1),
        target_app: z.string().trim().min(1),
        assignment_unit: z.literal("userID"),
        parameter: z.literal("variant_id"),
        arms: z.tuple([armSchema, armSchema]),
        primary_metric: z
          .object({name: z.literal(INSTALL_RATE_METRIC), type: z.literal("ratio")})
          .strict(),
        secondary_metrics: z
          .tuple([
            z
              .object({name: z.literal(CTR_METRIC), type: z.literal("ratio")})
              .strict(),
          ]),
      })
      .strict(),
    statsig_experiment: statsigExperimentReceiptSchema.nullable(),
  })
  .strict()
  .superRefine((run, context) => {
    const [control, treatment] = run.experiment.arms;
    if (control.role !== "control" || treatment.role !== "treatment") {
      context.addIssue({
        code: "custom",
        message: "The first arm must be control and the second must be treatment.",
        path: ["experiment", "arms"],
      });
    }
    if (control.variant_id === treatment.variant_id) {
      context.addIssue({
        code: "custom",
        message: "Control and treatment must use different variants.",
        path: ["experiment", "arms"],
      });
    }
    if (run.status === "prepared" && run.statsig_experiment !== null) {
      context.addIssue({
        code: "custom",
        message: "A prepared run cannot already have a Statsig experiment.",
        path: ["statsig_experiment"],
      });
    }
    if (run.status !== "prepared" && run.statsig_experiment === null) {
      context.addIssue({
        code: "custom",
        message: "A Statsig experiment is required after preparation.",
        path: ["statsig_experiment"],
      });
    }
    if (
      ["serving", "served", "awaiting_results"].includes(run.status) &&
      run.statsig_experiment?.active_observed_at === null
    ) {
      context.addIssue({
        code: "custom",
        message: "A serving run requires an active Statsig experiment.",
        path: ["statsig_experiment", "active_observed_at"],
      });
    }
  });

export const experimentEventRecordSchema = impressionOutcomeSchema
  .extend({
    run_id: safeIdSchema,
    statsig_group_name: z.string().trim().min(1),
    statsig_rule_id: z.string().trim().min(1),
  })
  .strict();

export const experimentSummarySchema = z
  .object({
    run_id: safeIdSchema,
    note: z.literal("Local reconciliation only; Statsig remains the result source."),
    users: z.number().int().positive(),
    impressions: z.number().int().positive(),
    clicks: z.number().int().nonnegative(),
    installs: z.number().int().nonnegative(),
    arms: z.array(
      z
        .object({
          variant_id: safeIdSchema,
          impressions: z.number().int().nonnegative(),
          clicks: z.number().int().nonnegative(),
          installs: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();

export type ExperimentRun = z.infer<typeof experimentRunSchema>;
export type ExperimentEventRecord = z.infer<
  typeof experimentEventRecordSchema
>;
export type ExperimentSummary = z.infer<typeof experimentSummarySchema>;
export type StatsigExperimentReceipt = z.infer<
  typeof statsigExperimentReceiptSchema
>;

type PrepareExperimentRunInput = {
  run_id: string;
  prepared_at: string;
  seed: number;
  users: number;
  environment: string;
  target_app: string;
  audience_model_path: string;
  audience_model: AudienceModel;
  control_manifest_path: string;
  control_manifest: CreativeManifest;
  treatment_manifest_path: string;
  treatment_manifest: CreativeManifest;
};

export function prepareExperimentRun(
  input: PrepareExperimentRunInput,
): ExperimentRun {
  return experimentRunSchema.parse({
    schema_version: 1,
    run_id: input.run_id,
    status: "prepared",
    prepared_at: input.prepared_at,
    seed: input.seed,
    audience_model: {
      path: input.audience_model_path,
      fingerprint: modelFingerprint(input.audience_model),
    },
    traffic: {
      users: input.users,
      exposures_per_user: 1,
      stop_condition: "fixed_users",
    },
    experiment: {
      name: `simula_${input.run_id}`,
      hypothesis:
        "Changing the opening hook changes install rate for otherwise matched creative.",
      environment: input.environment,
      target_app: input.target_app,
      assignment_unit: "userID",
      parameter: "variant_id",
      arms: [
        {
          role: "control",
          variant_id: input.control_manifest.variant_id,
          manifest: {
            path: input.control_manifest_path,
            fingerprint: manifestFingerprint(input.control_manifest),
          },
          allocation_percent: 50,
        },
        {
          role: "treatment",
          variant_id: input.treatment_manifest.variant_id,
          manifest: {
            path: input.treatment_manifest_path,
            fingerprint: manifestFingerprint(input.treatment_manifest),
          },
          allocation_percent: 50,
        },
      ],
      primary_metric: {name: INSTALL_RATE_METRIC, type: "ratio"},
      secondary_metrics: [{name: CTR_METRIC, type: "ratio"}],
    },
    statsig_experiment: null,
  });
}

export function verifyRunInputs(
  run: ExperimentRun,
  audienceModel: AudienceModel,
  controlManifest: CreativeManifest,
  treatmentManifest: CreativeManifest,
): void {
  const [control, treatment] = run.experiment.arms;
  if (modelFingerprint(audienceModel) !== run.audience_model.fingerprint) {
    throw new Error("Audience model fingerprint no longer matches run.json.");
  }
  if (
    controlManifest.variant_id !== control.variant_id ||
    manifestFingerprint(controlManifest) !== control.manifest.fingerprint
  ) {
    throw new Error("Control manifest no longer matches run.json.");
  }
  if (
    treatmentManifest.variant_id !== treatment.variant_id ||
    manifestFingerprint(treatmentManifest) !== treatment.manifest.fingerprint
  ) {
    throw new Error("Treatment manifest no longer matches run.json.");
  }
}

export function buildExposureContexts(
  run: ExperimentRun,
  audienceModel: AudienceModel,
  exposureTime: string,
): ExposureContext[] {
  if (modelFingerprint(audienceModel) !== run.audience_model.fingerprint) {
    throw new Error("Audience model fingerprint no longer matches run.json.");
  }
  if (audienceModel.audience_mix.length === 0) {
    throw new Error("Audience model has no audience distribution.");
  }

  const contexts = Array.from({length: run.traffic.users}, (_, index) => {
    const ordinal = index + 1;
    const unit = deterministicUniform(
      `${run.audience_model.fingerprint}|${run.seed}|audience|${ordinal}`,
    );
    let cumulative = 0;
    let audience = audienceModel.audience_mix.at(-1)!;
    for (const candidate of audienceModel.audience_mix) {
      cumulative += candidate.weight;
      if (unit < cumulative) {
        audience = candidate;
        break;
      }
    }
    const suffix = ordinal.toString().padStart(6, "0");
    return {
      impression_id: `${run.run_id}_impression_${suffix}`,
      ts_utc: exposureTime,
      user_id: `simula_${run.run_id}_user_${suffix}`,
      segment: audience.segment,
      os: audience.os,
      exposure_n: 1,
    };
  });

  return z.array(exposureContextSchema).parse(contexts);
}

export function summarizeExperimentEvents(
  run: ExperimentRun,
  records: ExperimentEventRecord[],
): ExperimentSummary {
  if (records.length !== run.traffic.users) {
    throw new Error(
      `Expected ${run.traffic.users} events, received ${records.length}.`,
    );
  }
  if (new Set(records.map((record) => record.user_id)).size !== records.length) {
    throw new Error("Experiment event users must be unique.");
  }
  if (
    new Set(records.map((record) => record.impression_id)).size !== records.length
  ) {
    throw new Error("Experiment impression IDs must be unique.");
  }

  const arms = run.experiment.arms.map(({variant_id}) => {
    const armRecords = records.filter(
      (record) => record.variant_id === variant_id,
    );
    return {
      variant_id,
      impressions: armRecords.length,
      clicks: armRecords.reduce((total, record) => total + record.click, 0),
      installs: armRecords.reduce((total, record) => total + record.install, 0),
    };
  });
  const knownVariants = new Set(arms.map(({variant_id}) => variant_id));
  if (records.some((record) => !knownVariants.has(record.variant_id))) {
    throw new Error("Experiment events contain an unknown variant.");
  }

  return experimentSummarySchema.parse({
    run_id: run.run_id,
    note: "Local reconciliation only; Statsig remains the result source.",
    users: records.length,
    impressions: records.length,
    clicks: records.reduce((total, record) => total + record.click, 0),
    installs: records.reduce((total, record) => total + record.install, 0),
    arms,
  });
}

function manifestFingerprint(manifest: CreativeManifest): string {
  return sha256(JSON.stringify(creativeManifestSchema.parse(manifest)));
}
