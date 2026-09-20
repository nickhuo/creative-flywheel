import type {DecisionProposalRecord} from "../agent/ledger";
import type {
  ProposedAction,
  ResultSnapshot,
} from "../experiment/evaluation";
import type {ExperimentRun, ExperimentSummary} from "../experiment/run";
import {
  CREATIVE_LAYER_FIELDS,
  type RenderableCreativeManifest,
} from "../manifest";

type SummaryRow = {
  round: number;
  sample: string;
  effect: string;
  decision: string;
  agent: string;
};

export class SimulationReporter {
  readonly #enabled: boolean;
  readonly #rows: SummaryRow[] = [];

  constructor(enabled: boolean) {
    this.#enabled = enabled;
  }

  start(input: {
    root_run_id: string;
    max_rounds: number;
    model: string;
  }): void {
    if (!this.#enabled) return;
    console.log("\nCreative Flywheel local optimization");
    console.log(`  Run          ${input.root_run_id}`);
    console.log(`  Rounds       ${input.max_rounds}`);
    console.log(`  Model        ${input.model}`);
  }

  roundStarted(round: number, maxRounds: number, run: ExperimentRun): void {
    if (!this.#enabled) return;
    const [control, treatment] = run.experiment.arms;
    console.log(`\nRound ${round}/${maxRounds}`);
    console.log(`  Experiment   ${run.run_id}`);
    console.log(
      `  Traffic      ${formatInteger(run.traffic.users)} users · ` +
        `${control.allocation_percent}/${treatment.allocation_percent} split · ` +
        `batch ${formatInteger(run.traffic.batch_size)}`,
    );
    console.log(
      `  Arms         ${control.variant_id} → ${treatment.variant_id}`,
    );
    console.log(`  Hypothesis   ${run.experiment.hypothesis.statement}`);
    console.log("  Status       Simulating exposure and outcomes…");
  }

  trafficCompleted(
    summary: ExperimentSummary,
    snapshot: ResultSnapshot,
  ): void {
    if (!this.#enabled) return;
    const allocation = summary.arms
      .map(({variant_id: variantId, impressions}) =>
        `${variantId} ${formatInteger(impressions)}`
      )
      .join(" · ");
    console.log(`  Delivered    ${allocation}`);
    if (snapshot.primary_metric.status !== "ready") {
      console.log(`  Result       ${snapshot.primary_metric.status}`);
      return;
    }
    const metric = snapshot.primary_metric;
    console.log(
      `  Install      control ${formatPercent(metric.control.mean)} · ` +
        `treatment ${formatPercent(metric.treatment.mean)} · ` +
        `effect ${formatPercentagePoints(metric.absolute_effect)}`,
    );
    console.log(
      `  Confidence   ${formatInterval(
        metric.confidence_interval.lower,
        metric.confidence_interval.upper,
      )} · p=${formatPValue(metric.p_value)}`,
    );
  }

  agentStarted(input: {
    decision: "stop" | "promote";
    agent_name: string;
    prompt_version: string;
    model: string;
    champion_variant_id: string;
    snapshot_id: string;
  }): void {
    if (!this.#enabled) return;
    console.log(`  Policy       ${input.decision}`);
    console.log(
      `  Agent        ${input.agent_name} · ${input.prompt_version} · ${input.model}`,
    );
    console.log(
      `  Input        champion=${input.champion_variant_id} · ` +
        `snapshot=${input.snapshot_id.slice(0, 12)}`,
    );
    console.log(
      "  Tools        search_experiment_runs · get_experiment_trajectory",
    );
    console.log("  Status       Retrieving evidence and generating challenger…");
  }

  roundCompleted(input: {
    round: number;
    run: ExperimentRun;
    snapshot: ResultSnapshot;
    action: ProposedAction;
    proposal: DecisionProposalRecord;
    champion_manifest: RenderableCreativeManifest;
  }): void {
    if (!this.#enabled) return;
    const metric = input.snapshot.primary_metric;
    const effect = metric.status === "ready"
      ? formatPercentagePoints(metric.absolute_effect)
      : metric.status;
    const agent = input.proposal.model === "deterministic"
      ? "—"
      : input.proposal.prompt_version.startsWith("explore-")
        ? "Explore"
        : "Exploit";
    this.#rows.push({
      round: input.round,
      sample: formatInteger(input.run.traffic.users),
      effect,
      decision: input.action.action === "terminate"
        ? `terminate/${input.action.final_experiment_action}`
        : input.action.action,
      agent,
    });

    console.log(
      `  Decision     ${input.action.action}` +
        (input.action.action === "terminate"
          ? ` · final experiment action ${input.action.final_experiment_action}`
          : ""),
    );
    if (input.action.action === "terminate") {
      console.log(`  Champion     ${input.action.champion_variant_id}`);
      return;
    }

    const challenger = input.action.next_challenger;
    const changes = CREATIVE_LAYER_FIELDS.flatMap((layer) => {
      const before = input.champion_manifest.layers[layer];
      const after = challenger.layers[layer];
      return before === after ? [] : [`${layer}: ${before} → ${after}`];
    });
    console.log("  Agent output");
    console.log(`    Learning   ${challenger.evaluation.learning}`);
    console.log(`    Hypothesis ${challenger.hypothesis.statement}`);
    console.log(`    Mechanism  ${challenger.hypothesis.mechanism}`);
    console.log(`    Changes    ${changes.join(" · ")}`);
    for (const [index, evidence] of challenger.evidence.entries()) {
      console.log(`    Evidence ${index + 1}  ${evidence}`);
    }
  }

  nextRoundPrepared(run: ExperimentRun): void {
    if (!this.#enabled) return;
    console.log(
      `  Next         ${run.run_id} · sample ${formatInteger(
        run.statistical_design.required_users,
      )}`,
    );
  }

  complete(rootRunId: string): void {
    if (!this.#enabled) return;
    console.log("\nRun summary");
    console.table(this.#rows);
    console.log(`Artifacts: artifacts/runs/${rootRunId}`);
  }
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(3)}%`;
}

function formatPercentagePoints(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(3)} pp`;
}

function formatInterval(lower: number, upper: number): string {
  return `95% CI ${formatPercentagePoints(lower)} to ${formatPercentagePoints(upper)}`;
}

function formatPValue(value: number): string {
  return value < 0.001 ? value.toExponential(2) : value.toFixed(3);
}
