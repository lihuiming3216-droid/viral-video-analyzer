import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("ships the finished product shell and branded preview", async () => {
  const [page, layout, app, image] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/layout.tsx", root), "utf8"),
    readFile(new URL("app/ViralAnalyzerApp.tsx", root), "utf8"),
    stat(new URL("public/og.png", root)),
  ]);
  assert.match(page, /ViralAnalyzerApp/);
  assert.match(layout, /爆片分析/);
  assert.match(layout, /og\.png/);
  assert.match(app, /产品爆片档案库/);
  assert.match(app, /两条视频对比/);
  assert.match(app, /逐镜头时间轴/);
  assert.ok(image.size > 100_000);
  assert.doesNotMatch(`${page}\n${layout}\n${app}`, /codex-preview|SkeletonPreview|Your site is taking shape/);
});

test("database schema covers archive, scenes, providers, learning, Feishu and search indexes", async () => {
  const database = await readFile(new URL("lib/database.ts", root), "utf8");
  for (const table of ["products", "videos", "scenes", "provider_settings", "learning_memories", "learning_profiles", "feishu_settings", "feishu_targets", "feishu_batches", "feishu_deliveries", "feishu_documents", "feishu_events"]) {
    assert.match(database, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  for (const index of ["idx_videos_product_created", "idx_videos_account_created", "idx_videos_status", "idx_scenes_video_shot", "idx_learning_memories_product"]) {
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

test("product documents auto-sync in lightweight mode and keep the manual prop area", async () => {
  const [instrumentation, sync, analysis, document, formatter, qwen, tokscript, processing] = await Promise.all([
    readFile(new URL("instrumentation.ts", root), "utf8"),
    readFile(new URL("lib/feishu/product-doc-sync.ts", root), "utf8"),
    readFile(new URL("lib/analysis.ts", root), "utf8"),
    readFile(new URL("lib/feishu/document.ts", root), "utf8"),
    readFile(new URL("lib/product-doc-analysis.ts", root), "utf8"),
    readFile(new URL("lib/providers/qwen.ts", root), "utf8"),
    readFile(new URL("lib/providers/tokscript.ts", root), "utf8"),
    readFile(new URL("lib/video-processing.ts", root), "utf8"),
  ]);
  assert.match(instrumentation, /startProductDocumentSyncWorker/);
  assert.match(sync, /getVideoBySourceUrl/);
  assert.match(sync, /中文翻译\|原口播文案/);
  assert.match(sync, /setTimeout\(resolve, 380\)/);
  assert.match(analysis, /analysisMode === "product_doc" \? 2_000 : 4_500/);
  assert.match(analysis, /learningContext = analysisMode === "product_doc" \? null/);
  assert.match(analysis, /includeCover: analysisMode !== "product_doc"/);
  assert.match(analysis, /includeAudio: analysisMode !== "product_doc" && !transcript/);
  assert.match(analysis, /translationZh 必须写“无口播”/);
  assert.match(formatter, /分析爆点/);
  assert.doesNotMatch(formatter, /原视频链接|复拍口播稿|分镜脚本/);
  assert.match(qwen, /max_tokens: input\.maxTokens \|\| 4_500/);
  assert.match(tokscript, /options\.includeCover !== false/);
  assert.match(tokscript, /fetchOpenAI\(this\.endpoint/);
  assert.match(tokscript, /AbortSignal\.timeout/);
  assert.match(processing, /includeAudio\?: boolean/);
  assert.match(processing, /fetchOpenAI\(url/);
  assert.match(document, /insertProductPropsSection/);
  assert.match(document, /道具列表（员工手动录入）/);
  assert.match(document, /column_size: 3/);
  assert.match(document, /B3GNdl05HoEdjnx8WPrcwC5Hnlg/);
});

test("Feishu bot receives links, returns scored reports, and excludes remake copy from documents", async () => {
  const [runtime, handler, cards, document, app, packageJson] = await Promise.all([
    readFile(new URL("lib/feishu/runtime.ts", root), "utf8"),
    readFile(new URL("lib/feishu/handler.ts", root), "utf8"),
    readFile(new URL("lib/feishu/cards.ts", root), "utf8"),
    readFile(new URL("lib/feishu/document.ts", root), "utf8"),
    readFile(new URL("app/ViralAnalyzerApp.tsx", root), "utf8"),
    readFile(new URL("package.json", root), "utf8"),
  ]);
  assert.match(runtime, /createLarkChannel/);
  assert.match(runtime, /requireMention: true/);
  assert.match(handler, /parseFeishuSubmission/);
  assert.match(handler, /createFeishuBatch/);
  for (const score of ["流量潜力", "带货转化", "画面质量", "产品展示", "声音情绪", "节奏完播"]) {
    assert.match(cards, new RegExp(score));
    assert.match(document, new RegExp(score));
  }
  assert.doesNotMatch(document, /rewriteScript|可直接照着拍的新中文脚本/);
  assert.match(app, /发送到飞书/);
  assert.match(packageJson, /@larksuiteoapi\/node-sdk/);
});

test("source tree contains no pasted API keys", async () => {
  const files = [
    "app/ViralAnalyzerApp.tsx", "lib/provider-config.ts", "lib/providers/openai.ts",
    "lib/providers/qwen.ts", "lib/providers/tokscript.ts", "README.md",
  ];
  const text = (await Promise.all(files.map((file) => readFile(new URL(file, root), "utf8")))).join("\n");
  assert.doesNotMatch(text, /sk-proj-[A-Za-z0-9_-]{20,}/);
  assert.doesNotMatch(text, /sk-ws-[A-Za-z0-9._-]{20,}/);
  assert.doesNotMatch(text, /sk_[a-f0-9]{32,}/i);
});

test("local dashboard API exposes business data without leaking provider secrets", async () => {
  const baseUrl = process.env.TEST_BASE_URL || "http://localhost:3000";
  const response = await fetch(`${baseUrl}/api/dashboard`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.ok(Array.isArray(payload.products));
  assert.ok(Array.isArray(payload.videos));
  assert.ok(Array.isArray(payload.providers));
  assert.ok(payload.products.every((product) => typeof product.pid === "string"));
  assert.ok(payload.providers.every((provider) => !("encryptedApiKey" in provider) && !("apiKey" in provider)));
});

test("OpenAI uses the macOS proxy and model calls cannot hang forever", async () => {
  const [network, openai, qwen] = await Promise.all([
    readFile(new URL("lib/network.ts", root), "utf8"),
    readFile(new URL("lib/providers/openai.ts", root), "utf8"),
    readFile(new URL("lib/providers/qwen.ts", root), "utf8"),
  ]);
  assert.match(network, /scutil/);
  assert.match(network, /ProxyAgent/);
  assert.match(openai, /fetchOpenAI/);
  assert.match(openai, /AbortSignal\.timeout/);
  assert.match(qwen, /AbortSignal\.timeout/);
});

test("queue polling cannot enqueue the currently active video twice", async () => {
  const queue = await readFile(new URL("lib/queue.ts", root), "utf8");
  assert.match(queue, /__viralQueueActiveId/);
  assert.match(queue, /__viralQueueActiveId !== id/);
  assert.match(queue, /AbortController/);
  assert.match(queue, /controller\.abort/);
});

test("finished videos can be deleted with their archived media", async () => {
  const [route, processing, app, types] = await Promise.all([
    readFile(new URL("app/api/videos/[id]/route.ts", root), "utf8"),
    readFile(new URL("lib/video-processing.ts", root), "utf8"),
    readFile(new URL("app/ViralAnalyzerApp.tsx", root), "utf8"),
    readFile(new URL("lib/types.ts", root), "utf8"),
  ]);
  assert.match(route, /export async function DELETE/);
  assert.match(route, /"waiting", "completed", "failed", "stopped"/);
  assert.match(route, /deleteVideoMedia/);
  assert.match(processing, /rmSync\(target, \{ recursive: true, force: true \}\)/);
  assert.match(app, /永久删除这条视频/);
  assert.match(app, /className="queue-delete"/);
  assert.match(app, /const queue = data\.videos/);
  assert.match(app, /停止/);
  assert.match(types, /"stopped"/);
});

test("analysis page can quickly create a product with an optional PID", async () => {
  const [app, database, types] = await Promise.all([
    readFile(new URL("app/ViralAnalyzerApp.tsx", root), "utf8"),
    readFile(new URL("lib/database.ts", root), "utf8"),
    readFile(new URL("lib/types.ts", root), "utf8"),
  ]);
  assert.match(app, /新增产品档案/);
  assert.match(app, /PID（选填）/);
  assert.match(app, /创建并选中/);
  assert.match(database, /ALTER TABLE products ADD COLUMN pid/);
  assert.match(database, /idx_products_pid/);
  assert.match(types, /pid: string/);
});

test("Feishu automation can return fields without requiring Base write permission", async () => {
  const [automation, route] = await Promise.all([
    readFile(new URL("lib/feishu/automation.ts", root), "utf8"),
    readFile(new URL("app/api/feishu/automation/route.ts", root), "utf8"),
  ]);
  assert.match(automation, /writeBack\s*=\s*input\.writeBack === true/);
  assert.match(automation, /if \(writeBack && Object\.keys\(patch\)\.length\)/);
  assert.match(route, /fields: result\.patch/);
  assert.match(route, /productDocument/);
  assert.match(route, /writeBackError/);
});

test("product cards use verified TikTok evidence and resync reused documents", async () => {
  const [parser, automation, document, database, ensureDocument, tiktokProduct] = await Promise.all([
    readFile(new URL("lib/product-parser.ts", root), "utf8"),
    readFile(new URL("lib/feishu/automation.ts", root), "utf8"),
    readFile(new URL("lib/feishu/document.ts", root), "utf8"),
    readFile(new URL("lib/database.ts", root), "utf8"),
    readFile(new URL("app/api/products/ensure-document/route.ts", root), "utf8"),
    readFile(new URL("lib/tiktok-product.ts", root), "utf8"),
  ]);
  assert.match(tiktokProduct, /https:\/\/shop\.tiktok\.com\/us\/pdp\/\$\{TIKTOK_SHOP_SLUG\}\/\$\{normalized\}\?source=anchor/);
  assert.match(tiktokProduct, /shop\.tiktokw\.us/);
  assert.match(parser, /__MODERN_ROUTER_DATA__/);
  assert.match(parser, /product_model/);
  assert.match(parser, /clean\(model\.product_id\) !== productId/);
  assert.match(parser, /tools: \[\{ type: "web_search" \}\]/);
  assert.match(parser, /enable_thinking: false/);
  assert.match(parser, /hasUsableProductInfo/);
  assert.match(parser, /needsCompletenessRetry/);
  assert.match(parser, /explicitBundleCount/);
  assert.match(parser, /numericSpecificationCount/);
  assert.match(parser, /coreFunctions 必须恰好返回 \$\{bundleCount\} 条/);
  assert.match(parser, /temperature: 0/);
  assert.match(parser, /产品主要功能/);
  assert.match(parser, /JSON 键名必须严格使用/);
  assert.match(parser, /SKU 不得填写 PID 或商品ID/);
  assert.match(parser, /skuWithoutLabel !== clean\(productId\)/);
  assert.match(parser, /type: "image_url"/);
  assert.match(parser, /MAX_PRODUCT_IMAGES = 4/);
  assert.match(parser, /max_pixels: MAX_IMAGE_PIXELS/);
  assert.match(parser, /visualEvidence/);
  assert.match(parser, /hasReliableVisualEvidence/);
  assert.doesNotMatch(parser, /categoryFallbackPrompt/);
  assert.match(parser, /不得使用常识补齐/);
  assert.match(parser, /exactSourceMatched/);
  assert.match(parser, /sellingPoints: ""/);
  assert.match(parser, /sourceImageUrls: \[\]/);
  assert.match(automation, /!product\.visualAnalyzedAt/);
  assert.match(automation, /productUrlChanged/);
  assert.match(automation, /visualAnalyzedAt: new Date\(\)\.toISOString\(\)/);
  assert.match(ensureDocument, /forceProductParse === true/);
  assert.match(database, /source_image_urls_json/);
  assert.match(database, /visual_analysis_status/);
  assert.match(database, /visual_analyzed_at/);
  assert.match(database, /input\.visualAnalyzedAt === undefined/);
  assert.match(automation, /已停止生成空白产品手卡/);
  assert.match(document, /syncProductFieldText/);
  assert.match(document, /\["产品卖点", "", true\]/);
  assert.match(document, /text_element_style: \{ link: \{ url: productUrl \} \}/);
  assert.match(document, /核心功能A: ""/);
  assert.match(document, /核心功能E: ""/);
  assert.match(document, /核心功能: functions\.join\("；"\)/);
  assert.match(document, /values\[`核心功能\$\{ranked\[2\]\.toUpperCase\(\)\}`\] \|\| ""/);
  assert.match(document, /next = `\$\{ranked\[1\]\}\$\{value\}`/);
  assert.match(document, /const reused = Boolean\(product\.documentId && product\.documentUrl\)/);
});

test("long-term learning is visible and used by future analysis", async () => {
  const [learning, analysis, app, feedbackRoute] = await Promise.all([
    readFile(new URL("lib/learning.ts", root), "utf8"),
    readFile(new URL("lib/analysis.ts", root), "utf8"),
    readFile(new URL("app/ViralAnalyzerApp.tsx", root), "utf8"),
    readFile(new URL("app/api/videos/[id]/route.ts", root), "utf8"),
  ]);
  assert.match(learning, /getLearningContext/);
  assert.match(learning, /人工标签和备注是最高优先级证据/);
  assert.match(analysis, /长期学习系统提供的产品\/品类\/团队历史经验/);
  assert.match(analysis, /learnFromVideo/);
  assert.match(feedbackRoute, /learnFromVideo/);
  assert.match(app, /长期学习中心/);
  assert.match(app, /学习中心/);
});

test("learning API backfills completed reports", async () => {
  const baseUrl = process.env.TEST_BASE_URL || "http://localhost:3000";
  const response = await fetch(`${baseUrl}/api/learning`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.ok(Number.isInteger(payload.learnedVideos));
  assert.ok(Array.isArray(payload.profiles));
  assert.ok(Array.isArray(payload.recentMemories));
});
