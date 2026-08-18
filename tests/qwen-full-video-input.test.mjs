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
    model: globalThis.__qwenProviderModel || "qwen3.7-plus"
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

async function waitUntil(predicate, message) {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(message);
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

test("a supported Omni model from provider settings is used for both video and translation", async () => {
  const priorEnvironmentModel = process.env.QWEN_VIDEO_MODEL;
  delete process.env.QWEN_VIDEO_MODEL;
  globalThis.__qwenProviderModel = "qwen3.5-omni-flash";
  const models = [];
  try {
    await withMockedFetch(async (_url, init) => {
      const body = JSON.parse(String(init.body));
      models.push(body.model);
      const isTranslation = JSON.stringify(body).includes("TokScript 提供的完整口播原文");
      return successfulStream({
        result: isTranslation ? { translationZh: "中文翻译" } : { summary: "视频分析" },
      });
    }, async () => {
      await qwen.analyzeVideoWithQwen({ prompt: "分析", localVideoPath: videoPath });
      await qwen.translateTranscriptWithQwen({ transcript: "spoken script" });
    });
  } finally {
    delete globalThis.__qwenProviderModel;
    if (priorEnvironmentModel === undefined) delete process.env.QWEN_VIDEO_MODEL;
    else process.env.QWEN_VIDEO_MODEL = priorEnvironmentModel;
  }
  assert.deepEqual(models, ["qwen3.5-omni-flash", "qwen3.5-omni-flash"]);
});

test("video requests share a two-slot Qwen limit and jump ahead of queued translations", async () => {
  const started = [];
  const heldResolvers = [];
  await withMockedFetch((_url, init) => {
    const body = JSON.parse(String(init.body));
    const serialized = JSON.stringify(body);
    const label = serialized.includes("视频一")
      ? "video-one"
      : serialized.includes("视频二")
        ? "video-two"
        : serialized.includes("视频三")
          ? "video-three"
          : "translation";
    started.push(label);
    if (started.length <= 2) {
      return new Promise((resolve) => {
        heldResolvers.push(() => resolve(successfulStream({ result: { summary: label } })));
      });
    }
    return Promise.resolve(successfulStream({
      result: label === "translation" ? { translationZh: "中文" } : { summary: label },
    }));
  }, async () => {
    const first = qwen.analyzeVideoWithQwen({ prompt: "视频一", localVideoPath: videoPath });
    const second = qwen.analyzeVideoWithQwen({ prompt: "视频二", localVideoPath: videoPath });
    await waitUntil(() => started.length === 2, "two video requests did not start");

    const translation = qwen.translateTranscriptWithQwen({ transcript: "translate me" });
    const third = qwen.analyzeVideoWithQwen({ prompt: "视频三", localVideoPath: videoPath });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(started, ["video-one", "video-two"]);

    heldResolvers[0]();
    await waitUntil(() => started.length >= 3, "the next queued request did not start");
    assert.equal(started[2], "video-three");
    heldResolvers[1]();
    await Promise.all([first, second, third, translation]);
  });
  assert.deepEqual(started, ["video-one", "video-two", "video-three", "translation"]);
});

test("every Qwen request receives an exact ten-minute timeout", async () => {
  const originalTimeout = AbortSignal.timeout;
  const observedTimeouts = [];
  const fetchSignals = [];
  AbortSignal.timeout = (milliseconds) => {
    observedTimeouts.push(milliseconds);
    return new AbortController().signal;
  };
  try {
    const parentController = new AbortController();
    for (const signal of [undefined, parentController.signal]) {
      await withMockedFetch(async (_url, init) => {
        fetchSignals.push(init.signal);
        return successfulStream();
      }, () => qwen.analyzeVideoWithQwen({
        prompt: "分析",
        localVideoPath: videoPath,
        signal,
      }));
    }
  } finally {
    AbortSignal.timeout = originalTimeout;
  }

  assert.deepEqual(observedTimeouts, [600_000, 600_000]);
  assert.equal(fetchSignals.length, 2);
  assert.ok(fetchSignals.every((signal) => signal instanceof AbortSignal));
});

test("the parent task signal can stop Qwen before the ten-minute ceiling", async () => {
  const controller = new AbortController();
  let fetchSignal;
  let diagnostic;

  await withMockedFetch((_url, init) => new Promise((_resolve, reject) => {
    fetchSignal = init.signal;
    const rejectFromAbort = () => reject(init.signal.reason || new Error("parent task stopped"));
    if (init.signal.aborted) rejectFromAbort();
    else init.signal.addEventListener("abort", rejectFromAbort, { once: true });
  }), async () => {
    const analysis = qwen.analyzeVideoWithQwen({
      prompt: "分析",
      localVideoPath: videoPath,
      signal: controller.signal,
      onDiagnostic(value) {
        diagnostic = value;
      },
    });
    controller.abort(new Error("parent task stopped"));
    await assert.rejects(analysis, /parent task stopped/);
  });

  assert.equal(fetchSignal.aborted, true);
  assert.equal(diagnostic.outcome, "aborted");
  assert.ok(diagnostic.totalMs < 600_000);
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
        /Qwen 完整视频请求失败（HTTP 429）/,
      );
    },
  );

  assert.equal(diagnostic.outcome, "http_error");
  assert.equal(diagnostic.requestId, "req-rate-limit");
  assert.equal(diagnostic.httpStatus, 429);
  assert.equal(typeof diagnostic.headersMs, "number");
  assert.equal(diagnostic.firstTokenMs, null);
});

test("network failures are retryable but never expose the raw provider error", async () => {
  let diagnostic;
  await withMockedFetch(async () => {
    throw new Error("socket failed at https://signed.example/video?token=secret");
  }, async () => {
    await assert.rejects(
      qwen.analyzeVideoWithQwen({
        prompt: "分析",
        localVideoPath: videoPath,
        onDiagnostic(value) {
          diagnostic = value;
        },
      }),
      (error) => {
        assert.equal(error.name, "QwenRequestError");
        assert.equal(error.code, "network_error");
        assert.equal(error.retryable, true);
        assert.equal(error.message, "Qwen 完整视频网络连接失败");
        assert.doesNotMatch(error.message, /signed|token|secret/);
        return true;
      },
    );
  });
  assert.equal(diagnostic.outcome, "network_error");
  assert.equal(diagnostic.httpStatus, null);
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
        /Qwen 没有返回可用的视频分析结构/,
      );
    },
  );

  assert.equal(diagnostic.outcome, "invalid_response");
  assert.equal(diagnostic.httpStatus, 200);
  assert.equal(typeof diagnostic.headersMs, "number");
  assert.equal(diagnostic.firstTokenMs, null);
  assert.equal(diagnostic.responseSha256, "");
});
