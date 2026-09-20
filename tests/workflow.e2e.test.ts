import {expect, test} from "bun:test";
import {randomUUID} from "node:crypto";
import {mkdtemp, rm, stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";

const projectRoot = resolve(import.meta.dir, "..");

test(
  "prepares and simulates a complete local experiment",
  async () => {
    const runId = `e2e_${randomUUID().replaceAll("-", "")}`;
    const runDirectory = join(
      projectRoot,
      "artifacts",
      "experiments",
      runId,
    );
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "simula-e2e-"));
    const ledgerPath = join(temporaryDirectory, "state.sqlite");

    try {
      const prepareOutput = await runCli([
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
      ]);
      const prepared = JSON.parse(prepareOutput) as {
        status: string;
        statistical_design: {required_users: number};
      };

      expect(prepared.status).toBe("prepared");
      expect(prepared.statistical_design.required_users).toBe(22);

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
          OPENAI_MODEL: "unused-in-final-round",
          SIMULA_AGENT_DB: ledgerPath,
        },
      );
      const simulation = JSON.parse(simulationOutput) as {
        source: string;
        root_run_id: string;
        termination: string;
        trajectory: Array<{
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
        action: {action: "terminate"},
        action_receipt: {status: "succeeded"},
      });
      expect((await stat(ledgerPath)).size).toBeGreaterThan(0);
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
