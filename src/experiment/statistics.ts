const SQRT_TWO = Math.sqrt(2);

export type FixedHorizonSampleSizeInput = Readonly<{
  baselineRate: number;
  minimumDetectableEffect: number;
  alpha: number;
  power: number;
  batchSize: number;
}>;

export function standardNormalCdf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const magnitude = Math.abs(value) / SQRT_TWO;
  const scale = 1 / (1 + 0.3275911 * magnitude);
  const errorFunction = 1 -
    (((((1.061405429 * scale - 1.453152027) * scale + 1.421413741) *
      scale - 0.284496736) * scale + 0.254829592) * scale) *
      Math.exp(-magnitude * magnitude);
  return 0.5 * (1 + sign * errorFunction);
}

export function standardNormalQuantile(probability: number): number {
  if (!(probability > 0 && probability < 1)) {
    throw new RangeError("probability must be between 0 and 1.");
  }
  let lower = -8;
  let upper = 8;
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const midpoint = (lower + upper) / 2;
    if (standardNormalCdf(midpoint) < probability) lower = midpoint;
    else upper = midpoint;
  }
  return (lower + upper) / 2;
}

export function calculateRequiredUsers(
  input: FixedHorizonSampleSizeInput,
): number {
  const {
    baselineRate,
    minimumDetectableEffect,
    alpha,
    power,
    batchSize,
  } = input;
  if (!(baselineRate > 0 && baselineRate < 1)) {
    throw new RangeError("baselineRate must be between 0 and 1.");
  }
  if (
    minimumDetectableEffect <= 0 ||
    baselineRate + minimumDetectableEffect >= 1
  ) {
    throw new RangeError(
      "minimumDetectableEffect must be positive and keep the treatment rate below 1.",
    );
  }
  if (!(alpha > 0 && alpha < 1)) {
    throw new RangeError("alpha must be between 0 and 1.");
  }
  if (!(power > 0.5 && power < 1)) {
    throw new RangeError("power must be between 0.5 and 1.");
  }
  if (!Number.isSafeInteger(batchSize) || batchSize < 2 || batchSize % 2 !== 0) {
    throw new RangeError("batchSize must be a positive even integer.");
  }

  const treatmentRate = baselineRate + minimumDetectableEffect;
  const averageRate = (baselineRate + treatmentRate) / 2;
  const alphaCriticalValue = standardNormalQuantile(1 - alpha / 2);
  const powerCriticalValue = standardNormalQuantile(power);
  const perArmUsers =
    Math.pow(
      alphaCriticalValue * Math.sqrt(2 * averageRate * (1 - averageRate)) +
        powerCriticalValue *
          Math.sqrt(
            baselineRate * (1 - baselineRate) +
              treatmentRate * (1 - treatmentRate),
          ),
      2,
    ) / Math.pow(minimumDetectableEffect, 2);
  const totalUsers = 2 * Math.ceil(perArmUsers);
  return Math.ceil(totalUsers / batchSize) * batchSize;
}
