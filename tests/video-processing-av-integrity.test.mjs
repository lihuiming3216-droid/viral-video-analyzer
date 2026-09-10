import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffprobeStatic from "ffprobe-static";
import ts from "typescript";

const runFile = promisify(execFile);
const source = await readFile(new URL("../lib/video-processing.ts", import.meta.url), "utf8");

function moduleUrl(text) {
  return `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`;
}

const ffmpegStub = moduleUrl(`export default { path: ${JSON.stringify(ffmpegInstaller.path)} };`);
const ffprobeStub = moduleUrl(`export default { path: ${JSON.stringify(ffprobeStatic.path)} };`);
const networkStub = moduleUrl("export const fetchWithProxy = (...args) => fetch(...args);");
let compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
compiled = compiled
  .replace('import "server-only";', "")
  .replaceAll('"@ffmpeg-installer/ffmpeg"', JSON.stringify(ffmpegStub))
  .replaceAll('"ffprobe-static"', JSON.stringify(ffprobeStub))
  .replaceAll('"@/lib/network"', JSON.stringify(networkStub));
const processing = await import(moduleUrl(compiled));

async function makeFixture(directory, name, includeAudio, audioSource = "sine=frequency=440:sample_rate=16000") {
  const output = path.join(directory, name);
  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=12",
  ];
  if (includeAudio) {
    args.push(
      "-f", "lavfi", "-i", audioSource,
      "-map", "0:v:0", "-map", "1:a:0",
    );
  }
  args.push(
    "-t", "1",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    ...(includeAudio ? ["-c:a", "aac"] : ["-an"]),
    output,
  );
  await runFile(ffmpegInstaller.path, args, { maxBuffer: 8 * 1024 * 1024 });
  return output;
}

async function decodeAudio(file) {
  const { stdout } = await runFile(ffmpegInstaller.path, [
    "-v", "error", "-i", file, "-map", "0:a:0", "-vn",
    "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1",
  ], { encoding: "buffer", maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

function audioRms(pcm) {
  assert.ok(pcm.length > 0, "decoding must return actual audio samples");
  let squareSum = 0;
  for (let i = 0; i < pcm.length; i += 2) squareSum += pcm.readInt16LE(i) ** 2;
  return Math.sqrt(squareSum / (pcm.length / 2));
}

async function makeOversizedFixture(directory) {
  const output = path.join(directory, "large.mp4");
  await runFile(ffmpegInstaller.path, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "nullsrc=s=320x180:r=24,geq=random(1)*255:128:128",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000",
    "-t", "3",
    "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "0", "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    output,
  ], { maxBuffer: 8 * 1024 * 1024 });
  assert.ok((await stat(output)).size > 6 * 1024 * 1024);
  return output;
}

test("a small video with picture and sound is accepted without transcoding", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "qwen-av-small-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = await makeFixture(directory, "source.mp4", true);
  const targetPath = path.join(directory, "proxy.mp4");

  const prepared = await processing.prepareCompleteVideoFileForQwen(sourcePath, targetPath, 1);
  const metadata = await processing.validateCompleteVideoForQwen(prepared);

  assert.equal(prepared, sourcePath);
  assert.equal(metadata.videoCodec, "h264");
  assert.equal(metadata.audioCodec, "aac");
  await assert.rejects(access(targetPath));
});

test("a video-only MP4 is rejected before Qwen preparation", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "qwen-av-silent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = await makeFixture(directory, "silent.mp4", false);
  const targetPath = path.join(directory, "proxy.mp4");

  await assert.rejects(
    processing.prepareCompleteVideoFileForQwen(sourcePath, targetPath, 1),
    /缺少音频轨/,
  );
  await assert.rejects(access(targetPath));
});

test("a complete MP4 with a genuinely silent AAC track is accepted unchanged", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "qwen-av-zero-audio-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = await makeFixture(directory, "silent-track.mp4", true, "anullsrc=r=16000:cl=mono");
  const targetPath = path.join(directory, "proxy.mp4");
  const before = await readFile(sourcePath);
  assert.equal(audioRms(await decodeAudio(sourcePath)), 0);
  const prepared = await processing.prepareCompleteVideoFileForQwen(sourcePath, targetPath, 1);
  assert.equal(prepared, sourcePath);
  assert.equal((await processing.validateCompleteVideoForQwen(prepared)).audioCodec, "aac");
  assert.deepEqual(await readFile(prepared), before);
  await assert.rejects(access(targetPath));
});

test("an oversized source becomes a bounded full-duration H.264/AAC proxy", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "qwen-av-proxy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = await makeOversizedFixture(directory);
  const targetPath = path.join(directory, "qwen-full-video.mp4");
  const sourceMetadata = await processing.validateCompleteVideoForQwen(sourcePath);

  const prepared = await processing.prepareCompleteVideoFileForQwen(
    sourcePath,
    targetPath,
    sourceMetadata.duration,
  );
  const [targetStats, proxyMetadata] = await Promise.all([
    stat(targetPath),
    processing.validateCompleteVideoForQwen(targetPath),
  ]);

  assert.equal(prepared, targetPath);
  assert.ok(targetStats.size <= 6 * 1024 * 1024);
  assert.equal(proxyMetadata.videoCodec, "h264");
  assert.equal(proxyMetadata.audioCodec, "aac");
  assert.ok(Math.abs(proxyMetadata.duration - sourceMetadata.duration) <= 0.5);
  const sourceAudio = await decodeAudio(sourcePath);
  const proxyAudio = await decodeAudio(targetPath);
  assert.ok(audioRms(sourceAudio) > 100, "the fixture actually contains an audible signal");
  assert.ok(audioRms(proxyAudio) > 100, "transcoding must not turn the source signal into silence");
  assert.ok(Math.abs(sourceAudio.length - proxyAudio.length) / (16000 * 2) <= 0.5,
    "the proxy must retain the full audio duration as well as the picture duration");
});

test("download validation decodes both original tracks without modifying an audible or silent MP4", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "download-av-validation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [name, audio] of [["audible", "sine=frequency=440:sample_rate=16000"], ["silent", "anullsrc=r=16000:cl=mono"]]) {
    const file = await makeFixture(directory, `${name}.mp4`, true, audio);
    const before = await readFile(file);
    assert.equal((await processing.validateDownloadedVideoFile(file)).audioCodec, "aac");
    assert.deepEqual(await readFile(file), before);
  }
  const videoOnly = await makeFixture(directory, "video-only.mp4", false);
  await assert.rejects(processing.validateDownloadedVideoFile(videoOnly), /缺少音频轨/);
});
