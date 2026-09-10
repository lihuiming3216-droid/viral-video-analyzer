import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const dataUrl = value => `data:text/javascript;base64,${Buffer.from(value).toString("base64")}`;
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const guardUrl = dataUrl(compile(await readFile(new URL("../lib/feishu/delivery-guard.ts", import.meta.url), "utf8")));
const guard = await import(guardUrl);
const source = await readFile(new URL("../lib/feishu/automation.ts", import.meta.url), "utf8");

test("blank-only patches preserve text, zero, attachments and meaningful rich text", () => {
  const current = { 原口播: [{ text: "人工原文", type: "text" }], 中文翻译: "人工中文", 文件: [{ file_token: "manual" }], zero: 0, empty: [{ text: "  ", type: "text" }] };
  assert.deepEqual(guard.emptyFieldPatch(current, { 原口播: "新原文", 中文翻译: "新中文", 文件: [{ file_token: "new" }], zero: 1, empty: "补空", missing: "", absent: "补入" }), { empty: "补空", absent: "补入" });
});

test("delivery source accepts harmless URL decoration, but not a changed or removed link", () => {
  guard.assertDeliverySource("https://www.tiktok.com/t/Sample/", { link: "https://www.tiktok.com/t/Sample?lang=en" });
  guard.assertDeliverySource("https://www.tiktok.com/@old/video/1234567890123456789", [{ text: "https://www.tiktok.com/@new/video/1234567890123456789/" }]);
  for (const value of ["", "https://www.tiktok.com/t/Changed/", "https://evil.test/@new/video/1234567890123456789"]) {
    assert.throws(() => guard.assertDeliverySource("https://www.tiktok.com/t/Sample/", value), error => error.reason === "source_changed");
  }
});

test("only confirmed permanent delivery errors are paused, with a fixed safe message", () => {
  for (const [message, reason] of [["RecordIdNotFound https://secret.invalid", "record_missing"], ["FieldNameNotFound token=secret", "field_missing"]]) {
    const failure = guard.permanentDeliveryFailure(new Error(message));
    assert.equal(failure.reason, reason);
    assert.doesNotMatch(failure.message, /secret|token|https:/);
  }
  for (const message of ["timeout", "HTTP 429", "HTTP 500", "RolePermNotAllow"]) assert.equal(guard.permanentDeliveryFailure(new Error(message)), null);
});

async function fixture() {
  const hookKey = `deliveryTest${Math.random()}`;
  let compiled = compile(source).replace('import "server-only";', "");
  const imports = [...compiled.matchAll(/import\s*\{([^}]+)\}\s*from\s*"(@\/lib\/[^\"]+)"/g)];
  for (const [, names, module] of imports) {
    if (module === "@/lib/feishu/delivery-guard") { compiled = compiled.replaceAll(JSON.stringify(module), JSON.stringify(guardUrl)); continue; }
    const stub = names.split(",").map(name => name.trim()).filter(Boolean).map(name => `export const ${name} = (...a) => globalThis[${JSON.stringify(hookKey)}][${JSON.stringify(name)}]?.(...a);`).join("\n");
    compiled = compiled.replaceAll(JSON.stringify(module), JSON.stringify(dataUrl(stub)));
  }
  const automation = await import(dataUrl(`${compiled}\n// ${hookKey}`));
  const map = { ...Object.fromEntries(Object.keys(automation.defaultFeishuAutomationFieldMap).map(key => [key, ""])), videoUrl: "视频链接", videoFile: "文件", transcript: "原口播", translation: "中文翻译" };
  const job = { videoId: "video", appToken: "app", tableId: "table", recordId: "row", fieldMap: map, attempts: 0, blockedReason: "" };
  const video = { id: "video", productId: "product", status: "completed", analysisMode: "transcript_only", sourceUrl: "https://www.tiktok.com/t/Sample/", originalPath: "video/download-unique/1/original.mp4", transcriptOriginal: "provider speech", transcriptZh: "接口中文", transcriptSegments: [], title: "😀".repeat(900) };
  const row = { 视频链接: { link: video.sourceUrl }, 文件: [], 原口播: "人工原文", 中文翻译: "人工中文", 备注: "人工备注" };
  const columns = ["视频链接", "文件", "原口播", "中文翻译", "备注"];
  const writes = [], uploads = [], blocks = [];
  let pending = true, requests = 0, subtitleCalls = 0;
  const hooks = {
    getFeishuAutomationJobs: () => pending ? [job] : [],
    getVideo: () => video,
    getProduct: () => ({ id: "product" }),
    getFeishuProductCardMapping: () => null,
    listFeishuAutomationJobVideoIds: () => pending && !job.blockedReason ? ["video"] : [],
    blockFeishuAutomationJob: (_job, reason, message) => { job.blockedReason = reason; blocks.push({ reason, message }); },
    incrementFeishuAutomationJobAttempts: () => { job.attempts++; },
    deleteFeishuAutomationJob: () => { pending = false; },
    resolveMediaPath: value => `/media/${value}`,
    uploadBaseAttachment: async (_client, input) => { uploads.push(input); return [{ file_token: "uploaded" }]; },
    generateBilingualSubtitleFile: async () => { subtitleCalls++; return null; },
  };
  const client = { request: async request => {
    requests++;
    if (request.url.endsWith("/fields")) return { code: 0, data: { items: columns.map(field_name => ({ field_name })) } };
    if (request.method === "GET") {
      if (hooks.beforeRead) await hooks.beforeRead();
      return { code: 0, data: { record: { fields: structuredClone(row) } } };
    }
    if (hooks.beforeWrite) await hooks.beforeWrite(request);
    writes.push(structuredClone(request.data.fields));
    Object.assign(row, request.data.fields);
    return { code: 0 };
  } };
  hooks.getConnectedFeishuChannel = () => ({ rawClient: client });
  globalThis[hookKey] = hooks;
  return { automation, job, video, row, columns, writes, uploads, blocks, hooks, client,
    pending: () => pending, requests: () => requests, subtitles: () => subtitleCalls };
}

test("a real mapped file column receives the cached file without changing manual text or calling a model", async () => {
  const f = await fixture();
  assert.equal(await f.automation.completeFeishuAutomation("video"), true);
  assert.deepEqual(f.writes, [{ 文件: [{ file_token: "uploaded" }] }]);
  assert.equal(f.uploads[0].fileName, "video.mp4");
  assert.equal(f.row.中文翻译, "人工中文");
  assert.equal(f.row.备注, "人工备注");
  assert.equal(f.subtitles(), 0);
  assert.equal(f.pending(), false);
});

test("missing mapped columns pause durably before uploading or generating subtitles", async () => {
  const f = await fixture();
  f.job.fieldMap.videoFile = "视频文件";
  f.job.fieldMap.status = "分析状态";
  f.video.transcriptSegments = [{ start: 0, end: 1, text: "test" }];
  assert.equal(await f.automation.completeFeishuAutomation("video"), false);
  assert.equal(f.job.blockedReason, "field_missing");
  assert.equal(f.uploads.length, 0);
  assert.equal(f.subtitles(), 0);
  assert.equal(f.pending(), true);
  const requests = f.requests();
  await f.automation.completeFeishuAutomation("video");
  await f.automation.runFeishuAutomationDeliveryPass();
  assert.equal(f.requests(), requests);
});

test("a missing record pauses before any file/model call and preserves its job", async () => {
  const f = await fixture();
  f.hooks.beforeRead = () => { throw new Error("RecordIdNotFound"); };
  assert.equal(await f.automation.completeFeishuAutomation("video"), false);
  assert.equal(f.job.blockedReason, "record_missing");
  assert.equal(f.uploads.length, 0);
  assert.equal(f.pending(), true);
});

test("a missing row does not block delivery to another row for the same video", async () => {
  const f = await fixture();
  const second = { ...f.job, recordId: "second-row" };
  let secondPending = true;
  f.hooks.getFeishuAutomationJobs = () => [f.job, ...(secondPending ? [second] : [])];
  f.hooks.deleteFeishuAutomationJob = job => { assert.equal(job.recordId, "second-row"); secondPending = false; };
  const request = f.client.request;
  f.client.request = input => {
    if (input.url.endsWith("/records/row")) throw new Error("RecordIdNotFound");
    return request(input);
  };
  assert.equal(await f.automation.completeFeishuAutomation("video"), false);
  assert.equal(f.job.blockedReason, "record_missing");
  assert.equal(secondPending, false);
  assert.deepEqual(f.writes, [{ 文件: [{ file_token: "uploaded" }] }]);
});

test("a changed link stops stale delivery even after a file upload", async () => {
  const f = await fixture();
  f.hooks.uploadBaseAttachment = async () => { f.row.视频链接 = "https://www.tiktok.com/t/NewVideo/"; return [{ file_token: "unused" }]; };
  assert.equal(await f.automation.completeFeishuAutomation("video"), false);
  assert.equal(f.job.blockedReason, "source_changed");
  assert.deepEqual(f.writes, []);
});

test("an attachment added manually during upload is retained", async () => {
  const f = await fixture();
  f.hooks.uploadBaseAttachment = async () => { f.row.文件 = [{ file_token: "manual-late" }]; return [{ file_token: "unused" }]; };
  assert.equal(await f.automation.completeFeishuAutomation("video"), true);
  assert.deepEqual(f.row.文件, [{ file_token: "manual-late" }]);
  assert.deepEqual(f.writes, []);
});

test("a file upload failure still delivers blank text, retains the pending job and later retries only the file", async () => {
  const f = await fixture();
  f.row.原口播 = ""; f.row.中文翻译 = "";
  const upload = f.hooks.uploadBaseAttachment;
  f.hooks.uploadBaseAttachment = async () => { throw new Error("temporary upload failure"); };
  assert.equal(await f.automation.completeFeishuAutomation("video"), false);
  assert.equal(f.row.中文翻译, "接口中文");
  assert.equal(f.pending(), true);
  assert.equal(f.job.attempts, 1);
  f.writes.length = 0;
  f.hooks.uploadBaseAttachment = upload;
  assert.equal(await f.automation.completeFeishuAutomation("video"), true);
  assert.deepEqual(f.writes, [{ 文件: [{ file_token: "uploaded" }] }]);
});

test("failure of analysis does not prevent delivery of an available file and translation", async () => {
  const f = await fixture();
  f.video.status = "failed"; f.video.errorMessage = "video model failed";
  f.row.中文翻译 = "";
  assert.equal(await f.automation.completeFeishuAutomation("video"), true);
  assert.equal(f.row.文件[0].file_token, "uploaded");
  assert.equal(f.row.中文翻译, "接口中文");
});

test("early delivery is blank-only and a deleted row is not retried forever", async () => {
  const f = await fixture();
  await f.automation.deliverEarlyTranscript("video");
  assert.deepEqual(f.writes, []);
  f.hooks.beforeRead = () => { throw new Error("RecordIdNotFound"); };
  await f.automation.deliverEarlyTranscript("video");
  assert.equal(f.job.blockedReason, "record_missing");
  const reads = f.requests();
  await f.automation.deliverEarlyTranscript("video");
  assert.equal(f.requests(), reads);
});

test("network write failures remain retryable; fixing them does not require new analysis", async () => {
  const f = await fixture();
  f.row.文件 = [{ file_token: "existing" }];
  f.row.中文翻译 = "";
  let failures = 2;
  f.hooks.beforeWrite = () => { if (failures-- > 0) throw new Error("temporary connection failure"); };
  assert.equal(await f.automation.completeFeishuAutomation("video"), true);
  assert.equal(f.job.blockedReason, "");
  assert.equal(f.uploads.length, 0);
  assert.equal(f.row.中文翻译, "接口中文");
});

test("explicitly skipped product-document mapping never falls back to a nonexistent column", async () => {
  const f = await fixture();
  assert.equal(f.automation.resolveAutomationFields({}, { productDocument: "" }).map.productDocument, "");
});

test("a task-table delivery binding is saved before its analysis can start", async () => {
  const route = await readFile(new URL("../app/api/feishu/task-table/route.ts", import.meta.url), "utf8");
  assert.ok(route.indexOf("await saveFeishuAutomationJob(") < route.indexOf("await enqueueVideos("));
});
