import {readdir} from "node:fs/promises";
import {z} from "zod";

import {optimizationRunPlanSchema} from "../artifacts";
import {
  challengerProposalSchema,
  proposedActionSchema,
  resultSnapshotSchema,
} from "../experiment/evaluation";
import {experimentRunSchema} from "../experiment/run";
import {creativeManifestSchema} from "../manifest";
import {
  defaultHistorySource,
  experimentTrack,
  latestSnapshots,
  loadCreativeManifest,
  loadLedgerIndex,
  loadOptimizationArtifacts,
  proposalMetadata,
  type ExperimentHistorySource,
} from "./history-store";

export const getExperimentTrajectoryInputSchema = z
  .object({run_id: z.string().trim().min(1)})
  .strict();

const trajectoryEvidenceRoundSchema = z
  .object({
    round: z.number().int().positive(),
    selected: z.boolean(),
    run_id: z.string().trim().min(1),
    track: z.enum(["seed", "explore", "exploit"]).nullable(),
    experiment: experimentRunSchema,
    manifests: z
      .object({
        control: creativeManifestSchema,
        treatment: creativeManifestSchema,
      })
      .strict(),
    snapshot: resultSnapshotSchema.nullable(),
    tested_pitch: z
      .object({
        review_status: z.string().trim().min(1).nullable(),
        prompt_version: z.string().trim().min(1).nullable(),
        proposal: challengerProposalSchema,
      })
      .strict()
      .nullable(),
    decision: proposedActionSchema.nullable(),
    decision_metadata: z
      .object({
        proposal_id: z.string().trim().min(1),
        status: z.string().trim().min(1),
        policy_version: z.string().trim().min(1),
        prompt_version: z.string().trim().min(1),
        model: z.string().trim().min(1),
        reviewed_by: z.string().trim().min(1).nullable(),
      })
      .strict()
      .nullable(),
    learning: z.string().trim().min(1).nullable(),
    next_pitch: challengerProposalSchema.nullable(),
  })
  .strict();

export const getExperimentTrajectoryOutputSchema = z
  .object({
    optimization_run_id: z.string().trim().min(1),
    selected_run_id: z.string().trim().min(1),
    selected_round: z.number().int().positive(),
    status: z.enum(["running", "completed"]),
    plan: optimizationRunPlanSchema,
    rounds: z.array(trajectoryEvidenceRoundSchema).min(1),
    lineage: z.array(
      z
        .object({
          variant_id: z.string().trim().min(1),
          generation: z.number().int().nonnegative(),
          parent_id: z.string().trim().min(1).nullable(),
        })
        .strict(),
    ),
    artifact_refs: z
      .object({
        plan: z.string().trim().min(1),
        experiments: z.string().trim().min(1),
        observations: z.string().trim().min(1),
        trajectory: z.string().trim().min(1),
      })
      .strict(),
  })
  .strict();

export type GetExperimentTrajectoryInput = z.input<
  typeof getExperimentTrajectoryInputSchema
>;
export type GetExperimentTrajectoryOutput = z.infer<
  typeof getExperimentTrajectoryOutputSchema
>;

export async function getExperimentTrajectory(
  input: GetExperimentTrajectoryInput,
  source: ExperimentHistorySource = defaultHistorySource,
): Promise<GetExperimentTrajectoryOutput> {
  const {run_id: requestedRunId} = getExperimentTrajectoryInputSchema.parse(input);
  const ledger = loadLedgerIndex(source.ledger_path);
  const entries = await readdir(source.runs_directory, {withFileTypes: true}).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );

  for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
    const artifacts = await loadOptimizationArtifacts(entry.name, source);
    const selectedRecord = artifacts.experiments.find(
      (record) => record.experiment_run_id === requestedRunId,
    );
    if (
      selectedRecord === undefined &&
      artifacts.plan.optimization_run_id !== requestedRunId
    ) {
      continue;
    }

    const trajectoryByRound = new Map(
      artifacts.trajectory.rounds.map((round) => [round.round, round]),
    );
    const lineage = new Map<
      string,
      {variant_id: string; generation: number; parent_id: string | null}
    >();
    const rounds: z.infer<typeof trajectoryEvidenceRoundSchema>[] = [];
    for (const record of artifacts.experiments) {
      const run = record.experiment;
      const [controlArm, treatmentArm] = run.experiment.arms;
      const controlManifest = await loadCreativeManifest(
        source,
        controlArm.manifest.path,
      );
      const treatmentManifest = await loadCreativeManifest(
        source,
        treatmentArm.manifest.path,
      );
      for (const manifest of [controlManifest, treatmentManifest]) {
        lineage.set(manifest.variant_id, {
          variant_id: manifest.variant_id,
          generation: manifest.generation,
          parent_id: manifest.parent_id,
        });
      }
      const snapshots = latestSnapshots(
        run.run_id,
        artifacts.observations,
        ledger.snapshots_by_run,
      );
      const snapshot = snapshots.at(-1) ?? null;
      const trajectoryRound = trajectoryByRound.get(record.round_number);
      const previousRound = trajectoryByRound.get(record.round_number - 1);
      const testedPitch = previousRound?.action.action === "stop" ||
          previousRound?.action.action === "promote"
        ? previousRound.action.next_challenger
        : null;
      const evaluationProposal = trajectoryRound === undefined
        ? snapshot === null
          ? undefined
          : ledger.proposals_by_snapshot.get(snapshot.snapshot_id)
        : proposalMetadata(trajectoryRound);
      const resolvedAction = trajectoryRound?.action ?? evaluationProposal?.action;
      const resolvedNextPitch = resolvedAction?.action === "stop" ||
          resolvedAction?.action === "promote"
        ? resolvedAction.next_challenger
        : null;

      rounds.push({
        round: record.round_number,
        selected: selectedRecord?.round_number === record.round_number,
        run_id: run.run_id,
        track: experimentTrack(record.round_number, previousRound?.action),
        experiment: run,
        manifests: {control: controlManifest, treatment: treatmentManifest},
        snapshot,
        tested_pitch: testedPitch === null
          ? null
          : {
              review_status: previousRound?.proposal.status ?? null,
              prompt_version: previousRound?.proposal.prompt_version ?? null,
              proposal: testedPitch,
            },
        decision: resolvedAction ?? null,
        decision_metadata: evaluationProposal === undefined
          ? null
          : {
              proposal_id: evaluationProposal.proposal_id,
              status: evaluationProposal.status,
              policy_version: evaluationProposal.policy_version,
              prompt_version: evaluationProposal.prompt_version,
              model: evaluationProposal.model,
              reviewed_by: evaluationProposal.reviewed_by,
            },
        learning: resolvedNextPitch?.evaluation.learning ?? null,
        next_pitch: resolvedNextPitch,
      });
    }

    return getExperimentTrajectoryOutputSchema.parse({
      optimization_run_id: artifacts.plan.optimization_run_id,
      selected_run_id: selectedRecord?.experiment_run_id ?? requestedRunId,
      selected_round: selectedRecord?.round_number ?? 1,
      status: artifacts.trajectory.status,
      plan: artifacts.plan,
      rounds,
      lineage: [...lineage.values()].sort(
        (left, right) => left.generation - right.generation ||
          left.variant_id.localeCompare(right.variant_id),
      ),
      artifact_refs: {
        plan: `artifacts/runs/${artifacts.plan.optimization_run_id}/plan.json`,
        experiments:
          `artifacts/runs/${artifacts.plan.optimization_run_id}/experiments.json`,
        observations:
          `artifacts/runs/${artifacts.plan.optimization_run_id}/observations.json`,
        trajectory:
          `artifacts/runs/${artifacts.plan.optimization_run_id}/trajectory.json`,
      },
    });
  }

  throw new Error(`Experiment run not found: ${requestedRunId}`);
}
