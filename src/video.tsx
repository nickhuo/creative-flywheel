import {type CSSProperties} from "react";
import {
  AbsoluteFill,
  Audio,
  Composition,
  Img,
  interpolate,
  registerRoot,
  spring,
  staticFile,
  useCurrentFrame,
} from "remotion";

import {
  renderableCreativeManifestSchema,
  type AudioStyle,
  type Background,
  type RenderableCreativeManifest,
  type SubjectAction,
  type SubjectCharacter,
  VIDEO_SPEC,
} from "./manifest";

const AUDIO_TRACKS = {
  low_drums: "audio/low_drums.ogg",
  upbeat_synth: "audio/upbeat_synth.ogg",
  warm_piano: "audio/warm_piano.ogg",
} satisfies Record<AudioStyle, string>;

const BACKGROUNDS = {
  cozy_cafe: {
    sky: "linear-gradient(180deg, #f48675 0%, #f8bd78 35%, #273a3d 72%, #101719 100%)",
    accent: "#ffd45c",
    sun: "#fff1a3",
    far: "#5f6452",
    near: "#162729",
    eyebrow: "REST BETWEEN ADVENTURES",
  },
  moonlit_temple: {
    sky: "linear-gradient(180deg, #103943 0%, #155d62 36%, #132f3a 68%, #081419 100%)",
    accent: "#35e8ee",
    sun: "#bdfbff",
    far: "#28535a",
    near: "#0a242b",
    eyebrow: "ANCIENT RUNES AWAKE",
  },
  neon_city: {
    sky: "linear-gradient(180deg, #3b195b 0%, #973b87 34%, #263d59 70%, #101525 100%)",
    accent: "#50efff",
    sun: "#ff9fd8",
    far: "#47365f",
    near: "#171b35",
    eyebrow: "MAGIC MEETS THE UNKNOWN",
  },
  storm_battlefield: {
    sky: "linear-gradient(180deg, #253546 0%, #52616f 36%, #7b553f 70%, #1b1c22 100%)",
    accent: "#ffbf57",
    sun: "#fff0a1",
    far: "#514b4c",
    near: "#1b2128",
    eyebrow: "EVERY CHOICE LEAVES A MARK",
  },
  sunlit_meadow: {
    sky: "linear-gradient(180deg, #f69ab4 0%, #ffc67d 37%, #65846f 69%, #213429 100%)",
    accent: "#fff06a",
    sun: "#fffbd0",
    far: "#638565",
    near: "#234630",
    eyebrow: "A WHOLE WORLD TO WANDER",
  },
  throne_room: {
    sky: "linear-gradient(180deg, #102d3b 0%, #215568 36%, #705342 70%, #17151a 100%)",
    accent: "#6df5ef",
    sun: "#ffd96e",
    far: "#3f5660",
    near: "#142833",
    eyebrow: "FORGE YOUR OWN LEGEND",
  },
} satisfies Record<
  Background,
  {
    sky: string;
    accent: string;
    sun: string;
    far: string;
    near: string;
    eyebrow: string;
  }
>;

const CHARACTERS = {
  Kael: {
    image: "characters/kael.png",
    role: "RUNE KNIGHT",
    promise: "Choose your path.",
    accent: "#40e6ee",
  },
  Luna: {
    image: "characters/luna.png",
    role: "BEAST TAMER",
    promise: "Befriend what others fear.",
    accent: "#ee70e6",
  },
  Mira: {
    image: "characters/mira.png",
    role: "WILD SAGE",
    promise: "Every creature has a story.",
    accent: "#7fe3a2",
  },
  Rex: {
    image: "characters/rex.png",
    role: "VANGUARD",
    promise: "Make the world your own.",
    accent: "#ffc45b",
  },
} satisfies Record<
  SubjectCharacter,
  {image: string; role: string; promise: string; accent: string}
>;

const ACTION_LABELS = {
  casts_spell: "RUNE CHARGED",
  close_up_smile: "TRUST EARNED",
  draws_blade: "QUEST STARTED",
  opens_treasure: "RELIC FOUND",
  waves_to_camera: "PARTY READY",
} satisfies Record<SubjectAction, string>;

const CTA_COLORS = {
  "Claim Bonus": "linear-gradient(135deg, #ffd95f, #f49b42)",
  "Install Now": "linear-gradient(135deg, #6ff5ef, #38b8e9)",
  "Join Luna": "linear-gradient(135deg, #ff93df, #a988ff)",
  "Play Free": "linear-gradient(135deg, #9cf08d, #47d5b0)",
} as const;

const ACTION_STYLES = {
  casts_spell: (frame: number) => ({
    filter: `drop-shadow(0 0 ${34 + 12 * Math.sin(frame / 5)}px rgba(63, 235, 242, 0.7))`,
    transform: `scale(${1.01 + 0.014 * Math.sin(frame / 8)}) rotate(${1.2 * Math.sin(frame / 11)}deg)`,
  }),
  close_up_smile: (frame: number) => ({
    transform: `translateY(82px) scale(${interpolate(frame, [0, 56], [0.98, 1.22], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    })})`,
  }),
  draws_blade: (frame: number) => ({
    transform: `translateX(${interpolate(frame, [8, 34], [80, 0], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    })}px) rotate(${interpolate(frame, [8, 34], [3, 0], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    })}deg)`,
  }),
  opens_treasure: (frame: number) => ({
    filter: `brightness(${interpolate(frame, [28, 64], [0.8, 1.16], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    })}) drop-shadow(0 18px 38px rgba(255, 213, 80, 0.32))`,
    transform: `translateY(${9 * Math.sin(frame / 10)}px)`,
  }),
  waves_to_camera: (frame: number) => ({
    transform: `rotate(${2 * Math.sin(frame / 5)}deg)`,
  }),
} satisfies Record<SubjectAction, (frame: number) => CSSProperties>;

const defaultManifest: RenderableCreativeManifest = {
  variant_id: "g0_v00",
  generation: 0,
  parent_id: null,
  layers: {
    background: "moonlit_temple",
    subject_character: "Luna",
    subject_action: "draws_blade",
    hook_text: "Your party is waiting.",
    cta_text: "Install Now",
    audio_style: "warm_piano",
  },
};

const RuneKeepersAd = ({layers}: RenderableCreativeManifest) => {
  const frame = useCurrentFrame();
  const background = BACKGROUNDS[layers.background];
  const character = CHARACTERS[layers.subject_character];
  const entrance = spring({
    frame,
    fps: VIDEO_SPEC.fps,
    config: {damping: 17, mass: 0.9, stiffness: 104},
  });
  const hookOpacity = interpolate(frame, [5, 20, 208, 228], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const characterOpacity = interpolate(frame, [12, 30], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const ctaProgress = spring({
    frame: frame - 128,
    fps: VIDEO_SPEC.fps,
    config: {damping: 16, mass: 0.75, stiffness: 120},
  });
  const worldDrift = 18 * Math.sin(frame / 42);

  return (
    <AbsoluteFill
      style={{
        background: background.sky,
        color: "#fffbed",
        fontFamily:
          'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        overflow: "hidden",
      }}
    >
      <Audio
        loop
        src={staticFile(AUDIO_TRACKS[layers.audio_style])}
        volume={0.34}
      />

      <div
        style={{
          background: background.sun,
          borderRadius: "46% 54% 48% 52%",
          boxShadow: `0 0 100px ${background.sun}99`,
          height: 230,
          opacity: 0.9,
          position: "absolute",
          right: 74 + worldDrift,
          top: 260,
          transform: `rotate(${frame / 10}deg)`,
          width: 230,
        }}
      />

      <div
        style={{
          background: background.far,
          bottom: 460,
          clipPath:
            "polygon(0 70%, 12% 45%, 20% 61%, 34% 23%, 47% 58%, 60% 31%, 73% 62%, 88% 27%, 100% 53%, 100% 100%, 0 100%)",
          height: 650,
          left: -70 + worldDrift,
          opacity: 0.86,
          position: "absolute",
          width: 1240,
        }}
      />
      <div
        style={{
          background: background.near,
          bottom: 310,
          clipPath:
            "polygon(0 55%, 9% 36%, 18% 58%, 29% 30%, 39% 66%, 52% 39%, 63% 58%, 75% 25%, 87% 54%, 95% 39%, 100% 48%, 100% 100%, 0 100%)",
          height: 620,
          left: -90 - worldDrift,
          position: "absolute",
          width: 1280,
        }}
      />

      {Array.from({length: 8}, (_, index) => (
        <div
          key={index}
          style={{
            background: index % 2 === 0 ? background.near : background.far,
            clipPath: "polygon(50% 0, 100% 78%, 68% 72%, 88% 100%, 12% 100%, 32% 72%, 0 78%)",
            height: 220 + (index % 3) * 72,
            left: index * 150 - 70 + worldDrift * (index % 2 === 0 ? 0.4 : -0.3),
            opacity: index % 2 === 0 ? 0.92 : 0.6,
            position: "absolute",
            top: 770 - (index % 3) * 70,
            width: 150,
          }}
        />
      ))}

      <div
        style={{
          border: `3px solid ${background.accent}55`,
          borderRadius: "50%",
          boxShadow: `0 0 90px ${background.accent}25, inset 0 0 60px ${background.accent}1c`,
          height: 790,
          left: 145,
          position: "absolute",
          top: 590,
          transform: `rotate(${frame / 7}deg)`,
          width: 790,
        }}
      >
        <div
          style={{
            border: `2px solid ${background.accent}44`,
            height: 550,
            left: 118,
            position: "absolute",
            top: 118,
            transform: "rotate(45deg)",
            width: 550,
          }}
        />
      </div>

      <div
        style={{
          alignItems: "center",
          display: "flex",
          left: 64,
          position: "absolute",
          right: 64,
          top: 58,
          zIndex: 5,
        }}
      >
        <div
          style={{
            background: `linear-gradient(135deg, #8fffff, ${background.accent})`,
            boxShadow: `0 0 28px ${background.accent}aa`,
            clipPath: "polygon(50% 0, 92% 25%, 78% 82%, 50% 100%, 20% 80%, 8% 28%)",
            height: 58,
            marginRight: 20,
            transform: `rotate(${4 * Math.sin(frame / 24)}deg)`,
            width: 45,
          }}
        />
        <div>
          <div
            style={{
              fontFamily: "Impact, 'Arial Black', sans-serif",
              fontSize: 44,
              fontStyle: "italic",
              fontWeight: 900,
              letterSpacing: -1,
              lineHeight: 0.9,
              textShadow: "3px 4px 0 #0a2025, -1px -1px 0 #0a2025",
            }}
          >
            RUNEKEEPER
          </div>
          <div
            style={{
              color: background.accent,
              fontSize: 14,
              fontWeight: 900,
              letterSpacing: 4,
              marginTop: 10,
            }}
          >
            OPEN WORLD · MONSTER TAMING RPG
          </div>
        </div>
        <div
          style={{
            background: `linear-gradient(90deg, ${background.accent}77, transparent)`,
            height: 2,
            marginLeft: 26,
            flex: 1,
          }}
        />
      </div>

      <div
        style={{
          left: 64,
          opacity: hookOpacity,
          position: "absolute",
          right: 64,
          top: 190,
          transform: `translateY(${interpolate(entrance, [0, 1], [48, 0])}px)`,
          zIndex: 4,
        }}
      >
        <div
          style={{
            alignItems: "center",
            display: "flex",
            gap: 15,
            marginBottom: 18,
          }}
        >
          <div
            style={{
              background: background.accent,
              boxShadow: `0 0 18px ${background.accent}`,
              height: 10,
              transform: "rotate(45deg)",
              width: 10,
            }}
          />
          <div
            style={{
              color: background.accent,
              fontSize: 18,
              fontWeight: 900,
              letterSpacing: 5,
            }}
          >
            {background.eyebrow}
          </div>
        </div>
        <div
          style={{
            fontFamily: "Impact, 'Arial Black', sans-serif",
            fontSize: 108,
            fontWeight: 950,
            letterSpacing: -2.5,
            lineHeight: 0.91,
            maxWidth: 920,
            textShadow:
              "0 7px 0 rgba(8, 23, 27, 0.8), 0 18px 46px rgba(4, 14, 20, 0.45)",
            textTransform: "uppercase",
          }}
        >
          {layers.hook_text}
        </div>
      </div>

      <div
        style={{
          bottom: 230,
          height: 1160,
          left: -34,
          opacity: characterOpacity,
          position: "absolute",
          right: -34,
          transform: `translateY(${interpolate(entrance, [0, 1], [82, 0])}px)`,
          zIndex: 2,
        }}
      >
        <Img
          src={staticFile(character.image)}
          style={{
            height: "100%",
            objectFit: "contain",
            objectPosition: "center bottom",
            width: "100%",
            ...ACTION_STYLES[layers.subject_action](frame),
          }}
        />
      </div>

      <div
        style={{
          background:
            "linear-gradient(180deg, transparent 0%, rgba(5, 16, 21, 0.78) 28%, #071116 62%)",
          bottom: 0,
          height: 650,
          left: 0,
          position: "absolute",
          right: 0,
          zIndex: 3,
        }}
      />

      <div
        style={{
          bottom: 265,
          left: 64,
          position: "absolute",
          right: 64,
          zIndex: 5,
        }}
      >
        <div
          style={{
            alignItems: "center",
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <div
            style={{
              alignItems: "center",
              background: "rgba(5, 18, 24, 0.72)",
              border: `2px solid ${character.accent}99`,
              borderRadius: 8,
              boxShadow: `0 0 28px ${character.accent}25`,
              display: "flex",
              gap: 14,
              padding: "13px 18px",
            }}
          >
            <div
              style={{
                background: character.accent,
                boxShadow: `0 0 16px ${character.accent}`,
                height: 10,
                transform: "rotate(45deg)",
                width: 10,
              }}
            />
            <div
              style={{
                color: character.accent,
                fontSize: 18,
                fontWeight: 900,
                letterSpacing: 3,
              }}
            >
              {ACTION_LABELS[layers.subject_action]}
            </div>
          </div>
          <div
            style={{
              background: "rgba(5, 18, 24, 0.72)",
              border: `1px solid ${background.accent}88`,
              borderRadius: 999,
              color: "rgba(255, 251, 237, 0.82)",
              fontSize: 15,
              fontWeight: 900,
              letterSpacing: 3,
              padding: "13px 18px",
            }}
          >
            {character.role}
          </div>
        </div>
        <div
          style={{
            alignItems: "baseline",
            display: "flex",
            gap: 22,
            marginTop: 18,
          }}
        >
          <div
            style={{
              fontFamily: "Impact, 'Arial Black', sans-serif",
              fontSize: 70,
              fontStyle: "italic",
              letterSpacing: 1,
              textShadow: "0 5px 0 #071116",
              textTransform: "uppercase",
            }}
          >
            {layers.subject_character}
          </div>
          <div
            style={{
              color: "rgba(255, 251, 237, 0.72)",
              fontSize: 25,
              fontWeight: 700,
            }}
          >
            {character.promise}
          </div>
        </div>
      </div>

      <div
        style={{
          bottom: 64,
          left: 64,
          opacity: ctaProgress,
          position: "absolute",
          right: 64,
          transform: `translateY(${interpolate(ctaProgress, [0, 1], [32, 0])}px) scale(${interpolate(ctaProgress, [0, 1], [0.96, 1]) * (1 + 0.007 * Math.sin(frame / 10))})`,
          zIndex: 6,
        }}
      >
        <div
          style={{
            alignItems: "center",
            background: CTA_COLORS[layers.cta_text],
            borderRadius: 14,
            boxShadow:
              "0 16px 45px rgba(0, 0, 0, 0.38), inset 0 2px rgba(255, 255, 255, 0.48)",
            color: "#07161b",
            display: "flex",
            fontFamily: "Impact, 'Arial Black', sans-serif",
            fontSize: 38,
            fontStyle: "italic",
            fontWeight: 950,
            justifyContent: "space-between",
            letterSpacing: 2,
            minHeight: 108,
            padding: "0 30px 0 38px",
            textTransform: "uppercase",
          }}
        >
          <span>{layers.cta_text}</span>
          <span
            style={{
              alignItems: "center",
              background: "rgba(5, 22, 27, 0.12)",
              border: "2px solid rgba(5, 22, 27, 0.34)",
              borderRadius: 10,
              display: "flex",
              fontFamily: "Arial, sans-serif",
              fontSize: 36,
              fontStyle: "normal",
              height: 62,
              justifyContent: "center",
              width: 62,
            }}
          >
            →
          </span>
        </div>
        <div
          style={{
            color: "rgba(255, 251, 237, 0.55)",
            fontSize: 14,
            fontWeight: 800,
            letterSpacing: 3,
            marginTop: 17,
            textAlign: "center",
          }}
        >
          EXPLORE · TAME · BUILD · CHOOSE YOUR STORY
        </div>
      </div>
    </AbsoluteFill>
  );
};

const RemotionRoot = () => (
  <Composition
    id={VIDEO_SPEC.compositionId}
    component={RuneKeepersAd}
    durationInFrames={VIDEO_SPEC.durationInFrames}
    fps={VIDEO_SPEC.fps}
    width={VIDEO_SPEC.width}
    height={VIDEO_SPEC.height}
    defaultProps={defaultManifest}
    schema={renderableCreativeManifestSchema}
  />
);

registerRoot(RemotionRoot);
