import {mkdir, rename} from "node:fs/promises";
import {resolve} from "node:path";

import {z} from "zod";

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

const [manifestArgument] = Bun.argv.slice(2);

if (manifestArgument === undefined) {
  throw new Error("Usage: bun run render <manifest.json>");
}

const projectRoot = resolve(import.meta.dir, "../..");
const manifestPath = resolve(manifestArgument);
const manifestFile = Bun.file(manifestPath);

if (!(await manifestFile.exists())) {
  throw new Error(`Manifest not found: ${manifestPath}`);
}

const manifestJson: unknown = await manifestFile.json();
const manifest = renderableCreativeManifestSchema.parse(manifestJson);
const rendersDirectory = resolve(projectRoot, "renders");
const outputPath = resolve(rendersDirectory, `${manifest.variant_id}.mp4`);
const pendingOutputPath = resolve(
  rendersDirectory,
  `${manifest.variant_id}.partial.mp4`,
);
const remotionCli = resolve(projectRoot, "node_modules/.bin/remotion");

await mkdir(rendersDirectory, {recursive: true});

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

console.log(`Rendered and validated ${manifest.variant_id} at ${outputPath}`);
