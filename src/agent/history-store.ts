import {Database} from "bun:sqlite";
import {resolve} from "node:path";
import {z} from "zod";

import {
  defaultLedgerPath,
  experimentLogRecordSchema,
  observationLogRecordSchema,
  optimizationRunPlanSchema,
  projectRoot,
  runsDirectory,
} from "../artifacts";
import {
  proposedActionSchema,
  resultSnapshotSchema,
  type ProposedAction,
  type ResultSnapshot,
} from "../experiment/evaluation";
import {creativeManifestSchema, type CreativeManifest} from "../manifest";

const trajectoryProposalSchema = z
  .object({
    proposal_id: z.string().trim().min(1),
    policy_version: z.string().trim().min(1),
    prompt_version: z.string().trim().min(1),
    model: z.string().trim().min(1),
    status: z.string().trim().min(1),
    reviewed_by: z.string().trim().min(1).nullable(),
  })
  .passthrough();

const trajectoryRoundSchema = z
  .object({
    round: z.number().int().positive(),
    run_id: z.string().trim().min(1),
    action: proposedActionSchema,
    proposal: trajectoryProposalSchema,
  })
  .passthrough();

const trajectorySchema = z
  .object({
    schema_version: z.literal(1),
    optimization_run_id: z.string().trim().min(1),
    status: z.enum(["running", "completed"]),
    max_rounds: z.number().int().positive().optional(),
    rounds: z.array(trajectoryRoundSchema),
  })
  .passthrough();

const simulatorObservationSchema = z
  .object({snapshot: resultSnapshotSchema})
  .passthrough();

const proposalPayloadSchema = z
  .object({proposal: proposedActionSchema})
  .passthrough();

export type ExperimentTrack = "seed" | "explore" | "exploit";
export type ExperimentHistorySource = Readonly<{
  project_root: string;
  runs_directory: string;
  ledger_path: string;
}>;
export type TrajectoryRound = z.infer<typeof trajectoryRoundSchema>;
export type ProposalMetadata = Readonly<{
  proposal_id: string;
  policy_version: string;
  prompt_version: string;
  model: string;
  status: string;
  reviewed_by: string | null;
  action: ProposedAction;
}>;
export type LedgerIndex = Readonly<{
  snapshots_by_run: ReadonlyMap<string, readonly ResultSnapshot[]>;
  proposals_by_snapshot: ReadonlyMap<string, ProposalMetadata>;
}>;
export type OptimizationArtifacts = Readonly<{
  plan: z.infer<typeof optimizationRunPlanSchema>;
  experiments: readonly z.infer<typeof experimentLogRecordSchema>[];
  observations: readonly z.infer<typeof observationLogRecordSchema>[];
  trajectory: z.infer<typeof trajectorySchema>;
}>;

export const defaultHistorySource: ExperimentHistorySource = {
  project_root: projectRoot,
  runs_directory: runsDirectory,
  ledger_path: defaultLedgerPath,
};

export function loadLedgerIndex(ledgerPath: string): LedgerIndex {
  const snapshotsByRun = new Map<string, ResultSnapshot[]>();
  const proposalsBySnapshot = new Map<string, ProposalMetadata>();
  if (!Bun.file(ledgerPath).size) {
    return {snapshots_by_run: snapshotsByRun, proposals_by_snapshot: proposalsBySnapshot};
  }
  const database = new Database(ledgerPath, {readonly: true, strict: true});
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
      const rows = database
        .query<{payload_json: string}, []>(
          "SELECT payload_json FROM result_snapshots ORDER BY observed_at",
        )
        .all();
      for (const row of rows) {
        const parsed = resultSnapshotSchema.safeParse(JSON.parse(row.payload_json));
        if (!parsed.success) continue;
        const snapshots = snapshotsByRun.get(parsed.data.run_id) ?? [];
        snapshots.push(parsed.data);
        snapshotsByRun.set(parsed.data.run_id, snapshots);
      }
    }
    if (tables.has("decision_proposals")) {
      const rows = database
        .query<
          {
            proposal_id: string;
            snapshot_id: string;
            policy_version: string;
            prompt_version: string;
            model: string;
            status: string;
            reviewed_by: string | null;
            payload_json: string;
          },
          []
        >(
          `SELECT proposal_id, snapshot_id, policy_version, prompt_version,
                  model, status, reviewed_by, payload_json
           FROM decision_proposals
           ORDER BY created_at`,
        )
        .all();
      for (const row of rows) {
        const payload = proposalPayloadSchema.safeParse(JSON.parse(row.payload_json));
        if (!payload.success) continue;
        proposalsBySnapshot.set(row.snapshot_id, {
          proposal_id: row.proposal_id,
          policy_version: row.policy_version,
          prompt_version: row.prompt_version,
          model: row.model,
          status: row.status,
          reviewed_by: row.reviewed_by,
          action: payload.data.proposal,
        });
      }
    }
  } finally {
    database.close();
  }
  return {snapshots_by_run: snapshotsByRun, proposals_by_snapshot: proposalsBySnapshot};
}

export async function loadOptimizationArtifacts(
  optimizationRunId: string,
  source: ExperimentHistorySource,
): Promise<OptimizationArtifacts> {
  const directory = resolve(source.runs_directory, optimizationRunId);
  const plan = optimizationRunPlanSchema.parse(
    await Bun.file(resolve(directory, "plan.json")).json(),
  );
  const records = z.array(experimentLogRecordSchema).parse(
    await Bun.file(resolve(directory, "experiments.json")).json(),
  );
  const latestByRound = new Map<number, (typeof records)[number]>();
  for (const record of records) {
    const existing = latestByRound.get(record.round_number);
    if (existing === undefined || existing.recorded_at <= record.recorded_at) {
      latestByRound.set(record.round_number, record);
    }
  }
  return {
    plan,
    experiments: [...latestByRound.values()].sort(
      (left, right) => left.round_number - right.round_number,
    ),
    observations: z.array(observationLogRecordSchema).parse(
      await Bun.file(resolve(directory, "observations.json")).json(),
    ),
    trajectory: trajectorySchema.parse(
      await Bun.file(resolve(directory, "trajectory.json")).json(),
    ),
  };
}

export async function loadCreativeManifest(
  source: ExperimentHistorySource,
  path: string,
): Promise<CreativeManifest> {
  return creativeManifestSchema.parse(
    await Bun.file(resolve(source.project_root, path)).json(),
  );
}

export function latestSnapshots(
  runId: string,
  observations: readonly z.infer<typeof observationLogRecordSchema>[],
  ledgerSnapshots: ReadonlyMap<string, readonly ResultSnapshot[]>,
): ResultSnapshot[] {
  const snapshots = new Map<string, ResultSnapshot>();
  for (const snapshot of ledgerSnapshots.get(runId) ?? []) {
    snapshots.set(snapshot.snapshot_id, snapshot);
  }
  for (const observation of observations) {
    if (
      observation.experiment_run_id !== runId ||
      observation.type !== "simulator_result"
    ) {
      continue;
    }
    const parsed = simulatorObservationSchema.safeParse(observation.payload);
    if (parsed.success) {
      snapshots.set(parsed.data.snapshot.snapshot_id, parsed.data.snapshot);
    }
  }
  return [...snapshots.values()].sort((left, right) =>
    left.observed_at.localeCompare(right.observed_at)
  );
}

export function experimentTrack(
  roundNumber: number,
  previousAction: ProposedAction | undefined,
): ExperimentTrack | null {
  if (roundNumber === 1) return "seed";
  if (previousAction === undefined) return null;
  return previousAction.action === "promote" ? "exploit" : "explore";
}

export function proposalMetadata(round: TrajectoryRound): ProposalMetadata {
  return {
    proposal_id: round.proposal.proposal_id,
    policy_version: round.proposal.policy_version,
    prompt_version: round.proposal.prompt_version,
    model: round.proposal.model,
    status: round.proposal.status,
    reviewed_by: round.proposal.reviewed_by,
    action: round.action,
  };
}
