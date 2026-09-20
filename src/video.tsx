import {type CSSProperties} from "react";
import {
  AbsoluteFill,
  Audio,
  Composition,
  interpolate,
  registerRoot,
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
    scene: "radial-gradient(circle at 75% 18%, #f2c078 0 7%, transparent 8%), linear-gradient(160deg, #713f2b 0%, #2d1c26 54%, #100f1c 100%)",
    glow: "#f2ad63",
    horizon: "rgba(255, 205, 137, 0.26)",
  },
  moonlit_temple: {
    scene: "radial-gradient(circle at 72% 16%, #e5e8ff 0 8%, #777bb5 9%, transparent 20%), linear-gradient(165deg, #3f4475 0%, #171a36 48%, #090a16 100%)",
    glow: "#c8b778",
    horizon: "rgba(165, 172, 255, 0.2)",
  },
  neon_city: {
    scene: "linear-gradient(125deg, transparent 36%, rgba(45, 238, 255, 0.2) 37% 39%, transparent 40%), linear-gradient(155deg, #3d0b5e 0%, #11183c 48%, #050611 100%)",
    glow: "#40e8ff",
    horizon: "rgba(255, 55, 194, 0.28)",
  },
  storm_battlefield: {
    scene: "linear-gradient(115deg, transparent 43%, rgba(255, 246, 194, 0.72) 44% 45%, transparent 46%), radial-gradient(circle at 22% 70%, #763b35 0%, #2f3342 38%, #10131d 100%)",
    glow: "#ffb06d",
    horizon: "rgba(209, 221, 255, 0.2)",
  },
  sunlit_meadow: {
    scene: "radial-gradient(circle at 24% 13%, #fff4a8 0 7%, #e9b764 8%, transparent 19%), linear-gradient(165deg, #78a8a0 0%, #587c57 52%, #1d3328 100%)",
    glow: "#fff0a3",
    horizon: "rgba(208, 242, 158, 0.3)",
  },
  throne_room: {
    scene: "linear-gradient(90deg, rgba(140, 92, 38, 0.28) 0 8%, transparent 9% 91%, rgba(140, 92, 38, 0.28) 92%), radial-gradient(circle at 50% 35%, #7a323b 0%, #341825 45%, #120d18 100%)",
    glow: "#e2bd67",
    horizon: "rgba(227, 183, 93, 0.2)",
  },
} satisfies Record<Background, {scene: string; glow: string; horizon: string}>;

const CHARACTERS = {
  Kael: {gradient: "linear-gradient(145deg, #e2a84f, #6b3527)", sigil: "K"},
  Luna: {gradient: "linear-gradient(145deg, #d7d5ff, #654b9d)", sigil: "L"},
  Mira: {gradient: "linear-gradient(145deg, #89e5c0, #276b72)", sigil: "M"},
  Rex: {gradient: "linear-gradient(145deg, #e88b76, #663044)", sigil: "R"},
} satisfies Record<SubjectCharacter, {gradient: string; sigil: string}>;

const CTA_COLORS = {
  "Claim Bonus": "#ffc962",
  "Install Now": "#efe0a3",
  "Join Luna": "#d7d5ff",
  "Play Free": "#8ce2bd",
} as const;

const ACTION_STYLES = {
  casts_spell: (frame: number) => ({
    boxShadow: `0 0 ${70 + 30 * Math.sin(frame / 5)}px rgba(151, 122, 255, 0.68)`,
    transform: `rotate(${3 * Math.sin(frame / 7)}deg)`,
  }),
  close_up_smile: (frame: number) => ({
    transform: `scale(${interpolate(frame, [0, 30], [0.9, 1.18], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    })})`,
  }),
  draws_blade: (frame: number) => ({
    transform: `translateX(${interpolate(frame, [8, 32], [-75, 0], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    })}px) rotate(${interpolate(frame, [8, 32], [-12, 0], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    })}deg)`,
  }),
  opens_treasure: (frame: number) => ({
    filter: `brightness(${interpolate(frame, [15, 42], [0.75, 1.35], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    })})`,
    transform: `translateY(${8 * Math.sin(frame / 8)}px)`,
  }),
  waves_to_camera: (frame: number) => ({
    transform: `rotate(${7 * Math.sin(frame / 4)}deg)`,
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
  const audioSource = AUDIO_TRACKS[layers.audio_style];
  const opacity = interpolate(frame, [0, 15, 215, 239], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const offset = interpolate(frame, [0, 24], [70, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        background: background.scene,
        color: "#f8f2dc",
        fontFamily: "sans-serif",
        opacity,
        overflow: "hidden",
        padding: "120px 88px 96px",
      }}
    >
      <Audio loop src={staticFile(audioSource)} volume={0.35} />

      <div
        style={{
          background: background.horizon,
          borderRadius: "50%",
          filter: "blur(35px)",
          height: 760,
          left: -180,
          position: "absolute",
          top: 620,
          transform: `translateX(${24 * Math.sin(frame / 32)}px)`,
          width: 1440,
        }}
      />

      <div
        style={{
          color: background.glow,
          fontSize: 28,
          letterSpacing: 8,
          textTransform: "uppercase",
        }}
      >
        Rune Keepers · {layers.background.replaceAll("_", " ")}
      </div>

      <div
        style={{
          fontSize: 118,
          fontWeight: 800,
          letterSpacing: -5,
          lineHeight: 0.96,
          marginTop: 120,
          textShadow: `0 8px 50px ${background.glow}55`,
          transform: `translateY(${offset}px)`,
        }}
      >
        {layers.hook_text}
      </div>

      <div
        style={{
          alignItems: "center",
          display: "flex",
          flex: 1,
          justifyContent: "center",
          position: "relative",
        }}
      >
        <div style={{textAlign: "center"}}>
          <div
            style={{
              alignItems: "center",
              background: character.gradient,
              border: `3px solid ${background.glow}`,
              borderRadius: "46% 54% 50% 50%",
              color: "#141329",
              display: "flex",
              fontSize: 190,
              fontWeight: 900,
              height: 440,
              justifyContent: "center",
              margin: "0 auto",
              width: 440,
              ...ACTION_STYLES[layers.subject_action](frame),
            }}
          >
            {character.sigil}
          </div>
          <div style={{fontSize: 62, fontWeight: 750, marginTop: 46}}>
            {layers.subject_character}
          </div>
          <div
            style={{
              color: "rgba(248, 242, 220, 0.72)",
              fontSize: 34,
              marginTop: 12,
              textTransform: "capitalize",
            }}
          >
            {layers.subject_action.replaceAll("_", " ")}
          </div>
        </div>
      </div>

      <div
        style={{
          background: CTA_COLORS[layers.cta_text],
          border: `2px solid ${background.glow}`,
          borderRadius: 28,
          boxShadow: `0 14px 50px ${background.glow}40`,
          color: "#141329",
          fontSize: 48,
          fontWeight: 850,
          padding: "34px 48px",
          textAlign: "center",
          textTransform: "uppercase",
          transform: `scale(${1 + 0.025 * Math.sin(frame / 9)})`,
        }}
      >
        {layers.cta_text}
      </div>
      <div
        style={{
          color: "rgba(248, 242, 220, 0.45)",
          fontSize: 18,
          letterSpacing: 4,
          marginTop: 22,
          textAlign: "center",
          textTransform: "uppercase",
        }}
      >
        Sound · {layers.audio_style.replaceAll("_", " ")}
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
