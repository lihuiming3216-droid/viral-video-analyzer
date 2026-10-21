import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { loadAutomationFixture } from "./helpers/automation-fixture.mjs";

const read = path => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("retired handcard analysis has no formatter, write path, or active prompt template", async () => {
  await assert.rejects(stat(new URL("../lib/product-doc-analysis.ts", import.meta.url)), { code: "ENOENT" });
  const [sync, automation, analysis, prompts, providers] = await Promise.all([
    read("lib/feishu/product-doc-sync.ts"), read("lib/feishu/automation.ts"),
    read("lib/analysis.ts"), read("app/admin/prompts/page.tsx"),
    read("app/admin/providers/page.tsx"),
  ]);
  assert.doesNotMatch(sync, /analysisCellId|conciseProductDocAnalysis|product_doc_failure_delivered/);
  assert.doesNotMatch(automation, /setMappedField\(fields, map\.analysis|\[map\.analysis\]/);
  assert.doesNotMatch(analysis, /video_analysis_product_doc|极简的产品样片分析/);
  assert.doesNotMatch(prompts, /PROMPT_TEMPLATE_\w+\.product_doc/);
  assert.match(providers, /purposes\.filter\(setting => setting\.config\.purpose !== "video"\)/);
  assert.match(providers, /不再调用视频分析模型/);
  assert.match(sync, /analysisMode: "product_doc"/, "retain the durable handcard row identity");
  assert.match(analysis, /if \(analysisMode !== "full"\)/);
});

test("historical handcard prompt replays return before loading media or requesting a video model", async () => {
  let capturedReads = 0, modelCalls = 0, mediaReads = 0;
  const key = "__handcardPromptRetirementHooks";
  globalThis[key] = {
    getPromptDebugCapture: async () => { capturedReads += 1; return { inputs: { mode: "product_doc" }, qwenVideoPath: "legacy.mp4" }; },
    analyzeVideoWithQwen: () => { modelCalls += 1; throw Error("retired handcard analysis must not be requested"); },
    resolveMediaPath: () => { mediaReads += 1; throw Error("retired handcard media must not be read"); },
  };
  const stub = `const hooks = () => globalThis.${key};
    export const revalidatePath = () => {};
    export const savePromptTemplate = () => {};
    export const getPromptDebugCapture = (...args) => hooks().getPromptDebugCapture(...args);
    export const analyzeVideoWithQwen = (...args) => hooks().analyzeVideoWithQwen(...args);
    export const resolveMediaPath = (...args) => hooks().resolveMediaPath(...args);
    export const TRANSCRIPT_TRANSLATION_PROMPT_SLUG = "transcript_translation";
    export const translateTranscriptWithQwen = () => { throw Error("unexpected translation"); };`;
  const stubUrl = `data:text/javascript;base64,${Buffer.from(stub).toString("base64")}`;
  const compiled = ts.transpileModule(await read("app/admin/prompts/actions.ts"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText.replaceAll(/"(?:@\/lib\/[^\"]+|next\/cache)"/g, JSON.stringify(stubUrl));
  try {
    const actions = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
    const form = new FormData();
    form.set("slug", "video_analysis_product_doc");
    form.set("captureId", "historical-handcard-input");
    const result = await actions.runPromptTestAction(null, form);
    assert.equal(result.ok, false);
    assert.match(result.error, /手卡视频分析已停用/);
    assert.equal(capturedReads, 1);
    assert.equal(modelCalls, 0);
    assert.equal(mediaReads, 0);
  } finally { delete globalThis[key]; }
});

for (const status of ["completed", "failed", "stopped"]) {
  for (const existing of [false, true]) {
    test(`legacy Base handcard delivery ignores the retired analysis field: ${status}, existing=${existing}`, async t => {
      const sourceUrl = "https://www.tiktok.com/@fixture/video/123456789";
      const current = { 视频链接: sourceUrl, ...(existing ? { 中文翻译: "人工翻译", 视频文件: [{ file_token: "manual-file" }] } : {}) };
      const writes = [];
      let pending = true, uploads = 0;
      const video = { id: "legacy-handcard-video", productId: "p", sourceUrl, status, analysisMode: "product_doc", attemptCount: 1,
        originalPath: "existing.mp4", transcriptOriginal: "TokScript speech", transcriptZh: "自动中文",
        transcriptSegments: [], summary: "不可回填的旧分析", analysis: { summary: "旧缓存" },
        errorMessage: "upstream Authorization: Bearer must-not-write" };
      const client = { request: async ({ url, method, data }) => {
        if (url.endsWith("/fields")) return { code: 0, data: { items: ["视频链接", "视频文件", "中文翻译"].map(field_name => ({ field_name })) } };
        if (method === "GET") return { code: 0, data: { record: { fields: structuredClone(current) } } };
        assert.equal(method, "PUT");
        writes.push(data.fields);
        Object.assign(current, data.fields);
        return { code: 0 };
      } };
      const job = { videoId: video.id, appToken: "app", tableId: "table", recordId: "row", attempts: 0 };
      const automation = await loadAutomationFixture(t, {
        getVideo: () => video, getProduct: () => null, getFeishuProductCardMapping: () => null,
        getFeishuAutomationJobs: () => pending ? [job] : [],
        getConnectedFeishuChannel: () => ({ rawClient: client }),
        deleteFeishuAutomationJob: () => { pending = false; },
        resolveMediaPath: value => `/fixture/${value}`,
        uploadBaseAttachment: async () => { uploads += 1; return [{ file_token: "automatic-file" }]; },
      });
      job.fieldMap = { ...Object.fromEntries(Object.keys(automation.defaultFeishuAutomationFieldMap).map(key => [key, ""])),
        videoUrl: "视频链接", videoFile: "视频文件", translation: "中文翻译", analysis: "视频分析" };
      assert.equal(await automation.completeFeishuAutomation(video.id), true);
      assert.equal(pending, false);
      assert.equal(uploads, existing ? 0 : 1);
      assert.equal(current.中文翻译, existing ? "人工翻译" : "自动中文");
      assert.equal(current.视频文件[0].file_token, existing ? "manual-file" : "automatic-file");
      assert.ok(writes.every(fields => !Object.hasOwn(fields, "视频分析")));
      assert.doesNotMatch(JSON.stringify(writes), /旧分析|旧缓存|must-not-write|失败|停止/);
    });
  }
}
