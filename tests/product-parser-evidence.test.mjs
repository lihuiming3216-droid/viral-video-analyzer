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
const cameraPid = "1731678528327946361";
const cameraSlug = "cinmoore-2-5k-indoor-security-camera-ai-detection-2-way-audio-night-vision";
const cameraUrl = `https://shop.tiktok.com/us/pdp/${cameraSlug}/${cameraPid}?source=anchor`;
const cameraPageTitle = "CINMOORE 2.5K Security Camera Indoor, Non-Subscription AI Person/Pet/Cry Detection, 4MP Pet/Dog/Cat Camera with Phone App, Pan Tilt 2.4GHz WiFi Cameras for Home Security, IR Night Vision, Full Duplex 2-Way Audio";

function structuredCameraPage(options = {}) {
  const pageTitle = options.pageTitle ?? cameraPageTitle;
  const metaTitle = options.metaTitle ?? "CINMOORE 2.5K Indoor Security Camera with AI Detection - TikTok Shop";
  const descriptionTexts = options.descriptionTexts ?? [
    "2.5K Ultra HD + Night Vision",
    "Smart AI Detection",
    "Full Duplex 2-Way Audio",
  ];
  const model = {
    product_id: options.productId ?? cameraPid,
    name: pageTitle,
    description: JSON.stringify(descriptionTexts.map((text) => ({ text }))),
    images: options.images ?? [{
      url_list: ["https://p16-oec-va.ibyteimg.com/tos-maliva-i-o3syd03w52/camera.webp"],
    }],
    product_properties: [
      { property_name: "Video Capture Resolution", property_values: [{ property_value_name: "2.5K" }] },
      { property_name: "Special Features", property_values: [
        { property_value_name: "Night Vision" },
        { property_value_name: "2-Way Audio" },
        { property_value_name: "AI Detection" },
      ] },
    ],
    skus: [{ sku_name: "CAM-TEST" }],
  };
  return `<html><head><meta property="og:title" content="${metaTitle}"><title>${metaTitle}</title></head><body><script id="__MODERN_ROUTER_DATA__" type="application/json">${JSON.stringify({ loaderData: { product_model: model } })}</script></body></html>`;
}

function qwenProductResponse(product) {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(product) } }],
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

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
  const overlongSlug = `${"camera-".repeat(85)}without-night-vision`;
  assert.equal(
    parser.trustedProductPathEvidence(`https://shop.tiktok.com/us/pdp/${overlongSlug}/${pid}`, pid),
    "",
    "an overlong slug must be rejected whole instead of truncating a trailing negation",
  );
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

test("a valid direct AI result takes priority over deterministic camera facts", async () => {
  let chatCalls = 0;
  globalThis.__productParserTestHooks = {
    fetchWithProxy: async (url) => {
      if (String(url).includes("/chat/completions")) {
        chatCalls += 1;
        return qwenProductResponse({
          sourceTitle: "",
          sourceDescription: "",
          sku: "",
          coreFunctions: ["宠物看护"],
          productParameters: "分辨率：4MP",
          usageMethod: "通过手机应用查看",
          audience: "",
          scenes: "",
          sellingPoints: "",
          visualEvidence: "",
          evidenceQuotes: {
            sku: [],
            coreFunctions: ["Pet/Dog/Cat Camera"],
            productParameters: ["4MP"],
            usageMethod: ["Phone App"],
            audience: [],
            scenes: [],
          },
        });
      }
      return new Response(structuredCameraPage(), { status: 200 });
    },
  };

  const result = await parser.parsePublicProductPage(cameraUrl, { productName: "室内摄像头", pid: cameraPid });
  assert.equal(chatCalls, 1);
  assert.deepEqual(result.coreFunctions, ["宠物看护"]);
  assert.equal(result.productParameters, "分辨率：4MP");
  assert.equal(result.usageMethod, "通过手机应用查看");
  assert.doesNotMatch(JSON.stringify(result), /室内安防监控|AI检测|双向语音|夜视/);
});

test("the production camera URL falls back safely when direct Qwen times out", async () => {
  const chatModes = [];
  globalThis.__productParserTestHooks = {
    fetchWithProxy: async (url, init = {}) => {
      if (String(url).includes("/chat/completions")) {
        const request = JSON.parse(String(init.body));
        chatModes.push(Array.isArray(request.messages?.[0]?.content) ? "visual" : "text");
        const error = new Error("request timed out");
        error.name = "TimeoutError";
        throw error;
      }
      return new Response(structuredCameraPage(), { status: 200 });
    },
  };

  const result = await parser.parsePublicProductPage(cameraUrl, { productName: "室内摄像头", pid: cameraPid });
  assert.deepEqual(chatModes, ["visual"], "a usable deterministic candidate must prevent a redundant text retry");
  assert.deepEqual(result.coreFunctions, ["室内安防监控", "AI检测", "双向语音", "夜视"]);
  assert.equal(result.productParameters, "分辨率：2.5K");
  assert.equal(result.scenes, "室内");
  assert.equal(result.sku, "");
  assert.equal(result.sourceDescription, "");
  assert.deepEqual(result.sourceImageUrls, []);
});

test("a valid but evidence-insufficient Qwen response uses the same camera fallback", async () => {
  let chatCalls = 0;
  globalThis.__productParserTestHooks = {
    fetchWithProxy: async (url) => {
      if (String(url).includes("/chat/completions")) {
        chatCalls += 1;
        return qwenProductResponse({ coreFunctions: [], evidenceQuotes: {} });
      }
      return new Response(structuredCameraPage(), { status: 200 });
    },
  };

  const result = await parser.parsePublicProductPage(cameraUrl, { productName: "室内摄像头", pid: cameraPid });
  assert.equal(chatCalls, 2);
  assert.deepEqual(result.coreFunctions, ["室内安防监控", "AI检测", "双向语音", "夜视"]);
  assert.equal(result.productParameters, "分辨率：2.5K");
  assert.equal(result.scenes, "室内");
});

test("camera fallback respects scoped negations without suppressing no-subscription features", async () => {
  globalThis.__productParserTestHooks = {
    fetchWithProxy: async (url) => {
      if (String(url).includes("/chat/completions")) return qwenProductResponse({ coreFunctions: [], evidenceQuotes: {} });
      return new Response(structuredCameraPage(), { status: 200 });
    },
  };

  const negatedSlug = "no-shockproof-2-5k-indoor-security-camera-non-ai-detection-not-supported-2-way-audio-without-support-for-night-vision";
  const negated = await parser.parsePublicProductPage(
    `https://shop.tiktok.com/us/pdp/${negatedSlug}/${cameraPid}`,
    { productName: "室内摄像头", pid: cameraPid },
  );
  assert.deepEqual(negated.coreFunctions, ["室内安防监控"]);
  assert.equal(negated.productParameters, "分辨率：2.5K");
  assert.equal(negated.scenes, "室内");

  const noSubscriptionSlug = "2-5k-indoor-security-camera-no-subscription-night-vision";
  const noSubscription = await parser.parsePublicProductPage(
    `https://shop.tiktok.com/us/pdp/${noSubscriptionSlug}/${cameraPid}`,
    { productName: "室内摄像头", pid: cameraPid },
  );
  assert.deepEqual(noSubscription.coreFunctions, ["室内安防监控", "夜视"]);

  for (const suffix of [
    "not-supported", "not-included", "not-available", "not-enabled",
    "no-longer-supported", "no-longer-included", "no-longer-available", "no-longer-enabled",
    "anti", "unsupported", "disabled", "unavailable",
  ]) {
    const mixedEvidenceSlug = `2-5k-indoor-security-camera-night-vision-night-vision-${suffix}`;
    const mixed = await parser.parsePublicProductPage(
      `https://shop.tiktok.com/us/pdp/${mixedEvidenceSlug}/${cameraPid}`,
      { productName: "室内摄像头", pid: cameraPid },
    );
    assert.deepEqual(
      mixed.coreFunctions,
      ["室内安防监控"],
      `any explicit postfixed negation must reject all night-vision occurrences: ${suffix}`,
    );
  }

  for (const prefix of [
    "not-supported", "not-included", "not-available", "not-enabled",
    "no-longer-supported", "no-longer-included", "no-longer-available", "no-longer-enabled",
    "anti", "unsupported", "disabled", "unavailable",
  ]) {
    const prefixedNegationSlug = `2-5k-camera-feature-${prefix}-night-vision-indoor-security-camera`;
    const prefixed = await parser.parsePublicProductPage(
      `https://shop.tiktok.com/us/pdp/${prefixedNegationSlug}/${cameraPid}`,
      { productName: "室内摄像头", pid: cameraPid },
    );
    assert.deepEqual(
      prefixed.coreFunctions,
      ["室内安防监控"],
      `any explicit prefixed negation must reject night vision: ${prefix}`,
    );
  }

  for (const pagePhrase of ["Night Vision - Not Supported", "Not Supported - Night Vision"]) {
    globalThis.__productParserTestHooks = {
      fetchWithProxy: async (url) => String(url).includes("/chat/completions")
        ? qwenProductResponse({ coreFunctions: [], evidenceQuotes: {} })
        : new Response(structuredCameraPage({
            pageTitle: cameraPageTitle.replace("IR Night Vision", pagePhrase),
          }), { status: 200 }),
    };
    const pageNegated = await parser.parsePublicProductPage(cameraUrl, { productName: "室内摄像头", pid: cameraPid });
    assert.doesNotMatch(JSON.stringify(pageNegated.coreFunctions), /夜视/, pagePhrase);
  }

  for (const pagePhrase of ["Non-AI Detection", "No-AI Detection"]) {
    globalThis.__productParserTestHooks = {
      fetchWithProxy: async (url) => String(url).includes("/chat/completions")
        ? qwenProductResponse({ coreFunctions: [], evidenceQuotes: {} })
        : new Response(structuredCameraPage({
            pageTitle: cameraPageTitle.replace("Non-Subscription AI Person/Pet/Cry Detection", pagePhrase),
          }), { status: 200 }),
    };
    const pageNegated = await parser.parsePublicProductPage(cameraUrl, { productName: "室内摄像头", pid: cameraPid });
    assert.doesNotMatch(JSON.stringify(pageNegated.coreFunctions), /AI检测/, pagePhrase);
  }
});

test("a forged direct slug cannot create facts absent from the same structured page", async () => {
  const forgedSlug = "waterproof-battery-2-5k-indoor-security-camera-ai-detection-2-way-audio-night-vision";
  const chatModes = [];
  globalThis.__productParserTestHooks = {
    fetchWithProxy: async (url, init = {}) => {
      if (String(url).includes("/chat/completions")) {
        const request = JSON.parse(String(init.body));
        chatModes.push(Array.isArray(request.messages?.[0]?.content) ? "visual" : "text");
        const error = new Error("request timed out");
        error.name = "TimeoutError";
        throw error;
      }
      return new Response(structuredCameraPage({
        pageTitle: "Plain Desk Clock",
        metaTitle: "2.5K Indoor Security Camera with AI Detection, 2-Way Audio and Night Vision",
        descriptionTexts: ["Simple clock display"],
      }), { status: 200 });
    },
  };

  await assert.rejects(
    parser.parsePublicProductPage(
      `https://shop.tiktok.com/us/pdp/${forgedSlug}/${cameraPid}`,
      { productName: "桌面时钟", pid: cameraPid },
    ),
    /Qwen 请求超时.*官方商品页路径也没有足够的确定性白名单资料/,
  );
  assert.deepEqual(chatModes, ["visual", "text"], "a product without a usable deterministic candidate keeps the text retry");
});

test("direct fallback ignores conflicting meta titles and fuzzy 2 5K router text", async () => {
  const fuzzyTitle = cameraPageTitle.replaceAll("2.5K", "2 5K");
  globalThis.__productParserTestHooks = {
    fetchWithProxy: async (url) => {
      if (String(url).includes("/chat/completions")) {
        const error = new Error("request timed out");
        error.name = "TimeoutError";
        throw error;
      }
      return new Response(structuredCameraPage({
        pageTitle: fuzzyTitle,
        metaTitle: "CINMOORE 2.5K Indoor Security Camera with AI Detection - TikTok Shop",
      }), { status: 200 });
    },
  };

  await assert.rejects(
    parser.parsePublicProductPage(cameraUrl, { productName: "室内摄像头", pid: cameraPid }),
    /官方商品页路径也没有足够的确定性白名单资料/,
  );
});

test("direct provider HTTP, invalid JSON, and insufficient failures remain diagnosable", async () => {
  const unsupportedUrl = `https://shop.tiktok.com/us/pdp/plain-desk-clock/${cameraPid}`;
  const page = structuredCameraPage({
    pageTitle: "Plain Desk Clock",
    metaTitle: "Plain Desk Clock - TikTok Shop",
    descriptionTexts: ["Simple clock display"],
  });
  const scenarios = [
    {
      providerResponse: () => new Response("", { status: 503 }),
      expected: /Qwen HTTP 503/,
    },
    {
      providerResponse: () => new Response("not-json", { status: 200 }),
      expected: /Qwen 返回的商品资料不是有效 JSON/,
    },
    {
      providerResponse: () => qwenProductResponse({ coreFunctions: [], evidenceQuotes: {} }),
      expected: /Qwen 返回资料未通过证据引文与字段完整性校验/,
    },
    {
      providerResponse: () => { throw new Error("socket reset at provider-internal.example"); },
      expected: /Qwen 请求失败/,
      forbidden: /socket reset|provider-internal/i,
    },
    {
      providerResponse: () => { throw new Error("HTTP 500 Authorization: Bearer secret-token"); },
      expected: /Qwen HTTP 500/,
      forbidden: /Authorization|Bearer|secret-token/i,
    },
    {
      providerResponse: () => { throw new Error("valid json Bearer secret-token"); },
      expected: /Qwen 返回的商品资料不是有效 JSON/,
      forbidden: /Bearer|secret-token/i,
    },
  ];

  for (const scenario of scenarios) {
    globalThis.__productParserTestHooks = {
      fetchWithProxy: async (url) => String(url).includes("/chat/completions")
        ? scenario.providerResponse()
        : new Response(page, { status: 200 }),
    };
    await assert.rejects(
      parser.parsePublicProductPage(unsupportedUrl, { productName: "桌面时钟", pid: cameraPid }),
      (error) => {
        assert.match(error.message, scenario.expected);
        if (scenario.forbidden) assert.doesNotMatch(error.message, scenario.forbidden);
        return true;
      },
    );
  }
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
    { response: new Response("", { status: 503 }), expected: /联网检索失败：Qwen HTTP 503/ },
    { error: new Error("search socket reset provider-internal.example"), expected: /联网检索失败：Qwen 请求失败/, forbidden: /socket reset|provider-internal/i },
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
      (error) => {
        assert.match(error.message, scenario.expected);
        if (scenario.forbidden) assert.doesNotMatch(error.message, scenario.forbidden);
        return true;
      },
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
    parser.productParseFailureReason({ searchMode: true, pageError: "HTTP 404", exactSourceMatched: false, searchError: "Qwen HTTP 503" }),
    "HTTP 404；联网检索失败：Qwen HTTP 503",
  );
  assert.equal(
    parser.productParseFailureReason({ searchMode: false, pageError: "", exactSourceMatched: false }),
    "AI 没有返回足够的可验证商品资料",
  );
});
