import {mkdir, rename} from "node:fs/promises";
import {dirname, resolve} from "node:path";

import {z} from "zod";

import {
  artifactPath,
  creativeManifestPath,
  projectRoot,
  runArtifactPaths,
  writeJsonAtomic,
  writeJsonNew,
} from "../artifacts";
import {experimentRunIdSchema} from "../experiment/run";
import {renderableCreativeManifestSchema, VIDEO_SPEC} from "../manifest";

const MAX_CONTAINER_DURATION_DRIFT_IN_FRAMES = 2; // Covers silent AAC encoder priming.

const probeSchema = z.object({
  streams: z.array(
    z.object({
      codec_type: z.string(),
      codec_name: z.string(),
      width: z.number().optional(),
      height: z.number().optional(),
      pix_fmt: z.string().optional(),
      avg_frame_rate: z.string(),
      nb_read_frames: z.string(),
    }),
  ),
  format: z.object({
    format_name: z.string(),
    duration: z.string(),
  }),
});

const [runFlag, runIdArgument, manifestArgument] = Bun.argv.slice(2);

if (
  runFlag !== "--run-id" ||
  runIdArgument === undefined ||
  manifestArgument === undefined
) {
  throw new Error(
    "Usage: bun run render --run-id <optimization-run-id> <manifest.json>",
  );
}

const optimizationRunId = experimentRunIdSchema.parse(runIdArgument);
const planPath = runArtifactPaths(optimizationRunId).plan;
if (!(await Bun.file(planPath).exists())) {
  throw new Error(`Optimization run not found: ${optimizationRunId}`);
}
const manifestPath = resolve(manifestArgument);
const manifestFile = Bun.file(manifestPath);

if (!(await manifestFile.exists())) {
  throw new Error(`Manifest not found: ${manifestPath}`);
}

const manifestJson: unknown = await manifestFile.json();
const manifest = renderableCreativeManifestSchema.parse(manifestJson);
const storedManifestPath = creativeManifestPath(
  optimizationRunId,
  manifest.variant_id,
);
const creativeDirectory = dirname(storedManifestPath);
const outputPath = resolve(creativeDirectory, "video.mp4");
const pendingOutputPath = resolve(creativeDirectory, "video.partial.mp4");
const renderMetadataPath = resolve(creativeDirectory, "render.json");
const remotionCli = resolve(projectRoot, "node_modules/.bin/remotion");

await mkdir(creativeDirectory, {recursive: true});
const storedManifestFile = Bun.file(storedManifestPath);
if (await storedManifestFile.exists()) {
  const storedManifest = renderableCreativeManifestSchema.parse(
    await storedManifestFile.json(),
  );
  if (JSON.stringify(storedManifest) !== JSON.stringify(manifest)) {
    throw new Error(
      `Creative ${manifest.variant_id} already has a different manifest.`,
    );
  }
} else {
  await writeJsonNew(storedManifestPath, manifest);
}
if (await Bun.file(outputPath).exists()) {
  throw new Error(`Rendered video already exists for ${manifest.variant_id}.`);
}

const renderProcess = Bun.spawn({
  cmd: [
    remotionCli,
    "render",
    resolve(projectRoot, "src/video.tsx"),
    VIDEO_SPEC.compositionId,
    pendingOutputPath,
    `--props=${JSON.stringify(manifest)}`,
    "--codec=h264",
    "--audio-codec=aac",
    "--pixel-format=yuv420p",
    "--color-space=bt709",
    "--enforce-audio-track",
    "--concurrency=1",
  ],
  cwd: projectRoot,
  stdout: "inherit",
  stderr: "inherit",
});
const exitCode = await renderProcess.exited;

if (exitCode !== 0) {
  throw new Error(`Render failed with exit code ${exitCode}.`);
}

const probeProcess = Bun.spawn({
  cmd: [
    remotionCli,
    "ffprobe",
    "-v",
    "error",
    "-count_frames",
    "-show_entries",
    "format=format_name,duration:stream=codec_type,codec_name,width,height,pix_fmt,avg_frame_rate,nb_read_frames",
    "-of",
    "json",
    "-i",
    pendingOutputPath,
  ],
  cwd: projectRoot,
  stdout: "pipe",
  stderr: "pipe",
});
const [probeExitCode, probeOutput, probeError] = await Promise.all([
  probeProcess.exited,
  new Response(probeProcess.stdout).text(),
  new Response(probeProcess.stderr).text(),
]);

if (probeExitCode !== 0 || probeError.trim() !== "") {
  throw new Error(`ffprobe failed: ${probeError.trim() || probeExitCode}`);
}

const probeJson: unknown = JSON.parse(probeOutput);
const probe = probeSchema.parse(probeJson);
const videoStreams = probe.streams.filter(
  (stream) => stream.codec_type === "video",
);
const audioStreams = probe.streams.filter(
  (stream) => stream.codec_type === "audio",
);
const video = videoStreams[0];
const audio = audioStreams[0];
const failures: string[] = [];

if (videoStreams.length !== 1 || audioStreams.length !== 1) {
  failures.push("expected exactly one video stream and one audio stream");
}

if (video !== undefined) {
  const [fpsNumerator, fpsDenominator] = video.avg_frame_rate
    .split("/")
    .map(Number);
  const fps = fpsNumerator / fpsDenominator;

  if (video.codec_name !== "h264") failures.push("video codec is not h264");
  if (video.width !== VIDEO_SPEC.width || video.height !== VIDEO_SPEC.height) {
    failures.push(`dimensions are not ${VIDEO_SPEC.width}x${VIDEO_SPEC.height}`);
  }
  if (video.pix_fmt !== "yuv420p") failures.push("pixel format is not yuv420p");
  if (fps !== VIDEO_SPEC.fps) failures.push(`frame rate is not ${VIDEO_SPEC.fps}`);
  if (Number(video.nb_read_frames) !== VIDEO_SPEC.durationInFrames) {
    failures.push(`frame count is not ${VIDEO_SPEC.durationInFrames}`);
  }
}

if (audio !== undefined && audio.codec_name !== "aac") {
  failures.push("audio codec is not aac");
}

if (!probe.format.format_name.split(",").includes("mp4")) {
  failures.push("container is not mp4");
}

const expectedDuration = VIDEO_SPEC.durationInFrames / VIDEO_SPEC.fps;
const duration = Number(probe.format.duration);

if (
  !Number.isFinite(duration) ||
  Math.abs(duration - expectedDuration) >
    MAX_CONTAINER_DURATION_DRIFT_IN_FRAMES / VIDEO_SPEC.fps
) {
  failures.push(`duration is not approximately ${expectedDuration} seconds`);
}

if (failures.length > 0) {
  throw new Error(`Rendered media failed validation: ${failures.join("; ")}.`);
}

await rename(pendingOutputPath, outputPath);

await writeJsonAtomic(renderMetadataPath, {
  schema_version: 1,
  variant_id: manifest.variant_id,
  rendered_at: new Date().toISOString(),
  renderer: {
    name: "remotion",
    composition_id: VIDEO_SPEC.compositionId,
  },
  video: {
    path: artifactPath(outputPath),
    codec: "h264",
    audio_codec: "aac",
    pixel_format: "yuv420p",
    width: VIDEO_SPEC.width,
    height: VIDEO_SPEC.height,
    fps: VIDEO_SPEC.fps,
    duration_in_frames: VIDEO_SPEC.durationInFrames,
  },
});

console.log(`Rendered and validated ${manifest.variant_id} at ${outputPath}`);
