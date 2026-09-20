import {tool, type Tool} from "@openai/agents";
import {readdir} from "node:fs/promises";
import {relative} from "node:path";
import {z} from "zod";

import {CREATIVE_LAYER_FIELDS} from "../manifest";
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
import {
  getExperimentTrajectory,
  getExperimentTrajectoryInputSchema,
  getExperimentTrajectoryOutputSchema,
} from "./trajectory";

export {
  getExperimentTrajectory,
  getExperimentTrajectoryInputSchema,
  getExperimentTrajectoryOutputSchema,
} from "./trajectory";
export type {ExperimentHistorySource} from "./history-store";
export type {GetExperimentTrajectoryInput} from "./trajectory";

const trackSchema = z.enum(["seed", "explore", "exploit"]);
const decisionSchema = z.enum(["stop", "promote"]);
const workflowActionSchema = z.enum(["stop", "promote", "terminate"]);
const metricOutcomeSchema = z.enum([
  "positive_significant",
  "negative_significant",
  "inconclusive",
]);

export const searchExperimentRunsInputSchema = z
  .object({
    track: trackSchema.optional().describe("Creative track to match."),
    decision: decisionSchema
      .optional()
      .describe("Experiment outcome to match, including the outcome of a final round."),
    workflow_action: workflowActionSchema
      .optional()
      .describe("Stored workflow action, including terminate on the final round."),
    metric_outcome: metricOutcomeSchema
      .optional()
      .describe("Primary-metric outcome classified from its confidence interval."),
    observed_after: z
      .string()
      .datetime({offset: true})
      .optional()
      .describe("Inclusive lower bound for the latest observation timestamp."),
    observed_before: z
      .string()
      .datetime({offset: true})
      .optional()
      .describe("Inclusive upper bound for the latest observation timestamp."),
    concept_query: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .optional()
      .describe("Keyword phrase matched against hypothesis and pitch text."),
    changed_layers: z
      .array(z.enum(CREATIVE_LAYER_FIELDS))
      .min(1)
      .max(CREATIVE_LAYER_FIELDS.length)
      .optional()
      .describe("Exact set of renderable layers changed by the experiment."),
    control_variant_id: z.string().trim().min(1).optional(),
    treatment_variant_id: z.string().trim().min(1).optional(),
    winner_variant_id: z.string().trim().min(1).optional(),
    pitch_prompt_version: z.string().trim().min(1).optional(),
    evaluation_prompt_version: z.string().trim().min(1).optional(),
    policy_version: z.string().trim().min(1).optional(),
    exclude_run_id: z.string().trim().min(1).optional(),
    limit: z.number().int().min(1).max(10).default(5),
  })
  .strict()
  .refine(
    ({observed_after: after, observed_before: before}) =>
      after === undefined ||
      before === undefined ||
      Date.parse(after) <= Date.parse(before),
    {
      message: "observed_after cannot be later than observed_before.",
      path: ["observed_after"],
    },
  );

const searchMetricSchema = z
  .object({
    name: z.string().trim().min(1),
    control_mean: z.number().finite(),
    treatment_mean: z.number().finite(),
    absolute_effect: z.number().finite(),
    confidence_interval: z
      .object({
        lower: z.number().finite(),
        upper: z.number().finite(),
        level: z.number().positive().lt(1),
      })
      .strict(),
    p_value: z.number().min(0).max(1),
    outcome: metricOutcomeSchema,
  })
  .strict();

export const searchExperimentRunMatchSchema = z
  .object({
    run_id: z.string().trim().min(1),
    optimization_run_id: z.string().trim().min(1),
    round: z.number().int().positive(),
    track: trackSchema.nullable(),
    track_basis: z.enum([
      "optimization_root",
      "previous_decision_stop",
      "previous_decision_promote",
      "unknown",
    ]),
    hypothesis: z.string().trim().min(1),
    changed_layers: z.array(z.enum(CREATIVE_LAYER_FIELDS)).min(1),
    control_variant_id: z.string().trim().min(1),
    treatment_variant_id: z.string().trim().min(1),
    winner_variant_id: z.string().trim().min(1),
    decision: decisionSchema,
    workflow_action: workflowActionSchema,
    observed_at: z.string().datetime(),
    metric: searchMetricSchema,
    pitch_prompt_version: z.string().trim().min(1).nullable(),
    evaluation_prompt_version: z.string().trim().min(1).nullable(),
    policy_version: z.string().trim().min(1).nullable(),
    concept_match: z
      .object({
        value: z.string().trim().min(1),
        match_basis: z.literal("keyword"),
      })
      .strict()
      .nullable(),
    artifact_refs: z
      .object({
        experiment: z
          .object({path: z.string().trim().min(1), round: z.number().int().positive()})
          .strict(),
        trajectory: z
          .object({path: z.string().trim().min(1), round: z.number().int().positive()})
          .strict(),
        snapshot: z
          .object({
            store: z.string().trim().min(1),
            table: z.literal("result_snapshots"),
            id: z.string().trim().min(1),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export const searchExperimentRunsOutputSchema = z
  .object({
    matches: z.array(searchExperimentRunMatchSchema).max(10),
    has_more: z.boolean(),
  })
  .strict();

export type SearchExperimentRunsInput = z.input<
  typeof searchExperimentRunsInputSchema
>;
export type SearchExperimentRunsOutput = z.infer<
  typeof searchExperimentRunsOutputSchema
>;
export type ExperimentHistoryToolOptions = Readonly<{
  source?: ExperimentHistorySource;
  exclude_run_id?: string;
}>;

export async function searchExperimentRuns(
  input: SearchExperimentRunsInput,
  source: ExperimentHistorySource = defaultHistorySource,
): Promise<SearchExperimentRunsOutput> {
  const filters = searchExperimentRunsInputSchema.parse(input);
  const ledger = loadLedgerIndex(source.ledger_path);
  const entries = await readdir(source.runs_directory, {withFileTypes: true}).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  const matches: z.infer<typeof searchExperimentRunMatchSchema>[] = [];

  for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
    const artifacts = await loadOptimizationArtifacts(entry.name, source);
    const trajectoryByRound = new Map(
      artifacts.trajectory.rounds.map((round) => [round.round, round]),
    );

    for (const record of artifacts.experiments) {
      const run = record.experiment;
      if (run.run_id === filters.exclude_run_id) continue;
      const [controlArm, treatmentArm] = run.experiment.arms;
      if (
        filters.control_variant_id !== undefined &&
        filters.control_variant_id !== controlArm.variant_id
      ) {
        continue;
      }
      if (
        filters.treatment_variant_id !== undefined &&
        filters.treatment_variant_id !== treatmentArm.variant_id
      ) {
        continue;
      }

      const controlManifest = await loadCreativeManifest(
        source,
        controlArm.manifest.path,
      );
      const treatmentManifest = await loadCreativeManifest(
        source,
        treatmentArm.manifest.path,
      );
      const changedLayers = CREATIVE_LAYER_FIELDS.filter(
        (layer) => controlManifest.layers[layer] !== treatmentManifest.layers[layer],
      );
      if (
        filters.changed_layers !== undefined &&
        (changedLayers.length !== filters.changed_layers.length ||
          changedLayers.some((layer) => !filters.changed_layers!.includes(layer)))
      ) {
        continue;
      }

      const trajectoryRound = trajectoryByRound.get(record.round_number);
      const previousRound = trajectoryByRound.get(record.round_number - 1);
      const track = experimentTrack(record.round_number, previousRound?.action);
      if (filters.track !== undefined && filters.track !== track) continue;

      const snapshots = latestSnapshots(
        run.run_id,
        artifacts.observations,
        ledger.snapshots_by_run,
      );
      const snapshot = snapshots.at(-1);
      const observedAt = snapshot?.observed_at ?? run.prepared_at;
      if (
        filters.observed_after !== undefined &&
        Date.parse(observedAt) < Date.parse(filters.observed_after)
      ) {
        continue;
      }
      if (
        filters.observed_before !== undefined &&
        Date.parse(observedAt) > Date.parse(filters.observed_before)
      ) {
        continue;
      }

      if (snapshot === undefined || snapshot.primary_metric.status !== "ready") {
        continue;
      }
      const metric = snapshot.primary_metric;
      const metricOutcome = metric.confidence_interval.lower > 0
        ? "positive_significant"
        : metric.confidence_interval.upper < 0
          ? "negative_significant"
          : "inconclusive";
      if (
        filters.metric_outcome !== undefined &&
        metricOutcome !== filters.metric_outcome
      ) {
        continue;
      }

      const evaluationProposal = trajectoryRound === undefined
        ? snapshot === undefined
          ? undefined
          : ledger.proposals_by_snapshot.get(snapshot.snapshot_id)
        : proposalMetadata(trajectoryRound);
      const pitchProposal = previousRound === undefined
        ? undefined
        : proposalMetadata(previousRound);
      const action = trajectoryRound?.action ?? evaluationProposal?.action;
      if (action === undefined) continue;
      const decision = action.action === "terminate"
        ? action.final_experiment_action
        : action.action;
      if (filters.decision !== undefined && decision !== filters.decision) {
        continue;
      }
      if (
        filters.workflow_action !== undefined &&
        action.action !== filters.workflow_action
      ) {
        continue;
      }
      const winnerVariantId = action.action === "stop"
        ? controlArm.variant_id
        : action.action === "promote"
          ? treatmentArm.variant_id
          : action.champion_variant_id;
      if (
        filters.winner_variant_id !== undefined &&
        winnerVariantId !== filters.winner_variant_id
      ) {
        continue;
      }
      if (
        filters.pitch_prompt_version !== undefined &&
        pitchProposal?.prompt_version !== filters.pitch_prompt_version
      ) {
        continue;
      }
      if (
        filters.evaluation_prompt_version !== undefined &&
        evaluationProposal?.prompt_version !== filters.evaluation_prompt_version
      ) {
        continue;
      }
      if (
        filters.policy_version !== undefined &&
        evaluationProposal?.policy_version !== filters.policy_version &&
        pitchProposal?.policy_version !== filters.policy_version
      ) {
        continue;
      }

      const testedPitch = previousRound?.action.action === "stop" ||
          previousRound?.action.action === "promote"
        ? previousRound.action.next_challenger
        : null;
      if (filters.concept_query !== undefined) {
        const normalizedQuery = normalizeSearchText(filters.concept_query);
        const searchableText = normalizeSearchText([
          run.experiment.hypothesis.statement,
          testedPitch?.hypothesis.audience_motivation ?? "",
          testedPitch?.hypothesis.mechanism ?? "",
          testedPitch?.evaluation.learning ?? "",
        ].join(" "));
        if (!searchableText.includes(normalizedQuery)) continue;
      }

      matches.push(searchExperimentRunMatchSchema.parse({
        run_id: run.run_id,
        optimization_run_id: artifacts.plan.optimization_run_id,
        round: record.round_number,
        track,
        track_basis: record.round_number === 1
          ? "optimization_root"
          : previousRound?.action.action === "promote"
            ? "previous_decision_promote"
            : previousRound === undefined
              ? "unknown"
              : "previous_decision_stop",
        hypothesis: run.experiment.hypothesis.statement,
        changed_layers: changedLayers,
        control_variant_id: controlArm.variant_id,
        treatment_variant_id: treatmentArm.variant_id,
        winner_variant_id: winnerVariantId,
        decision,
        workflow_action: action.action,
        observed_at: observedAt,
        metric: {
          name: metric.name,
          control_mean: metric.control.mean,
          treatment_mean: metric.treatment.mean,
          absolute_effect: metric.absolute_effect,
          confidence_interval: metric.confidence_interval,
          p_value: metric.p_value,
          outcome: metricOutcome,
        },
        pitch_prompt_version: pitchProposal?.prompt_version ?? null,
        evaluation_prompt_version: evaluationProposal?.prompt_version ?? null,
        policy_version:
          evaluationProposal?.policy_version ?? pitchProposal?.policy_version ?? null,
        concept_match: filters.concept_query === undefined
          ? null
          : {value: filters.concept_query, match_basis: "keyword"},
        artifact_refs: {
          experiment: {
            path: `artifacts/runs/${artifacts.plan.optimization_run_id}/experiments.json`,
            round: record.round_number,
          },
          trajectory: {
            path: `artifacts/runs/${artifacts.plan.optimization_run_id}/trajectory.json`,
            round: record.round_number,
          },
          snapshot: {
            store: relative(source.project_root, source.ledger_path),
            table: "result_snapshots",
            id: snapshot.snapshot_id,
          },
        },
      }));
    }
  }

  matches.sort((left, right) =>
    right.observed_at.localeCompare(left.observed_at) ||
    String(left.run_id).localeCompare(String(right.run_id))
  );
  return searchExperimentRunsOutputSchema.parse({
    matches: matches.slice(0, filters.limit),
    has_more: matches.length > filters.limit,
  });
}

export function createExperimentHistoryTools(
  options: ExperimentHistoryToolOptions = {},
): readonly Tool[] {
  const source = options.source ?? defaultHistorySource;
  return [
    tool({
      name: "search_experiment_runs",
      description:
        "Search a small, structured set of completed historical experiment runs. Use this before proposing a creative to find relevant evidence and avoid repeating prior tests.",
      parameters: searchExperimentRunsInputSchema,
      outputSchema: searchExperimentRunsOutputSchema,
      execute: (input) =>
        searchExperimentRuns(
          {
            ...input,
            exclude_run_id: options.exclude_run_id ?? input.exclude_run_id,
          },
          source,
        ),
    }),
    tool({
      name: "get_experiment_trajectory",
      description:
        "Load the complete normalized evidence and creative lineage for one selected experiment run or optimization root returned by search_experiment_runs.",
      parameters: getExperimentTrajectoryInputSchema,
      outputSchema: getExperimentTrajectoryOutputSchema,
      execute: (input) => getExperimentTrajectory(input, source),
    }),
  ];
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
