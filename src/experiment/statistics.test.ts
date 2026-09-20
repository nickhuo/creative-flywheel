import {describe, expect, test} from "bun:test";

import {calculateRequiredUsers} from "./statistics";

describe("fixed-horizon sample size", () => {
  test("calculates both arms and rounds up to a complete traffic batch", () => {
    expect(
      calculateRequiredUsers({
        baselineRate: 0.003888736389422637,
        minimumDetectableEffect: 0.005,
        alpha: 0.05,
        power: 0.8,
        batchSize: 500,
      }),
    ).toBe(8000);
  });

  test("rejects invalid probability and allocation inputs", () => {
    expect(() =>
      calculateRequiredUsers({
        baselineRate: 0.01,
        minimumDetectableEffect: 0.005,
        alpha: 0.05,
        power: 0.8,
        batchSize: 501,
      }),
    ).toThrow("positive even integer");
    expect(() =>
      calculateRequiredUsers({
        baselineRate: 0.9,
        minimumDetectableEffect: 0.2,
        alpha: 0.05,
        power: 0.8,
        batchSize: 500,
      }),
    ).toThrow("keep the treatment rate below 1");
  });
});
