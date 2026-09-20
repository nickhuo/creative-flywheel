import {z} from "zod";

const nonEmptyString = z.string().trim().min(1);
const manifestId = nonEmptyString.regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, {
  message: "Use only letters, numbers, underscores, and hyphens.",
});

export const CREATIVE_LAYER_FIELDS = [
  "background",
  "subject_character",
  "subject_action",
  "hook_text",
  "cta_text",
  "audio_style",
] as const;

export const CREATIVE_LAYER_VALUES = {
  background: [
    "cozy_cafe",
    "moonlit_temple",
    "neon_city",
    "storm_battlefield",
    "sunlit_meadow",
    "throne_room",
  ],
  subject_character: ["Kael", "Luna", "Mira", "Rex"],
  subject_action: [
    "casts_spell",
    "close_up_smile",
    "draws_blade",
    "opens_treasure",
    "waves_to_camera",
  ],
  hook_text: [
    "Can you beat level 3?",
    "Free gems every day",
    "She remembers everything.",
    "The ruins are calling",
    "Your party is waiting.",
  ],
  cta_text: ["Claim Bonus", "Install Now", "Join Luna", "Play Free"],
  audio_style: ["low_drums", "none", "upbeat_synth", "warm_piano"],
} as const;

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

export const renderableCreativeLayersSchema = z
  .object({
    background: z.enum(CREATIVE_LAYER_VALUES.background),
    subject_character: z.enum(CREATIVE_LAYER_VALUES.subject_character),
    subject_action: z.enum(CREATIVE_LAYER_VALUES.subject_action),
    hook_text: z.enum(CREATIVE_LAYER_VALUES.hook_text),
    cta_text: z.enum(CREATIVE_LAYER_VALUES.cta_text),
    audio_style: z.enum(CREATIVE_LAYER_VALUES.audio_style),
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

export const renderableCreativeManifestSchema = creativeManifestSchema.safeExtend({
  layers: renderableCreativeLayersSchema,
});

export type CreativeManifest = z.infer<typeof creativeManifestSchema>;
export type RenderableCreativeManifest = z.infer<
  typeof renderableCreativeManifestSchema
>;
export type CreativeLayerField = (typeof CREATIVE_LAYER_FIELDS)[number];
export type Background = (typeof CREATIVE_LAYER_VALUES.background)[number];
export type SubjectCharacter =
  (typeof CREATIVE_LAYER_VALUES.subject_character)[number];
export type SubjectAction =
  (typeof CREATIVE_LAYER_VALUES.subject_action)[number];
export type AudioStyle = (typeof CREATIVE_LAYER_VALUES.audio_style)[number];

export const VIDEO_SPEC = {
  compositionId: "RuneKeepersAd",
  width: 1080,
  height: 1920,
  fps: 30,
  durationInFrames: 240,
} as const;
