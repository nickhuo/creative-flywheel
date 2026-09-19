import {z} from "zod";

const nonEmptyString = z.string().trim().min(1);
const manifestId = nonEmptyString.regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, {
  message: "Use only letters, numbers, underscores, and hyphens.",
});

export const creativeLayersSchema = z
  .object({
    background: nonEmptyString,
    subject_character: nonEmptyString,
    subject_action: nonEmptyString,
    hook_text: nonEmptyString,
    cta_text: nonEmptyString,
    audio_style: nonEmptyString,
  })
  .strict();

export const creativeManifestSchema = z
  .object({
    variant_id: manifestId,
    generation: z.number().int().nonnegative(),
    parent_id: manifestId.nullable(),
    layers: creativeLayersSchema,
  })
  .strict()
  .superRefine((manifest, context) => {
    const hasValidParent =
      manifest.generation === 0
        ? manifest.parent_id === null
        : manifest.parent_id !== null;

    if (!hasValidParent) {
      context.addIssue({
        code: "custom",
        message: "Generation 0 must have no parent; later generations require one.",
        path: ["parent_id"],
      });
    }
  });

export type CreativeManifest = z.infer<typeof creativeManifestSchema>;

export const VIDEO_SPEC = {
  compositionId: "RuneKeepersAd",
  width: 1080,
  height: 1920,
  fps: 30,
  durationInFrames: 240,
} as const;
