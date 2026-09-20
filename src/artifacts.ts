import {mkdir, readdir, rename, writeFile} from "node:fs/promises";
import {dirname, relative, resolve} from "node:path";

import {z} from "zod";

import {AgentLedger} from "./agent/ledger";
import {
  experimentRunIdSchema,
  experimentRunSchema,
  type ExperimentRun,
} from "./experiment/run";
import {type CreativeManifest} from "./manifest";

export const projectRoot = resolve(import.meta.dir, "..");
export const artifactsDirectory = resolve(projectRoot, "artifacts");
export const runsDirectory = resolve(artifactsDirectory, "runs");
export const defaultLedgerPath = resolve(artifactsDirectory, "state.sqlite");

const timestampSchema = z.string().datetime();

export const optimizationRunPlanSchema = z
  .object({
    schema_version: z.literal(1),
    optimization_run_id: experimentRunIdSchema,
    created_at: timestampSchema,
    initial_experiment_run_id: experimentRunIdSchema,
    audience_model: z
      .object({
        path: z.string().trim().min(1),
      })
      .strict(),
    initial_variants: z.tuple([
      z.object({role: z.literal("control"), variant_id: experimentRunIdSchema}),
      z.object({role: z.literal("treatment"), variant_id: experimentRunIdSchema}),
    ]),
  })
  .strict();

export const experimentLogRecordSchema = z
  .object({
    schema_version: z.literal(1),
    optimization_run_id: experimentRunIdSchema,
    experiment_run_id: experimentRunIdSchema,
    round_number: z.number().int().positive(),
    recorded_at: timestampSchema,
    experiment: experimentRunSchema,
  })
  .strict();

export const observationTypeSchema = z.enum([
  "simulator_result",
  "statsig_create",
  "statsig_inspect",
  "statsig_result",
  "serve_pending",
  "serve_completed",
]);

export const observationLogRecordSchema = z
  .object({
    schema_version: z.literal(1),
    optimization_run_id: experimentRunIdSchema,
    experiment_run_id: experimentRunIdSchema,
    round_number: z.number().int().positive(),
    type: observationTypeSchema,
    recorded_at: timestampSchema,
    payload: z.unknown(),
  })
  .strict();

export type ExperimentLogRecord = z.infer<typeof experimentLogRecordSchema>;
export type ObservationType = z.infer<typeof observationTypeSchema>;
export type ObservationLogRecord = z.infer<typeof observationLogRecordSchema>;

export type RunArtifactPaths = {
  directory: string;
  plan: string;
  experiments: string;
  observations: string;
  trajectory: string;
  creatives: string;
};

export function runArtifactPaths(optimizationRunId: string): RunArtifactPaths {
  const directory = resolve(runsDirectory, optimizationRunId);
  return {
    directory,
    plan: resolve(directory, "plan.json"),
    experiments: resolve(directory, "experiments.json"),
    observations: resolve(directory, "observations.json"),
    trajectory: resolve(directory, "trajectory.json"),
    creatives: resolve(directory, "creatives"),
  };
}

export async function openAgentLedger(): Promise<AgentLedger> {
  const configuredPath = Bun.env.SIMULA_AGENT_DB?.trim();
  const path = configuredPath === undefined || configuredPath === ""
    ? defaultLedgerPath
    : resolve(projectRoot, configuredPath);
  await mkdir(dirname(path), {recursive: true});
  return new AgentLedger(path);
}

export function indexOptimizationRun(
  ledger: AgentLedger,
  optimizationRunId: string,
  run: ExperimentRun,
): void {
  const paths = runArtifactPaths(optimizationRunId);
  ledger.registerOptimizationRun({
    optimization_run_id: optimizationRunId,
    status: "running",
    plan_path: artifactPath(paths.plan),
    current_round: 1,
    champion_variant_id: run.experiment.arms[0].variant_id,
    created_at: run.prepared_at,
    updated_at: run.prepared_at,
  });
  indexExperimentRound(ledger, optimizationRunId, 1, run, run.prepared_at);
}

export function indexExperimentRound(
  ledger: AgentLedger,
  optimizationRunId: string,
  roundNumber: number,
  run: ExperimentRun,
  recordedAt: string,
): void {
  const [control, treatment] = run.experiment.arms;
  ledger.upsertExperimentRound({
    experiment_run_id: run.run_id,
    optimization_run_id: optimizationRunId,
    round_number: roundNumber,
    experiment_path: artifactPath(runArtifactPaths(optimizationRunId).experiments),
    status: run.status,
    control_variant_id: control.variant_id,
    treatment_variant_id: treatment.variant_id,
    created_at: run.prepared_at,
    updated_at: recordedAt,
  });
}

export async function initializeOptimizationRun(
  optimizationRunId: string,
  run: ExperimentRun,
  initialManifests: readonly [CreativeManifest, CreativeManifest],
): Promise<RunArtifactPaths> {
  const paths = runArtifactPaths(optimizationRunId);
  const [control, treatment] = run.experiment.arms;
  const [controlManifest, treatmentManifest] = initialManifests;
  if (
    controlManifest.variant_id !== control.variant_id ||
    treatmentManifest.variant_id !== treatment.variant_id
  ) {
    throw new Error("Initial manifests do not match experiment arms.");
  }
  await mkdir(paths.directory, {recursive: true});
  const plan = optimizationRunPlanSchema.parse({
    schema_version: 1,
    optimization_run_id: optimizationRunId,
    created_at: run.prepared_at,
    initial_experiment_run_id: run.run_id,
    audience_model: run.audience_model,
    initial_variants: [
      {role: "control", variant_id: control.variant_id},
      {role: "treatment", variant_id: treatment.variant_id},
    ],
  });
  await writeJsonNew(paths.plan, plan);
  await writeJsonNew(paths.experiments, []);
  await writeJsonNew(paths.observations, []);
  await writeJsonNew(
    creativeManifestPath(optimizationRunId, controlManifest.variant_id),
    controlManifest,
  );
  await writeJsonNew(
    creativeManifestPath(optimizationRunId, treatmentManifest.variant_id),
    treatmentManifest,
  );
  await appendExperimentSnapshot({
    optimization_run_id: optimizationRunId,
    round_number: 1,
    recorded_at: run.prepared_at,
    experiment: run,
  });
  await writeJsonNew(paths.trajectory, {
    schema_version: 1,
    optimization_run_id: optimizationRunId,
    status: "running",
    rounds: [],
  });
  return paths;
}

export async function appendExperimentSnapshot(input: {
  optimization_run_id: string;
  round_number: number;
  recorded_at: string;
  experiment: ExperimentRun;
}): Promise<void> {
  const record = experimentLogRecordSchema.parse({
    schema_version: 1,
    optimization_run_id: input.optimization_run_id,
    experiment_run_id: input.experiment.run_id,
    round_number: input.round_number,
    recorded_at: input.recorded_at,
    experiment: input.experiment,
  });
  const path = runArtifactPaths(input.optimization_run_id).experiments;
  await appendJsonRecord(path, experimentLogRecordSchema, record);
}

export async function appendObservation(input: {
  optimization_run_id: string;
  experiment_run_id: string;
  round_number: number;
  type: ObservationType;
  recorded_at: string;
  payload: unknown;
}): Promise<void> {
  const record = observationLogRecordSchema.parse({schema_version: 1, ...input});
  const path = runArtifactPaths(input.optimization_run_id).observations;
  await appendJsonRecord(path, observationLogRecordSchema, record);
}

export async function findExperiment(
  experimentRunId: string,
): Promise<ExperimentLogRecord> {
  const records = await listLatestExperiments();
  const record = records.find(
    ({experiment_run_id}) => experiment_run_id === experimentRunId,
  );
  if (record === undefined) {
    throw new Error(`Experiment run not found: ${experimentRunId}`);
  }
  return record;
}

export async function listLatestExperiments(): Promise<ExperimentLogRecord[]> {
  let entries;
  try {
    entries = await readdir(runsDirectory, {withFileTypes: true});
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const latest = new Map<string, ExperimentLogRecord>();
  for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
    const path = runArtifactPaths(entry.name).experiments;
    for (const record of await readJsonRecords(path, experimentLogRecordSchema)) {
      const existing = latest.get(record.experiment_run_id);
      if (
        existing !== undefined &&
        existing.optimization_run_id !== record.optimization_run_id
      ) {
        throw new Error(
          `Experiment run ID is shared by ${existing.optimization_run_id} and ${record.optimization_run_id}: ${record.experiment_run_id}`,
        );
      }
      latest.set(record.experiment_run_id, record);
    }
  }
  return [...latest.values()].sort((left, right) =>
    left.experiment_run_id.localeCompare(right.experiment_run_id)
  );
}

export async function findLatestObservation(
  optimizationRunId: string,
  experimentRunId: string,
  type: ObservationType,
): Promise<ObservationLogRecord | null> {
  const path = runArtifactPaths(optimizationRunId).observations;
  const records = await readJsonRecords(path, observationLogRecordSchema);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]!;
    if (record.experiment_run_id === experimentRunId && record.type === type) {
      return record;
    }
  }
  return null;
}

export function creativeManifestPath(
  optimizationRunId: string,
  variantId: string,
): string {
  return resolve(
    runArtifactPaths(optimizationRunId).creatives,
    variantId,
    "manifest.json",
  );
}

export function artifactPath(path: string): string {
  const projectRelative = relative(projectRoot, path);
  if (projectRelative === "" || projectRelative.startsWith("..")) {
    throw new Error(`Artifact must be inside the project: ${path}`);
  }
  return projectRelative;
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), {recursive: true});
  const pendingPath = `${path}.partial`;
  await writeFile(pendingPath, `${JSON.stringify(value, null, 2)}\n`);
  await rename(pendingPath, path);
}

export async function writeJsonNew(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), {recursive: true});
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {flag: "wx"});
}

async function appendJsonRecord<Schema extends z.ZodType>(
  path: string,
  schema: Schema,
  record: z.infer<Schema>,
): Promise<void> {
  const records = await readJsonRecords(path, schema);
  records.push(record);
  await writeJsonAtomic(path, records);
}

async function readJsonRecords<Schema extends z.ZodType>(
  path: string,
  schema: Schema,
): Promise<z.infer<Schema>[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  return z.array(schema).parse(await file.json());
}
