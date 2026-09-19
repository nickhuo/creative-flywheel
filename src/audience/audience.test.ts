import {describe, expect, test} from "bun:test";

import {
  audienceModelSchema,
  impressionOutcomeSchema,
  fatigueBucket,
  sampleExposure,
  scoreExposure,
  type ExposureContext,
} from "./model";
import {
  AUDIENCE_CSV_HEADER,
  fitAudience,
  isValidationUser,
} from "./fit";
import {type CreativeManifest} from "../manifest";

const trainUsers = findUsers(false, 8, "train");
const validationUsers = findUsers(true, 4, "validation");
const csv = makeFixtureCsv([...trainUsers, ...validationUsers]);
const model = fitAudience(csv);
const manifest: CreativeManifest = {
  variant_id: "fixture_v0",
  generation: 0,
  parent_id: null,
  layers: {
    background: "forest",
    subject_character: "Luna",
    subject_action: "casts_spell",
    hook_text: "Join the quest",
    cta_text: "Install Now",
    audio_style: "drums",
  },
};
const context: ExposureContext = {
  impression_id: "fixture_impression",
  ts_utc: "2026-08-30 23:59",
  user_id: "fixture_user",
  segment: "rpg",
  os: "ios",
  exposure_n: 4,
};

describe("audience fit", () => {
  test("uses a deterministic user-level split and fit", () => {
    expect(trainUsers.every((user) => !isValidationUser(user))).toBe(true);
    expect(validationUsers.every((user) => isValidationUser(user))).toBe(true);
    expect(model.split.train_users).toBe(trainUsers.length);
    expect(model.split.validation_users).toBe(validationUsers.length);
    expect(JSON.stringify(fitAudience(csv))).toBe(JSON.stringify(model));
  });

  test("produces finite calibrated probability summaries", () => {
    for (const split of [model.metrics.train, model.metrics.validation]) {
      for (const metrics of [
        split.click,
        split.install.conditional,
        split.install.marginal,
        split.install.no_click,
        split.install.after_click,
      ]) {
        expect(Number.isFinite(metrics.log_loss)).toBe(true);
        expect(metrics.mean_prediction).toBeGreaterThanOrEqual(0);
        expect(metrics.mean_prediction).toBeLessThanOrEqual(1);
      }
    }
    const selectedInstall = model.training.install_lambda_scores.reduce(
      (best, candidate) =>
        candidate.validation_log_loss < best.validation_log_loss
          ? candidate
          : best,
    );
    expect(model.install_model.l2).toBe(selectedInstall.l2);
    expect(selectedInstall.validation_log_loss).toBe(
      model.metrics.validation.install.conditional.log_loss,
    );
    expect(
      model.metrics.validation.install.after_click.mean_prediction,
    ).toBeGreaterThan(model.metrics.validation.install.no_click.mean_prediction);
  });
});

describe("audience sampling", () => {
  test("is byte-identical for the same seed and impression", () => {
    const first = sampleExposure(model, manifest, context, 42);
    const second = sampleExposure(model, manifest, context, 42);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(impressionOutcomeSchema.parse(first)).toEqual(first);
  });

  test("allows a view-through install without a click", () => {
    const forcedModel = audienceModelSchema.parse({
      ...model,
      click_model: {
        ...model.click_model,
        intercept: -1000,
        coefficients: model.click_model.coefficients.map(() => 0),
      },
      install_model: {
        ...model.install_model,
        intercept: 1000,
        coefficients: model.install_model.coefficients.map(() => 0),
      },
    });
    expect(sampleExposure(forcedModel, manifest, context, 42)).toMatchObject({
      click: 0,
      install: 1,
    });
  });

  test("uses the declared reference-level fallback for unknown creative values", () => {
    const background = model.features.find(
      (feature) => feature.field === "background",
    );
    expect(background).toBeDefined();
    const baselineManifest: CreativeManifest = {
      ...manifest,
      layers: {...manifest.layers, background: background!.baseline},
    };
    const unknownManifest: CreativeManifest = {
      ...manifest,
      variant_id: "fixture_unseen",
      layers: {...manifest.layers, background: "unseen_background"},
    };
    const baseline = scoreExposure(model, baselineManifest, context);
    const unknown = scoreExposure(model, unknownManifest, context);

    expect(unknown.p_click).toBe(baseline.p_click);
    expect(unknown.p_install_if_click).toBe(baseline.p_install_if_click);
    expect(unknown.unseen_layers).toEqual(["background"]);
    expect(unknown.layer_coverage).toBe("contains_unseen_values");
  });

  test("rejects an unknown audience category", () => {
    expect(() =>
      scoreExposure(model, manifest, {
        ...context,
        segment: "unknown" as never,
      }),
    ).toThrow();
  });
});

test("fatigue bucket boundaries are explicit", () => {
  expect(
    [1, 2, 3, 4, 5, 6, 10, 11, 20, 21, 50, 51, 659].map(fatigueBucket),
  ).toEqual([
    "1",
    "2",
    "3",
    "4-5",
    "4-5",
    "6-10",
    "6-10",
    "11-20",
    "11-20",
    "21-50",
    "21-50",
    "51+",
    "51+",
  ]);
  expect(() => fatigueBucket(0)).toThrow();
});

function findUsers(
  validation: boolean,
  count: number,
  prefix: string,
): string[] {
  const users: string[] = [];
  for (let index = 0; users.length < count; index += 1) {
    const user = `${prefix}_${index}`;
    if (isValidationUser(user) === validation) users.push(user);
  }
  return users;
}

function makeFixtureCsv(users: string[]): string {
  const rows = users.flatMap((user, userIndex) =>
    [1, 2, 3, 4].map((exposure, exposureIndex) => {
      const signal = userIndex + exposureIndex;
      const click = signal % 4 === 0 ? 1 : 0;
      const install = signal % 9 === 0 ? 1 : 0;
      return [
        `imp_${userIndex}_${exposure}`,
        `2026-08-${String(17 + (userIndex % 10)).padStart(2, "0")} 12:00`,
        user,
        ["casual", "companion", "rpg"][userIndex % 3],
        userIndex % 2 === 0 ? "android" : "ios",
        `v_${signal % 2}`,
        exposure % 2 === 1 ? "forest" : "temple",
        userIndex % 2 === 0 ? "Luna" : "Rex",
        exposure % 2 === 1 ? "casts_spell" : "draws_blade",
        exposure % 2 === 1 ? "Join the quest" : "Your party is waiting.",
        userIndex % 2 === 0 ? "Install Now" : "Play Free",
        exposure % 2 === 1 ? "drums" : "piano",
        "9:16",
        "15",
        String(exposure),
        String(click),
        String(install),
      ].join(",");
    }),
  );
  return `${AUDIENCE_CSV_HEADER}\n${rows.join("\n")}\n`;
}
