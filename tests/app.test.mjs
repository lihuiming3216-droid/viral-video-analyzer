import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("database schema covers products, videos, providers, Feishu and search indexes", async () => {
  const database = await readFile(new URL("lib/db/schema.sql", root), "utf8");
  for (const table of ["products", "videos", "provider_settings", "feishu_settings", "feishu_documents"]) {
    assert.match(database, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  for (const index of ["idx_videos_product_created", "idx_videos_account_created", "idx_videos_status"]) {
    assert.match(database, new RegExp(index));
  }
});

test("new product insert keeps its columns and bound values aligned", async () => {
  const database = await readFile(new URL("lib/database.ts", root), "utf8");
  const statement = database.match(/INSERT INTO products\(([\s\S]*?)\) VALUES \(([\s\S]*?)\)`/);
  assert.ok(statement, "createProduct INSERT statement is present");
  const columns = statement[1].split(",").map((item) => item.trim()).filter(Boolean);
  const placeholders = statement[2].match(/\?/g) || [];
  assert.equal(placeholders.length, columns.length);
});

test("new video insert keeps its columns and bound values aligned", async () => {
  const database = await readFile(new URL("lib/database.ts", root), "utf8");
  const statement = database.match(/INSERT INTO videos\(([\s\S]*?)\) VALUES \(([\s\S]*?)\)`/);
  assert.ok(statement, "createVideo INSERT statement is present");
  const columns = statement[1].split(",").map((item) => item.trim()).filter(Boolean);
  const placeholders = statement[2].match(/\?/g) || [];
  assert.equal(placeholders.length, columns.length - 2, "status and stage are SQL literals; every other video column needs a bound value");
});

test("product documents only sync files and translation and the manual prop area remains", async () => {
  const [instrumentation, sync, analysis, document, qwen, tokscript, processing] = await Promise.all([
    readFile(new URL("instrumentation.ts", root), "utf8"),
    readFile(new URL("lib/feishu/product-doc-sync.ts", root), "utf8"),
    readFile(new URL("lib/analysis.ts", root), "utf8"),
    readFile(new URL("lib/feishu/document.ts", root), "utf8"),
    readFile(new URL("lib/providers/qwen.ts", root), "utf8"),
    readFile(new URL("lib/providers/tokscript.ts", root), "utf8"),
    readFile(new URL("lib/video-processing.ts", root), "utf8"),
  ]);
  assert.match(instrumentation, /startProductDocumentSyncWorker/);
  assert.match(sync, /getVideoBySourceUrl/);
  assert.match(sync, /中文翻译\|原口播文案/);
  assert.match(sync, /setTimeout\(resolve, 380\)/);
  assert.doesNotMatch(sync, /analysisCellId|conciseProductDocAnalysis|product_doc_failure_delivered/);
  assert.match(analysis, /includeCover: false/);
  assert.match(analysis, /recordStage\("analysis", "skipped"\)/);
  assert.doesNotMatch(analysis, /analyzeVideoWithQwen|extractVideoAssets|learnFromVideo/);
  assert.match(qwen, /qwen3\.5-omni-plus/);
  assert.doesNotMatch(qwen, /MAX_ANALYSIS_FRAMES|analyzeVideoWithQwen/);
  assert.doesNotMatch(analysis, /完整原文：\$\{input\.transcript\}/);
  assert.doesNotMatch(analysis, /transcribeAudioWithQwen|splitAudioForQwenAsr/);
  assert.doesNotMatch(processing, /segment_time", "270/);
  assert.match(tokscript, /options\.includeCover !== false/);
  assert.match(tokscript, /fetchWithProxy\(this\.endpoint/);
  assert.match(tokscript, /AbortSignal\.timeout/);
  assert.match(tokscript, /TokScript 未返回有效口播文案/);
  assert.match(tokscript, /resolveTokScriptVideoUrl/);
  assert.doesNotMatch(tokscript, /已改用音频转写/);
  assert.doesNotMatch(processing, /includeAudio\?: boolean/);
  assert.match(processing, /fetchWithProxy\(url/);
  assert.match(processing, /signal: requestSignal/);
  assert.match(processing, /normalizedDownloadError/);
  assert.match(analysis, /withOneNetworkRetry/);
  assert.match(analysis, /原视频下载较慢，正在自动重试/);
  assert.doesNotMatch(analysis, /assets\.audioPath|正在识别英语或西语口播/);
  assert.match(analysis, /transcript_original: transcript,/);
  assert.doesNotMatch(analysis, /transcript_original: transcript \|\| analysis\.scenes/);
  assert.match(analysis, /storedTokScriptFailure/);
  assert.match(analysis, /tokScriptTranscriptFailure\(transcript\)/);
  assert.match(analysis, /!relativeVideoPath \|\| !transcript\.trim\(\) \|\| storedTokScriptFailure/);
  assert.match(document, /insertProductPropsSection/);
  assert.match(document, /道具列表（员工手动录入）/);
  assert.match(document, /column_size: 3/);
  assert.match(document, /B3GNdl05HoEdjnx8WPrcwC5Hnlg/);
});

test("source tree contains no pasted API keys", async () => {
  const files = [
    "lib/provider-config.ts",
    "lib/providers/qwen.ts", "lib/providers/tokscript.ts", "README.md",
  ];
  const text = (await Promise.all(files.map((file) => readFile(new URL(file, root), "utf8")))).join("\n");
  assert.doesNotMatch(text, /sk-proj-[A-Za-z0-9_-]{20,}/);
  assert.doesNotMatch(text, /sk-ws-[A-Za-z0-9._-]{20,}/);
  assert.doesNotMatch(text, /sk_[a-f0-9]{32,}/i);
});

test("admin login retains independent Feishu callback authentication", async () => {
  const proxy = await readFile(new URL("proxy.ts", root), "utf8");
  assert.match(proxy, /checkAdminAuthorization/);
  assert.match(proxy, /publicMachineRoute/);
  assert.match(proxy, /status:.*401/);
  const [auth, compose] = await Promise.all([
    readFile(new URL("lib/feishu/webhook-shared.ts", root), "utf8"),
    readFile(new URL("docker-compose.yml", root), "utf8"),
  ]);
  assert.doesNotMatch(compose, /APP_BASIC_AUTH_USER|APP_BASIC_AUTH_PASSWORD/);
  assert.match(auth, /FEISHU_AUTOMATION_WEBHOOK_SECRET/);
  assert.match(auth, /DOUBAO_FEISHU_WEBHOOK_SECRET/);
  assert.match(auth, /x-doubao-feishu-secret/);
  assert.match(auth, /FEISHU_SUBTITLE_BRIDGE_SECRET/);
  assert.match(compose, /DOUBAO_FEISHU_WEBHOOK_SECRET/);
  assert.match(compose, /FEISHU_SUBTITLE_BRIDGE_SECRET/);
  assert.match(compose, /\/api\/health/);
});

test("TikTok inputs require HTTPS TikTok hosts and PID links do not invent a product slug", async () => {
  const links = await readFile(new URL("lib/tiktok-product.ts", root), "utf8");
  assert.match(links, /url\.protocol === "https:"/);
  assert.match(links, /hostname\.endsWith\("\.tiktok\.com"\)/);
  assert.match(links, /www\.tiktok\.com\/view\/product/);
  assert.doesNotMatch(links, /zhenmi-cordless-blender/);
});

test("Qwen uses bounded requests and outbound dependencies can use the macOS proxy", async () => {
  const [network, qwen] = await Promise.all([
    readFile(new URL("lib/network.ts", root), "utf8"),
    readFile(new URL("lib/providers/qwen.ts", root), "utf8"),
  ]);
  assert.match(network, /scutil/);
  assert.match(network, /ProxyAgent/);
  assert.match(network, /fetchWithProxy/);
  assert.match(qwen, /AbortSignal\.timeout/);
  assert.doesNotMatch(qwen, /OpenAI/);
});

test("queue runs two videos concurrently without enqueueing an active id twice", async () => {
  const queue = await readFile(new URL("lib/queue.ts", root), "utf8");
  assert.match(queue, /MAX_CONCURRENT_VIDEOS = 2/);
  assert.match(queue, /__viralQueueActiveIds/);
  assert.match(queue, /__viralQueueActiveIds!\.has\(id\)/);
  assert.match(queue, /VIDEO_TASK_TIMEOUT_MS = 30 \* 60 \* 1_000/);
  assert.match(queue, /AbortController/);
  assert.match(queue, /controller\.abort/);
});

test("Feishu automation supports direct Base write-back", async () => {
  const [automation, route, inbox] = await Promise.all([
    readFile(new URL("lib/feishu/automation.ts", root), "utf8"),
    readFile(new URL("app/api/feishu/automation/route.ts", root), "utf8"),
    readFile(new URL("lib/feishu/inbox.ts", root), "utf8"),
  ]);
  assert.match(automation, /writeBack\s*=\s*input\.writeBack === true/);
  assert.match(automation, /const flushPatch = async \(\) =>/);
  assert.match(automation, /await flushPatch\(\)/);
  assert.match(route, /await claimFeishuRequest/);
  assert.match(route, /after\(\(\) => runFeishuInboxPass\(\)\)/);
  assert.match(inbox, /await handleFeishuAutomation\(\{ client, \.\.\.input, fields, writeBack: true \}\)/);
  assert.match(route, /code: 0/);
  assert.match(route, /msg: "success"/);
});

test("Feishu button durably queues PID-based template creation without the legacy product-link analyzer", async () => {
  const [automation, route] = await Promise.all([
    readFile(new URL("lib/feishu/automation.ts", root), "utf8"),
    readFile(new URL("app/api/feishu/automation/route.ts", root), "utf8"),
  ]);
  assert.match(route, /await claimFeishuRequest/);
  assert.match(route, /after\(\(\) => runFeishuInboxPass\(\)\)/);
  assert.doesNotMatch(route, /\{ status: 202 \}/);
  assert.match(route, /code: 0/);
  assert.match(route, /msg: "success"/);
  assert.doesNotMatch(route, /productDocument: ""/);
  assert.doesNotMatch(route, /activeProductJobs/);
  assert.match(route, /kind: "handcard"/);
  assert.match(automation, /product-card-record:/);
  assert.doesNotMatch(automation, /canRelinkExistingDocument|cachedFallbackEligible|hasVerifiedCache/);
  assert.match(automation, /ensureProductCardByPid/);
  assert.match(automation, /Product-link analysis is disabled/);
  assert.match(automation, /exact `_PID` title suffix/);
  assert.doesNotMatch(automation, /parsePublicProductPage/);
  assert.match(automation, /queueMappedPatch\(resolved\.map\.productDocument, shell\.documentUrl\)/);
});

test("generated Feishu documents grant company editors collaborator management", async () => {
  const [document, permissionRoute] = await Promise.all([
    readFile(new URL("lib/feishu/document.ts", root), "utf8"),
    readFile(new URL("app/api/feishu/product-document-permissions/route.ts", root), "utf8"),
  ]);
  assert.match(document, /external_access_entity: "closed"/);
  assert.match(document, /link_share_entity: "tenant_editable"/);
  assert.match(document, /manage_collaborator_entity: "collaborator_can_edit"/);
  assert.match(document, /security_entity: "anyone_can_edit"/);
  assert.match(permissionRoute, /company_manage_all_generated_documents/);
  assert.match(permissionRoute, /getCompanyDocumentPermission/);
});

test("product cards are created only by the Feishu button and identified by exact PID titles", async () => {
  const [automation, document, database, tiktokProduct] = await Promise.all([
    readFile(new URL("lib/feishu/automation.ts", root), "utf8"),
    readFile(new URL("lib/feishu/document.ts", root), "utf8"),
    readFile(new URL("lib/database.ts", root), "utf8"),
    readFile(new URL("lib/tiktok-product.ts", root), "utf8"),
  ]);
  assert.match(tiktokProduct, /https:\/\/www\.tiktok\.com\/view\/product\/\$\{normalized\}/);
  assert.doesNotMatch(tiktokProduct, /TIKTOK_SHOP_SLUG/);
  assert.match(tiktokProduct, /shop\.tiktokw\.us/);
  assert.match(automation, /const productUrl = urlField/);
  assert.match(automation, /pid: suppliedPid/);
  assert.doesNotMatch(automation, /extractProductIdFromUrl/);
  assert.match(automation, /ensureProductCardByPid\(input\.client/);
  assert.match(automation, /pid: effectivePid/);
  assert.match(automation, /手卡空白基础资料已补录，已有内容保留/);
  assert.doesNotMatch(automation, /parsePublicProductPage/);
  assert.match(automation, /syncProductCardManagedFields/);
  assert.match(automation, /fillEmptyOnly: true/);
  assert.match(automation, /getProductCatalog\(effectivePid\)/);
  assert.doesNotMatch(automation, /productUrlFromPid\(pid\)/);
  assert.doesNotMatch(automation, /patch\[resolved\.map\.productUrl\]/);
  assert.doesNotMatch(automation, /hyperlinkFieldValue/);
  assert.doesNotMatch(automation, /mergeVerifiedProductFacts/);
  assert.match(database, /source_image_urls_json/);
  assert.match(database, /visual_analysis_status/);
  assert.match(database, /visual_analyzed_at/);
  assert.match(database, /input\.visualAnalyzedAt === undefined/);
  assert.match(database, /feishu_product_card_mappings/);
  assert.match(database, /upsertFeishuProductCardMapping/);
  assert.match(document, /ensureProductCardShell/);
  assert.match(document, /ensureProductCardByPid/);
  assert.match(document, /findProductDocumentByPid/);
  assert.match(document, /已自动选择最近编辑的一份/);
  assert.match(document, /return matches\[0\] \|\| null/);
  assert.match(document, /syncProductCardManagedFields/);
  assert.match(document, /PRODUCT_CARD_IDENTITY_LABELS/);
  assert.match(document, /PRODUCT_CARD_DERIVED_LABELS/);
  assert.match(document, /syncProductFieldText/);
  assert.match(document, /\["产品卖点", "", true\]/);
  assert.match(document, /text_element_style: \{ link: \{ url: linkUrl \} \}/);
  assert.match(document, /styledProductFieldElements\(next, currentProduct\.productUrl\)/);
  assert.match(document, /核心功能A: ""/);
  assert.match(document, /核心功能E: ""/);
  assert.match(document, /核心功能: functions\.join\("；"\)/);
  assert.match(document, /values\[`核心功能\$\{ranked\[2\]\.toUpperCase\(\)\}`\] \|\| ""/);
  assert.match(document, /next = `\$\{ranked\[1\]\}\$\{value\}`/);
  assert.match(document, /let reused = false/);
  assert.match(document, /findProductDocumentByTitle/);
  assert.match(document, /clearProductDocumentLink/);
  assert.match(document, /withProductDocumentLock/);
});

