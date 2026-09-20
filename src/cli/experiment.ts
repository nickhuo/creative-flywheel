import {resolve} from "node:path";

import {
  appendExperimentSnapshot,
  appendObservation,
  artifactPath,
  findExperiment,
  findLatestObservation,
  indexExperimentRound,
  indexOptimizationRun,
  initializeOptimizationRun,
  openAgentLedger,
  projectRoot,
} from "../artifacts";
import {
  audienceModelSchema,
  sampleExposure,
  scoreExposure,
  type AudienceModel,
} from "../audience/model";
import {
  buildExposureContexts,
  experimentEventRecordSchema,
  experimentRunIdSchema,
  experimentRunSchema,
  prepareExperimentRun,
  summarizeExperimentEvents,
  verifyRunInputs,
  type ExperimentEventRecord,
  type ExperimentRun,
} from "../experiment/run";
import {
  StatsigConsoleClient,
  StatsigExperimentSession,
} from "../experiment/statsig";
import {
  creativeManifestSchema,
  type CreativeManifest,
} from "../manifest";

const defaultModelPath = resolve(projectRoot, "artifacts/audience/model.json");
const defaultControlPath = resolve(projectRoot, "manifests/g0_v00.json");
const defaultTreatmentPath = resolve(projectRoot, "manifests/g0_v01.json");
const defaultHypothesis =
  "Changing the opening hook increases install rate for otherwise matched creative.";
const defaultMinimumDetectableEffect = 0.0025;

const [command, ...arguments_] = Bun.argv.slice(2);

if (command === "prepare") {
  await prepareCommand(arguments_);
} else if (command === "create") {
  await createCommand(arguments_);
} else if (command === "serve") {
  await serveCommand(arguments_);
} else if (command === "inspect") {
  await inspectCommand(arguments_);
} else {
  throw new Error(
    "Usage: bun run experiment <prepare|create|serve|inspect> --run-id <id> [prepare options]",
  );
}

async function prepareCommand(arguments_: string[]): Promise<void> {
  const runId = experimentRunIdSchema.parse(readFlag(arguments_, "--run-id"));
  const modelPath = resolve(
    projectRoot,
    readOptionalFlag(arguments_, "--model") ?? defaultModelPath,
  );
  const controlPath = resolve(
    projectRoot,
    readOptionalFlag(arguments_, "--control") ?? defaultControlPath,
  );
  const treatmentPath = resolve(
    projectRoot,
    readOptionalFlag(arguments_, "--treatment") ?? defaultTreatmentPath,
  );
  const batchSize = Number(readOptionalFlag(arguments_, "--batch-size") ?? "500");
  const minimumDetectableEffect = Number(
    readOptionalFlag(arguments_, "--mde") ?? defaultMinimumDetectableEffect,
  );
  const alpha = Number(readOptionalFlag(arguments_, "--alpha") ?? "0.05");
  const power = Number(readOptionalFlag(arguments_, "--power") ?? "0.8");
  const hypothesis =
    readOptionalFlag(arguments_, "--hypothesis") ?? defaultHypothesis;
  const seed = Number(readOptionalFlag(arguments_, "--seed") ?? "42");
  const environment =
    readOptionalFlag(arguments_, "--environment") ??
    Bun.env.STATSIG_ENVIRONMENT ??
    "development";
  if (!Number.isInteger(batchSize) || batchSize < 2 || batchSize % 2 !== 0) {
    throw new RangeError("--batch-size must be a positive even integer.");
  }
  if (!Number.isSafeInteger(seed)) {
    throw new RangeError("--seed must be a safe integer.");
  }

  const audienceModel = audienceModelSchema.parse(await readJson(modelPath));
  const controlManifest = creativeManifestSchema.parse(
    await readJson(controlPath),
  );
  const treatmentManifest = creativeManifestSchema.parse(
    await readJson(treatmentPath),
  );
  const preparedAt = new Date().toISOString();
  const modeledBaselineRate = audienceModel.audience_mix.reduce(
    (total, audience) => {
      const prediction = scoreExposure(audienceModel, controlManifest, {
        impression_id: `${runId}_baseline`,
        ts_utc: preparedAt,
        user_id: `${runId}_baseline`,
        segment: audience.segment,
        os: audience.os,
        exposure_n: 1,
      });
      return total + audience.weight * (
        prediction.p_click * prediction.p_install_if_click +
        (1 - prediction.p_click) * prediction.p_install_if_no_click
      );
    },
    0,
  );
  const baselineRate = Number(
    readOptionalFlag(arguments_, "--baseline-rate") ?? modeledBaselineRate,
  );
  const run = prepareExperimentRun({
    run_id: runId,
    prepared_at: preparedAt,
    seed,
    batch_size: batchSize,
    baseline_rate: baselineRate,
    minimum_detectable_effect: minimumDetectableEffect,
    alpha,
    power,
    hypothesis,
    environment,
    audience_model_path: artifactPath(modelPath),
    control_manifest_path: artifactPath(controlPath),
    control_manifest: controlManifest,
    treatment_manifest_path: artifactPath(treatmentPath),
    treatment_manifest: treatmentManifest,
  });
  const paths = await initializeOptimizationRun(runId, run);
  const ledger = await openAgentLedger();
  try {
    indexOptimizationRun(ledger, runId, run);
  } finally {
    ledger.close();
  }

  console.log(
    JSON.stringify(
      {
        run: paths.experiments,
        status: run.status,
        statistical_design: run.statistical_design,
        traffic: run.traffic,
        arms: run.experiment.arms.map(({role, variant_id}) => ({
          role,
          variant_id,
        })),
        next: `bun run experiment create --run-id ${runId}`,
      },
      null,
      2,
    ),
  );
}

async function createCommand(arguments_: string[]): Promise<void> {
  const runId = experimentRunIdSchema.parse(readFlag(arguments_, "--run-id"));
  const location = await findExperiment(runId);
  let run = location.experiment;
  await loadAndVerifyInputs(run);
  const consoleKey = requiredEnvironmentVariable("STATSIG_CONSOLE_API_KEY");
  const client = new StatsigConsoleClient(consoleKey);
  let statsigCreateArtifact: Record<string, unknown>;

  if (run.status === "prepared" && run.statsig_experiment === null) {
    const metrics = await client.ensureExperimentMetrics(run);
    const experiment = await client.ensureExperiment(run);
    statsigCreateArtifact = {
      metrics,
      experiment: experiment.raw,
      experiment_reused: experiment.reused,
      start: null,
    };
    await appendObservation({
      optimization_run_id: location.optimization_run_id,
      experiment_run_id: run.run_id,
      round_number: location.round_number,
      type: "statsig_create",
      recorded_at: new Date().toISOString(),
      payload: statsigCreateArtifact,
    });
    run = experimentRunSchema.parse({
      ...run,
      status: "created",
      statsig_experiment: experiment.receipt,
    });
    await appendRunSnapshot(location, run);
  } else if (
    run.status === "created" &&
    run.statsig_experiment !== null &&
    run.statsig_experiment.active_observed_at === null
  ) {
    const storedObservation = await findLatestObservation(
      location.optimization_run_id,
      run.run_id,
      "statsig_create",
    );
    const storedArtifact = storedObservation?.payload;
    if (
      typeof storedArtifact !== "object" ||
      storedArtifact === null ||
      Array.isArray(storedArtifact)
    ) {
      throw new Error(`Missing Statsig create observation for ${run.run_id}.`);
    }
    statsigCreateArtifact = {...storedArtifact};
  } else {
    throw new Error(`Run ${runId} is not awaiting Statsig creation or start.`);
  }

  if (run.statsig_experiment === null) {
    throw new Error("Created run is missing its Statsig receipt.");
  }
  const statsigExperiment = run.statsig_experiment;
  const start = await client.ensureExperimentStarted(
    statsigExperiment.experiment_id,
  );
  await appendObservation({
    optimization_run_id: location.optimization_run_id,
    experiment_run_id: run.run_id,
    round_number: location.round_number,
    type: "statsig_create",
    recorded_at: new Date().toISOString(),
    payload: {...statsigCreateArtifact, start},
  });
  const startedRun = experimentRunSchema.parse({
    ...run,
    statsig_experiment: {
      ...statsigExperiment,
      active_observed_at: new Date().toISOString(),
    },
  });
  await appendRunSnapshot(location, startedRun);

  console.log(
    JSON.stringify(
      {
        run: runId,
        status: startedRun.status,
        experiment_id: statsigExperiment.experiment_id,
        permalink: statsigExperiment.permalink,
        already_active: start.already_active,
        next: `bun run experiment serve --run-id ${runId}`,
      },
      null,
      2,
    ),
  );
}

async function serveCommand(arguments_: string[]): Promise<void> {
  const runId = experimentRunIdSchema.parse(readFlag(arguments_, "--run-id"));
  const location = await findExperiment(runId);
  const run = location.experiment;
  if (
    run.status !== "created" ||
    run.statsig_experiment === null ||
    run.statsig_experiment.active_observed_at === null
  ) {
    throw new Error(`Run ${runId} is not ready to serve.`);
  }
  const pending = await findLatestObservation(
    location.optimization_run_id,
    run.run_id,
    "serve_pending",
  );
  if (pending !== null) {
    throw new Error(
      `Run ${runId} already has a pending serve batch; refusing to resend events.`,
    );
  }

  const {audienceModel, controlManifest, treatmentManifest} =
    await loadAndVerifyInputs(run);
  const manifests = new Map(
    [controlManifest, treatmentManifest].map((manifest) => [
      manifest.variant_id,
      manifest,
    ]),
  );
  const contexts = buildExposureContexts(
    run,
    audienceModel,
    new Date().toISOString(),
  );
  const session = await StatsigExperimentSession.open(
    requiredEnvironmentVariable("STATSIG_SERVER_SECRET"),
    run,
  );
  let records: ExperimentEventRecord[] = [];
  let operationError: unknown;

  try {
    records = contexts.map((context) => {
      const assignment = session.assign(context);
      const manifest = manifests.get(assignment.variant_id);
      if (manifest === undefined) {
        throw new Error(`No manifest for ${assignment.variant_id}.`);
      }
      const outcome = sampleExposure(
        audienceModel,
        manifest,
        context,
        run.seed,
      );
      return experimentEventRecordSchema.parse({
        ...outcome,
        run_id: run.run_id,
        statsig_group_name: assignment.statsig_group_name,
        statsig_rule_id: assignment.statsig_rule_id,
      });
    });
    const summary = summarizeExperimentEvents(run, records);
    if (summary.arms.some((arm) => arm.impressions === 0)) {
      throw new Error("Statsig assigned no users to one of the experiment arms.");
    }

    await appendObservation({
      optimization_run_id: location.optimization_run_id,
      experiment_run_id: run.run_id,
      round_number: location.round_number,
      type: "serve_pending",
      recorded_at: new Date().toISOString(),
      payload: {events: records, summary},
    });
    await appendRunSnapshot(
      location,
      experimentRunSchema.parse({...run, status: "serving"}),
    );
    for (const record of records) session.log(record);
  } catch (error) {
    operationError = error;
  }

  try {
    await session.close();
  } catch (error) {
    operationError ??= error;
  }
  if (operationError !== undefined) throw operationError;

  const summary = summarizeExperimentEvents(run, records);
  await appendObservation({
    optimization_run_id: location.optimization_run_id,
    experiment_run_id: run.run_id,
    round_number: location.round_number,
    type: "serve_completed",
    recorded_at: new Date().toISOString(),
    payload: {summary},
  });
  const servedRun = experimentRunSchema.parse({...run, status: "served"});
  await appendRunSnapshot(location, servedRun);

  console.log(
    JSON.stringify(
      {
        run: runId,
        status: servedRun.status,
        summary,
        next: `bun run experiment inspect --run-id ${runId}`,
      },
      null,
      2,
    ),
  );
}

async function inspectCommand(arguments_: string[]): Promise<void> {
  const runId = experimentRunIdSchema.parse(readFlag(arguments_, "--run-id"));
  const location = await findExperiment(runId);
  const run = location.experiment;
  if (
    (run.status !== "served" && run.status !== "awaiting_results") ||
    run.statsig_experiment === null
  ) {
    throw new Error(`Run ${runId} has not finished serving.`);
  }

  const client = new StatsigConsoleClient(
    requiredEnvironmentVariable("STATSIG_CONSOLE_API_KEY"),
  );
  const raw = await client.inspectExperiment(
    run.statsig_experiment.experiment_id,
  );
  await appendObservation({
    optimization_run_id: location.optimization_run_id,
    experiment_run_id: run.run_id,
    round_number: location.round_number,
    type: "statsig_inspect",
    recorded_at: new Date().toISOString(),
    payload: raw,
  });
  const inspectedRun = experimentRunSchema.parse({
    ...run,
    status: "awaiting_results",
  });
  await appendRunSnapshot(location, inspectedRun);

  console.log(
    JSON.stringify(
      {
        run: runId,
        status: inspectedRun.status,
        raw_inspection: "observations.json",
        note: "Metric normalization belongs to the next ResultSnapshot step.",
      },
      null,
      2,
    ),
  );
}

async function loadAndVerifyInputs(run: ExperimentRun): Promise<{
  audienceModel: AudienceModel;
  controlManifest: CreativeManifest;
  treatmentManifest: CreativeManifest;
}> {
  const [control, treatment] = run.experiment.arms;
  const audienceModel = audienceModelSchema.parse(
    await readJson(resolve(projectRoot, run.audience_model.path)),
  );
  const controlManifest = creativeManifestSchema.parse(
    await readJson(resolve(projectRoot, control.manifest.path)),
  );
  const treatmentManifest = creativeManifestSchema.parse(
    await readJson(resolve(projectRoot, treatment.manifest.path)),
  );
  verifyRunInputs(run, controlManifest, treatmentManifest);
  return {audienceModel, controlManifest, treatmentManifest};
}

async function readJson(path: string): Promise<unknown> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`File not found: ${path}`);
  return file.json();
}

async function appendRunSnapshot(
  location: Awaited<ReturnType<typeof findExperiment>>,
  run: ExperimentRun,
): Promise<void> {
  await appendExperimentSnapshot({
    optimization_run_id: location.optimization_run_id,
    round_number: location.round_number,
    recorded_at: new Date().toISOString(),
    experiment: run,
  });
  const ledger = await openAgentLedger();
  try {
    indexExperimentRound(
      ledger,
      location.optimization_run_id,
      location.round_number,
      run,
      new Date().toISOString(),
    );
  } finally {
    ledger.close();
  }
}

function readFlag(arguments_: string[], name: string): string {
  const value = readOptionalFlag(arguments_, name);
  if (value === undefined) throw new Error(`Missing required flag ${name}.`);
  return value;
}

function readOptionalFlag(arguments_: string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  if (index === -1) return undefined;
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}.`);
  }
  return value;
}

function requiredEnvironmentVariable(name: string): string {
  const value = Bun.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required environment variable ${name}.`);
  }
  return value;
}
