import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../lib/providers/qwen.ts", import.meta.url), "utf8");
const stubSource = `
  export const requireProvider = () => ({
    apiKey: "test-key",
    baseUrl: "https://qwen.test/v1",
    model: "qwen3.7-plus"
  });
  export const parseJsonLoose = JSON.parse;
  export const readTextFromModelResponse = (payload) => payload.choices[0].message.content;
`;
const stubUrl = `data:text/javascript;base64,${Buffer.from(stubSource).toString("base64")}`;
let compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
compiled = compiled
  .replace('import "server-only";', "")
  .replaceAll('"@/lib/json-utils"', JSON.stringify(stubUrl))
  .replaceAll('"@/lib/provider-config"', JSON.stringify(stubUrl));
const qwen = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

async function captureRequest(input) {
  let requestBody;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init.body));
    const result = JSON.stringify({ summary: "ok" });
    const chunks = [result.slice(0, 8), result.slice(8)]
      .map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`)
      .join("\n");
    return new Response(`${chunks}\ndata: [DONE]\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  try {
    await qwen.analyzeVideoWithQwen({ prompt: "分析", ...input });
    return requestBody;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("TikTok analysis sends the complete remote video instead of sampled images", async () => {
  const body = await captureRequest({
    remoteVideoUrl: "https://cdn.example/full-video.mp4?token=temporary",
    localVideoPath: "/not/read/when/remote/url/is/valid.mp4",
  });
  const content = body.messages[0].content;
  assert.equal(content.length, 2);
  assert.equal(content[0].type, "video_url");
  assert.equal(content[0].video_url.url, "https://cdn.example/full-video.mp4?token=temporary");
  assert.equal(content[0].fps, 2);
  assert.equal(content.some((item) => item.type === "image_url"), false);
  assert.equal(content.some((item) => item.type === "input_audio"), false);
  assert.match(content[1].text, /原始画面和原始音轨的完整 MP4/);
  assert.equal(body.model, "qwen3.5-omni-plus");
  assert.deepEqual(body.modalities, ["text"]);
  assert.equal(body.stream, true);
  assert.equal("response_format" in body, false);
});

test("local uploads inline the complete video when no public URL exists", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "qwen-video-"));
  const videoPath = path.join(directory, "full.mp4");
  await writeFile(videoPath, Buffer.from("complete-video-bytes"));
  const body = await captureRequest({ localVideoPath: videoPath });
  const video = body.messages[0].content[0];
  assert.equal(video.type, "video_url");
  assert.match(video.video_url.url, /^data:video\/mp4;base64,/);
  assert.equal(video.video_url.url.endsWith(Buffer.from("complete-video-bytes").toString("base64")), true);
});
