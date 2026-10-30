import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffprobeStatic from "ffprobe-static";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

test("chunked cover downloads enforce their streamed size limit and preserve an existing file", async t => {
  const videoId = `audit-${randomUUID()}`;
  const target = processing.resolveMediaPath(`${videoId}/cover.jpg`);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, "prior valid cover");
  const oldFetch = globalThis.fetch;
  t.after(async () => { globalThis.fetch = oldFetch; await rm(path.dirname(target), { recursive: true, force: true }); });
  let chunks = 0;
  globalThis.fetch = async () => new Response(new ReadableStream({
    pull(controller) { if (chunks++ < 13) controller.enqueue(new Uint8Array(1024 * 1024)); else controller.close(); },
  }), { headers: { "content-type": "image/jpeg" } });
  await assert.rejects(processing.downloadMedia(videoId, "https://fixture.invalid/cover.jpg", "cover"), /超过 12MB/);
  assert.equal(await readFile(target, "utf8"), "prior valid cover");
  assert.deepEqual(await readdir(path.dirname(target)), ["cover.jpg"], "partial downloads are cleaned, prior files are retained");
});

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
