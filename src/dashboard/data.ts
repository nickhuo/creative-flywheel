import {Database} from "bun:sqlite";
import type {Dirent} from "node:fs";
import {readdir} from "node:fs/promises";
import {resolve} from "node:path";
import {z} from "zod";

import {
  experimentLogRecordSchema,
  observationLogRecordSchema,
  optimizationRunPlanSchema,
} from "../artifacts";
import {
  proposedActionSchema,
  resultSnapshotSchema,
  type MetricResult,
  type ProposedAction,
  type ResultSnapshot,
} from "../experiment/evaluation";
import type {ExperimentRun} from "../experiment/run";
import {
  creativeManifestSchema,
  type CreativeLayerField,
} from "../manifest";

export type DashboardObservationSource = (
  run: ExperimentRun,
) => Promise<ResultSnapshot>;

export type DashboardRound = {
  optimization_run_id: string;
  run_id: string;
  status: ExperimentRun["status"];
  prepared_at: string;
  environment: string;
  hypothesis: string;
  hypothesis_changes: ExperimentRun["experiment"]["hypothesis"]["changes"];
  required_users: number;
  batch_size: number;
  alpha: number;
  power: number;
  minimum_detectable_effect: number;
  evidence_source: "simulator" | "statsig";
  round: number;
  parent_run_id: string | null;
  next_run_id: string | null;
  statsig: {
    experiment_id: string;
    permalink: string;
    active_observed_at: string | null;
  } | null;
  arms: Array<{
    role: "control" | "treatment";
    variant_id: string;
    generation: number;
    parent_id: string | null;
    allocation_percent: 50;
    layers: Record<CreativeLayerField, string>;
    video_url: string | null;
  }>;
  snapshots: Array<{
    snapshot_id: string;
    observed_at: string;
    data_through: string | null;
    exposure_groups: ResultSnapshot["exposure_groups"];
    health_issues: ResultSnapshot["health_issues"];
    primary_metric: MetricResult;
    secondary_metrics: readonly MetricResult[];
  }>;
  decision: {
    status: string;
    action: ProposedAction;
  } | null;
  live_error: string | null;
};

export type DashboardTrack = {
  optimization_run_id: string;
  status: "completed" | "running";
  created_at: string;
  max_rounds: number | null;
  rounds: DashboardRound[];
};

export type DashboardData = {
  generated_at: string;
  source: "optimization_artifacts_and_statsig";
  tracks: DashboardTrack[];
};

const trajectorySchema = z
  .object({
    schema_version: z.literal(1),
    optimization_run_id: z.string().trim().min(1),
    status: z.enum(["completed", "running"]),
    max_rounds: z.number().int().positive().optional(),
    rounds: z.array(
      z
        .object({
          round: z.number().int().positive(),
          run_id: z.string().trim().min(1),
          action: proposedActionSchema,
          proposal: z.object({status: z.string().trim().min(1)}).passthrough(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const simulatorPayloadSchema = z
  .object({snapshot: resultSnapshotSchema})
  .passthrough();

export async function loadDashboardData(input: {
  project_root: string;
  runs_directory: string;
  ledger_path: string;
  observe?: DashboardObservationSource;
  now?: () => Date;
}): Promise<DashboardData> {
  let runEntries: Dirent<string>[] = [];
  try {
    runEntries = await readdir(input.runs_directory, {withFileTypes: true});
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const persistedSnapshots = new Map<string, ResultSnapshot[]>();
  const proposals = new Map<
    string,
    {status: string; action: ProposedAction}
  >();
  if (await Bun.file(input.ledger_path).exists()) {
    const database = new Database(input.ledger_path, {
      readonly: true,
      strict: true,
    });
    try {
      const tables = new Set(
        database
          .query<{name: string}, []>(
            "SELECT name FROM sqlite_master WHERE type = 'table'",
          )
          .all()
          .map(({name}) => name),
      );
      if (tables.has("result_snapshots")) {
        for (const {payload_json: payloadJson} of database
          .query<{payload_json: string}, []>(
            "SELECT payload_json FROM result_snapshots ORDER BY observed_at",
          )
          .all()) {
          const parsed = resultSnapshotSchema.safeParse(JSON.parse(payloadJson));
          if (!parsed.success) continue;
          const snapshots = persistedSnapshots.get(parsed.data.run_id) ?? [];
          snapshots.push(parsed.data);
          persistedSnapshots.set(parsed.data.run_id, snapshots);
        }
      }
      if (tables.has("decision_proposals")) {
        for (const proposal of database
          .query<
            {snapshot_id: string; status: string; payload_json: string},
            []
          >(
            `SELECT snapshot_id, status, payload_json
             FROM decision_proposals
             ORDER BY created_at`,
          )
          .all()) {
          const payload: unknown = JSON.parse(proposal.payload_json);
          if (
            typeof payload !== "object" ||
            payload === null ||
            !("proposal" in payload)
          ) {
            continue;
          }
          const action = proposedActionSchema.safeParse(payload.proposal);
          if (action.success) {
            proposals.set(proposal.snapshot_id, {
              status: proposal.status,
              action: action.data,
            });
          }
        }
      }
    } finally {
      database.close();
    }
  }

  const tracks = await Promise.all(
    runEntries
      .filter((entry) => entry.isDirectory())
      .map(async (entry): Promise<DashboardTrack> => {
        const directory = resolve(input.runs_directory, entry.name);
        const plan = optimizationRunPlanSchema.parse(
          await readJson(resolve(directory, "plan.json")),
        );
        const experimentRecords = z
          .array(experimentLogRecordSchema)
          .parse(await readJson(resolve(directory, "experiments.json")));
        const observations = z
          .array(observationLogRecordSchema)
          .parse(await readJson(resolve(directory, "observations.json")));
        const trajectory = trajectorySchema.parse(
          await readJson(resolve(directory, "trajectory.json")),
        );
        if (
          plan.optimization_run_id !== entry.name ||
          trajectory.optimization_run_id !== entry.name
        ) {
          throw new Error(`Optimization artifacts do not match ${entry.name}.`);
        }

        const latestExperiments = new Map<
          number,
          (typeof experimentRecords)[number]
        >();
        for (const record of experimentRecords) {
          const existing = latestExperiments.get(record.round_number);
          if (
            existing === undefined ||
            existing.recorded_at <= record.recorded_at
          ) {
            latestExperiments.set(record.round_number, record);
          }
        }
        const experimentRounds = [...latestExperiments.values()].sort(
          (left, right) => left.round_number - right.round_number,
        );
        const trajectoryRounds = new Map(
          trajectory.rounds.map((round) => [round.round, round]),
        );

        const rounds = await Promise.all(
          experimentRounds.map(async (record, index): Promise<DashboardRound> => {
            const run = record.experiment;
            const arms = await Promise.all(
              run.experiment.arms.map(async (arm) => {
                const manifest = creativeManifestSchema.parse(
                  await readJson(resolve(input.project_root, arm.manifest.path)),
                );
                return {
                  role: arm.role,
                  variant_id: arm.variant_id,
                  generation: manifest.generation,
                  parent_id: manifest.parent_id,
                  allocation_percent: arm.allocation_percent,
                  layers: manifest.layers,
                  video_url: await Bun.file(
                    resolve(
                      directory,
                      "creatives",
                      arm.variant_id,
                      "video.mp4",
                    ),
                  ).exists()
                    ? `/media/${plan.optimization_run_id}/${arm.variant_id}.mp4`
                    : null,
                };
              }),
            );
            const simulatorSnapshots = observations
              .filter(
                (observation) =>
                  observation.experiment_run_id === run.run_id &&
                  observation.type === "simulator_result",
              )
              .map(({payload}) => simulatorPayloadSchema.parse(payload).snapshot);
            const snapshots = simulatorSnapshots.length > 0
              ? simulatorSnapshots
              : [...(persistedSnapshots.get(run.run_id) ?? [])];
            let liveError: string | null = null;
            if (
              simulatorSnapshots.length === 0 &&
              input.observe !== undefined &&
              run.statsig_experiment !== null
            ) {
              try {
                const liveSnapshot = await input.observe(run);
                if (
                  !snapshots.some(
                    ({snapshot_id: snapshotId}) =>
                      snapshotId === liveSnapshot.snapshot_id,
                  )
                ) {
                  snapshots.push(liveSnapshot);
                }
              } catch (error) {
                liveError = error instanceof Error
                  ? error.message
                  : "Statsig refresh failed with an unknown error.";
              }
            }
            snapshots.sort((left, right) =>
              left.observed_at.localeCompare(right.observed_at)
            );
            const trajectoryRound = trajectoryRounds.get(record.round_number);
            const latestSnapshot = snapshots.at(-1);
            const decision = trajectoryRound === undefined
              ? latestSnapshot === undefined
                ? null
                : proposals.get(latestSnapshot.snapshot_id) ?? null
              : {
                  status: trajectoryRound.proposal.status,
                  action: trajectoryRound.action,
                };

            return {
              optimization_run_id: plan.optimization_run_id,
              run_id: run.run_id,
              status: run.status,
              prepared_at: run.prepared_at,
              environment: run.experiment.environment,
              hypothesis: run.experiment.hypothesis.statement,
              hypothesis_changes: run.experiment.hypothesis.changes,
              required_users: run.statistical_design.required_users,
              batch_size: run.traffic.batch_size,
              alpha: run.statistical_design.alpha,
              power: run.statistical_design.power,
              minimum_detectable_effect:
                run.statistical_design.minimum_detectable_effect,
              evidence_source: simulatorSnapshots.length > 0
                ? "simulator"
                : "statsig",
              round: record.round_number,
              parent_run_id: experimentRounds[index - 1]?.experiment_run_id ?? null,
              next_run_id: experimentRounds[index + 1]?.experiment_run_id ?? null,
              statsig: run.statsig_experiment === null
                ? null
                : {
                    experiment_id: run.statsig_experiment.experiment_id,
                    permalink: run.statsig_experiment.permalink,
                    active_observed_at:
                      run.statsig_experiment.active_observed_at,
                  },
              arms,
              snapshots: snapshots.map((snapshot) => ({
                snapshot_id: snapshot.snapshot_id,
                observed_at: snapshot.observed_at,
                data_through: snapshot.data_through,
                exposure_groups: snapshot.exposure_groups,
                health_issues: snapshot.health_issues,
                primary_metric: snapshot.primary_metric,
                secondary_metrics: snapshot.secondary_metrics,
              })),
              decision,
              live_error: liveError,
            };
          }),
        );

        return {
          optimization_run_id: plan.optimization_run_id,
          status: trajectory.status,
          created_at: plan.created_at,
          max_rounds: trajectory.max_rounds ?? null,
          rounds,
        };
      }),
  );
  tracks.sort((left, right) => right.created_at.localeCompare(left.created_at));

  return {
    generated_at: (input.now ?? (() => new Date()))().toISOString(),
    source: "optimization_artifacts_and_statsig",
    tracks,
  };
}

async function readJson(path: string): Promise<unknown> {
  return Bun.file(path).json();
}
