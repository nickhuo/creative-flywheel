import {appendFile, mkdir, readdir, rename, writeFile} from "node:fs/promises";
import {basename, dirname, relative, resolve} from "node:path";

import {audienceModelSchema, sha256} from "../audience/model";
import {type ChallengerContext} from "../agent/challenger";
import {
  AgentLedger,
  type DecisionProposalRecord,
  type ObservationTrigger,
  type ProposalStatus,
} from "../agent/ledger";
import {evaluateSnapshot} from "../agent/orchestrator";
import {
  type ProposedAction,
  type ResultSnapshot,
} from "../experiment/evaluation";
import {
  experimentRunIdSchema,
  experimentRunSchema,
  summarizeExperimentEvents,
  type ExperimentEventRecord,
  type ExperimentRun,
} from "../experiment/run";
import {
  createNextSimulationRun,
  createSimulatedResultSnapshot,
  simulateExperimentBatch,
} from "../experiment/simulation";
import {normalizeStatsigObservation} from "../experiment/statsig-results";
import {StatsigConsoleClient} from "../experiment/statsig";
import {
  renderableCreativeManifestSchema,
  type RenderableCreativeManifest,
} from "../manifest";

const OBSERVATION_INTERVAL_MS = 60 * 60 * 1000;
const LEASE_DURATION_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ROUNDS = 10;
const projectRoot = resolve(import.meta.dir, "../..");
const experimentsDirectory = resolve(projectRoot, "artifacts/experiments");
const defaultLedgerPath = resolve(projectRoot, "artifacts/agent/state.sqlite");

const [command, ...arguments_] = Bun.argv.slice(2);

if (command === "tick") {
  await tickCommand(arguments_);
} else if (command === "simulate") {
  await simulateCommand(arguments_);
} else if (command === "proposals") {
  await proposalsCommand(arguments_);
} else if (command === "approve") {
  await reviewCommand(arguments_, "approved");
} else if (command === "reject") {
  await reviewCommand(arguments_, "rejected");
} else {
  throw new Error(
    "Usage: bun run agent <tick|simulate|proposals|approve|reject> [options]",
  );
}

async function simulateCommand(arguments_: string[]): Promise<void> {
  const rootRunId = experimentRunIdSchema.parse(
    readFlag(arguments_, "--run-id"),
  );
  const maxRounds = Number(
    readOptionalFlag(arguments_, "--max-rounds") ?? DEFAULT_MAX_ROUNDS,
  );
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1) {
    throw new RangeError("--max-rounds must be a positive integer.");
  }
  let run = await loadRun(
    resolve(experimentsDirectory, rootRunId, "run.json"),
  );
  const audienceModel = audienceModelSchema.parse(
    await Bun.file(resolve(projectRoot, run.audience_model.path)).json(),
  );
  const model = requiredEnvironmentVariable("OPENAI_MODEL");
  let simulationTime = Date.parse(run.prepared_at);
  if (Number.isNaN(simulationTime)) {
    throw new Error(`Run ${rootRunId} has an invalid prepared_at timestamp.`);
  }
  const ledger = await openLedger();
  try {
    const experimentHistory: ChallengerContext["experiment_history"] = [];
    const trajectory: unknown[] = [];
    let termination: "max_rounds" | null = null;

    for (let round = 1; round <= maxRounds; round += 1) {
      const {controlManifest, treatmentManifest} = await loadRunManifests(run);
      const initialObservedAt = new Date(simulationTime).toISOString();
      if (ledger.getRuntime(run.run_id) === null) {
        ledger.upsertRuntime({
          run_id: run.run_id,
          next_observation_at: null,
          lease_until: null,
          cooldown_until: null,
          updated_at: initialObservedAt,
        });
      }

      const events: ExperimentEventRecord[] = [];
      const batches: unknown[] = [];
      let finalSnapshot: ResultSnapshot | null = null;
      let finalAction: ProposedAction | null = null;
      let finalProposal: DecisionProposalRecord | null = null;
      for (
        let start = 0, batch = 1;
        start < run.traffic.users;
        start += run.traffic.batch_size, batch += 1
      ) {
        simulationTime += 60_000;
        const observedAt = new Date(simulationTime).toISOString();
        events.push(
          ...simulateExperimentBatch(
            run,
            audienceModel,
            controlManifest,
            treatmentManifest,
            start,
            run.traffic.batch_size,
            observedAt,
          ),
        );
        const summary = summarizeExperimentEvents(run, events);
        const snapshot = createSimulatedResultSnapshot(run, summary, observedAt);
        const outcome = await evaluateSnapshot({
          run,
          snapshot,
          trigger: "manual",
          observed_at: observedAt,
          model,
          ledger,
          challenger_context: {
            round,
            max_rounds: maxRounds,
            control_manifest: controlManifest,
            treatment_manifest: treatmentManifest,
            experiment_history: experimentHistory,
          },
          tracing_disabled: Bun.env.OPENAI_AGENTS_DISABLE_TRACING === "1",
        });
        batches.push({
          batch,
          cumulative_users: summary.users,
          arms: summary.arms,
          snapshot_id: outcome.snapshot_id,
          eligibility: outcome.eligibility,
          proposal: outcome.proposal,
        });
        if (outcome.action !== null) {
          finalSnapshot = snapshot;
          finalAction = outcome.action;
          finalProposal = outcome.proposal;
        }
      }

      if (
        finalSnapshot === null ||
        finalAction === null ||
        finalProposal === null
      ) {
        throw new Error(`Run ${run.run_id} completed without a workflow action.`);
      }
      if (finalProposal.status !== "pending") {
        throw new Error(
          `Run ${run.run_id} proposal is already ${finalProposal.status}.`,
        );
      }
      const reviewedAt = new Date(simulationTime).toISOString();
      const approvedProposal = ledger.approveProposal(
        finalProposal.proposal_id,
        {
          reviewed_at: reviewedAt,
          reviewed_by: "local_simulator",
          review_note: "Automatically approved inside the local simulator.",
        },
      );
      experimentHistory.push({
        run_id: run.run_id,
        hypothesis: run.experiment.hypothesis.statement,
        control_manifest: controlManifest,
        treatment_manifest: treatmentManifest,
        primary_metric: finalSnapshot.primary_metric,
        secondary_metrics: finalSnapshot.secondary_metrics,
        decision: finalAction,
      });

      const idempotencyKey = `${approvedProposal.proposal_id}:${finalAction.action}`;
      if (finalAction.action === "terminate") {
        const receipt = ledger.recordActionReceipt({
          receipt_id: sha256(idempotencyKey),
          proposal_id: approvedProposal.proposal_id,
          idempotency_key: idempotencyKey,
          action_type: finalAction.action,
          status: "succeeded",
          recorded_at: reviewedAt,
          payload: {
            effect: "optimization_terminated",
            run_id: run.run_id,
            round,
            final_experiment_action: finalAction.final_experiment_action,
            champion_variant_id: finalAction.champion_variant_id,
          },
        });
        trajectory.push({
          round,
          run_id: run.run_id,
          hypothesis: run.experiment.hypothesis,
          batch_size: run.traffic.batch_size,
          required_users: run.statistical_design.required_users,
          batches,
          action: finalAction,
          action_receipt: receipt,
        });
        termination = "max_rounds";
        break;
      }

      const nextRound = round + 1;
      const nextRunId = experimentRunIdSchema.parse(
        `${rootRunId}_round_${nextRound.toString().padStart(2, "0")}`,
      );
      const nextRunDirectory = resolve(experimentsDirectory, nextRunId);
      const challengerPath = resolve(nextRunDirectory, "challenger.json");
      const nextRunPath = resolve(nextRunDirectory, "run.json");
      if (
        (await Bun.file(challengerPath).exists()) ||
        (await Bun.file(nextRunPath).exists())
      ) {
        throw new Error(`Next-round artifacts already exist for ${nextRunId}.`);
      }
      simulationTime += 60_000;
      if (finalSnapshot.primary_metric.status !== "ready") {
        throw new Error("The final snapshot must contain a ready primary metric.");
      }
      const championBaselineRate = finalAction.action === "promote"
        ? finalSnapshot.primary_metric.treatment.mean
        : finalSnapshot.primary_metric.control.mean;
      const next = createNextSimulationRun({
        next_run_id: nextRunId,
        prepared_at: new Date(simulationTime).toISOString(),
        challenger_manifest_path: relative(projectRoot, challengerPath),
        current_run: run,
        audience_model: audienceModel,
        control_manifest: controlManifest,
        treatment_manifest: treatmentManifest,
        champion_baseline_rate: championBaselineRate,
        action: finalAction,
      });
      await writeJsonNew(challengerPath, next.challenger_manifest);
      await writeJsonNew(nextRunPath, next.run);
      const receipt = ledger.recordActionReceipt({
        receipt_id: sha256(idempotencyKey),
        proposal_id: approvedProposal.proposal_id,
        idempotency_key: idempotencyKey,
        action_type: finalAction.action,
        status: "succeeded",
        recorded_at: reviewedAt,
        payload: {
          effect: finalAction.action === "promote"
            ? "treatment_promoted_and_next_run_prepared"
            : "control_retained_and_next_run_prepared",
          run_id: run.run_id,
          round,
          champion_variant_id: next.champion_manifest.variant_id,
          challenger_variant_id: next.challenger_manifest.variant_id,
          next_run_id: next.run.run_id,
        },
      });
      trajectory.push({
        round,
        run_id: run.run_id,
        hypothesis: run.experiment.hypothesis,
        batch_size: run.traffic.batch_size,
        required_users: run.statistical_design.required_users,
        batches,
        action: finalAction,
        action_receipt: receipt,
        next_run: next.run,
      });
      run = next.run;
    }

    if (termination === null) termination = "max_rounds";
    console.log(
      JSON.stringify(
        {
          source: "simulator",
          root_run_id: rootRunId,
          max_rounds: maxRounds,
          termination,
          trajectory,
        },
        null,
        2,
      ),
    );
  } finally {
    ledger.close();
  }
}

async function tickCommand(arguments_: string[]): Promise<void> {
  const requestedRunId = readOptionalFlag(arguments_, "--run-id");
  const trigger = parseTrigger(
    readOptionalFlag(arguments_, "--trigger") ??
      (requestedRunId === undefined ? "cron" : "manual"),
  );
  const observedAt = new Date().toISOString();
  const runPaths = await findRunPaths(requestedRunId);
  const ledger = await openLedger();
  const client = new StatsigConsoleClient(
    requiredEnvironmentVariable("STATSIG_CONSOLE_API_KEY"),
  );
  const model = Bun.env.OPENAI_MODEL?.trim() ?? "";
  const outcomes: unknown[] = [];
  let hasFailure = false;

  try {
    for (const runPath of runPaths) {
      let run = await loadRun(runPath);
      if (run.status !== "served" && run.status !== "awaiting_results") {
        continue;
      }
      const runtime = ledger.getRuntime(run.run_id);
      if (
        trigger === "cron" &&
        runtime?.next_observation_at !== null &&
        runtime?.next_observation_at !== undefined &&
        runtime.next_observation_at > observedAt
      ) {
        continue;
      }
      if (runtime === null) {
        ledger.upsertRuntime({
          run_id: run.run_id,
          next_observation_at: null,
          lease_until: null,
          cooldown_until: null,
          updated_at: observedAt,
        });
      }
      const leaseUntil = new Date(
        Date.parse(observedAt) + LEASE_DURATION_MS,
      ).toISOString();
      if (!ledger.acquireLease(run.run_id, observedAt, leaseUntil)) {
        outcomes.push({run_id: run.run_id, status: "already_claimed"});
        continue;
      }

      try {
        if (run.status === "served") {
          run = experimentRunSchema.parse({
            ...run,
            status: "awaiting_results",
          });
          await writeJsonAtomic(runPath, run);
        }
        const observation = await client.observeExperiment(run);
        await appendObservation(run.run_id, observedAt, observation);
        const snapshot = normalizeStatsigObservation(
          run,
          observation,
          observedAt,
        );
        const {controlManifest, treatmentManifest} = await loadRunManifests(run);
        const outcome = await evaluateSnapshot({
          run,
          snapshot,
          trigger,
          observed_at: observedAt,
          model,
          ledger,
          challenger_context: {
            round: 1,
            max_rounds: DEFAULT_MAX_ROUNDS,
            control_manifest: controlManifest,
            treatment_manifest: treatmentManifest,
            experiment_history: [],
          },
          tracing_disabled: Bun.env.OPENAI_AGENTS_DISABLE_TRACING === "1",
        });
        const nextObservationAt = new Date(
          Date.parse(observedAt) + OBSERVATION_INTERVAL_MS,
        ).toISOString();
        if (
          !ledger.completeObservation(
            run.run_id,
            leaseUntil,
            nextObservationAt,
            runtime?.cooldown_until ?? null,
            observedAt,
          )
        ) {
          throw new Error(`Lost observation lease for run ${run.run_id}.`);
        }
        outcomes.push({run_id: run.run_id, status: "observed", ...outcome});
      } catch (error) {
        hasFailure = true;
        ledger.releaseLease(run.run_id, leaseUntil, observedAt);
        outcomes.push({
          run_id: run.run_id,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    ledger.close();
  }

  console.log(JSON.stringify({trigger, observed_at: observedAt, outcomes}, null, 2));
  if (hasFailure) process.exitCode = 1;
}

async function proposalsCommand(arguments_: string[]): Promise<void> {
  const statusFlag = readOptionalFlag(arguments_, "--status");
  const status = statusFlag === undefined ? undefined : parseProposalStatus(statusFlag);
  const ledger = await openLedger();
  try {
    console.log(JSON.stringify({proposals: ledger.listProposals(status)}, null, 2));
  } finally {
    ledger.close();
  }
}

async function reviewCommand(
  arguments_: string[],
  decision: "approved" | "rejected",
): Promise<void> {
  const proposalId = readFlag(arguments_, "--proposal-id");
  const reviewedBy = readFlag(arguments_, "--reviewed-by");
  const note = readOptionalFlag(arguments_, "--note");
  const reviewedAt = new Date().toISOString();
  const ledger = await openLedger();
  try {
    const proposal = ledger.getProposal(proposalId);
    if (proposal === null) throw new Error(`Proposal not found: ${proposalId}`);
    if (decision === "approved") {
      const snapshot = ledger.getSnapshot(proposal.snapshot_id);
      if (snapshot === null) {
        throw new Error(`Snapshot not found: ${proposal.snapshot_id}`);
      }
      const runtime = ledger.getRuntime(snapshot.run_id);
      if (runtime?.last_snapshot_id !== proposal.snapshot_id) {
        throw new Error(
          `Proposal ${proposalId} is stale and cannot be approved.`,
        );
      }
    }
    const reviewed = decision === "approved"
      ? ledger.approveProposal(proposalId, {
          reviewed_at: reviewedAt,
          reviewed_by: reviewedBy,
          review_note: note,
        })
      : ledger.rejectProposal(proposalId, {
          reviewed_at: reviewedAt,
          reviewed_by: reviewedBy,
          review_note: note,
        });
    console.log(
      JSON.stringify(
        {
          proposal: reviewed,
          executor_status:
            decision === "approved" ? "not_implemented" : "not_required",
        },
        null,
        2,
      ),
    );
  } finally {
    ledger.close();
  }
}

async function findRunPaths(requestedRunId?: string): Promise<string[]> {
  if (requestedRunId !== undefined) {
    return [resolve(experimentsDirectory, requestedRunId, "run.json")];
  }
  let entries;
  try {
    entries = await readdir(experimentsDirectory, {withFileTypes: true});
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(experimentsDirectory, entry.name, "run.json"))
    .sort();
}

async function loadRun(path: string): Promise<ExperimentRun> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`Run not found: ${path}`);
  const run = experimentRunSchema.parse(await file.json());
  if (run.run_id !== basename(dirname(path))) {
    throw new Error(`Run ID does not match its artifact directory: ${path}`);
  }
  return run;
}

async function loadRunManifests(run: ExperimentRun): Promise<{
  controlManifest: RenderableCreativeManifest;
  treatmentManifest: RenderableCreativeManifest;
}> {
  const [controlArm, treatmentArm] = run.experiment.arms;
  const controlManifest = renderableCreativeManifestSchema.parse(
    await Bun.file(resolve(projectRoot, controlArm.manifest.path)).json(),
  );
  const treatmentManifest = renderableCreativeManifestSchema.parse(
    await Bun.file(resolve(projectRoot, treatmentArm.manifest.path)).json(),
  );
  return {controlManifest, treatmentManifest};
}

async function appendObservation(
  runId: string,
  observedAt: string,
  observation: unknown,
): Promise<void> {
  const path = resolve(experimentsDirectory, runId, "observations.jsonl");
  await mkdir(dirname(path), {recursive: true});
  await appendFile(
    path,
    `${JSON.stringify({run_id: runId, observed_at: observedAt, observation})}\n`,
  );
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const pendingPath = `${path}.partial`;
  await writeFile(pendingPath, `${JSON.stringify(value, null, 2)}\n`);
  await rename(pendingPath, path);
}

async function writeJsonNew(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), {recursive: true});
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {flag: "wx"});
}

async function openLedger(): Promise<AgentLedger> {
  const configuredPath = Bun.env.SIMULA_AGENT_DB?.trim();
  const path = configuredPath === undefined || configuredPath === ""
    ? defaultLedgerPath
    : resolve(projectRoot, configuredPath);
  await mkdir(dirname(path), {recursive: true});
  return new AgentLedger(path);
}

function parseTrigger(value: string): ObservationTrigger {
  if (value === "cron" || value === "manual" || value === "provider_event") {
    return value;
  }
  throw new Error("--trigger must be cron, manual, or provider_event.");
}

function parseProposalStatus(value: string): ProposalStatus {
  if (value === "pending" || value === "approved" || value === "rejected") {
    return value;
  }
  throw new Error("--status must be pending, approved, or rejected.");
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
