import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../lib/providers/qwen.ts", import.meta.url), "utf8");
const stubSource = `
  export const requireProvider = () => ({
    apiKey: "test-key",
    baseUrl: "https://qwen.test/v1",
    model: globalThis.__qwenProviderModel || "qwen3.7-plus"
  });
  export const parseJsonLoose = JSON.parse;
  export const getQwenPurposeModel = async () => null;
  export const requireAiRuntime = async purpose => globalThis.__aiRuntime || ({
    purpose, provider: "qwen", apiKey: "test-key", baseUrl: "https://qwen.test/v1",
    model: purpose === "translation" ? "qwen-plus" : "qwen3.5-omni-plus", retries: 0
  });
  export const getPromptTemplate = async (_slug, _label, template) => ({ template });
  export const fetchQwen = (...args) => globalThis.fetch(...args);
`;
const stubUrl = `data:text/javascript;base64,${Buffer.from(stubSource).toString("base64")}`;
const typesSource = await readFile(new URL("../lib/types.ts", import.meta.url), "utf8");
const typesUrl = `data:text/javascript;base64,${Buffer.from(ts.transpileModule(typesSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText).toString("base64")}`;
let compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
compiled = compiled
  .replace('import "server-only";', "")
  .replaceAll('"@/lib/json-utils"', JSON.stringify(stubUrl))
  .replaceAll('"@/lib/database"', JSON.stringify(stubUrl))
  .replaceAll('"@/lib/ai/settings"', JSON.stringify(stubUrl))
  .replaceAll('"@/lib/types"', JSON.stringify(typesUrl))
  .replaceAll('"@/lib/providers/qwen-transport"', JSON.stringify(stubUrl))
  .replaceAll('"@/lib/provider-config"', JSON.stringify(stubUrl));
const qwen = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

const directory = await mkdtemp(path.join(tmpdir(), "qwen-video-"));
const videoPath = path.join(directory, "complete.mp4");
const videoBytes = Buffer.from([0, 1, 2, 3, 127, 128, 254, 255, ...Buffer.from("complete-video")]);
await writeFile(videoPath, videoBytes);
after(() => rm(directory, { recursive: true, force: true }));

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

test("translation prompt preview sends the edited draft rather than the saved production prompt", async () => {
  let prompt;
  const result = await withMockedFetch(async (_url, init) => {
    prompt = JSON.parse(init.body).messages[0].content[0].text;
    return successfulStream({ result: { translationZh: "你好" } });
  }, () => qwen.translateTranscriptWithQwen({ transcript: "hello", promptTemplate: "DRAFT ONLY {{TRANSCRIPT_JSON}}" }));
  assert.equal(prompt, 'DRAFT ONLY "hello"');
  assert.equal(result, "你好");
});

test("blank segment translations are rejected instead of producing incomplete subtitles", async () => {
  await withMockedFetch(async () => successfulStream({ result: { translations: [""] } }), () =>
    assert.rejects(qwen.translateSegmentsWithQwen({ segments: [{ start: 0, end: 1, text: "hello" }] }), /中文翻译失败/));
});

test("translation retries use one configuration snapshot, never another model or provider", async t => {
  globalThis.__aiRuntime = { provider: "openai", apiKey: "independent-fixture", baseUrl: "https://independent.example/v1", model: "translation-only", retries: 1 };
  t.after(() => { delete globalThis.__aiRuntime; });
  let calls = 0;
  const result = await withMockedFetch(async (url, init) => {
    calls++;
    assert.equal(url, "https://independent.example/v1/chat/completions");
    const body = JSON.parse(init.body);
    assert.equal(body.model, "translation-only");
    assert.equal("enable_thinking" in body, false);
    assert.equal("modalities" in body, false);
    if (calls === 1) {
      globalThis.__aiRuntime = { ...globalThis.__aiRuntime, model: "changed-during-request" };
      return new Response("private error text", { status: 503 });
    }
    return successfulStream({ result: { translationZh: "中文" } });
  }, () => qwen.translateTranscriptWithQwen({ transcript: "English" }));
  assert.equal(result, "中文");
  assert.equal(calls, 2);
});

test("translation authentication failures are not retried or leaked", async t => {
  globalThis.__aiRuntime = { provider: "qwen", apiKey: "fixture", baseUrl: "https://independent.example/v1", model: "qwen-plus", retries: 1 };
  t.after(() => { delete globalThis.__aiRuntime; });
  let calls = 0;
  await withMockedFetch(async () => { calls++; return new Response("private provider secret", { status: 401 }); },
    () => assert.rejects(qwen.translateTranscriptWithQwen({ transcript: "English" }), error => {
      assert.match(error.message, /HTTP 401/); assert.doesNotMatch(error.message, /private|secret/); return true;
    }));
  assert.equal(calls, 1);
});

test("subtitle budget is checked before each actual request, including configured inner retries", async t => {
  globalThis.__aiRuntime = { provider: "qwen", apiKey: "fixture", baseUrl: "https://qwen.test/v1", model: "qwen-plus", retries: 1 };
  t.after(() => { delete globalThis.__aiRuntime; });
  let reservations=0,calls=0;
  const beforeRequest=async()=>{if(reservations>=2)throw Error("durable budget exhausted");reservations++;};
  const input={segments:[{start:0,end:1,text:"hello"}],beforeRequest};
  await withMockedFetch(async()=>{calls++;return new Response("unavailable",{status:503});},async()=>{
    await assert.rejects(qwen.translateSegmentsWithQwen(input), /中文翻译失败/);
    await assert.rejects(qwen.translateSegmentsWithQwen(input), /durable budget exhausted/);
  });
  assert.equal(calls,2);
  assert.equal(reservations,2);
});

