import {expect, test} from "bun:test";
import {Database} from "bun:sqlite";
import {randomUUID} from "node:crypto";
import {mkdtemp, readdir, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";

import {experimentLogRecordSchema} from "../src/artifacts";
import {AgentLedger} from "../src/agent/ledger";
import {createResultSnapshot} from "../src/experiment/evaluation";
import {experimentRunSchema} from "../src/experiment/run";
import {StatsigConsoleClient} from "../src/experiment/statsig";

const projectRoot = resolve(import.meta.dir, "..");

test("snapshot identity ignores repeated observation time", () => {
  const evidence = {
    schema_version: 1 as const,
    run_id: "snapshot_test",
    data_through: null,
    source: {provider: "simulator" as const, experiment_id: "experiment"},
    analysis: "fixed_horizon" as const,
    exposure_groups: [
      {
        group_id: "control",
        variant_id: "g0_v00",
        role: "control" as const,
        exposures: 10,
      },
      {
        group_id: "treatment",
        variant_id: "g0_v01",
        role: "treatment" as const,
        exposures: 10,
      },
    ],
    health_issues: [],
    primary_metric: {
      name: "install_rate_user",
      status: "pending" as const,
      reason: "Waiting for results.",
    },
    secondary_metrics: [],
  };
  const first = createResultSnapshot({
    ...evidence,
    observed_at: "2026-09-19T00:00:00.000Z",
  });
  const repeated = createResultSnapshot({
    ...evidence,
    observed_at: "2026-09-19T01:00:00.000Z",
  });
  expect(repeated.snapshot_id).toBe(first.snapshot_id);

  const ledger = new AgentLedger();
  try {
    ledger.recordSnapshot({
      snapshot_id: first.snapshot_id,
      run_id: first.run_id,
      trigger: "manual",
      observed_at: first.observed_at,
      recorded_at: first.observed_at,
      payload: first,
    });
    const persisted = ledger.recordSnapshot({
      snapshot_id: repeated.snapshot_id,
      run_id: repeated.run_id,
      trigger: "cron",
      observed_at: repeated.observed_at,
      recorded_at: repeated.observed_at,
      payload: repeated,
    });
    expect(persisted.observed_at).toBe(first.observed_at);
  } finally {
    ledger.close();
  }
});

test(
  "prepares and simulates a complete local experiment",
  async () => {
    const runId = `e2e_${randomUUID().replaceAll("-", "")}`;
    const runDirectory = join(
      projectRoot,
      "artifacts",
      "runs",
      runId,
    );
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "simula-e2e-"));
    const ledgerPath = join(temporaryDirectory, "state.sqlite");
    const environment = {SIMULA_AGENT_DB: ledgerPath};

    try {
      const prepareOutput = await runCli(
        [
          "src/cli/experiment.ts",
          "prepare",
          "--run-id",
          runId,
          "--baseline-rate",
          "0.01",
          "--mde",
          "0.5",
          "--batch-size",
          "2",
        ],
        environment,
      );
      const prepared = JSON.parse(prepareOutput) as {
        status: string;
        statistical_design: {required_users: number};
      };

      expect(prepared.status).toBe("prepared");
      expect(prepared.statistical_design.required_users).toBe(22);
      const run = experimentRunSchema.parse(
        experimentLogRecordSchema.parse(
          (
            await Bun.file(join(runDirectory, "experiments.json")).json() as
              unknown[]
          ).at(-1),
        ).experiment,
      );
      expect(run.experiment.primary_metric).toEqual({
        name: "install_rate_user",
        type: "event_user",
      });
      expect(run.experiment.secondary_metrics).toEqual([
        {name: "ctr_user", type: "event_user"},
      ]);
      expect(
        experimentRunSchema.safeParse({
          ...run,
          experiment: {
            ...run.experiment,
            primary_metric: {name: "install_rate", type: "ratio"},
            secondary_metrics: [{name: "ctr", type: "ratio"}],
          },
        }).success,
      ).toBe(true);

      const metricRequests: Array<Record<string, unknown>> = [];
      const statsig = new StatsigConsoleClient("test-console-key", {
        fetch: async (_input, init) => {
          if (init?.method === "GET") return new Response(null, {status: 404});
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          metricRequests.push(body);
          const metricEvents = body.metricEvents as Array<{
            name: string;
            criteria: unknown[];
          }>;
          return Response.json(
            {
              data: {
                ...body,
                metricEvents: metricEvents.map(({name, criteria}) => ({
                  name,
                  criteria,
                })),
              },
            },
            {status: 201},
          );
        },
      });
      await statsig.ensureExperimentMetrics(run);
      expect(metricRequests).toMatchObject([
        {
          name: "install_rate_user",
          type: "event_user",
          rollupTimeWindow: "max",
          metricEvents: [{name: "ad_install"}],
        },
        {
          name: "ctr_user",
          type: "event_user",
          rollupTimeWindow: "max",
          metricEvents: [{name: "ad_click"}],
        },
      ]);

      const simulationOutput = await runCli(
        [
          "src/cli/agent.ts",
          "simulate",
          "--run-id",
          runId,
          "--max-rounds",
          "1",
        ],
        {
          ...environment,
          OPENAI_MODEL: "unused-in-final-round",
        },
      );
      const simulation = JSON.parse(simulationOutput) as {
        source: string;
        root_run_id: string;
        termination: string;
        trajectory: Array<{
          log: string;
          action: {action: string};
          action_receipt: {status: string};
        }>;
      };

      expect(simulation).toMatchObject({
        source: "simulator",
        root_run_id: runId,
        termination: "max_rounds",
      });
      expect(simulation.trajectory).toHaveLength(1);
      expect(simulation.trajectory[0]).toMatchObject({
        log: `artifacts/runs/${runId}/trajectory.json`,
        action: {action: "terminate"},
        action_receipt: {status: "succeeded"},
      });
      expect((await readdir(runDirectory)).sort()).toEqual([
        "experiments.json",
        "observations.json",
        "plan.json",
        "trajectory.json",
      ]);
      expect(await Bun.file(ledgerPath).exists()).toBe(true);
      const ledger = new Database(ledgerPath, {readonly: true, strict: true});
      try {
        expect(
          ledger
            .query<
              {status: string; current_round: number},
              [string]
            >(
              `SELECT status, current_round
               FROM optimization_runs
               WHERE optimization_run_id = ?`,
            )
            .get(runId),
        ).toEqual({status: "completed", current_round: 1});
        expect(
          ledger
            .query<{count: number}, [string]>(
              `SELECT COUNT(*) AS count
               FROM experiment_rounds
               WHERE optimization_run_id = ?`,
            )
            .get(runId),
        ).toEqual({count: 1});
      } finally {
        ledger.close();
      }

      const trajectory = await Bun.file(
        join(runDirectory, "trajectory.json"),
      ).json();
      expect(trajectory).toMatchObject({
        schema_version: 1,
        source: "simulator",
        optimization_run_id: runId,
        status: "completed",
        rounds: [
          {
            run_id: runId,
            action: {action: "terminate"},
            proposal: {status: "approved"},
            action_receipt: {status: "succeeded"},
          },
        ],
      });
      expect(trajectory).not.toHaveProperty("batches");
    } finally {
      await rm(runDirectory, {recursive: true, force: true});
      await rm(temporaryDirectory, {recursive: true, force: true});
    }
  },
  30_000,
);

async function runCli(
  arguments_: string[],
  environment: Record<string, string> = {},
): Promise<string> {
  const childProcess = Bun.spawn({
    cmd: [process.execPath, "run", ...arguments_],
    cwd: projectRoot,
    env: {...Bun.env, ...environment},
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    childProcess.exited,
    new Response(childProcess.stdout).text(),
    new Response(childProcess.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`CLI exited with ${exitCode}: ${stderr || stdout}`);
  }
  return stdout;
}
