import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

test("archived product-link parser retains its historical implementation contract", async () => {
  const [parser, openaiAnalyzer] = await Promise.all([
    readFile(new URL("lib/product-parser.ts", root), "utf8"),
    readFile(new URL("lib/openai-product-analyzer.ts", root), "utf8"),
  ]);
  assert.match(parser, /__MODERN_ROUTER_DATA__/);
  assert.match(parser, /product_model/);
  assert.match(parser, /clean\(model\.product_id\) !== productId/);
  assert.match(parser, /tools: \[\{ type: "web_search" \}\]/);
  assert.match(parser, /enable_thinking: false/);
  assert.match(parser, /hasUsableProductInfo/);
  assert.match(parser, /needsCompletenessRetry/);
  assert.match(parser, /explicitBundleCount/);
  assert.match(parser, /enumeratedBundleFeatures/);
  assert.match(parser, /qwenTranslateBundleFeatures/);
  assert.match(parser, /productParameters: mergeAtomicText\(current\.productParameters, candidate\.productParameters\)/);
  assert.match(parser, /numericSpecificationCount/);
  assert.match(parser, /coreFunctions 必须恰好返回 \$\{bundleOutputCount\} 条/);
  assert.match(parser, /temperature: 0/);
  assert.match(parser, /产品主要功能/);
  assert.match(parser, /JSON 键名必须严格使用/);
  assert.match(parser, /SKU 不得填写 PID 或商品ID/);
  assert.match(parser, /SKU is copied only from the exact-PID router model/);
  assert.match(parser, /sku: base\.sku/);
  assert.match(parser, /analyzeProductCaptureWithOpenAI/);
  assert.match(parser, /parsedProductInfoFromOpenAICapture/);
  assert.match(parser, /MAX_PRODUCT_IMAGES = 20/);
  assert.match(parser, /playwright-core/);
  assert.match(parser, /PRODUCT_DETAIL_CONTROL_LABELS/);
  assert.match(parser, /"详细内容"/);
  assert.match(parser, /requiredStableRounds/);
  assert.match(parser, /all_product_images_unavailable/);
  assert.match(parser, /scoped-dom-details/);
  assert.match(parser, /max_pixels: MAX_IMAGE_PIXELS/);
  assert.match(parser, /visualEvidence/);
  assert.match(parser, /hasReliableVisualEvidence/);
  assert.doesNotMatch(parser, /categoryFallbackPrompt/);
  assert.match(parser, /不得使用常识补齐/);
  assert.match(parser, /exactSourceMatched/);
  assert.match(parser, /sellingPoints: ""/);
  assert.match(parser, /sourceImageUrls: \[\]/);
  assert.match(openaiAnalyzer, /gpt-5\.6-terra/);
  assert.match(openaiAnalyzer, /type: "json_schema"/);
  assert.match(openaiAnalyzer, /strict: true/);
  assert.match(openaiAnalyzer, /（AI推断）/);
  assert.match(openaiAnalyzer, /CONTROLLED_INFERENCE_TEMPLATES/);
  assert.match(openaiAnalyzer, /titleHasAccessorySubject/);
  assert.match(openaiAnalyzer, /role: "developer"/);
});
