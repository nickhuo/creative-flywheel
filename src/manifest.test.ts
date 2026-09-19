import {describe, expect, test} from "bun:test";

import {creativeManifestSchema} from "./manifest";

const first = creativeManifestSchema.parse(
  await Bun.file(new URL("../manifests/g0_v00.json", import.meta.url)).json(),
);
const second = creativeManifestSchema.parse(
  await Bun.file(new URL("../manifests/g0_v01.json", import.meta.url)).json(),
);

describe("creative manifests", () => {
  test("the scaffold fixtures satisfy the schema", () => {
    expect(first.variant_id).toBe("g0_v00");
    expect(second.variant_id).toBe("g0_v01");
  });

  test("the second arm changes only its identity and hook", () => {
    expect({
      ...second,
      variant_id: first.variant_id,
      layers: {...second.layers, hook_text: first.layers.hook_text},
    }).toEqual(first);
  });

  test("later generations require a parent", () => {
    expect(
      creativeManifestSchema.safeParse({...first, generation: 1}).success,
    ).toBe(false);
  });

  test("variant IDs cannot escape the render directory", () => {
    expect(
      creativeManifestSchema.safeParse({...first, variant_id: "../../video"})
        .success,
    ).toBe(false);
  });
});
