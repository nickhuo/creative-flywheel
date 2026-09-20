import {
  deterministicUniform,
  sampleExposure,
  sha256,
  type AudienceModel,
} from "../audience/model";
import {
  renderableCreativeManifestSchema,
  type CreativeManifest,
  type RenderableCreativeManifest,
} from "../manifest";
import {
  createResultSnapshot,
  type MetricResult,
  type ProposedAction,
  type ResultSnapshot,
} from "./evaluation";
import {
  buildExposureContexts,
  experimentEventRecordSchema,
  experimentSummarySchema,
  prepareExperimentRun,
  SIMULATOR_CONTROL_GROUP_ID,
  SIMULATOR_TREATMENT_GROUP_ID,
  verifyRunInputs,
  type ExperimentEventRecord,
  type ExperimentRun,
  type ExperimentSummary,
} from "./run";
import {standardNormalCdf, standardNormalQuantile} from "./statistics";

type IteratingAction = Extract<
  ProposedAction,
  {action: "stop" | "promote"}
>;

export function createNextSimulationRun(input: {
  next_run_id: string;
  prepared_at: string;
  challenger_manifest_path: string;
  current_run: ExperimentRun;
  audience_model: AudienceModel;
  control_manifest: RenderableCreativeManifest;
  treatment_manifest: RenderableCreativeManifest;
  champion_baseline_rate: number;
  action: IteratingAction;
}): {
  run: ExperimentRun;
  champion_manifest: RenderableCreativeManifest;
  challenger_manifest: RenderableCreativeManifest;
} {
  const [controlArm, treatmentArm] = input.current_run.experiment.arms;
  const championManifest = input.action.action === "promote"
    ? input.treatment_manifest
    : input.control_manifest;
  const championArm = input.action.action === "promote"
    ? treatmentArm
    : controlArm;
  const nextGeneration = Math.max(
    input.control_manifest.generation,
    input.treatment_manifest.generation,
  ) + 1;
  const challengerManifest = renderableCreativeManifestSchema.parse({
    variant_id: `g${nextGeneration}_v00`,
    generation: nextGeneration,
    parent_id: championManifest.variant_id,
    layers: input.action.next_challenger.layers,
  });
  const run = prepareExperimentRun({
    run_id: input.next_run_id,
    prepared_at: input.prepared_at,
    seed: input.current_run.seed + 1,
    batch_size: input.current_run.traffic.batch_size,
    baseline_rate: input.champion_baseline_rate,
    minimum_detectable_effect:
      input.current_run.statistical_design.minimum_detectable_effect,
    alpha: input.current_run.statistical_design.alpha,
    power: input.current_run.statistical_design.power,
    hypothesis: input.action.next_challenger.hypothesis,
    environment: input.current_run.experiment.environment,
    audience_model_path: input.current_run.audience_model.path,
    audience_model: input.audience_model,
    control_manifest_path: championArm.manifest.path,
    control_manifest: championManifest,
    treatment_manifest_path: input.challenger_manifest_path,
    treatment_manifest: challengerManifest,
  });

  return {
    run,
    champion_manifest: championManifest,
    challenger_manifest: challengerManifest,
  };
}

export function simulateExperimentBatch(
  run: ExperimentRun,
  audienceModel: AudienceModel,
  controlManifest: CreativeManifest,
  treatmentManifest: CreativeManifest,
  start: number,
  count: number,
  observedAt: string,
): ExperimentEventRecord[] {
  verifyRunInputs(run, audienceModel, controlManifest, treatmentManifest);
  if (start % 2 !== 0 || count % 2 !== 0) {
    throw new RangeError("Simulation batches must preserve paired 50/50 blocks.");
  }
  const contexts = buildExposureContexts(run, audienceModel, observedAt, {
    start,
    count,
  });
  return contexts.map((context, index) => {
    const globalIndex = start + index;
    const pairIndex = Math.floor(globalIndex / 2);
    const controlFirst =
      deterministicUniform(`${run.seed}|assignment|${pairIndex}`) < 0.5;
    const isControl = globalIndex % 2 === 0 ? controlFirst : !controlFirst;
    const manifest = isControl ? controlManifest : treatmentManifest;
    const outcome = sampleExposure(audienceModel, manifest, context, run.seed);
    return experimentEventRecordSchema.parse({
      ...outcome,
      run_id: run.run_id,
      statsig_group_name: isControl ? "Simulator Control" : "Simulator Treatment",
      statsig_rule_id: isControl
        ? SIMULATOR_CONTROL_GROUP_ID
        : SIMULATOR_TREATMENT_GROUP_ID,
    });
  });
}

export function createSimulatedResultSnapshot(
  run: ExperimentRun,
  inputSummary: ExperimentSummary,
  observedAt: string,
): ResultSnapshot {
  const summary = experimentSummarySchema.parse(inputSummary);
  const [controlArm, treatmentArm] = run.experiment.arms;
  const control = summary.arms.find(
    ({variant_id}) => variant_id === controlArm.variant_id,
  );
  const treatment = summary.arms.find(
    ({variant_id}) => variant_id === treatmentArm.variant_id,
  );
  if (
    summary.run_id !== run.run_id ||
    control === undefined ||
    treatment === undefined ||
    summary.arms.length !== 2
  ) {
    throw new Error("Experiment summary does not match the two-arm run.");
  }
  if (
    control.impressions === 0 ||
    treatment.impressions === 0 ||
    control.impressions + treatment.impressions !== summary.impressions
  ) {
    throw new Error("Experiment summary has invalid arm impressions.");
  }

  const confidenceLevel = 1 - run.statistical_design.alpha;
  const confidenceZ = standardNormalQuantile(
    1 - run.statistical_design.alpha / 2,
  );
  const metric = (
    name: string,
    controlSuccesses: number,
    treatmentSuccesses: number,
  ): MetricResult => {
    const controlMean = controlSuccesses / control.impressions;
    const treatmentMean = treatmentSuccesses / treatment.impressions;
    const absoluteEffect = treatmentMean - controlMean;
    const intervalError = confidenceZ * Math.sqrt(
      controlMean * (1 - controlMean) / control.impressions +
        treatmentMean * (1 - treatmentMean) / treatment.impressions,
    );
    const pooledMean =
      (controlSuccesses + treatmentSuccesses) /
      (control.impressions + treatment.impressions);
    const pooledError = Math.sqrt(
      pooledMean *
        (1 - pooledMean) *
        (1 / control.impressions + 1 / treatment.impressions),
    );
    const zScore = pooledError === 0 ? 0 : absoluteEffect / pooledError;

    return {
      name,
      status: "ready",
      control: {
        variant_id: controlArm.variant_id,
        units: control.impressions,
        mean: controlMean,
      },
      treatment: {
        variant_id: treatmentArm.variant_id,
        units: treatment.impressions,
        mean: treatmentMean,
      },
      absolute_effect: absoluteEffect,
      relative_effect:
        controlMean === 0 ? null : absoluteEffect / controlMean,
      confidence_interval: {
        lower: absoluteEffect - intervalError,
        upper: absoluteEffect + intervalError,
        level: confidenceLevel,
      },
      p_value: 2 * (1 - standardNormalCdf(Math.abs(zScore))),
    };
  };
  const primaryMetric = metric(
    run.experiment.primary_metric.name,
    control.installs,
    treatment.installs,
  );
  const secondaryMetric = metric(
    run.experiment.secondary_metrics[0].name,
    control.clicks,
    treatment.clicks,
  );

  return createResultSnapshot({
    schema_version: 1,
    run_id: run.run_id,
    observed_at: observedAt,
    data_through: observedAt.slice(0, 10),
    source: {
      provider: "simulator",
      experiment_id: run.experiment.name,
      raw_fingerprint: sha256(
        JSON.stringify({
          method: "two_proportion_z_v1",
          alpha: run.statistical_design.alpha,
          summary,
        }),
      ),
    },
    analysis: run.statistical_design.analysis,
    exposure_groups: [
      {
        group_id: SIMULATOR_CONTROL_GROUP_ID,
        variant_id: controlArm.variant_id,
        role: "control",
        exposures: control.impressions,
      },
      {
        group_id: SIMULATOR_TREATMENT_GROUP_ID,
        variant_id: treatmentArm.variant_id,
        role: "treatment",
        exposures: treatment.impressions,
      },
    ],
    health_issues: [],
    primary_metric: primaryMetric,
    secondary_metrics: [secondaryMetric],
  });
}
