import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../lib/providers/qwen.ts", import.meta.url), "utf8");
const stubSource = `
  export const requireProvider = () => ({
    apiKey: "test-key",
    baseUrl: "https://qwen.test/v1",
    model: "qwen3.7-plus"
  });
  export const parseJsonLoose = JSON.parse;
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

const directory = await mkdtemp(path.join(tmpdir(), "qwen-video-"));
const videoPath = path.join(directory, "complete.mp4");
const videoBytes = Buffer.from([0, 1, 2, 3, 127, 128, 254, 255, ...Buffer.from("complete-video")]);
await writeFile(videoPath, videoBytes);

function successfulStream({ requestId = "req-success", result = { summary: "ok" } } = {}) {
  const serialized = JSON.stringify(result);
  const chunks = [serialized.slice(0, 8), serialized.slice(8)]
    .map((content) => `data: ${JSON.stringify({ id: "stream-id", choices: [{ delta: { content } }] })}`)
    .join("\n");
  return new Response(`${chunks}\ndata: [DONE]\n`, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "x-request-id": requestId,
    },
  });
}

async function withMockedFetch(fetchImpl, task) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await task();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("Qwen always sends the local complete MP4 and ignores a residual remote URL", async () => {
  const remoteVideoUrl = "https://cdn.example/remote-video-that-must-not-be-used.mp4?token=secret";
  let requestBody;
  let diagnostic;
  const result = await withMockedFetch(async (_url, init) => {
    requestBody = JSON.parse(String(init.body));
    return successfulStream();
  }, () => qwen.analyzeVideoWithQwen({
    prompt: "分析",
    localVideoPath: videoPath,
    remoteVideoUrl,
    onDiagnostic(value) {
      diagnostic = value;
    },
  }));

  assert.deepEqual(result, { summary: "ok" });
  const content = requestBody.messages[0].content;
  assert.equal(content.length, 2);
  assert.equal(content[0].type, "video_url");
  assert.match(content[0].video_url.url, /^data:video\/mp4;base64,/);
  assert.equal(JSON.stringify(requestBody).includes(remoteVideoUrl), false);
  assert.deepEqual(
    Buffer.from(content[0].video_url.url.split(",", 2)[1], "base64"),
    videoBytes,
  );
  assert.equal(content[0].fps, 2);
  assert.equal(content.some((item) => item.type === "image_url"), false);
  assert.equal(content.some((item) => item.type === "input_audio"), false);
  assert.match(content[1].text, /原始画面和原始音轨的完整 MP4/);
  assert.equal(requestBody.model, "qwen3.5-omni-plus");
  assert.deepEqual(requestBody.modalities, ["text"]);
  assert.equal(requestBody.stream, true);
  assert.equal("response_format" in requestBody, false);

  assert.equal(diagnostic.outcome, "success");
  assert.equal(diagnostic.model, "qwen3.5-omni-plus");
  assert.equal(diagnostic.inputBytes, videoBytes.length);
  assert.equal(diagnostic.inputSha256, createHash("sha256").update(videoBytes).digest("hex"));
  assert.equal(diagnostic.requestId, "req-success");
  assert.equal(diagnostic.httpStatus, 200);
  assert.equal(typeof diagnostic.headersMs, "number");
  assert.equal(typeof diagnostic.firstTokenMs, "number");
  assert.equal(typeof diagnostic.totalMs, "number");
  assert.equal(
    diagnostic.responseSha256,
    createHash("sha256").update(JSON.stringify({ summary: "ok" })).digest("hex"),
  );
});

test("a throwing diagnostic callback cannot alter a successful analysis", async () => {
  let callbackCalls = 0;
  const result = await withMockedFetch(
    async () => successfulStream({ result: { summary: "still-ok" } }),
    () => qwen.analyzeVideoWithQwen({
      prompt: "分析",
      localVideoPath: videoPath,
      onDiagnostic() {
        callbackCalls += 1;
        throw new Error("diagnostic storage failed");
      },
    }),
  );

  assert.deepEqual(result, { summary: "still-ok" });
  assert.equal(callbackCalls, 1);
});

test("timeout failures emit a timeout diagnostic", async () => {
  let diagnostic;
  await withMockedFetch(async () => {
    throw new Error("The operation was aborted due to timeout");
  }, async () => {
    await assert.rejects(
      qwen.analyzeVideoWithQwen({
        prompt: "分析",
        localVideoPath: videoPath,
        onDiagnostic(value) {
          diagnostic = value;
        },
      }),
      /Qwen 完整视频分析超时/,
    );
  });

  assert.equal(diagnostic.outcome, "timeout");
  assert.equal(diagnostic.httpStatus, null);
  assert.equal(diagnostic.headersMs, null);
  assert.equal(diagnostic.firstTokenMs, null);
  assert.equal(diagnostic.responseSha256, "");
});

test("HTTP failures emit the response status and request ID", async () => {
  let diagnostic;
  await withMockedFetch(
    async () => new Response(JSON.stringify({ error: { message: "rate limited" } }), {
      status: 429,
      headers: {
        "content-type": "application/json",
        "x-request-id": "req-rate-limit",
      },
    }),
    async () => {
      await assert.rejects(
        qwen.analyzeVideoWithQwen({
          prompt: "分析",
          localVideoPath: videoPath,
          onDiagnostic(value) {
            diagnostic = value;
          },
        }),
        /rate limited/,
      );
    },
  );

  assert.equal(diagnostic.outcome, "http_error");
  assert.equal(diagnostic.requestId, "req-rate-limit");
  assert.equal(diagnostic.httpStatus, 429);
  assert.equal(typeof diagnostic.headersMs, "number");
  assert.equal(diagnostic.firstTokenMs, null);
});

test("an empty successful stream emits an invalid-response diagnostic", async () => {
  let diagnostic;
  await withMockedFetch(
    async () => new Response("data: [DONE]\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
    async () => {
      await assert.rejects(
        qwen.analyzeVideoWithQwen({
          prompt: "分析",
          localVideoPath: videoPath,
          onDiagnostic(value) {
            diagnostic = value;
          },
        }),
        /没有返回视频分析内容/,
      );
    },
  );

  assert.equal(diagnostic.outcome, "invalid_response");
  assert.equal(diagnostic.httpStatus, 200);
  assert.equal(typeof diagnostic.headersMs, "number");
  assert.equal(diagnostic.firstTokenMs, null);
  assert.equal(diagnostic.responseSha256, "");
});
