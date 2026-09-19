import {
  AbsoluteFill,
  Composition,
  interpolate,
  registerRoot,
  useCurrentFrame,
} from "remotion";

import {
  creativeManifestSchema,
  type CreativeManifest,
  VIDEO_SPEC,
} from "./manifest";

const defaultManifest: CreativeManifest = {
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

const formatLayerValue = (value: string): string => value.replaceAll("_", " ");

const RuneKeepersAd = ({layers}: CreativeManifest) => {
  const frame = useCurrentFrame();
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
        background: "radial-gradient(circle at 50% 32%, #3f4475 0%, #171a36 38%, #090a16 100%)",
        color: "#f8f2dc",
        fontFamily: "sans-serif",
        opacity,
        padding: "120px 88px 96px"
      }}
    >
      <div
        style={{
          color: "#c8b778",
          fontSize: 28,
          letterSpacing: 8,
          textTransform: "uppercase",
        }}
      >
        Rune Keepers · {formatLayerValue(layers.background)}
      </div>

      <div
        style={{
          fontSize: 118,
          fontWeight: 800,
          letterSpacing: -5,
          lineHeight: 0.96,
          marginTop: 120,
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
        }}
      >
        <div style={{textAlign: "center"}}>
          <div
            style={{
              alignItems: "center",
              background: "linear-gradient(145deg, #d5bc73, #70552b)",
              border: "3px solid rgba(255, 244, 199, 0.72)",
              borderRadius: "50%",
              boxShadow: "0 30px 90px rgba(0, 0, 0, 0.45)",
              color: "#141329",
              display: "flex",
              fontSize: 190,
              fontWeight: 900,
              height: 440,
              justifyContent: "center",
              margin: "0 auto",
              width: 440,
            }}
          >
            {layers.subject_character.slice(0, 1)}
          </div>
          <div style={{fontSize: 62, fontWeight: 750, marginTop: 46}}>
            {layers.subject_character}
          </div>
          <div
            style={{
              color: "rgba(248, 242, 220, 0.68)",
              fontSize: 34,
              marginTop: 12,
              textTransform: "capitalize",
            }}
          >
            {formatLayerValue(layers.subject_action)}
          </div>
        </div>
      </div>

      <div
        style={{
          background: "#efe0a3",
          borderRadius: 28,
          color: "#141329",
          fontSize: 48,
          fontWeight: 850,
          padding: "34px 48px",
          textAlign: "center",
          textTransform: "uppercase",
        }}
      >
        {layers.cta_text}
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
    schema={creativeManifestSchema}
  />
);

registerRoot(RemotionRoot);
