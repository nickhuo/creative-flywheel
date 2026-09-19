import {mkdir, rename} from "node:fs/promises";
import {dirname, resolve} from "node:path";

import {fitAudience} from "../audience/fit";
import {
  audienceModelSchema,
  deterministicUniform,
  FATIGUE_BUCKETS,
  modelFingerprint,
  sampleExposure,
  scoreExposure,
  type AudienceModel,
  type AudiencePrediction,
  type ExposureContext,
  type ImpressionOutcome,
} from "../audience/model";
import {creativeManifestSchema, type CreativeManifest} from "../manifest";

const EXPOSURE_REPRESENTATIVE: Record<(typeof FATIGUE_BUCKETS)[number], number> = {
  "1": 1,
  "2": 2,
  "3": 3,
  "4-5": 4,
  "6-10": 6,
  "11-20": 11,
  "21-50": 21,
  "51+": 51,
};

type PreviewRecord = {
  outcome: ImpressionOutcome;
  probabilities: {
    click: number;
    expected_install: number;
    install_given_sampled_click: number;
  };
  layer_coverage: AudiencePrediction["layer_coverage"];
  unseen_layers: AudiencePrediction["unseen_layers"];
};

const [command, ...arguments_] = Bun.argv.slice(2);

if (command === "fit") {
  await fitCommand(arguments_);
} else if (command === "sample") {
  await sampleCommand(arguments_);
} else {
  throw new Error(
    "Usage: bun run audience <fit|sample> [--csv ... --out ... | --model ... --manifests ... --per-variant ... --seed ... --out ...]",
  );
}

async function fitCommand(arguments_: string[]): Promise<void> {
  const csvPath = resolve(readFlag(arguments_, "--csv"));
  const outputPath = resolve(readFlag(arguments_, "--out"));
  const csvFile = Bun.file(csvPath);
  if (!(await csvFile.exists())) throw new Error(`File not found: ${csvPath}`);

  const model = fitAudience(await csvFile.text());
  await writeJson(outputPath, model);

  console.log(
    JSON.stringify(
      {
        artifact: outputPath,
        source_rows: model.source.row_count,
        model_fingerprint: modelFingerprint(model),
        selected_l2: {
          click: model.click_model.l2,
          install: model.install_model.l2,
        },
        validation: model.metrics.validation,
      },
      null,
      2,
    ),
  );
}

async function sampleCommand(arguments_: string[]): Promise<void> {
  const modelPath = resolve(readFlag(arguments_, "--model"));
  const manifestArguments = readFlag(arguments_, "--manifests")
    .split(",")
    .map((path) => path.trim());
  const manifestPaths = manifestArguments.map((path) => resolve(path));
  const perVariant = Number(readFlag(arguments_, "--per-variant"));
  const seed = Number(readFlag(arguments_, "--seed"));
  const outputPath = resolve(readFlag(arguments_, "--out"));

  if (!Number.isInteger(perVariant) || perVariant < 1) {
    throw new RangeError("--per-variant must be a positive integer.");
  }
  if (!Number.isSafeInteger(seed)) {
    throw new RangeError("--seed must be a safe integer.");
  }

  const modelJson: unknown = await Bun.file(modelPath).json();
  const model = audienceModelSchema.parse(modelJson);
  const manifests = await Promise.all(
    manifestPaths.map(async (path) => {
      const manifestJson: unknown = await Bun.file(path).json();
      return creativeManifestSchema.parse(manifestJson);
    }),
  );
  const hash = modelFingerprint(model);
  const records = manifests.flatMap((manifest) =>
    sampleManifest(model, manifest, perVariant, seed, hash),
  );
  const variants = manifests.map((manifest) => {
    const variantRecords = records.filter(
      ({outcome}) => outcome.variant_id === manifest.variant_id,
    );
    const first = variantRecords[0];
    if (first === undefined) throw new Error("Preview produced no records.");
    return {
      variant_id: manifest.variant_id,
      layer_coverage: first.layer_coverage,
      unseen_layers: first.unseen_layers,
      impressions: variantRecords.length,
      mean_predicted_ctr:
        variantRecords.reduce(
          (sum, {probabilities}) => sum + probabilities.click,
          0,
        ) / variantRecords.length,
      mean_predicted_install_rate:
        variantRecords.reduce(
          (sum, {probabilities}) => sum + probabilities.expected_install,
          0,
        ) / variantRecords.length,
      clicks: variantRecords.reduce((sum, {outcome}) => sum + outcome.click, 0),
      installs: variantRecords.reduce(
        (sum, {outcome}) => sum + outcome.install,
        0,
      ),
    };
  });
  const artifact = {
    schema_version: 1,
    kind: "audience_preview",
    note: "Independent model preview contexts; assignment and coherent exposure history remain the responsibility of the experiment runner.",
    model_fingerprint: hash,
    fingerprint_input: "JSON.stringify(parsed model)",
    seed,
    per_variant: perVariant,
    manifests,
    variants,
    records,
  };

  await writeJson(outputPath, artifact);
  console.log(JSON.stringify({artifact: outputPath, variants}, null, 2));
}

function sampleManifest(
  model: AudienceModel,
  manifest: CreativeManifest,
  count: number,
  seed: number,
  modelHash: string,
): PreviewRecord[] {
  return Array.from({length: count}, (_, index) => {
    const ordinal = index + 1;
    const contextKey = `${modelHash}|${seed}|preview_context|${ordinal}`;
    const audience = pickWeighted(
      model.audience_mix,
      deterministicUniform(`${contextKey}|audience`),
    );
    const exposure = pickWeighted(
      model.exposure_mix,
      deterministicUniform(`${contextKey}|fatigue`),
    );
    const context: ExposureContext = {
      impression_id: `preview_${manifest.variant_id}_${ordinal.toString().padStart(4, "0")}`,
      ts_utc: model.source.end_ts_utc,
      user_id: `preview_user_${manifest.variant_id}_${ordinal.toString().padStart(4, "0")}`,
      segment: audience.segment,
      os: audience.os,
      exposure_n: EXPOSURE_REPRESENTATIVE[exposure.bucket],
    };
    const outcome = sampleExposure(model, manifest, context, seed);
    const prediction = scoreExposure(model, manifest, context);
    return {
      outcome,
      probabilities: {
        click: prediction.p_click,
        expected_install:
          (1 - prediction.p_click) * prediction.p_install_if_no_click +
          prediction.p_click * prediction.p_install_if_click,
        install_given_sampled_click: outcome.click
          ? prediction.p_install_if_click
          : prediction.p_install_if_no_click,
      },
      layer_coverage: prediction.layer_coverage,
      unseen_layers: prediction.unseen_layers,
    };
  });
}

function pickWeighted<T extends {weight: number}>(items: T[], unit: number): T {
  if (items.length === 0) throw new Error("Cannot sample an empty distribution.");
  let cumulative = 0;
  for (const item of items) {
    cumulative += item.weight;
    if (unit < cumulative) return item;
  }
  return items.at(-1)!;
}

function readFlag(arguments_: string[], name: string): string {
  const index = arguments_.indexOf(name);
  const value = arguments_[index + 1];
  if (index === -1 || value === undefined || value.startsWith("--")) {
    throw new Error(`Missing required flag ${name}.`);
  }
  return value;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), {recursive: true});
  const pendingPath = `${path}.partial`;
  await Bun.write(pendingPath, `${JSON.stringify(value, null, 2)}\n`);
  await rename(pendingPath, path);
}
