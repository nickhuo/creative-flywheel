import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {randomUUID} from "node:crypto";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {after, before, test} from "node:test";
import {setTimeout} from "node:timers/promises";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";

import {ApplicationFailure} from "@temporalio/activity";
import {WorkflowExecutionAlreadyStartedError, WorkflowFailedError} from "@temporalio/client";
import type {WorkflowHandle} from "@temporalio/client";
import {TestWorkflowEnvironment} from "@temporalio/testing";
import {bundleWorkflowCode, DefaultLogger, Runtime, Worker} from "@temporalio/worker";
import type {WorkflowBundle} from "@temporalio/worker";

import {observeExperiment} from "../src/agent/durable-activities";
import type {ObservationStep} from "../src/agent/durable-activities";
import type {watchExperiment} from "../src/agent/durable-workflow";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const workflowsPath = fileURLToPath(new URL("../src/agent/durable-workflow.ts", import.meta.url));
const waiting: ObservationStep = {status: "waiting", reasons: ["primary_metric_pending"], proposal_id: null};
const completed: ObservationStep = {status: "completed", reasons: [], proposal_id: "proposal-1"};
let environment: TestWorkflowEnvironment;
let workflowBundle: WorkflowBundle;

before(async () => {
  Runtime.install({logger: new DefaultLogger("ERROR")});
  workflowBundle = await bundleWorkflowCode({workflowsPath});
  environment = await TestWorkflowEnvironment.createLocal();
}, {timeout: 120_000});

after(async () => { await environment?.teardown(); });

async function createWorker(taskQueue: string, activity: typeof observeExperiment): Promise<Worker> {
  return Worker.create({
    connection: environment.nativeConnection,
    taskQueue,
    workflowBundle,
    activities: {observeExperiment: activity},
    maxConcurrentActivityTaskExecutions: 1,
  });
}

async function waitForStatus(handle: WorkflowHandle<typeof watchExperiment>, status: ObservationStep["status"]): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const latest = await handle.query<ObservationStep | null>("observationStatus");
    if (latest?.status === status) return;
    await setTimeout(25);
  }
  assert.fail(`Workflow did not reach ${status}`);
}

test("durable timer polls pending results and completes with a proposal; history replays", {timeout: 30_000}, async () => {
  const id = randomUUID();
  let observations = 0;
  const worker = await createWorker(id, async () => ++observations === 1 ? waiting : completed);
  const handle = await environment.client.workflow.start<typeof watchExperiment>("watchExperiment", {
    workflowId: id, taskQueue: id,
    args: [{run_id: "test", max_rounds: 10, poll_interval_ms: 1000}],
    workflowIdReusePolicy: "ALLOW_DUPLICATE_FAILED_ONLY",
  });
  assert.deepEqual(await worker.runUntil(handle.result()), completed);
  assert.equal(observations, 2);
  await Worker.runReplayHistory({workflowBundle}, await handle.fetchHistory());
  await assert.rejects(environment.client.workflow.start("watchExperiment", {
    workflowId: id, taskQueue: id, args: [], workflowIdReusePolicy: "ALLOW_DUPLICATE_FAILED_ONLY",
  }), WorkflowExecutionAlreadyStartedError);
});

test("a new Worker resumes persisted waiting state and a signal wakes it", {timeout: 30_000}, async () => {
  const id = randomUUID();
  const firstWorker = await createWorker(id, async () => waiting);
  const handle = await environment.client.workflow.start<typeof watchExperiment>("watchExperiment", {
    workflowId: id, taskQueue: id,
    args: [{run_id: "restart", max_rounds: 10, poll_interval_ms: 3_600_000}],
  });
  await firstWorker.runUntil(() => waitForStatus(handle, "waiting"));
  await handle.signal("checkNow");
  let resumedObservations = 0;
  const secondWorker = await createWorker(id, async () => { resumedObservations++; return completed; });
  assert.deepEqual(await secondWorker.runUntil(handle.result()), completed);
  assert.equal(resumedObservations, 1);
});

test("transient Activity failure is retried", {timeout: 30_000}, async () => {
  const id = randomUUID();
  let attempts = 0;
  const worker = await createWorker(id, async () => {
    if (++attempts === 1) throw ApplicationFailure.retryable("provider unavailable");
    return completed;
  });
  const outcome = await worker.runUntil(() => environment.client.workflow.execute("watchExperiment", {
    workflowId: id, taskQueue: id,
    args: [{run_id: "retry", max_rounds: 10, poll_interval_ms: 1000}],
  }));
  assert.deepEqual(outcome, completed);
  assert.equal(attempts, 2);
});

test("non-retryable authorization failure stops the workflow", {timeout: 30_000}, async () => {
  const id = randomUUID();
  let attempts = 0;
  const worker = await createWorker(id, async () => {
    attempts++;
    throw ApplicationFailure.nonRetryable("invalid credentials", "StatsigAuthorizationError");
  });
  await worker.runUntil(async () => {
    await assert.rejects(environment.client.workflow.execute("watchExperiment", {
      workflowId: id, taskQueue: id,
      args: [{run_id: "auth", max_rounds: 10, poll_interval_ms: 1000}],
    }), WorkflowFailedError);
  });
  assert.equal(attempts, 1);
});

test("blocked evidence waits for an explicit signal, then resumes", {timeout: 30_000}, async () => {
  const id = randomUUID();
  let observations = 0;
  const worker = await createWorker(id, async () => ++observations === 1
    ? {status: "blocked", reasons: ["health_check_failed"], proposal_id: null}
    : completed);
  const handle = await environment.client.workflow.start<typeof watchExperiment>("watchExperiment", {
    workflowId: id, taskQueue: id,
    args: [{run_id: "blocked", max_rounds: 10, poll_interval_ms: 1000}],
  });
  await worker.runUntil(async () => {
    await waitForStatus(handle, "blocked");
    await setTimeout(1200);
    assert.equal(observations, 1);
    await handle.signal("checkNow");
    assert.deepEqual(await handle.result(), completed);
  });
});

test("real Bun Activity blocks unserved runs, cancels, and recovers a persisted proposal on restart", {timeout: 30_000}, async () => {
  const id = `temporal_${randomUUID().replaceAll("-", "")}`;
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "flywheel-temporal-"));
  const previousDatabase = process.env.SIMULA_AGENT_DB;
  const previousConsoleKey = process.env.STATSIG_CONSOLE_API_KEY;
  process.env.SIMULA_AGENT_DB = join(temporaryDirectory, "state.sqlite");
  process.env.STATSIG_CONSOLE_API_KEY = "test-no-network";
  try {
    await promisify(execFile)(process.env.BUN_EXECUTABLE ?? "bun", [
      "run", "src/cli/experiment.ts", "prepare", "--run-id", id,
      "--baseline-rate", "0.01", "--mde", "0.5", "--batch-size", "2",
    ], {cwd: projectRoot});
    const worker = await createWorker(id, observeExperiment);
    const handle = await environment.client.workflow.start<typeof watchExperiment>("watchExperiment", {
      workflowId: id, taskQueue: id,
      args: [{run_id: id, max_rounds: 10, poll_interval_ms: 1000}],
    });
    await worker.runUntil(async () => {
      await waitForStatus(handle, "blocked");
      const observation = await handle.query<ObservationStep>("observationStatus");
      assert.match(observation.reasons[0]!, /prepared/);
      await handle.cancel();
      await assert.rejects(handle.result(), WorkflowFailedError);
      assert.equal((await handle.describe()).status.name, "CANCELLED");
    });

    // Final-round simulation seeds a real ledger proposal without a model or provider call.
    const simulation = await promisify(execFile)(process.env.BUN_EXECUTABLE ?? "bun", [
      "run", "src/cli/agent.ts", "simulate", "--run-id", id, "--max-rounds", "1",
    ], {cwd: projectRoot});
    const trajectory = JSON.parse(simulation.stdout) as {
      trajectory: {proposal: {proposal_id: string}}[];
    };
    const recoveryWorker = await createWorker(id, observeExperiment);
    const recovered = await recoveryWorker.runUntil(() => environment.client.workflow.execute<typeof watchExperiment>("watchExperiment", {
      workflowId: id, taskQueue: id,
      args: [{run_id: id, max_rounds: 1, poll_interval_ms: 1000}],
      workflowIdReusePolicy: "ALLOW_DUPLICATE_FAILED_ONLY",
    }));
    assert.deepEqual(recovered, {
      status: "completed", reasons: [], proposal_id: trajectory.trajectory[0]!.proposal.proposal_id,
    });
  } finally {
    if (previousDatabase === undefined) delete process.env.SIMULA_AGENT_DB;
    else process.env.SIMULA_AGENT_DB = previousDatabase;
    if (previousConsoleKey === undefined) delete process.env.STATSIG_CONSOLE_API_KEY;
    else process.env.STATSIG_CONSOLE_API_KEY = previousConsoleKey;
    await rm(join(projectRoot, "artifacts/runs", id), {recursive: true, force: true});
    await rm(temporaryDirectory, {recursive: true, force: true});
  }
});
