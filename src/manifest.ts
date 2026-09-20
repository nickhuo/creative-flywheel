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

export const CREATIVE_LAYER_CATALOG = {
  background: {
    cozy_cafe: "Warm, conversational, and intimate.",
    moonlit_temple: "Mysterious fantasy exploration.",
    neon_city: "Modern, energetic, and high contrast.",
    storm_battlefield: "Urgency, danger, and combat.",
    sunlit_meadow: "Comfort, optimism, and approachability.",
    throne_room: "Epic scale, status, and power.",
  },
  subject_character: {
    Kael:
      "A sardonic dark mage in black robes who is secretly kind; signals magic, intrigue, and hidden warmth.",
    Luna:
      "A quiet hooded rogue with silver hair, dry humor, and a glowing rune blade; signals mystery, adventure, and attachment.",
    Mira:
      "A warm healer in white and gold who remembers everything the player says; signals care, memory, and trust.",
    Rex:
      "A loud, loyal armored knight with a red plume and a big grin; signals combat, energy, and loyalty.",
  },
  subject_action: {
    casts_spell: "Magic and power.",
    close_up_smile: "Warmth and trust.",
    draws_blade: "Action and impending conflict.",
    opens_treasure: "Reward and discovery.",
    waves_to_camera: "Friendly direct address.",
  },
  hook_text: {
    "Can you beat level 3?": "Challenge and mastery.",
    "Free gems every day": "Recurring tangible reward.",
    "She remembers everything.": "Memory and personal connection.",
    "The ruins are calling": "Mystery and exploration.",
    "Your party is waiting.": "Belonging and character attachment.",
  },
  cta_text: {
    "Claim Bonus": "Reward-oriented action.",
    "Install Now": "Direct acquisition action.",
    "Join Luna": "Character-specific invitation centered on Luna.",
    "Play Free": "Low-friction, free-to-play framing.",
  },
  audio_style: {
    low_drums: "Tension and anticipation.",
    upbeat_synth: "Energy and momentum.",
    warm_piano: "Warmth and emotional connection.",
  },
} as const;

function catalogValues<const Catalog extends Readonly<Record<string, string>>>(
  catalog: Catalog,
): readonly [Extract<keyof Catalog, string>, ...Extract<keyof Catalog, string>[]] {
  return Object.keys(catalog) as [
    Extract<keyof Catalog, string>,
    ...Extract<keyof Catalog, string>[],
  ];
}

export const CREATIVE_LAYER_VALUES = {
  background: catalogValues(CREATIVE_LAYER_CATALOG.background),
  subject_character: catalogValues(CREATIVE_LAYER_CATALOG.subject_character),
  subject_action: catalogValues(CREATIVE_LAYER_CATALOG.subject_action),
  hook_text: catalogValues(CREATIVE_LAYER_CATALOG.hook_text),
  cta_text: catalogValues(CREATIVE_LAYER_CATALOG.cta_text),
  audio_style: catalogValues(CREATIVE_LAYER_CATALOG.audio_style),
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
