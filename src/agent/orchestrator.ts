import {sha256} from "../audience/model";
import {
  assessEligibility,
  decideExperimentAction,
  proposedActionSchema,
  resultSnapshotSchema,
  type EligibilityAssessment,
  type ProposedAction,
  type ResultSnapshot,
} from "../experiment/evaluation";
import {type ExperimentRun} from "../experiment/run";
import {CREATIVE_LAYER_FIELDS} from "../manifest";
import {
  CHALLENGER_LAYER_STRATEGY,
  CHALLENGER_PROMPT,
  challengerContextSchema,
  runChallengerAgent,
  type ChallengerAgentResult,
  type ChallengerContext,
} from "./challenger";
import {
  AgentLedger,
  type DecisionProposalRecord,
  type ObservationTrigger,
} from "./ledger";

export const EXPERIMENT_POLICY_VERSION = "experiment-policy-v6";

export type ChallengerRunner = (
  run: ExperimentRun,
  snapshot: ResultSnapshot,
  context: ChallengerContext,
  decision: "stop" | "promote",
  config: {model: string; tracingDisabled?: boolean},
) => Promise<ChallengerAgentResult>;

export type EvaluateSnapshotInput = {
  run: ExperimentRun;
  snapshot: ResultSnapshot;
  trigger: ObservationTrigger;
  observed_at: string;
  model: string;
  ledger: AgentLedger;
  challenger_context: ChallengerContext;
  propose_challenger?: ChallengerRunner;
  tracing_disabled?: boolean;
};

export type EvaluationOutcome = {
  snapshot_id: string;
  eligibility: EligibilityAssessment;
  proposal: DecisionProposalRecord | null;
  action: ProposedAction | null;
};

export async function evaluateSnapshot(
  input: EvaluateSnapshotInput,
): Promise<EvaluationOutcome> {
  const snapshot = resultSnapshotSchema.parse(input.snapshot);
  const runtime = input.ledger.getRuntime(input.run.run_id);
  const existingProposals = input.ledger.listProposals().filter((proposal) => {
    const proposalSnapshot = input.ledger.getSnapshot(proposal.snapshot_id);
    return proposalSnapshot?.run_id === input.run.run_id;
  });
  const persisted = input.ledger.recordSnapshot({
    snapshot_id: snapshot.snapshot_id,
    run_id: snapshot.run_id,
    trigger: input.trigger,
    observed_at: input.observed_at,
    recorded_at: input.observed_at,
    payload: snapshot,
  });
  const persistedSnapshot = resultSnapshotSchema.parse(persisted.payload);
  const currentVersionProposals = existingProposals.filter(
    ({policy_version, prompt_version}) =>
      policy_version === EXPERIMENT_POLICY_VERSION &&
      prompt_version === CHALLENGER_PROMPT.version,
  );
  const eligibility = assessEligibility(input.run, persistedSnapshot, {
    previousSnapshotId: currentVersionProposals[0]?.snapshot_id ?? null,
    hasPendingProposal: currentVersionProposals.some(
      ({status}) => status === "pending",
    ),
    cooldownUntil: runtime?.cooldown_until ?? null,
    now: input.observed_at,
  });
  if (eligibility.status !== "ready") {
    return {
      snapshot_id: persistedSnapshot.snapshot_id,
      eligibility,
      proposal: null,
      action: null,
    };
  }

  const context = challengerContextSchema.parse(input.challenger_context);
  const [controlArm, treatmentArm] = input.run.experiment.arms;
  if (
    context.control_manifest.variant_id !== controlArm.variant_id ||
    context.treatment_manifest.variant_id !== treatmentArm.variant_id
  ) {
    throw new Error("Challenger context manifests do not match experiment arms.");
  }
  const primaryMetric = persistedSnapshot.primary_metric;
  if (primaryMetric.status !== "ready") {
    throw new Error("Eligible evidence must contain a ready primary metric.");
  }
  const decision = decideExperimentAction(
    input.run,
    persistedSnapshot,
  );
  const isFinalRound = context.round === context.max_rounds;
  const challengerResult = isFinalRound
    ? null
    : await (input.propose_challenger ?? runChallengerAgent)(
        input.run,
        persistedSnapshot,
        context,
        decision,
        {
          model: input.model,
          tracingDisabled: input.tracing_disabled,
        },
      );

  if (challengerResult !== null) {
    const champion = decision === "promote"
      ? context.treatment_manifest
      : context.control_manifest;
    const challengerLayers = JSON.stringify(challengerResult.challenger.layers);
    const changedLayers = CREATIVE_LAYER_FIELDS.filter(
      (layer) =>
        challengerResult.challenger.layers[layer] !== champion.layers[layer],
    );
    const strategy = CHALLENGER_LAYER_STRATEGY[decision];
    if (
      changedLayers.length < strategy.minimum_changed_layers ||
      changedLayers.length > strategy.maximum_changed_layers
    ) {
      throw new Error(
        `${strategy.mode} challenger must change ${strategy.minimum_changed_layers}` +
          (strategy.minimum_changed_layers === strategy.maximum_changed_layers
            ? ""
            : `-${strategy.maximum_changed_layers}`) +
          ` layer(s); received ${changedLayers.length}: ${changedLayers.join(", ") || "none"}.`,
      );
    }
    const testedLayers = [
      context.control_manifest.layers,
      context.treatment_manifest.layers,
      ...context.experiment_history.flatMap(
        ({control_manifest, treatment_manifest}) => [
          control_manifest.layers,
          treatment_manifest.layers,
        ],
      ),
    ];
    if (
      testedLayers.some(
        (layers) => JSON.stringify(layers) === challengerLayers,
      )
    ) {
      throw new Error("Challenger agent proposed a previously tested creative.");
    }
  }

  const metricEvidence = [
    `${primaryMetric.name}: control=${primaryMetric.control.mean}, treatment=${primaryMetric.treatment.mean}.`,
    `absolute_effect=${primaryMetric.absolute_effect}, p_value=${primaryMetric.p_value}.`,
    `confidence_interval=[${primaryMetric.confidence_interval.lower}, ${primaryMetric.confidence_interval.upper}].`,
  ];
  const common = {
    schema_version: 5 as const,
    snapshot_id: persistedSnapshot.snapshot_id,
    evidence: metricEvidence,
  };
  const proposal = proposedActionSchema.parse(
    challengerResult === null
      ? {
          ...common,
          action: "terminate",
          final_experiment_action: decision,
          champion_variant_id: decision === "promote"
            ? treatmentArm.variant_id
            : controlArm.variant_id,
          summary:
            "Record the final experiment outcome and terminate optimization.",
          rationale:
            `The final experiment resolved to ${decision}; round ${context.round} reached max_rounds=${context.max_rounds}.`,
          evidence: [
            ...metricEvidence,
            `round=${context.round} equals max_rounds=${context.max_rounds}.`,
          ],
        }
      : decision === "promote"
        ? {
            ...common,
            action: "promote",
            variant_id: treatmentArm.variant_id,
            summary: "Promote the treatment and test the next challenger.",
            rationale:
              "The treatment has a statistically significant positive primary-metric effect under the fixed-horizon policy.",
            next_challenger: challengerResult.challenger,
          }
        : {
            ...common,
            action: "stop",
            summary: "Retain the control and test the next challenger.",
            rationale:
              "The treatment did not satisfy the fixed-horizon promotion rule.",
            next_challenger: challengerResult.challenger,
          },
  );
  const proposalId = sha256(
    JSON.stringify({
      snapshot_id: persistedSnapshot.snapshot_id,
      policy_version: EXPERIMENT_POLICY_VERSION,
      prompt_version: CHALLENGER_PROMPT.version,
      proposal,
    }),
  );
  const record = input.ledger.recordProposal({
    proposal_id: proposalId,
    snapshot_id: persistedSnapshot.snapshot_id,
    action_type: proposal.action,
    policy_version: EXPERIMENT_POLICY_VERSION,
    prompt_version: CHALLENGER_PROMPT.version,
    model: challengerResult === null ? "deterministic" : input.model,
    created_at: input.observed_at,
    payload: {
      proposal,
      decision_source: "deterministic",
      ...(challengerResult?.lastResponseId === undefined
        ? {}
        : {last_response_id: challengerResult.lastResponseId}),
    },
  });

  return {
    snapshot_id: persistedSnapshot.snapshot_id,
    eligibility,
    proposal: record,
    action: proposal,
  };
}
