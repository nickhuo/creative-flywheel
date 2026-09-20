import {describe, expect, test} from "bun:test";

import {audienceModelSchema} from "./audience/model";
import {
  CREATIVE_LAYER_FIELDS,
  CREATIVE_LAYER_VALUES,
  creativeManifestSchema,
  renderableCreativeManifestSchema,
} from "./manifest";

const manifests = await Promise.all(
  Array.from({length: 8}, async (_, index) =>
    renderableCreativeManifestSchema.parse(
      await Bun.file(
        new URL(
          `../manifests/g0_v${index.toString().padStart(2, "0")}.json`,
          import.meta.url,
        ),
      ).json(),
    ),
  ),
);
const first = manifests[0]!;

describe("creative manifests", () => {
  test("provides eight valid and distinct generation-zero variants", () => {
    expect(manifests).toHaveLength(8);
    expect(manifests.map((manifest) => manifest.variant_id)).toEqual([
      "g0_v00",
      "g0_v01",
      "g0_v02",
      "g0_v03",
      "g0_v04",
      "g0_v05",
      "g0_v06",
      "g0_v07",
    ]);
    expect(new Set(manifests.map((manifest) => JSON.stringify(manifest.layers))).size)
      .toBe(8);
  });

  test("covers every renderable layer value across generation zero", () => {
    for (const field of CREATIVE_LAYER_FIELDS) {
      const covered = new Set(manifests.map((manifest) => manifest.layers[field]));
      expect(covered).toEqual(new Set(CREATIVE_LAYER_VALUES[field]));
    }
  });

  test("keeps the render vocabulary aligned with the fitted audience model", async () => {
    const model = audienceModelSchema.parse(
      await Bun.file(
        new URL("../artifacts/audience/model.json", import.meta.url),
      ).json(),
    );

    for (const field of CREATIVE_LAYER_FIELDS) {
      const feature = model.features.find((candidate) => candidate.field === field);
      expect(feature?.values).toEqual([...CREATIVE_LAYER_VALUES[field]]);
    }
  });

  test("keeps unseen values analyzable but rejects them at render time", () => {
    const unknown = {
      ...first,
      layers: {...first.layers, background: "unseen_background"},
    };

    expect(creativeManifestSchema.safeParse(unknown).success).toBe(true);
    expect(renderableCreativeManifestSchema.safeParse(unknown).success).toBe(false);
  });

  test("later generations require a parent", () => {
    expect(
      renderableCreativeManifestSchema.safeParse({...first, generation: 1})
        .success,
    ).toBe(false);
  });

  test("variant IDs cannot escape the render directory", () => {
    expect(
      renderableCreativeManifestSchema.safeParse({
        ...first,
        variant_id: "../../video",
      }).success,
    ).toBe(false);
  });
});
