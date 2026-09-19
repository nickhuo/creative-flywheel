import {z} from "zod";

import {
  audienceModelSchema,
  CREATIVE_FIELDS,
  FATIGUE_BUCKETS,
  fatigueBucket,
  featureNames,
  logisticModelSchema,
  metricsSchema,
  OPERATING_SYSTEMS,
  predict,
  layerCombinationKey,
  SEGMENTS,
  sha256,
  sigmoid,
  type AudienceModel,
  type Binary,
  type FeatureSpec,
  type LogisticModel,
  type Metrics,
  type OperatingSystem,
  type Segment,
} from "./model";
import {creativeLayersSchema} from "../manifest";

export const AUDIENCE_CSV_HEADER = [
  "impression_id",
  "ts_utc",
  "user_id",
  "segment",
  "os",
  "variant_id",
  "background",
  "subject_character",
  "subject_action",
  "hook_text",
  "cta_text",
  "audio_style",
  "aspect",
  "duration_s",
  "exposure_n",
  "click",
  "install",
].join(",");

const SPLIT_SEED = 20260918;
const VALIDATION_MODULUS = 5;
const LAMBDA_CANDIDATES = [
  0.0000001,
  0.000001,
  0.00001,
  0.0001,
  0.001,
] as const;
const MAX_ITERATIONS = 50;
const GRADIENT_TOLERANCE = 1e-8;

type AudienceRow = {
  ts_utc: string;
  user_id: string;
  segment: Segment;
  os: OperatingSystem;
  layers: z.infer<typeof creativeLayersSchema>;
  exposure_n: number;
  click: Binary;
  install: Binary;
};

type EncodedRow = {
  active_features: number[];
  click: Binary;
  install: Binary;
};

type BinomialGroup = {
  columns: number[];
  trials: number;
  successes: number;
};

export function isValidationUser(
  userId: string,
  splitSeed = SPLIT_SEED,
): boolean {
  const prefix = sha256(`${splitSeed}|${userId}`).slice(0, 8);
  return Number.parseInt(prefix, 16) % VALIDATION_MODULUS === 0;
}

export function fitAudience(csvText: string): AudienceModel {
  const rows = parseAudienceCsv(csvText);
  const trainRows = rows.filter((row) => !isValidationUser(row.user_id));
  const validationRows = rows.filter((row) => isValidationUser(row.user_id));

  if (trainRows.length === 0 || validationRows.length === 0) {
    throw new Error("The deterministic split must contain train and validation rows.");
  }

  const specs = buildFeatureSpecs(rows);
  const baseFeatureNames = featureNames(specs);
  const trainEncoded = encodeRows(trainRows, specs);
  const validationEncoded = encodeRows(validationRows, specs);
  const clickGroups = aggregateRows(
    trainEncoded,
    "click",
    false,
    baseFeatureNames.length,
  );
  const installGroups = aggregateRows(
    trainEncoded,
    "install",
    true,
    baseFeatureNames.length,
  );
  const clickRate = meanBinary(trainEncoded, "click");
  const installRate = meanBinary(trainEncoded, "install");
  const noClickRows = trainEncoded.filter((row) => row.click === 0);
  const clickedRows = trainEncoded.filter((row) => row.click === 1);
  const installBaselines = {
    overall: installRate,
    no_click: meanBinary(noClickRows, "install"),
    after_click: meanBinary(clickedRows, "install"),
  };
  const clickLambdaScores: Array<{l2: number; validation_log_loss: number}> = [];
  let clickModel: LogisticModel | undefined;
  let bestClickLoss = Number.POSITIVE_INFINITY;

  for (const l2 of LAMBDA_CANDIDATES) {
    const candidate = fitLogistic(clickGroups, baseFeatureNames, l2);
    const score = evaluateClick(validationEncoded, candidate, clickRate).log_loss;
    clickLambdaScores.push({l2, validation_log_loss: score});
    if (score < bestClickLoss) {
      clickModel = candidate;
      bestClickLoss = score;
    }
  }

  if (clickModel === undefined) throw new Error("Click model selection failed.");

  const installFeatureNames = [...baseFeatureNames, "click=1"];
  const installLambdaScores: Array<{l2: number; validation_log_loss: number}> = [];
  let installModel: LogisticModel | undefined;
  let bestInstallLoss = Number.POSITIVE_INFINITY;

  for (const l2 of LAMBDA_CANDIDATES) {
    const candidate = fitLogistic(installGroups, installFeatureNames, l2);
    const score = evaluateInstallConditional(
      validationEncoded,
      candidate,
      installRate,
    ).log_loss;
    installLambdaScores.push({l2, validation_log_loss: score});
    if (score < bestInstallLoss) {
      installModel = candidate;
      bestInstallLoss = score;
    }
  }

  if (installModel === undefined) throw new Error("Install model selection failed.");

  const trainUsers = new Set(trainRows.map((row) => row.user_id));
  const validationUsers = new Set(validationRows.map((row) => row.user_id));
  const seenCombinations = new Map<string, AudienceRow["layers"]>();
  const audienceCounts = new Map<string, number>();
  const exposureCounts = new Map<string, number>();

  for (const row of rows) {
    seenCombinations.set(layerCombinationKey(row.layers), row.layers);
    const audienceKey = `${row.segment}|${row.os}`;
    audienceCounts.set(audienceKey, (audienceCounts.get(audienceKey) ?? 0) + 1);
    const bucket = fatigueBucket(row.exposure_n);
    exposureCounts.set(bucket, (exposureCounts.get(bucket) ?? 0) + 1);
  }

  const timestamps = rows.map((row) => row.ts_utc).sort();
  const model = {
    schema_version: 1 as const,
    source: {
      sha256: sha256(csvText),
      row_count: rows.length,
      start_ts_utc: timestamps[0]!,
      end_ts_utc: timestamps.at(-1)!,
    },
    split: {
      key: "user_id" as const,
      seed: SPLIT_SEED,
      validation_percent: 20 as const,
      rule: "uint32(sha256(seed|user_id)[0:8]) mod 5 == 0",
      train_rows: trainRows.length,
      validation_rows: validationRows.length,
      train_users: trainUsers.size,
      validation_users: validationUsers.size,
    },
    training: {
      solver: "grouped_binomial_damped_newton" as const,
      objective: "mean_log_loss_plus_l2" as const,
      max_iterations: MAX_ITERATIONS,
      gradient_tolerance: GRADIENT_TOLERANCE,
      lambda_candidates: [...LAMBDA_CANDIDATES],
      click_lambda_scores: clickLambdaScores,
      install_lambda_scores: installLambdaScores,
    },
    inference: {
      unseen_layer_value: "use_reference_level_and_report" as const,
      unknown_audience_value: "reject" as const,
      new_combination: "additive_main_effects" as const,
    },
    features: specs,
    seen_layer_combinations: [...seenCombinations.entries()]
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([, layers]) => layers),
    click_model: clickModel,
    install_model: installModel,
    audience_mix: [...audienceCounts.entries()]
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([key, count]) => {
        const [segment, os] = key.split("|") as [Segment, OperatingSystem];
        return {segment, os, count, weight: count / rows.length};
      }),
    exposure_mix: FATIGUE_BUCKETS.flatMap((bucket) => {
      const count = exposureCounts.get(bucket);
      return count === undefined
        ? []
        : [{bucket, count, weight: count / rows.length}];
    }),
    metrics: {
      train: {
        click: evaluateClick(trainEncoded, clickModel, clickRate),
        install: evaluateInstall(
          trainEncoded,
          clickModel,
          installModel,
          installBaselines,
        ),
      },
      validation: {
        click: evaluateClick(validationEncoded, clickModel, clickRate),
        install: evaluateInstall(
          validationEncoded,
          clickModel,
          installModel,
          installBaselines,
        ),
      },
    },
  };

  return audienceModelSchema.parse(model);
}

function parseAudienceCsv(csvText: string): AudienceRow[] {
  if (csvText.includes('"')) {
    throw new Error("Quoted CSV fields are not supported by this fixed dataset parser.");
  }

  const lines = csvText.trimEnd().split(/\r?\n/);
  if (lines.shift() !== AUDIENCE_CSV_HEADER) {
    throw new Error("Audience CSV header does not match the expected 17 columns.");
  }

  return lines.map((line, index) => {
    const cells = line.split(",").map((cell) => cell.trim());
    if (cells.length !== 17) {
      throw new Error(`CSV row ${index + 2} has ${cells.length} columns, expected 17.`);
    }

    const segment = cells[3];
    const os = cells[4];
    if (!isOneOf(segment, SEGMENTS)) {
      throw new Error(`CSV row ${index + 2} has unknown segment: ${segment}.`);
    }
    if (!isOneOf(os, OPERATING_SYSTEMS)) {
      throw new Error(`CSV row ${index + 2} has unknown OS: ${os}.`);
    }

    const exposure = Number(cells[14]);
    const click = Number(cells[15]);
    const install = Number(cells[16]);
    if (!Number.isInteger(exposure) || exposure < 1) {
      throw new Error(`CSV row ${index + 2} has invalid exposure_n.`);
    }
    if (!isBinary(click) || !isBinary(install)) {
      throw new Error(`CSV row ${index + 2} has a non-binary outcome.`);
    }

    return {
      ts_utc: cells[1]!,
      user_id: cells[2]!,
      segment,
      os,
      layers: creativeLayersSchema.parse({
        background: cells[6],
        subject_character: cells[7],
        subject_action: cells[8],
        hook_text: cells[9],
        cta_text: cells[10],
        audio_style: cells[11],
      }),
      exposure_n: exposure,
      click,
      install,
    };
  });
}

function buildFeatureSpecs(rows: AudienceRow[]): FeatureSpec[] {
  const creativeSpecs = CREATIVE_FIELDS.map((field) => {
    const values = [...new Set(rows.map((row) => row.layers[field]))].sort();
    return {field, values, baseline: values[0]!};
  });

  return [
    ...creativeSpecs,
    {field: "segment", values: [...SEGMENTS], baseline: SEGMENTS[0]},
    {field: "os", values: [...OPERATING_SYSTEMS], baseline: OPERATING_SYSTEMS[0]},
    {
      field: "fatigue_bucket",
      values: [...FATIGUE_BUCKETS],
      baseline: FATIGUE_BUCKETS[0],
    },
  ];
}

function encodeRows(rows: AudienceRow[], specs: FeatureSpec[]): EncodedRow[] {
  const names = featureNames(specs);
  const nameToIndex = new Map(names.map((name, index) => [name, index]));

  return rows.map((row) => {
    const activeFeatures: number[] = [];
    for (const spec of specs) {
      const value =
        spec.field === "segment"
          ? row.segment
          : spec.field === "os"
            ? row.os
            : spec.field === "fatigue_bucket"
              ? fatigueBucket(row.exposure_n)
              : row.layers[spec.field];
      if (value !== spec.baseline) {
        const featureIndex = nameToIndex.get(`${spec.field}=${value}`);
        if (featureIndex === undefined) {
          throw new Error(`Unable to encode ${spec.field}=${value}.`);
        }
        activeFeatures.push(featureIndex);
      }
    }
    return {
      active_features: activeFeatures,
      click: row.click,
      install: row.install,
    };
  });
}

function aggregateRows(
  rows: EncodedRow[],
  target: "click" | "install",
  includeClick: boolean,
  featureCount: number,
): BinomialGroup[] {
  const groups = new Map<string, BinomialGroup>();

  for (const row of rows) {
    const columns = [0, ...row.active_features.map((index) => index + 1)];
    if (includeClick && row.click === 1) columns.push(featureCount + 1);
    const key = columns.join(",");
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        columns,
        trials: 1,
        successes: row[target],
      });
    } else {
      group.trials += 1;
      group.successes += row[target];
    }
  }

  return [...groups.values()].sort((left, right) =>
    compareStrings(left.columns.join(","), right.columns.join(",")),
  );
}

function fitLogistic(
  groups: BinomialGroup[],
  names: string[],
  l2: number,
): LogisticModel {
  const dimensions = names.length + 1;
  const observations = groups.reduce((sum, group) => sum + group.trials, 0);
  const positives = groups.reduce((sum, group) => sum + group.successes, 0);
  let weights = new Float64Array(dimensions);
  const initialRate = (positives + 0.5) / (observations + 1);
  weights[0] = Math.log(initialRate / (1 - initialRate));
  let loss = logisticObjective(groups, weights, observations, l2);
  let converged = false;
  let iterationsUsed = 0;

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration += 1) {
    const gradient = new Float64Array(dimensions);
    const hessian = Array.from(
      {length: dimensions},
      () => new Float64Array(dimensions),
    );

    for (const group of groups) {
      let linear = 0;
      for (const column of group.columns) linear += weights[column]!;
      const probability = sigmoid(linear);
      const error =
        (group.trials * probability - group.successes) / observations;
      const curvature =
        (group.trials * probability * (1 - probability)) / observations;
      for (const left of group.columns) {
        gradient[left]! += error;
        for (const right of group.columns) {
          hessian[left]![right]! += curvature;
        }
      }
    }

    for (let index = 1; index < dimensions; index += 1) {
      gradient[index]! += l2 * weights[index]!;
      hessian[index]![index]! += l2;
    }

    const maxGradient = Math.max(...gradient.map(Math.abs));
    iterationsUsed = iteration;
    if (maxGradient < GRADIENT_TOLERANCE) {
      converged = true;
      break;
    }

    const direction = solvePositiveDefinite(hessian, gradient);
    let step = 1;
    let nextWeights = weights;
    let nextLoss = loss;
    let acceptedStep = false;

    while (step >= 1 / 1024) {
      const candidate = Float64Array.from(
        weights,
        (weight, index) => weight - step * direction[index]!,
      );
      const candidateLoss = logisticObjective(
        groups,
        candidate,
        observations,
        l2,
      );
      if (candidateLoss < loss) {
        nextWeights = candidate;
        nextLoss = candidateLoss;
        acceptedStep = true;
        break;
      }
      step /= 2;
    }

    if (!acceptedStep) {
      throw new Error("Logistic line search failed before convergence.");
    }
    weights = nextWeights;
    loss = nextLoss;
  }

  if (!converged) {
    throw new Error(`Logistic fit did not converge in ${MAX_ITERATIONS} iterations.`);
  }

  return logisticModelSchema.parse({
    feature_names: names,
    intercept: weights[0],
    coefficients: Array.from(weights.slice(1)),
    l2,
    iterations_used: iterationsUsed,
    converged,
  });
}

function logisticObjective(
  groups: BinomialGroup[],
  weights: Float64Array,
  observations: number,
  l2: number,
): number {
  let loss = 0;
  for (const group of groups) {
    let linear = 0;
    for (const column of group.columns) linear += weights[column]!;
    loss +=
      group.trials *
        (Math.max(linear, 0) + Math.log1p(Math.exp(-Math.abs(linear)))) -
      group.successes * linear;
  }
  for (let index = 1; index < weights.length; index += 1) {
    loss += (observations * l2 * weights[index]! ** 2) / 2;
  }
  return loss / observations;
}

function solvePositiveDefinite(
  matrix: Float64Array[],
  vector: Float64Array,
): Float64Array {
  const size = vector.length;
  const lower = Array.from({length: size}, () => new Float64Array(size));

  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column <= row; column += 1) {
      let value = matrix[row]![column]!;
      for (let index = 0; index < column; index += 1) {
        value -= lower[row]![index]! * lower[column]![index]!;
      }
      if (row === column) {
        if (value <= 0 || !Number.isFinite(value)) {
          throw new Error("Logistic Hessian is not positive definite.");
        }
        lower[row]![column] = Math.sqrt(value);
      } else {
        lower[row]![column] = value / lower[column]![column]!;
      }
    }
  }

  const intermediate = new Float64Array(size);
  for (let row = 0; row < size; row += 1) {
    let value = vector[row]!;
    for (let column = 0; column < row; column += 1) {
      value -= lower[row]![column]! * intermediate[column]!;
    }
    intermediate[row] = value / lower[row]![row]!;
  }

  const solution = new Float64Array(size);
  for (let row = size - 1; row >= 0; row -= 1) {
    let value = intermediate[row]!;
    for (let column = row + 1; column < size; column += 1) {
      value -= lower[column]![row]! * solution[column]!;
    }
    solution[row] = value / lower[row]![row]!;
  }
  return solution;
}

function evaluateClick(
  rows: EncodedRow[],
  model: LogisticModel,
  baseline: number,
): Metrics {
  return calculateMetrics(
    rows.map((row) => ({
      actual: row.click,
      predicted: predict(model, row.active_features),
    })),
    baseline,
  );
}

function evaluateInstall(
  rows: EncodedRow[],
  clickModel: LogisticModel,
  installModel: LogisticModel,
  baselines: {overall: number; no_click: number; after_click: number},
): AudienceModel["metrics"]["train"]["install"] {
  const noClickRows = rows.filter((row) => row.click === 0);
  const clickedRows = rows.filter((row) => row.click === 1);
  return {
    conditional: evaluateInstallConditional(
      rows,
      installModel,
      baselines.overall,
    ),
    marginal: evaluateInstallMarginal(
      rows,
      clickModel,
      installModel,
      baselines.overall,
    ),
    no_click: evaluateInstallConditional(
      noClickRows,
      installModel,
      baselines.no_click,
    ),
    after_click: evaluateInstallConditional(
      clickedRows,
      installModel,
      baselines.after_click,
    ),
  };
}

function evaluateInstallConditional(
  rows: EncodedRow[],
  installModel: LogisticModel,
  baseline: number,
): Metrics {
  return calculateMetrics(
    rows.map((row) => ({
      actual: row.install,
      predicted: predict(installModel, row.active_features, row.click === 1),
    })),
    baseline,
  );
}

function evaluateInstallMarginal(
  rows: EncodedRow[],
  clickModel: LogisticModel,
  installModel: LogisticModel,
  baseline: number,
): Metrics {
  return calculateMetrics(
    rows.map((row) => {
      const pClick = predict(clickModel, row.active_features);
      const pWithoutClick = predict(installModel, row.active_features);
      const pWithClick = predict(installModel, row.active_features, true);
      return {
        actual: row.install,
        predicted: (1 - pClick) * pWithoutClick + pClick * pWithClick,
      };
    }),
    baseline,
  );
}

function calculateMetrics(
  outcomes: Array<{actual: Binary; predicted: number}>,
  baseline: number,
): Metrics {
  let positives = 0;
  let predictedTotal = 0;
  let logLoss = 0;
  let brier = 0;
  let baselineLogLoss = 0;
  let baselineBrier = 0;
  const clippedBaseline = Math.min(1 - 1e-12, Math.max(1e-12, baseline));

  for (const outcome of outcomes) {
    const predicted = Math.min(1 - 1e-12, Math.max(1e-12, outcome.predicted));
    positives += outcome.actual;
    predictedTotal += predicted;
    logLoss -=
      outcome.actual * Math.log(predicted) +
      (1 - outcome.actual) * Math.log(1 - predicted);
    brier += (predicted - outcome.actual) ** 2;
    baselineLogLoss -=
      outcome.actual * Math.log(clippedBaseline) +
      (1 - outcome.actual) * Math.log(1 - clippedBaseline);
    baselineBrier += (clippedBaseline - outcome.actual) ** 2;
  }

  return metricsSchema.parse({
    observations: outcomes.length,
    positive_rate: positives / outcomes.length,
    mean_prediction: predictedTotal / outcomes.length,
    log_loss: logLoss / outcomes.length,
    brier: brier / outcomes.length,
    baseline_log_loss: baselineLogLoss / outcomes.length,
    baseline_brier: baselineBrier / outcomes.length,
  });
}

function meanBinary(rows: EncodedRow[], field: "click" | "install"): number {
  return rows.reduce((sum, row) => sum + row[field], 0) / rows.length;
}

function isBinary(value: number): value is Binary {
  return value === 0 || value === 1;
}

function isOneOf<const T extends readonly string[]>(
  value: string | undefined,
  values: T,
): value is T[number] {
  return value !== undefined && (values as readonly string[]).includes(value);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
