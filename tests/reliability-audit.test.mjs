import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const url = code => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace('import "server-only";', "");
const read = file => readFile(new URL(`../${file}`, import.meta.url), "utf8");
const { parseMediaRange } = await import(url(compile(await read("lib/media-range.ts"))));

test("asynchronous notification failures cannot escape into the video worker", async () => {
  const events = await import(url(compile(await read("lib/video-events.ts"))));
  events.setVideoProgressHandler(async () => { throw Error("notification unavailable"); });
  events.emitVideoProgress("video");
  await new Promise(resolve => setImmediate(resolve));
  events.setVideoProgressHandler(() => { throw Error("synchronous notification unavailable"); });
  assert.doesNotThrow(() => events.emitVideoProgress("video"));
  events.setVideoProgressHandler(() => {});
});

test("a failed bot progress card does not strand already-created video tasks", async t => {
  const key = `auditHandler${Math.random()}`;
  const queued = [];
  let nextId = 0;
  globalThis[key] = {
    recordFeishuEvent: async () => true,
    parseFeishuSubmission: () => ({ productName: "Fixture", pid: "123456", urls: ["url-1", "url-2"] }),
    findOrCreateProduct: async () => ({ id: "product", name: "Fixture", pid: "123456" }),
    createFeishuBatch: async () => ({ id: "batch" }),
    createVideo: async () => ({ id: `video-${++nextId}` }),
    createFeishuDelivery: async () => ({ id: `delivery-${nextId}` }),
    enqueueVideos: async ids => { queued.push(...ids); },
    safeSdkLogValues: () => [],
  };
  const warnings = [];
  const previous = console.warn;
  console.warn = (...args) => { warnings.push(args); };
  t.after(() => { delete globalThis[key]; console.warn = previous; });
  let code = compile(await read("lib/feishu/handler.ts"));
  for (const [, names, module] of [...code.matchAll(/import\s*\{([^}]+)\}\s*from\s*"(@\/lib\/[^\"]+)"/g)]) {
    const stub = names.split(",").map(name => name.trim()).filter(Boolean).map(name => `export const ${name} = (...a) => globalThis[${JSON.stringify(key)}][${JSON.stringify(name)}]?.(...a);`).join("\n");
    code = code.replaceAll(JSON.stringify(module), JSON.stringify(url(stub)));
  }
  const callbacks = {};
  const channel = {
    on: (name, callback) => { callbacks[name] = callback; },
    send: async () => { throw Error("Authorization: Bearer PRIVATE_TOKEN"); },
  };
  (await import(url(code))).registerFeishuHandlers(channel);
  await callbacks.message({ messageId: "message", chatId: "chat", chatType: "p2p", senderId: "sender", content: "fixture" });
  assert.deepEqual(queued, ["video-1", "video-2"]);
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(JSON.stringify(warnings), /PRIVATE_TOKEN|Bearer/);
});

test("media range supports suffix/open-ended bounds and rejects invalid/overflow/multi-range requests", () => {
  assert.deepEqual(parseMediaRange("bytes=2-8", 10), { start: 2, end: 8 });
  assert.deepEqual(parseMediaRange("bytes=2-", 10), { start: 2, end: 9 });
  assert.deepEqual(parseMediaRange("bytes=-3", 10), { start: 7, end: 9 });
  assert.deepEqual(parseMediaRange("bytes=-30", 10), { start: 0, end: 9 });
  assert.deepEqual(parseMediaRange("bytes=0-999", 10), { start: 0, end: 9 });
  for (const value of ["bytes=8-2", "bytes=10-", "bytes=-0", "bytes=-", "bytes=0-1,3-4", "garbage bytes=0-2", "bytes=9007199254740992-"]) {
    assert.equal(parseMediaRange(value, 10), null, value);
  }
  assert.equal(parseMediaRange("bytes=0-", 0), null);
});

test("all Feishu HTTP methods have bounded deadlines and preserve upload allowance and caller cancellation", async t => {
  const key = `auditHttp${Math.random()}`;
  const calls = [];
  globalThis[key] = options => { calls.push(options); return Promise.resolve({ ok: true }); };
  t.after(() => { delete globalThis[key]; });
  const stub = url(`export const defaultHttpInstance = { request: options => globalThis[${JSON.stringify(key)}](options) };`);
  const code = compile(await read("lib/feishu/http.ts")).replaceAll('"@larksuiteoapi/node-sdk"', JSON.stringify(stub));
  const { feishuHttp } = await import(url(code));
  await feishuHttp.get("https://open.feishu.cn/open-apis/bitable/v1/apps/base/tables/table/records");
  await feishuHttp.post("https://open.feishu.cn/open-apis/drive/v1/medias/upload_all", "stream");
  await feishuHttp.post("https://open.feishu.cn/open-apis/drive/v1/medias/upload_part", "stream");
  await feishuHttp.post("https://open.feishu.cn/open-apis/im/v1/files", "stream");
  assert.deepEqual(calls.map(call => call.timeout), [30_000, 120_000, 120_000, 120_000]);
  for (const call of calls) assert.ok(call.signal instanceof AbortSignal);
  const controller = new AbortController();
  await feishuHttp.request({ url: "fixture", timeout: 900_000, signal: controller.signal });
  const cancellable = calls.at(-1);
  assert.equal(cancellable.timeout, 30_000);
  controller.abort();
  assert.equal(cancellable.signal.aborted, true);
  await feishuHttp.patch("fixture", { value: "retained" }, { timeout: 10 });
  assert.equal(calls.at(-1).timeout, 10);
  assert.equal(calls.at(-1).method, "PATCH");
  assert.deepEqual(calls.at(-1).data, { value: "retained" });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(calls.at(-1).signal.aborted, true);
  assert.equal(calls.length, 6, "the transport must not retry uncertain writes");
});

test("subtitle upload retries reuse persisted translations, independent tasks do not, and concurrent deliveries share one request", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "subtitle-cache-audit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  globalThis.__auditTranslate = async ({ segments, beforeRequest }) => { await beforeRequest?.(); calls++; return segments.map((_, i) => `中文${i}`); };
  t.after(() => { delete globalThis.__auditTranslate; });
  const jsonStub = url('export const formatTime = n => String(n);');
  const qwenStub = url('export const translateSegmentsWithQwen = a => globalThis.__auditTranslate(a);');
  const source = compile(await read("lib/subtitle.ts"))
    .replaceAll('"@/lib/json-utils"', JSON.stringify(jsonStub))
    .replaceAll('"@/lib/providers/qwen"', JSON.stringify(qwenStub))
    .replaceAll('process.cwd()', JSON.stringify(directory));
  const subtitles = await import(url(source));
  const segments = [{ start: 0, end: 1, text: "Hello" }, { start: 1, end: 2, text: "World" }];
  const results = await Promise.all([subtitles.generateBilingualSubtitleFile(segments, "video-1"), subtitles.generateBilingualSubtitleFile(segments, "video-1")]);
  assert.equal(calls, 1);
  for (const result of results) { assert.match(await readFile(result.filePath, "utf8"), /中文1/); await result.cleanup(); }
  const reloaded = await import(url(source + "\n// fresh module instance"));
  await (await reloaded.generateBilingualSubtitleFile(segments, "video-1")).cleanup();
  assert.equal(calls, 1, "a new module/process reuses the durable translation cache");
  await (await subtitles.generateBilingualSubtitleFile(segments, "video-2")).cleanup();
  assert.equal(calls, 2, "same source in another task remains independent");
  globalThis.__auditTranslate = async ({beforeRequest}) => { await beforeRequest?.(); return ["only one segment"]; };
  await assert.rejects(subtitles.generateBilingualSubtitleFile(segments, "invalid"), /翻译不完整/);
  globalThis.__auditTranslate = async ({beforeRequest}) => { await beforeRequest?.(); return ["一", "二"]; };
  await (await subtitles.generateBilingualSubtitleFile(segments, "invalid")).cleanup();
  let failedCalls = 0;
  globalThis.__auditTranslate = async ({beforeRequest}) => { await beforeRequest(); failedCalls++; throw Error("provider failed"); };
  await assert.rejects(subtitles.generateBilingualSubtitleFile(segments, "always-fails"), /provider failed/);
  await assert.rejects(reloaded.generateBilingualSubtitleFile(segments, "always-fails"), /provider failed/);
  for (let n=0;n<4;n++) await assert.rejects(reloaded.generateBilingualSubtitleFile(segments,"always-fails"), /两次请求上限/);
  assert.equal(failedCalls,2,"the two-request ceiling survives module reload and repeated deliveries");
  await assert.rejects(reloaded.generateBilingualSubtitleFile([{start:0,end:3,text:"changed source segments"}],"always-fails"), /两次请求上限/);
  assert.equal(failedCalls,2,"changed segments cannot reset the same task's billing budget");
});

test("a transient schema initialization failure is not permanently cached, and concurrent recovery initializes once", async t => {
  const key = `auditPool${Math.random()}`;
  const state = { attempts: 0, ended: 0, pool: {} };
  globalThis[key] = state;
  t.after(() => { delete globalThis[key]; });
  const driver = url(`export default {
    createPool: () => globalThis[${JSON.stringify(key)}].pool,
    createConnection: async () => {
      const s = globalThis[${JSON.stringify(key)}]; s.attempts++;
      if (s.attempts === 1) throw Error('database restarting');
      return { query: async () => {}, end: async () => { s.ended++; } };
    }
  };`);
  const code = compile(await read("lib/db/pool.ts"))
    .replaceAll('"mysql2/promise"', JSON.stringify(driver))
    .replace('const dbGlobal = globalThis;', 'const dbGlobal = {};');
  const db = await import(url(code));
  await assert.rejects(db.getPool(), /database restarting/);
  const pools = await Promise.all(Array.from({ length: 10 }, () => db.getPool()));
  assert.ok(pools.every(pool => pool === state.pool));
  assert.equal(state.attempts, 2);
  assert.equal(state.ended, 1);
});

test("seed initialization recovers and scene replacement rolls back instead of losing prior rows", async t => {
  const key = `auditDb${Math.random()}`;
  let seedFailed = false;
  const events = [];
  let scenes = ["retained scene"], snapshot;
  const connection = {
    beginTransaction: async () => { events.push("begin"); snapshot = [...scenes]; },
    commit: async () => events.push("commit"),
    rollback: async () => { events.push("rollback"); scenes = snapshot; },
    release: () => events.push("release"),
    query: async sql => {
      if (/DELETE FROM scenes/.test(sql)) { scenes = []; return [{}]; }
      if (/INSERT INTO scenes/.test(sql)) throw Error("insert failure");
      if (/SELECT attempt_count/.test(sql)) { assert.match(sql, /FOR UPDATE/); return [[{ attempt_count: 3 }]]; }
      return [{ affectedRows: 1 }];
    },
  };
  const pool = {
    getConnection: async () => connection,
    query: async () => { if (!seedFailed) { seedFailed = true; throw Error("seed temporarily unavailable"); } return [{}]; },
  };
  globalThis[key] = pool;
  t.after(() => { delete globalThis[key]; });
  const types = url(compile(await read("lib/types.ts")));
  const code = compile(await read("lib/database.ts"))
    .replaceAll('"@/lib/types"', JSON.stringify(types))
    .replaceAll('"@/lib/db/pool"', JSON.stringify(url(`export const getPool = async () => globalThis[${JSON.stringify(key)}];`)));
  const db = await import(url(code));
  await assert.rejects(db.getDb(), /seed temporarily unavailable/);
  assert.equal(await db.getDb(), pool);
  await assert.rejects(db.replaceScenes("video", [{}]), /insert failure/);
  assert.deepEqual(scenes, ["retained scene"]);
  assert.deepEqual(events, ["begin", "rollback", "release"]);
  events.length = 0;
  assert.equal((await db.startVideoAttempt("video")).attemptNumber, 4);
  assert.deepEqual(events, ["begin", "commit", "release"]);
});

test("concurrent forced Feishu reconnects share one socket and full secret rotations invalidate it", async t => {
  const key = `auditFeishu${Math.random()}`;
  let releaseConnect;
  let creates = 0, disconnects = 0;
  let credential = "first-secret-same-tail";
  globalThis[key] = {
    getRawFeishuSettings: async () => ({ enabled: true, app_id: "fixture", encrypted_app_secret: credential }),
    createLarkChannel: () => {
      creates++;
      return { on() {}, connect: () => new Promise(resolve => { releaseConnect = resolve; }), disconnect: async () => { disconnects++; } };
    },
  };
  t.after(() => { delete globalThis[key]; });
  const stub = url(`
    export const createLarkChannel = () => globalThis[${JSON.stringify(key)}].createLarkChannel();
    export const getRawFeishuSettings = () => globalThis[${JSON.stringify(key)}].getRawFeishuSettings();
    export const getFeishuSettings = async () => ({});
    export const setFeishuConnectionStatus = async () => {};
    export const Domain = { Feishu: 'fixture' };
    export const LoggerLevel = { warn: 'warn' };
    export const safeFeishuLogger = {};
    export const feishuHttp = {};
    export const decryptSecret = value => value;
    export const registerFeishuHandlers = () => {};
    export const getMediaRoot = () => '/fixture';
    export const getChatgptFeishuClient = () => {};
  `);
  const code = compile(await read("lib/feishu/runtime.ts"))
    .replace('const state = globalThis;', 'const state = {};')
    .replaceAll(/"(?:@\/lib\/[^\"]+|@larksuiteoapi\/node-sdk)"/g, JSON.stringify(stub));
  const runtime = await import(url(code));
  const pending = [runtime.ensureFeishuConnection(true), runtime.ensureFeishuConnection(true)];
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(creates, 1);
  releaseConnect();
  const [first, second] = await Promise.all(pending);
  assert.equal(first, second);
  credential = "other-secret-same-tail";
  const rotation = runtime.ensureFeishuConnection();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(creates, 2);
  releaseConnect(); await rotation;
  assert.ok(disconnects >= 1);
  await runtime.stopFeishuConnection();
  assert.equal(runtime.getConnectedFeishuChannel(), null);
});
