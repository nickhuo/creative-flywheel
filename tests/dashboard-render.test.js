import {expect, test} from "bun:test";

import {
  renderOptimizationTrend,
  renderTrajectoryLog,
} from "../src/dashboard/app.js";

test("trend compares observed arms with the champion selected after each round", () => {
  const html = renderOptimizationTrend(
    [
      {
        run_id: "round_01",
        round: 1,
        decision: {action: {action: "promote"}},
        snapshots: [
          {
            primary_metric: {
              status: "ready",
              control: {mean: 0.009},
              treatment: {mean: 0.0093},
            },
          },
        ],
      },
      {
        run_id: "round_02",
        round: 2,
        decision: {action: {action: "stop"}},
        snapshots: [
          {
            primary_metric: {
              status: "ready",
              control: {mean: 0.0093},
              treatment: {mean: 0.0085},
            },
          },
        ],
      },
    ],
    "round_02",
  );

  expect(html).toContain('class="trend-dot control"');
  expect(html).toContain('class="trend-dot challenger"');
  expect(html).toContain('class="trend-dot champion"');
  expect(html).toContain('class="champion-trend"');
  const pointCoordinates = (className) =>
    [...html.matchAll(
      new RegExp(
        `class="trend-dot ${className}" cx="([^"]+)" cy="([^"]+)"`,
        "g",
      ),
    )].map((match) => match.slice(1));
  const controlPoints = pointCoordinates("control");
  const challengerPoints = pointCoordinates("challenger");
  const championPoints = pointCoordinates("champion");
  expect(championPoints[0]).toEqual(challengerPoints[0]);
  expect(championPoints[1]).toEqual(controlPoints[1]);
  expect(html).toContain("Control observed");
  expect(html).toContain("Challenger observed");
  expect(html).toContain("Champion path");
});

test("trajectory embeds rendered videos with accessible native controls", () => {
  const layers = {
    background: "moonlit_temple",
    subject_character: "Luna",
    subject_action: "draws_blade",
    hook_text: "Your party is waiting.",
    cta_text: "Install Now",
    audio_style: "warm_piano",
  };
  const html = renderTrajectoryLog(
    [
      {
        run_id: "video_round",
        round: 1,
        arms: [
          {
            role: "control",
            variant_id: "g0_v00",
            allocation_percent: 50,
            layers,
            video_url: "/media/video_run/g0_v00.mp4",
          },
          {
            role: "treatment",
            variant_id: "g0_v01",
            allocation_percent: 50,
            layers: {...layers, hook_text: "The ruins are calling"},
            video_url: null,
          },
        ],
        required_users: 49_500,
        minimum_detectable_effect: 0.0025,
        alpha: 0.05,
        power: 0.8,
        batch_size: 500,
        hypothesis_changes: [],
        snapshots: [{primary_metric: {status: "pending"}}],
        decision: null,
      },
    ],
    "video_round",
  );

  expect(html).toContain("<video controls playsinline preload=\"metadata\"");
  expect(html).toContain(
    'aria-label="Control video for g0_v00"',
  );
  expect(html).toContain(
    '<source src="/media/video_run/g0_v00.mp4" type="video/mp4">',
  );
  expect(html).toContain("g0_v01 · unavailable");
});
