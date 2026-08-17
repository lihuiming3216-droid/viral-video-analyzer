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

async function makeFixture(directory, name, includeAudio) {
  const output = path.join(directory, name);
  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=12",
  ];
  if (includeAudio) {
    args.push(
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000",
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
});
