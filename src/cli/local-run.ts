import {resolve} from "node:path";

import {z} from "zod";

import {
  experimentLogRecordSchema,
  projectRoot,
  runArtifactPaths,
} from "../artifacts";
import {experimentRunIdSchema} from "../experiment/run";
import {
  CREATIVE_LAYER_FIELDS,
  renderableCreativeManifestSchema,
} from "../manifest";

const DEFAULT_CONTROL_VARIANT = "g0_v00";
const DEFAULT_TREATMENT_VARIANT = "g0_v01";
const DEFAULT_MAX_ROUNDS = 8;

export async function runLocalOptimization(arguments_: string[]): Promise<void> {
  if (arguments_.includes("--help")) {
    console.log(
      "Usage: bun run agent run [--seed-control g0_v00] " +
        "[--seed-treatment g0_v01] [--max-rounds 8] [--verbose]",
    );
    return;
  }

  const controlVariantId = experimentRunIdSchema.parse(
    readOptionalFlag(arguments_, "--seed-control") ?? DEFAULT_CONTROL_VARIANT,
  );
  const treatmentVariantId = experimentRunIdSchema.parse(
    readOptionalFlag(arguments_, "--seed-treatment") ??
      DEFAULT_TREATMENT_VARIANT,
  );
  if (controlVariantId === treatmentVariantId) {
    throw new Error("Seed control and treatment must be different variants.");
  }
  const maxRounds = positiveInteger(
    readOptionalFlag(arguments_, "--max-rounds") ?? String(DEFAULT_MAX_ROUNDS),
    "--max-rounds",
  );
  const seed = safeInteger(
    readOptionalFlag(arguments_, "--seed") ?? "42",
    "--seed",
  );
  const model = readOptionalFlag(arguments_, "--openai-model") ??
    requiredEnvironmentVariable("OPENAI_MODEL");
  requiredEnvironmentVariable("OPENAI_API_KEY");
  const isVerbose = arguments_.includes("--verbose") ||
    !arguments_.includes("--quiet");
  if (arguments_.includes("--verbose") && arguments_.includes("--quiet")) {
    throw new Error("Use either --verbose or --quiet, not both.");
  }

  const controlPath = resolve(
    projectRoot,
    "manifests",
    `${controlVariantId}.json`,
  );
  const treatmentPath = resolve(
    projectRoot,
    "manifests",
    `${treatmentVariantId}.json`,
  );
  const controlManifest = renderableCreativeManifestSchema.parse(
    await Bun.file(controlPath).json(),
  );
  const treatmentManifest = renderableCreativeManifestSchema.parse(
    await Bun.file(treatmentPath).json(),
  );
  for (const manifest of [controlManifest, treatmentManifest]) {
    if (manifest.generation !== 0 || manifest.parent_id !== null) {
      throw new Error(`${manifest.variant_id} is not a generation-zero seed.`);
    }
  }
  const changes = CREATIVE_LAYER_FIELDS.flatMap((layer) => {
    const before = controlManifest.layers[layer];
    const after = treatmentManifest.layers[layer];
    return before === after ? [] : [{layer, before, after}];
  });
  if (changes.length < 1 || changes.length > 2) {
    throw new Error(
      `A seed pair must change one or two layers; received ${changes.length}.`,
    );
  }

  const rootRunId = experimentRunIdSchema.parse(
    readOptionalFlag(arguments_, "--run-id") ??
      generatedRunId(controlVariantId, treatmentVariantId),
  );
  const hypothesis = readOptionalFlag(arguments_, "--hypothesis") ??
    `Changing ${changes.map(({layer, before, after}) =>
      `${layer} from ${before} to ${after}`
    ).join(" and ")} will improve install rate for the modeled Rune Keepers audience.`;

  if (isVerbose) {
    console.log("Preparing seed experiment");
    console.log(`  Control      ${controlVariantId}`);
    console.log(`  Treatment    ${treatmentVariantId}`);
    console.log(
      `  Changes      ${changes.map(({layer}) => layer).join(", ")}`,
    );
    console.log(`  Model        ${model}`);
  }

  const prepareArguments = [
    resolve(projectRoot, "src/cli/experiment.ts"),
    "prepare",
    "--run-id",
    rootRunId,
    "--control",
    controlPath,
    "--treatment",
    treatmentPath,
    "--seed",
    String(seed),
    "--hypothesis",
    hypothesis,
  ];
  for (const flag of [
    "--batch-size",
    "--baseline-rate",
    "--mde",
    "--alpha",
    "--power",
  ]) {
    const value = readOptionalFlag(arguments_, flag);
    if (value !== undefined) prepareArguments.push(flag, value);
  }
  await runCaptured([process.execPath, "run", ...prepareArguments]);

  const preparedRecords = z.array(experimentLogRecordSchema).parse(
    await Bun.file(runArtifactPaths(rootRunId).experiments).json(),
  );
  const preparedRun = preparedRecords.at(-1)?.experiment;
  if (preparedRun === undefined) {
    throw new Error(`Prepared experiment is missing for ${rootRunId}.`);
  }
  if (isVerbose) {
    console.log(
      `  Design       ${formatInteger(
        preparedRun.statistical_design.required_users,
      )} users · MDE ${(preparedRun.statistical_design.minimum_detectable_effect * 100).toFixed(3)} pp`,
    );
  }

  const simulation = Bun.spawn({
    cmd: [
      process.execPath,
      "run",
      resolve(projectRoot, "src/cli/agent.ts"),
      "simulate",
      "--run-id",
      rootRunId,
      "--max-rounds",
      String(maxRounds),
      ...(isVerbose ? ["--verbose"] : []),
    ],
    cwd: projectRoot,
    env: {...Bun.env, OPENAI_MODEL: model},
    stdout: "inherit",
    stderr: "inherit",
  });
  const simulationExitCode = await simulation.exited;
  if (simulationExitCode !== 0) {
    throw new Error(`Simulation failed with exit code ${simulationExitCode}.`);
  }

  if (!arguments_.includes("--no-render")) {
    const experimentRecords = z.array(experimentLogRecordSchema).parse(
      await Bun.file(runArtifactPaths(rootRunId).experiments).json(),
    );
    const manifestPaths = [
      ...new Set(
        experimentRecords.flatMap(({experiment}) =>
          experiment.experiment.arms.map(({manifest}) => manifest.path)
        ),
      ),
    ];
    console.log(`\nRendering ${manifestPaths.length} creative videos`);
    for (const [index, manifestPath] of manifestPaths.entries()) {
      const manifest = renderableCreativeManifestSchema.parse(
        await Bun.file(resolve(projectRoot, manifestPath)).json(),
      );
      console.log(
        `  Render ${index + 1}/${manifestPaths.length}  ${manifest.variant_id}`,
      );
      await runCaptured([
        process.execPath,
        "run",
        resolve(projectRoot, "src/cli/render.ts"),
        "--run-id",
        rootRunId,
        resolve(projectRoot, manifestPath),
      ]);
    }
  }

  if (!arguments_.includes("--no-dashboard")) {
    const port = dashboardPort();
    const dashboardOrigin = `http://localhost:${port}`;
    if (!(await dashboardIsReady(dashboardOrigin))) {
      const dashboard = Bun.spawn({
        cmd: [
          process.execPath,
          "run",
          resolve(projectRoot, "src/dashboard/server.ts"),
        ],
        cwd: projectRoot,
        env: {...Bun.env, DASHBOARD_PORT: String(port)},
        stdout: "ignore",
        stderr: "inherit",
      });
      dashboard.unref();
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (await dashboardIsReady(dashboardOrigin)) break;
        await Bun.sleep(250);
      }
      if (!(await dashboardIsReady(dashboardOrigin))) {
        throw new Error(`Dashboard did not become ready at ${dashboardOrigin}.`);
      }
    }
    const dashboardUrl =
      `${dashboardOrigin}/?run=${encodeURIComponent(rootRunId)}`;
    console.log(`\nDashboard: ${dashboardUrl}`);
    if (!arguments_.includes("--no-open")) await openBrowser(dashboardUrl);
  }
}

async function runCaptured(command: string[]): Promise<string> {
  const child = Bun.spawn({
    cmd: command,
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    const details = (stderr.trim() || stdout.trim()).slice(-8_000);
    throw new Error(`Command failed with exit code ${exitCode}: ${details}`);
  }
  return stdout;
}

async function dashboardIsReady(origin: string): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/health`, {
      signal: AbortSignal.timeout(750),
    });
    if (!response.ok) return false;
    const payload: unknown = await response.json();
    return typeof payload === "object" && payload !== null &&
      "status" in payload && payload.status === "ok";
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
}

async function openBrowser(url: string): Promise<void> {
  const command = process.platform === "darwin"
    ? ["open", url]
    : process.platform === "win32"
      ? ["cmd", "/c", "start", "", url]
      : ["xdg-open", url];
  await runCaptured(command);
}

function dashboardPort(): number {
  const port = Number(Bun.env.DASHBOARD_PORT ?? "3000");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError("DASHBOARD_PORT must be an integer from 1 to 65535.");
  }
  return port;
}

function generatedRunId(controlVariantId: string, treatmentVariantId: string): string {
  const timestamp = new Date().toISOString().replaceAll(/\D/g, "").slice(0, 17);
  return `seed_${controlVariantId}_vs_${treatmentVariantId}_${timestamp}`;
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new RangeError(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function safeInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new RangeError(`${flag} must be a safe integer.`);
  }
  return parsed;
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

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}
