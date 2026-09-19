import {z} from "zod";

import {
  creativeLayersSchema,
  type CreativeManifest,
} from "../manifest";

export const CREATIVE_FIELDS = [
  "background",
  "subject_character",
  "subject_action",
  "hook_text",
  "cta_text",
  "audio_style",
] as const;

export const FATIGUE_BUCKETS = [
"1",
  "2",
  "3",
  "4-5",
  "6-10",
  "11-20",
  "21-50",
  "51+",
] as const;

export const SEGMENTS = ["casual", "companion", "rpg"] as const;
export const OPERATING_SYSTEMS = ["android", "ios"] as const;
export const FEATURE_FIELDS = [
  ...CREATIVE_FIELDS,
  "segment",
  "os",
  "fatigue_bucket",
] as const;
export type Binary = 0 | 1;
type CreativeField = (typeof CREATIVE_FIELDS)[number];
type FeatureField = (typeof FEATURE_FIELDS)[number];
export type Segment = (typeof SEGMENTS)[number];
export type OperatingSystem = (typeof OPERATING_SYSTEMS)[number];

export const featureSpecSchema = z
  .object({
    field: z.enum(FEATURE_FIELDS),
    values: z.array(z.string().min(1)).min(1),
    baseline: z.string().min(1),
  })
  .strict()
  .superRefine((spec, context) => {
    if (!spec.values.includes(spec.baseline)) {
      context.addIssue({
        code: "custom",
        message: "The baseline must be one of the feature values.",
        path: ["baseline"],
      });
    }
    if (new Set(spec.values).size !== spec.values.length) {
      context.addIssue({
        code: "custom",
        message: "Feature values must be unique.",
        path: ["values"],
      });
    }
  });

export const logisticModelSchema = z
  .object({
    feature_names: z.array(z.string().min(1)),
    intercept: z.number().finite(),
    coefficients: z.array(z.number().finite()),
    l2: z.number().positive(),
    iterations_used: z.number().int().positive(),
    converged: z.boolean(),
  })
  .strict()
  .superRefine((model, context) => {
    if (model.feature_names.length !== model.coefficients.length) {
      context.addIssue({
        code: "custom",
        message: "Feature names and coefficients must have equal lengths.",
        path: ["coefficients"],
      });
    }
  });

export const metricsSchema = z
  .object({
    observations: z.number().int().nonnegative(),
    positive_rate: z.number().min(0).max(1),
    mean_prediction: z.number().min(0).max(1),
    log_loss: z.number().nonnegative(),
    brier: z.number().nonnegative(),
    baseline_log_loss: z.number().nonnegative(),
    baseline_brier: z.number().nonnegative(),
  })
  .strict();

const splitMetricsSchema = z
  .object({
    click: metricsSchema,
    install: z
      .object({
        conditional: metricsSchema,
        marginal: metricsSchema,
        no_click: metricsSchema,
        after_click: metricsSchema,
      })
      .strict(),
  })
  .strict();

export const exposureContextSchema = z
  .object({
    impression_id: z.string().trim().min(1),
    ts_utc: z.string().trim().min(1),
    user_id: z.string().trim().min(1),
    segment: z.enum(SEGMENTS),
    os: z.enum(OPERATING_SYSTEMS),
    exposure_n: z.number().int().positive(),
  })
  .strict();

export const impressionOutcomeSchema = exposureContextSchema
  .extend({
    variant_id: z.string().trim().min(1),
    click: z.union([z.literal(0), z.literal(1)]),
    install: z.union([z.literal(0), z.literal(1)]),
  })
  .strict();

export const audienceModelSchema = z
  .object({
    schema_version: z.literal(1),
    source: z
      .object({
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        row_count: z.number().int().positive(),
        start_ts_utc: z.string().min(1),
        end_ts_utc: z.string().min(1),
      })
      .strict(),
    split: z
      .object({
        key: z.literal("user_id"),
        seed: z.number().int(),
        validation_percent: z.literal(20),
        rule: z.string().min(1),
        train_rows: z.number().int().positive(),
        validation_rows: z.number().int().positive(),
        train_users: z.number().int().positive(),
        validation_users: z.number().int().positive(),
      })
      .strict(),
    training: z
      .object({
        solver: z.literal("grouped_binomial_damped_newton"),
        objective: z.literal("mean_log_loss_plus_l2"),
        max_iterations: z.number().int().positive(),
        gradient_tolerance: z.number().positive(),
        lambda_candidates: z.array(z.number().positive()).min(1),
        click_lambda_scores: z.array(
          z.object({l2: z.number().positive(), validation_log_loss: z.number()}),
        ),
        install_lambda_scores: z.array(
          z.object({l2: z.number().positive(), validation_log_loss: z.number()}),
        ),
      })
      .strict(),
    inference: z
      .object({
        unseen_layer_value: z.literal("use_reference_level_and_report"),
        unknown_audience_value: z.literal("reject"),
        new_combination: z.literal("additive_main_effects"),
      })
      .strict(),
    features: z.array(featureSpecSchema).length(FEATURE_FIELDS.length),
    seen_layer_combinations: z.array(creativeLayersSchema).min(1),
    click_model: logisticModelSchema,
    install_model: logisticModelSchema,
    audience_mix: z.array(
      z
        .object({
          segment: z.enum(SEGMENTS),
          os: z.enum(OPERATING_SYSTEMS),
          count: z.number().int().positive(),
          weight: z.number().positive().max(1),
        })
        .strict(),
    ),
    exposure_mix: z.array(
      z
        .object({
          bucket: z.enum(FATIGUE_BUCKETS),
          count: z.number().int().positive(),
          weight: z.number().positive().max(1),
        })
        .strict(),
    ),
    metrics: z
      .object({
        train: splitMetricsSchema,
        validation: splitMetricsSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((model, context) => {
    const baseNames = featureNames(model.features);
    const expectedInstallNames = [...baseNames, "click=1"];

    if (model.click_model.feature_names.join("\0") !== baseNames.join("\0")) {
      context.addIssue({
        code: "custom",
        message: "Click model features do not match the feature specification.",
        path: ["click_model", "feature_names"],
      });
    }
    if (
      model.install_model.feature_names.join("\0") !==
      expectedInstallNames.join("\0")
    ) {
      context.addIssue({
        code: "custom",
        message: "Install model features do not match the feature specification.",
        path: ["install_model", "feature_names"],
      });
    }
  });

export type ExposureContext = z.infer<typeof exposureContextSchema>;
export type ImpressionOutcome = z.infer<typeof impressionOutcomeSchema>;
export type AudienceModel = z.infer<typeof audienceModelSchema>;
export type AudiencePrediction = {
  p_click: number;
  p_install_if_no_click: number;
  p_install_if_click: number;
  layer_coverage:
    | "combination_seen"
    | "new_combination"
    | "contains_unseen_values";
  unseen_layers: CreativeField[];
};

export type FeatureSpec = z.infer<typeof featureSpecSchema>;
export type LogisticModel = z.infer<typeof logisticModelSchema>;
export type Metrics = z.infer<typeof metricsSchema>;

export function fatigueBucket(exposure: number): (typeof FATIGUE_BUCKETS)[number] {
  if (!Number.isInteger(exposure) || exposure < 1) {
    throw new RangeError("exposure_n must be a positive integer.");
  }
  if (exposure === 1) return "1";
  if (exposure === 2) return "2";
  if (exposure === 3) return "3";
  if (exposure <= 5) return "4-5";
  if (exposure <= 10) return "6-10";
  if (exposure <= 20) return "11-20";
  if (exposure <= 50) return "21-50";
  return "51+";
}

export function deterministicUniform(key: string): number {
  return Number.parseInt(sha256(key).slice(0, 13), 16) / 0x10000000000000;
}

export function modelFingerprint(model: AudienceModel): string {
  return sha256(JSON.stringify(model));
}

export function scoreExposure(
  model: AudienceModel,
  manifest: CreativeManifest,
  context: ExposureContext,
): AudiencePrediction {
  const parsedContext = exposureContextSchema.parse(context);
  const values: Record<FeatureField, string> = {
    ...manifest.layers,
    segment: parsedContext.segment,
    os: parsedContext.os,
    fatigue_bucket: fatigueBucket(parsedContext.exposure_n),
  };
  const featureIndex = new Map(
    model.click_model.feature_names.map((name, index) => [name, index]),
  );
  const active: number[] = [];
  const unseenLayers: CreativeField[] = [];

  for (const spec of model.features) {
    const value = values[spec.field];
    if (!spec.values.includes(value)) {
      if (isCreativeField(spec.field)) {
        unseenLayers.push(spec.field);
        continue;
      }
      throw new Error(`Unknown ${spec.field}: ${value}`);
    }
    if (value !== spec.baseline) {
      const index = featureIndex.get(`${spec.field}=${value}`);
      if (index === undefined) {
        throw new Error(`Missing coefficient for ${spec.field}=${value}.`);
      }
      active.push(index);
    }
  }

  const combinationWasSeen = model.seen_layer_combinations.some(
    (layers) =>
      layerCombinationKey(layers) === layerCombinationKey(manifest.layers),
  );

  return {
    p_click: predict(model.click_model, active),
    p_install_if_no_click: predict(model.install_model, active),
    p_install_if_click: predict(model.install_model, active, true),
    layer_coverage:
      unseenLayers.length > 0
        ? "contains_unseen_values"
        : combinationWasSeen
          ? "combination_seen"
          : "new_combination",
    unseen_layers: unseenLayers,
  };
}

export function sampleExposure(
  model: AudienceModel,
  manifest: CreativeManifest,
  context: ExposureContext,
  seed: number,
): ImpressionOutcome {
  const parsedContext = exposureContextSchema.parse(context);
  const prediction = scoreExposure(model, manifest, parsedContext);
  const hash = modelFingerprint(model);
  const sampleKey = `${hash}|${seed}|${parsedContext.impression_id}|${manifest.variant_id}`;
  const click: Binary =
    deterministicUniform(`${sampleKey}|click`) < prediction.p_click ? 1 : 0;
  const installProbability = click
    ? prediction.p_install_if_click
    : prediction.p_install_if_no_click;
  const install: Binary =
    deterministicUniform(`${sampleKey}|install`) < installProbability ? 1 : 0;

  return impressionOutcomeSchema.parse({
    ...parsedContext,
    variant_id: manifest.variant_id,
    click,
    install,
  });
}

export function featureNames(specs: FeatureSpec[]): string[] {
  return specs.flatMap((spec) =>
    spec.values
      .filter((value) => value !== spec.baseline)
      .map((value) => `${spec.field}=${value}`),
  );
}

export function predict(
  model: LogisticModel,
  activeFeatures: number[],
  clicked = false,
): number {
  let linear = model.intercept;
  for (const index of activeFeatures) linear += model.coefficients[index]!;
  if (clicked) linear += model.coefficients.at(-1)!;
  return sigmoid(linear);
}

export function layerCombinationKey(
  layers: z.infer<typeof creativeLayersSchema>,
): string {
  return JSON.stringify(CREATIVE_FIELDS.map((field) => layers[field]));
}

export function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

export function sigmoid(value: number): number {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exponential = Math.exp(value);
  return exponential / (1 + exponential);
}

function isCreativeField(field: FeatureField): field is CreativeField {
  return CREATIVE_FIELDS.includes(field as CreativeField);
}
