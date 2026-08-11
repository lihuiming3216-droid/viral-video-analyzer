import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const parserSource = await readFile(
  new URL("../lib/product-parser.ts", import.meta.url),
  "utf8",
);

async function loadProductParserModule() {
  const stubSource = `
    const hooks = () => globalThis.__productParserTestHooks || {};
    export const existsSync = () => false;
    export const fetchWithProxy = (...args) => hooks().fetchWithProxy(...args);
    export const getProviderConfig = () => ({
      enabled: true,
      apiKey: "test-key",
      baseUrl: "https://qwen.test/v1",
      model: "qwen3.7-plus",
    });
    export const parseJsonLoose = (input) => JSON.parse(input);
    export const readTextFromModelResponse = (payload) => {
      if (typeof payload.output_text === "string") return payload.output_text;
      for (const item of Array.isArray(payload.output) ? payload.output : []) {
        for (const part of Array.isArray(item?.content) ? item.content : []) {
          if (typeof part?.text === "string") return part.text;
        }
      }
      const first = Array.isArray(payload.choices) ? payload.choices[0] : null;
      if (typeof first?.message?.content === "string") return first.message.content;
      throw new Error("missing model text");
    };
    export const tiktokProductFetchUrls = (productUrl) => {
      const url = new URL(productUrl);
      if (url.hostname !== "shop.tiktok.com") return [productUrl];
      const origin = new URL(productUrl);
      origin.hostname = "shop.tiktokw.us";
      return [origin.toString(), productUrl];
    };
  `;
  const stubUrl = `data:text/javascript;base64,${Buffer.from(stubSource).toString("base64")}`;
  let compiled = ts.transpileModule(parserSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  compiled = compiled
    .replace('import "server-only";', "")
    .replaceAll('"node:fs"', JSON.stringify(stubUrl))
    .replaceAll('"@/lib/network"', JSON.stringify(stubUrl))
    .replaceAll('"@/lib/provider-config"', JSON.stringify(stubUrl))
    .replaceAll('"@/lib/json-utils"', JSON.stringify(stubUrl))
    .replaceAll('"@/lib/tiktok-product"', JSON.stringify(stubUrl));
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
  return import(moduleUrl);
}

const parser = await loadProductParserModule();
const pid = "1732364299482009895";
const productSlug = "anime-n-narutos-silicone-case-for-iphone-samsung-shockproof";
const productTitle = "anime n narutos silicone case for iphone samsung shockproof";
const productUrl = `https://shop.tiktok.com/us/pdp/${productSlug}/${pid}?source=anchor`;

test("expanded Chromium challenge pages are rejected as product evidence", () => {
  const expanded = {
    html: "<html><head><title>Security Check</title></head><body>Verify to continue</body></html>",
    text: `Verify to continue ${"challenge filler ".repeat(50)}`,
    imageUrls: [],
  };
  assert.equal(parser.isProductSecurityChallenge("Security Check", "", expanded.text), true);
  assert.equal(parser.isProductSecurityChallenge("Just a moment...", "", "Checking your browser"), true);
  assert.equal(parser.isProductSecurityChallenge("TikTok Shop", "Human verification", ""), true);
  assert.equal(parser.isProductSecurityChallenge("TikTok Shop", "", "请完成人机验证"), true);
  assert.equal(parser.expandedProductResult(expanded, productUrl), null);
  assert.equal(parser.isProductSecurityChallenge("Anime phone case", "Shockproof case", "Product details"), false);
});

test("exact public evidence accepts only official TikTok product paths with the same PID", () => {
  const accepted = [
    `https://shop.tiktok.com/us/pdp/${productSlug}/${pid}?source=anchor`,
    `https://www.tiktok.com/shop/pdp/${productSlug}/${pid}?source=301`,
    `https://www.tiktok.com/view/product/${pid}`,
    `https://shop.tiktok.com/us/pdp/${productSlug}/${pid}?pid=${pid}&product_id=${pid}`,
  ];
  for (const url of accepted) assert.equal(parser.isExactTikTokProductSource(url, pid), true, url);

  const rejected = [
    `http://shop.tiktok.com/us/pdp/anime-phone-case/${pid}`,
    `https://shop.tiktok.com/us/pdp/anime-phone-case/1732364299482009896`,
    `https://www.tiktok.com/@seller/video/${pid}`,
    `https://www.tiktok.com/video/${pid}`,
    `https://shop.tiktok.com.evil.example/us/pdp/anime-phone-case/${pid}`,
    `https://evil.example/www.tiktok.com/shop/pdp/anime-phone-case/${pid}`,
    `https://shop.tiktok.com/us/pdp/${productSlug}/${pid}?pid=1732364299482009896`,
    `https://shop.tiktok.com/us/pdp/${productSlug}/${pid}?product_id=${pid}&product_id=1732364299482009896`,
    `https://www.tiktok.com/shop/pdp/${productSlug}/${pid}?itemId=1732364299482009896`,
  ];
  for (const url of rejected) assert.equal(parser.isExactTikTokProductSource(url, pid), false, url);
  assert.equal(parser.trustedProductPathEvidence(accepted[0], pid), productTitle);
  assert.equal(parser.trustedProductPathEvidence(`https://www.tiktok.com/view/product/${pid}`, pid), "");
});

test("the parser rejects a TikTok video URL before fetching it", async () => {
  let fetchCalls = 0;
  globalThis.__productParserTestHooks = {
    fetchWithProxy: async () => {
      fetchCalls += 1;
      throw new Error("must not fetch a video page");
    },
  };
  await assert.rejects(
    parser.parsePublicProductPage(`https://www.tiktok.com/@seller/video/${pid}`, { productName: "手机壳", pid }),
    /必须是 HTTPS TikTok 官方商品详情页/,
  );
  assert.equal(fetchCalls, 0);
});

test("the parser rejects a conflicting query PID before fetching it", async () => {
  let fetchCalls = 0;
  globalThis.__productParserTestHooks = {
    fetchWithProxy: async () => {
      fetchCalls += 1;
      throw new Error("must not fetch a conflicting URL");
    },
  };
  await assert.rejects(
    parser.parsePublicProductPage(`${productUrl}&productId=1732364299482009896`, { productName: "手机壳", pid }),
    /链接 PID 必须与商品 PID 一致/,
  );
  assert.equal(fetchCalls, 0);
});

test("the 1+1 threshold is limited to freshly grounded search results", () => {
  const partial = {
    sourceTitle: "Shockproof phone case",
    sourceDescription: "",
    coreFunctions: ["防震保护"],
    productParameters: "适用于 iPhone",
    usageMethod: "",
    audience: "",
    scenes: "",
    sellingPoints: "",
  };
  assert.equal(parser.hasUsableProductInfo(partial), false, "legacy cache still requires two descriptive fields");
  assert.equal(parser.hasUsableProductInfo(partial, 1), true);
  assert.equal(parser.hasUsableProductInfo({ ...partial, coreFunctions: [] }, 1), false);
  assert.equal(parser.hasUsableProductInfo({ ...partial, productParameters: "" }, 1), false);
});

test("a direct TikTok challenge falls through to exact-source web search", { timeout: 15_000 }, async () => {
  const searchPayload = {
    output: [
      {
        type: "web_search_call",
        status: "completed",
        action: {
          sources: [
            { url: `https://www.tiktok.com/view/product/${pid}` },
            { url: `https://www.tiktok.com/shop/pdp/${productSlug}/${pid}?source=301` },
          ],
        },
      },
    ],
    // Responses prose is deliberately unrelated and must never be parsed as evidence.
    output_text: JSON.stringify({ coreFunctions: ["防水"], evidenceQuotes: { coreFunctions: ["waterproof"] } }),
  };
  let directCalls = 0;
  let searchCalls = 0;
  let chatCalls = 0;
  globalThis.__productParserTestHooks = {
    fetchWithProxy: async (url, init = {}) => {
      if (String(url).startsWith("https://qwen.test/v1/responses")) {
        searchCalls += 1;
        const request = JSON.parse(String(init.body));
        assert.deepEqual(request.tools, [{ type: "web_search" }]);
        return new Response(JSON.stringify(searchPayload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (String(url).startsWith("https://qwen.test/v1/chat/completions")) {
        chatCalls += 1;
        throw new Error("search fallback must not call chat completions");
      }
      directCalls += 1;
      return new Response("<html><head><title>Security Check</title></head><body>Verify to continue</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    },
  };

  const result = await parser.parsePublicProductPage(productUrl, { productName: "手机壳", pid });
  assert.equal(directCalls, 6, "both TikTok hosts should be retried before web search");
  assert.equal(searchCalls, 1);
  assert.equal(chatCalls, 0);
  assert.equal(result.productName, "手机壳");
  assert.deepEqual(result.coreFunctions, ["防震保护"]);
  assert.equal(result.productParameters, "材质：硅胶；兼容设备：iPhone、Samsung");
  assert.equal(result.sourceTitle, productTitle);
  assert.equal(result.sourceDescription, "");
  assert.equal(result.visualAnalysisStatus, "unavailable");
  assert.deepEqual(result.sourceImageUrls, []);
  assert.doesNotMatch(JSON.stringify(result), /waterproof|battery/i);
});

test("grounded-looking model output is rejected when search found only another PID", async () => {
  const otherPid = "1732364299482009896";
  const payload = {
    output: [{
      type: "web_search_call",
      status: "completed",
      action: { sources: [{ url: `https://shop.tiktok.com/us/pdp/similar-case/${otherPid}` }] },
    }],
    output_text: JSON.stringify({
      sourceTitle: "Similar shockproof phone case",
      sourceDescription: "Compatible with iPhone",
      coreFunctions: ["防震保护"],
      productParameters: "适用于 iPhone",
      evidenceQuotes: {
        coreFunctions: ["shockproof"],
        productParameters: ["Compatible with iPhone"],
      },
    }),
  };
  let searchCalls = 0;
  globalThis.__productParserTestHooks = {
    fetchWithProxy: async (url) => {
      if (String(url).startsWith("https://qwen.test/v1/responses")) {
        searchCalls += 1;
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("", { status: 404 });
    },
  };

  await assert.rejects(
    parser.parsePublicProductPage(productUrl, { productName: "手机壳", pid }),
    /联网检索也未找到与该 PID 完全匹配的官方公开商品页/,
  );
  assert.equal(searchCalls, 1);
});

test("response prose and later similar-product sources cannot enter deterministic slug facts", async () => {
  const otherPid = "1732364299482009896";
  const searchPayload = {
    output: [{
      type: "web_search_call",
      status: "completed",
      action: { sources: [
        { url: `https://shop.tiktok.com/us/pdp/${productSlug}/${pid}` },
        { url: `https://shop.tiktok.com/us/pdp/waterproof-battery-case/${pid}` },
        { url: `https://shop.tiktok.com/us/pdp/waterproof-battery-case/${otherPid}` },
      ] },
    }],
    output_text: JSON.stringify({
      sourceDescription: "waterproof battery case",
      coreFunctions: ["防水保护"],
      usageMethod: "内置电池供电",
    }),
  };
  let chatCalls = 0;
  globalThis.__productParserTestHooks = {
    fetchWithProxy: async (url) => {
      if (String(url).includes("/responses")) {
        return new Response(JSON.stringify(searchPayload), { status: 200 });
      }
      if (String(url).includes("/chat/completions")) {
        chatCalls += 1;
        throw new Error("search fallback must not call chat completions");
      }
      return new Response("", { status: 404 });
    },
  };

  const result = await parser.parsePublicProductPage(productUrl, { productName: "手机壳", pid });
  assert.deepEqual(result.coreFunctions, ["防震保护"]);
  assert.equal(result.productParameters, "材质：硅胶；兼容设备：iPhone、Samsung");
  assert.equal(result.usageMethod, "");
  assert.equal(result.sourceTitle, productTitle);
  assert.doesNotMatch(JSON.stringify(result), /waterproof|battery/i);
  assert.equal(chatCalls, 0);
});

test("an exact view-product URL without a slug fails closed", async () => {
  let extractionCalls = 0;
  let searchCalls = 0;
  globalThis.__productParserTestHooks = {
    fetchWithProxy: async (url) => {
      if (String(url).includes("/responses")) {
        searchCalls += 1;
        return new Response(JSON.stringify({
          output: [{
            type: "web_search_call",
            status: "completed",
            action: { sources: [{ url: `https://www.tiktok.com/view/product/${pid}` }] },
          }],
        }), { status: 200 });
      }
      if (String(url).includes("/chat/completions")) extractionCalls += 1;
      return new Response("", { status: 404 });
    },
  };
  await assert.rejects(
    parser.parsePublicProductPage(productUrl, { productName: "手机壳", pid }),
    /链接路径没有可独立验证的商品资料/,
  );
  assert.equal(searchCalls, 1, "a view-only result must fail without a second discovery or chat call");
  assert.equal(extractionCalls, 0);
});

test("web-search HTTP and network errors remain visible", async () => {
  for (const scenario of [
    { response: new Response("", { status: 503 }), expected: /联网检索失败：HTTP 503/ },
    { error: new Error("search socket reset"), expected: /联网检索失败：search socket reset/ },
  ]) {
    globalThis.__productParserTestHooks = {
      fetchWithProxy: async (url) => {
        if (String(url).includes("/responses")) {
          if (scenario.error) throw scenario.error;
          return scenario.response;
        }
        return new Response("", { status: 404 });
      },
    };
    await assert.rejects(
      parser.parsePublicProductPage(productUrl, { productName: "手机壳", pid }),
      scenario.expected,
    );
  }
});

test("product parse failures distinguish security, missing sources, and weak extraction", () => {
  assert.equal(
    parser.productParseFailureReason({ searchMode: true, pageError: "商品页要求安全验证", exactSourceMatched: false }),
    "商品页要求安全验证，联网检索也未找到与该 PID 完全匹配的官方公开商品页",
  );
  assert.equal(
    parser.productParseFailureReason({ searchMode: true, pageError: "HTTP 404", exactSourceMatched: false }),
    "HTTP 404；联网检索也未找到与该 PID 完全匹配的官方公开商品页",
  );
  assert.equal(
    parser.productParseFailureReason({ searchMode: true, pageError: "", exactSourceMatched: true, trustedEvidenceAvailable: true }),
    "联网检索找到了同 PID 的官方商品页，但链接路径没有足够的白名单商品资料",
  );
  assert.equal(
    parser.productParseFailureReason({ searchMode: true, pageError: "", exactSourceMatched: true, trustedEvidenceAvailable: false }),
    "联网检索找到了同 PID 的官方商品页，但链接路径没有可独立验证的商品资料",
  );
  assert.equal(
    parser.productParseFailureReason({ searchMode: true, pageError: "HTTP 404", exactSourceMatched: false, searchError: "HTTP 503" }),
    "HTTP 404；联网检索失败：HTTP 503",
  );
  assert.equal(
    parser.productParseFailureReason({ searchMode: false, pageError: "", exactSourceMatched: false }),
    "AI 没有返回足够的可验证商品资料",
  );
});
