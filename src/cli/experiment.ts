import {mkdir, rename, writeFile} from "node:fs/promises";
import {dirname, relative, resolve} from "node:path";

import {
  audienceModelSchema,
  sampleExposure,
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

const projectRoot = resolve(import.meta.dir, "../..");
const defaultModelPath = resolve(projectRoot, "artifacts/audience/model.json");
const defaultControlPath = resolve(projectRoot, "manifests/g0_v00.json");
const defaultTreatmentPath = resolve(projectRoot, "manifests/g0_v01.json");

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
  const targetApp =
    readOptionalFlag(arguments_, "--target-app") ?? Bun.env.STATSIG_TARGET_APP;
  if (targetApp === undefined || targetApp.trim() === "") {
    throw new Error(
      "Provide --target-app or set STATSIG_TARGET_APP before preparing a run.",
    );
  }

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
  const users = Number(readOptionalFlag(arguments_, "--users") ?? "2000");
  const seed = Number(readOptionalFlag(arguments_, "--seed") ?? "42");
  const environment =
    readOptionalFlag(arguments_, "--environment") ??
    Bun.env.STATSIG_ENVIRONMENT ??
    "development";
  if (!Number.isInteger(users) || users < 1) {
    throw new RangeError("--users must be a positive integer.");
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
  const run = prepareExperimentRun({
    run_id: runId,
    prepared_at: new Date().toISOString(),
    seed,
    users,
    environment,
    target_app: targetApp,
    audience_model_path: projectPath(modelPath),
    audience_model: audienceModel,
    control_manifest_path: projectPath(controlPath),
    control_manifest: controlManifest,
    treatment_manifest_path: projectPath(treatmentPath),
    treatment_manifest: treatmentManifest,
  });
  const paths = artifactPaths(runId);
  await writeJsonNew(paths.run, run);

  console.log(
    JSON.stringify(
      {
        run: paths.run,
        status: run.status,
        users: run.traffic.users,
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
  const paths = artifactPaths(runId);
  let run = await loadRun(paths.run, runId);
  await loadAndVerifyInputs(run);
  const consoleKey = requiredEnvironmentVariable("STATSIG_CONSOLE_API_KEY");
  const client = new StatsigConsoleClient(consoleKey);
  let statsigCreateArtifact: Record<string, unknown>;

  if (run.status === "prepared" && run.statsig_experiment === null) {
    const metrics = await client.ensureSmokeMetrics();
    const experiment = await client.ensureExperiment(run);
    statsigCreateArtifact = {
      metrics,
      experiment: experiment.raw,
      experiment_reused: experiment.reused,
      start: null,
    };
    if (await Bun.file(paths.statsigCreate).exists()) {
      await writeJson(paths.statsigCreate, statsigCreateArtifact);
    } else {
      await writeJsonNew(paths.statsigCreate, statsigCreateArtifact);
    }
    run = experimentRunSchema.parse({
      ...run,
      status: "created",
      statsig_experiment: experiment.receipt,
    });
    await writeJson(paths.run, run);
  } else if (
    run.status === "created" &&
    run.statsig_experiment !== null &&
    run.statsig_experiment.active_observed_at === null
  ) {
    const storedArtifact = await readJson(paths.statsigCreate);
    if (
      typeof storedArtifact !== "object" ||
      storedArtifact === null ||
      Array.isArray(storedArtifact)
    ) {
      throw new Error(`Invalid Statsig artifact at ${paths.statsigCreate}.`);
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
  await writeJson(paths.statsigCreate, {...statsigCreateArtifact, start});
  const startedRun = experimentRunSchema.parse({
    ...run,
    statsig_experiment: {
      ...statsigExperiment,
      active_observed_at: new Date().toISOString(),
    },
  });
  await writeJson(paths.run, startedRun);

  console.log(
    JSON.stringify(
      {
        run: paths.run,
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
  const paths = artifactPaths(runId);
  const run = await loadRun(paths.run, runId);
  if (
    run.status !== "created" ||
    run.statsig_experiment === null ||
    run.statsig_experiment.active_observed_at === null
  ) {
    throw new Error(`Run ${runId} is not ready to serve.`);
  }
  for (const path of [paths.events, paths.pendingEvents, paths.summary]) {
    if (await Bun.file(path).exists()) {
      throw new Error(`Artifact already exists at ${path}; refusing to resend events.`);
    }
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

    await mkdir(dirname(paths.pendingEvents), {recursive: true});
    await writeFile(
      paths.pendingEvents,
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      {flag: "wx"},
    );
    await writeJson(
      paths.run,
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
  await writeJsonNew(paths.summary, summary);
  await rename(paths.pendingEvents, paths.events);
  const servedRun = experimentRunSchema.parse({...run, status: "served"});
  await writeJson(paths.run, servedRun);

  console.log(
    JSON.stringify(
      {
        run: paths.run,
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
  const paths = artifactPaths(runId);
  const run = await loadRun(paths.run, runId);
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
  await writeJson(paths.inspect, raw);
  const inspectedRun = experimentRunSchema.parse({
    ...run,
    status: "awaiting_results",
  });
  await writeJson(paths.run, inspectedRun);

  console.log(
    JSON.stringify(
      {
        run: paths.run,
        status: inspectedRun.status,
        raw_inspection: paths.inspect,
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
  verifyRunInputs(
    run,
    audienceModel,
    controlManifest,
    treatmentManifest,
  );
  return {audienceModel, controlManifest, treatmentManifest};
}

async function loadRun(path: string, expectedId: string): Promise<ExperimentRun> {
  const run = experimentRunSchema.parse(await readJson(path));
  if (run.run_id !== expectedId) {
    throw new Error(`Run ID mismatch in ${path}.`);
  }
  return run;
}

async function readJson(path: string): Promise<unknown> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`File not found: ${path}`);
  return file.json();
}

function artifactPaths(runId: string): {
  run: string;
  statsigCreate: string;
  pendingEvents: string;
  events: string;
  summary: string;
  inspect: string;
} {
  const directory = resolve(projectRoot, "artifacts/experiments", runId);
  return {
    run: resolve(directory, "run.json"),
    statsigCreate: resolve(directory, "statsig-create.raw.json"),
    pendingEvents: resolve(directory, "events.pending.jsonl"),
    events: resolve(directory, "events.jsonl"),
    summary: resolve(directory, "summary.json"),
    inspect: resolve(directory, "statsig-inspect.raw.json"),
  };
}

function projectPath(path: string): string {
  const projectRelative = relative(projectRoot, path);
  if (projectRelative === "" || projectRelative.startsWith("..")) {
    throw new Error(`Input must be inside the project: ${path}`);
  }
  return projectRelative;
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

async function writeJsonNew(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), {recursive: true});
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {flag: "wx"});
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), {recursive: true});
  const pendingPath = `${path}.partial`;
  await writeFile(pendingPath, `${JSON.stringify(value, null, 2)}\n`);
  await rename(pendingPath, path);
}
