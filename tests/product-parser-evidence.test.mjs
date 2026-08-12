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
    "Quickly connect to your 2.4GHz WiFi with the Phone App",
  ];
  const model = {
    product_id: options.productId ?? cameraPid,
    name: pageTitle,
    description: JSON.stringify(descriptionTexts.map((text) => ({ text }))),
    images: options.images ?? [{
      url_list: ["https://p16-oec-va.ibyteimg.com/tos-maliva-i-o3syd03w52/camera.webp"],
    }],
    product_properties: options.productProperties ?? [
      { property_name: "Video Capture Resolution", property_values: [{ property_value_name: "2.5K" }] },
      { property_name: "Connectivity Technology", property_values: [{ property_value_name: "2.4GHz WiFi" }] },
      { property_name: "Power Source", property_values: [{ property_value_name: "Corded Electric" }] },
      { property_name: "Plug Type", property_values: [{ property_value_name: "US plug" }] },
      { property_name: "Input Voltage(V)", property_values: [{ property_value_name: "110-220" }] },
      { property_name: "Material", property_values: [{ property_value_name: "ABS" }] },
      { property_name: "Model", property_values: [{ property_value_name: "CM-C2LU" }] },
      { property_name: "Special Features", property_values: [
        { property_value_name: "Night Vision" },
        { property_value_name: "2-Way Audio" },
        { property_value_name: "AI Detection" },
      ] },
    ],
    skus: options.skus ?? [{ sku_name: "CAM-TEST" }],
  };
  return `<html><head><meta property="og:title" content="${metaTitle}"><title>${metaTitle}</title></head><body><script id="__MODERN_ROUTER_DATA__" type="application/json">${JSON.stringify({ loaderData: { product_model: model, ...(options.routerExtras || {}) } })}</script></body></html>`;
}

function structuredPhoneCasePage() {
  const model = {
    product_id: pid,
    name: productTitle,
    description: JSON.stringify([{ text: "Shockproof silicone case for iPhone and Samsung" }]),
    images: [],
    product_properties: [
      { property_name: "Material", property_values: [{ property_value_name: "Silicone" }] },
      { property_name: "Compatible Devices", property_values: [{ property_value_name: "iPhone Samsung" }] },
    ],
    skus: [],
  };
  return `<html><head><title>Untrusted meta printer listing</title></head><body><script id="__MODERN_ROUTER_DATA__" type="application/json">${JSON.stringify({ loaderData: { product_model: model } })}</script></body></html>`;
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
          usageMethod: "通过手机App连接2.4GHz Wi-Fi",
          audience: "",
          scenes: "",
          sellingPoints: "",
          visualEvidence: "",
          evidenceQuotes: {
            sku: [],
            coreFunctions: ["Pet/Dog/Cat Camera"],
            productParameters: ["4MP"],
            usageMethod: ["Quickly connect to your 2.4GHz WiFi with the Phone App"],
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
  assert.match(result.productParameters, /视频捕捉分辨率：2\.5K/);
  assert.doesNotMatch(result.productParameters, /4MP/);
  assert.equal(result.usageMethod, "通过手机App连接2.4GHz Wi-Fi");
  assert.doesNotMatch(JSON.stringify(result), /室内安防监控|AI检测|双向语音|夜视/);
});

test("AI fields require one trusted page quote per atomic claim and cannot self-certify", async () => {
  const scenarios = [
    {
      usageMethod: "通过手机App连接2.4GHz Wi-Fi；自定义检测区域",
      usageQuotes: ["Quickly connect to your 2.4GHz WiFi with the Phone App"],
      visualEvidence: "",
      expectedUsage: "通过手机App连接2.4GHz Wi-Fi",
    },
    {
      usageMethod: "自定义检测区域",
      usageQuotes: ["Custom Detection Zones"],
      visualEvidence: "Custom Detection Zones",
      expectedUsage: "",
    },
    {
      usageMethod: "通过手机App连接2.4GHz Wi-Fi",
      usageQuotes: ["", "Quickly connect to your 2.4GHz WiFi with the Phone App"],
      visualEvidence: "",
      expectedUsage: "",
    },
  ];
  for (const scenario of scenarios) {
    globalThis.__productParserTestHooks = {
      fetchWithProxy: async (url) => {
        if (String(url).includes("/chat/completions")) {
          return qwenProductResponse({
            sourceTitle: "",
            sourceDescription: "",
            sku: "",
            coreFunctions: ["宠物看护"],
            productParameters: "分辨率：4MP",
            usageMethod: scenario.usageMethod,
            audience: "需要远程查看家中情况的独居者",
            scenes: "室内家庭安防",
            sellingPoints: "",
            visualEvidence: scenario.visualEvidence,
            evidenceQuotes: {
              sku: [],
              coreFunctions: ["Pet/Dog/Cat Camera"],
              productParameters: ["4MP"],
              usageMethod: scenario.usageQuotes,
              audience: ["Quickly connect to your 2.4GHz WiFi with the Phone App"],
              scenes: [cameraPageTitle],
            },
          });
        }
        return new Response(structuredCameraPage(), { status: 200 });
      },
    };

    const result = await parser.parsePublicProductPage(cameraUrl, { productName: "室内摄像头", pid: cameraPid });
    assert.deepEqual(result.coreFunctions, ["宠物看护"]);
    assert.match(result.productParameters, /视频捕捉分辨率：2\.5K/);
    assert.doesNotMatch(result.productParameters, /4MP/);
    assert.equal(result.scenes, "室内家庭安防");
    assert.equal(result.usageMethod, scenario.expectedUsage, "only the independently grounded atomic claim is retained");
    assert.equal(result.audience, "", "remote access cannot imply a person living alone");
    assert.equal(result.verification.status, "partial");
    assert.ok(result.verification.rejectedFactCount >= 1);
    assert.equal(result.verification.sourceUrl, cameraUrl);
  }
});

test("partial verification keeps a grounded core fact while rejecting an extra invented fact", async () => {
  globalThis.__productParserTestHooks = {
    fetchWithProxy: async (url) => {
      if (String(url).includes("/chat/completions")) {
        return qwenProductResponse({
          coreFunctions: ["宠物看护", "防火"],
          usageMethod: "通过手机App连接2.4GHz Wi-Fi",
          evidenceQuotes: {
            coreFunctions: ["Pet/Dog/Cat Camera", cameraPageTitle],
            usageMethod: ["Quickly connect to your 2.4GHz WiFi with the Phone App"],
          },
        });
      }
      return new Response(structuredCameraPage(), { status: 200 });
    },
  };

  const result = await parser.parsePublicProductPage(cameraUrl, { productName: "室内摄像头", pid: cameraPid });
  assert.deepEqual(result.coreFunctions, ["宠物看护"]);
  assert.equal(result.usageMethod, "通过手机App连接2.4GHz Wi-Fi");
  assert.equal(result.verification.status, "partial");
  assert.ok(result.verification.verifiedFactCount >= 2);
  assert.ok(result.verification.rejectedFactCount >= 1);
  assert.deepEqual(result.verification.verifiedFields.includes("coreFunctions"), true);
  assert.equal(result.verification.evidenceVersion, "exact-pdp-atomic-v1");
});

test("visual completion status is recomputed after a grounded text retry", async () => {
  let chatCalls = 0;
  globalThis.__productParserTestHooks = {
    fetchWithProxy: async (url) => {
      if (String(url).includes("/chat/completions")) {
        chatCalls += 1;
        if (chatCalls === 1) {
          return qwenProductResponse({
            coreFunctions: [],
            productParameters: "",
            usageMethod: "",
            audience: "",
            scenes: "",
            visualEvidence: "Visible image label: 2.4GHz Wi-Fi",
            evidenceQuotes: {},
          });
        }
        return qwenProductResponse({
          coreFunctions: ["宠物看护"],
          productParameters: "分辨率：4MP",
          usageMethod: "通过手机App连接2.4GHz Wi-Fi",
          audience: "",
          scenes: "",
          visualEvidence: "",
          evidenceQuotes: {
            coreFunctions: ["Pet/Dog/Cat Camera"],
            productParameters: ["4MP"],
            usageMethod: ["Quickly connect to your 2.4GHz WiFi with the Phone App"],
          },
        });
      }
      return new Response(structuredCameraPage(), { status: 200 });
    },
  };

  const result = await parser.parsePublicProductPage(cameraUrl, { productName: "室内摄像头", pid: cameraPid });
  assert.equal(chatCalls, 2);
  assert.equal(result.visualAnalysisStatus, "completed");
  assert.match(result.visualEvidence, /2\.4GHz Wi-Fi/);
});

test("unknown, compound, negated, and partial-numeric claims cannot borrow real quotes", async () => {
  for (const scenario of [
    { productParameters: "颜色：蓝色", quote: "2.5K Ultra HD + Night Vision" },
    { productParameters: "分辨率：蓝色", quote: "2.5K Ultra HD + Night Vision" },
    { productParameters: "分辨率：2K", quote: "2.5K Ultra HD + Night Vision" },
    { productParameters: "支持Wi-Fi：5GHz", quote: "5GHz Wi-Fi is not supported" },
    { productParameters: "支持Wi-Fi：5GHz", quote: "5GHz Wi-Fi won't work" },
    { productParameters: "室内防火", quote: cameraPageTitle },
    { productParameters: "材质：硅胶", quote: "Material: ABS" },
    { productParameters: "支持快充", quote: "Charging supported" },
    { productParameters: "电池续航", quote: "Battery: Lithium" },
    { productParameters: "智能监控", quote: "Pet camera" },
    { productParameters: "增强夜视", quote: "Night Vision" },
    { productParameters: "实时监控", quote: "Pet camera" },
    { productParameters: "清晰夜视", quote: "Night Vision" },
    { productParameters: "平滑云台", quote: "Pan Tilt" },
  ]) {
    globalThis.__productParserTestHooks = {
      fetchWithProxy: async (url) => {
        if (String(url).includes("/chat/completions")) {
          return qwenProductResponse({
            coreFunctions: ["宠物看护"],
            productParameters: scenario.productParameters,
            usageMethod: "通过手机App连接2.4GHz Wi-Fi",
            audience: "",
            scenes: "",
            visualEvidence: "",
            evidenceQuotes: {
              coreFunctions: ["Pet/Dog/Cat Camera"],
              productParameters: [scenario.quote],
              usageMethod: ["Quickly connect to your 2.4GHz WiFi with the Phone App"],
            },
          });
        }
        return new Response(structuredCameraPage(), { status: 200 });
      },
    };
    const result = await parser.parsePublicProductPage(cameraUrl, { productName: "室内摄像头", pid: cameraPid });
    assert.notEqual(result.productParameters, scenario.productParameters);
    assert.doesNotMatch(JSON.stringify(result), /颜色：蓝色|分辨率：蓝色|分辨率：2K(?:\D|$)|支持Wi-Fi：5GHz|室内防火|材质：硅胶|支持快充|电池续航|智能监控|增强夜视|实时监控|清晰夜视|平滑云台/);
  }
});

test("product parameters are deterministically bound to exact router property pairs", async () => {
  const maliciousDescription = [
    "Material: ABS. Compatible with silicone mats.",
    "Power Source: Battery. Corded electric accessory sold separately.",
    "Plug Type: EU plug. US plug adapter sold separately.",
  ];
  globalThis.__productParserTestHooks = {
    fetchWithProxy: async (url) => {
      if (String(url).includes("/chat/completions")) {
        return qwenProductResponse({
          coreFunctions: ["宠物看护"],
          productParameters: "材质：硅胶；电源类型：有线电动；插头类型：美标插头",
          usageMethod: "通过手机App连接2.4GHz Wi-Fi",
          audience: "",
          scenes: "",
          visualEvidence: "",
          evidenceQuotes: {
            coreFunctions: ["Pet/Dog/Cat Camera"],
            productParameters: maliciousDescription,
            usageMethod: ["Quickly connect to your 2.4GHz WiFi with the Phone App"],
          },
        });
      }
      return new Response(structuredCameraPage({
        descriptionTexts: [
          "Pet/Dog/Cat Camera",
          "Quickly connect to your 2.4GHz WiFi with the Phone App",
          ...maliciousDescription,
        ],
        productProperties: [
          { property_name: "Material", property_values: [{ property_value_name: "ABS" }] },
          { property_name: "Power Source", property_values: [{ property_value_name: "Battery Powered" }] },
          { property_name: "Plug Type", property_values: [{ property_value_name: "EU plug" }] },
        ],
      }), { status: 200 });
    },
  };
  const result = await parser.parsePublicProductPage(cameraUrl, { productName: "室内摄像头", pid: cameraPid });
  assert.equal(result.productParameters, "材质：ABS；电源类型：电池供电；插头类型：欧标插头");
  assert.doesNotMatch(result.productParameters, /硅胶|有线电动|美标/);
});

test("an off instruction cannot certify the opposite on instruction", async () => {
  globalThis.__productParserTestHooks = {
    fetchWithProxy: async (url) => {
      if (String(url).includes("/chat/completions")) {
        return qwenProductResponse({
          coreFunctions: ["宠物看护"],
          productParameters: "分辨率：4MP",
          usageMethod: "一键开启监控",
          audience: "",
          scenes: "",
          visualEvidence: "",
          evidenceQuotes: {
            coreFunctions: ["Pet/Dog/Cat Camera"],
            productParameters: ["4MP"],
            usageMethod: ["Tap once to instantly turn off the camera"],
          },
        });
      }
      return new Response(structuredCameraPage({
        descriptionTexts: [
          "2.5K Ultra HD + Night Vision",
          "Pet/Dog/Cat Camera",
          "Tap once to instantly turn off the camera",
        ],
      }), { status: 200 });
    },
  };
  const result = await parser.parsePublicProductPage(cameraUrl, { productName: "室内摄像头", pid: cameraPid });
  assert.notEqual(result.usageMethod, "一键开启监控");
});

test("an AI-generated SKU cannot borrow an unrelated exact-page quote", async () => {
  globalThis.__productParserTestHooks = {
    fetchWithProxy: async (url) => {
      if (String(url).includes("/chat/completions")) {
        return qwenProductResponse({
          sku: "FAKE-SKU",
          coreFunctions: ["宠物看护"],
          productParameters: "分辨率：4MP",
          usageMethod: "通过手机App连接2.4GHz Wi-Fi",
          audience: "",
          scenes: "",
          visualEvidence: "",
          evidenceQuotes: {
            sku: ["Pet/Dog/Cat Camera"],
            coreFunctions: ["Pet/Dog/Cat Camera"],
            productParameters: ["4MP"],
            usageMethod: ["Quickly connect to your 2.4GHz WiFi with the Phone App"],
          },
        });
      }
      return new Response(structuredCameraPage({ skus: [] }), { status: 200 });
    },
  };
  const result = await parser.parsePublicProductPage(cameraUrl, { productName: "室内摄像头", pid: cameraPid });
  assert.equal(result.sku, "");
});

test("polluted router og_info, body text, and DOM images cannot certify facts for the exact product model", async () => {
  globalThis.__productParserTestHooks = {
    fetchWithProxy: async (url, init = {}) => {
      if (String(url).includes("/chat/completions")) {
        const request = JSON.parse(String(init.body));
        assert.doesNotMatch(JSON.stringify(request.messages), /Waterproof battery solar camera/);
        assert.doesNotMatch(JSON.stringify(request.messages), /wrong-product\.webp/);
        return qwenProductResponse({
          coreFunctions: ["防水保护", "宠物看护"],
          usageMethod: "通过手机App连接2.4GHz Wi-Fi",
          evidenceQuotes: {
            coreFunctions: ["Waterproof battery solar camera", "Pet/Dog/Cat Camera"],
            usageMethod: ["Quickly connect to your 2.4GHz WiFi with the Phone App"],
          },
        });
      }
      const exactModelPage = structuredCameraPage({
        images: [],
        routerExtras: {
          og_info: {
            product_id: "1739999999999999999",
            title: "Waterproof battery solar camera",
          },
        },
      }).replace(
        "</body>",
        '<div>Waterproof battery solar camera</div><img src="https://example.test/wrong-product.webp"></body>',
      );
      return new Response(exactModelPage, { status: 200 });
    },
  };

  const result = await parser.parsePublicProductPage(cameraUrl, { productName: "室内摄像头", pid: cameraPid });
  assert.deepEqual(result.coreFunctions, ["宠物看护"]);
  assert.doesNotMatch(JSON.stringify(result), /防水|solar|battery/i);
  assert.deepEqual(result.sourceImageUrls, []);
  assert.ok(result.verification.rejectedFactCount >= 1);
});

test("main-product core facts cannot borrow carrying-bag, travel-pouch, adapter, or remote evidence", async () => {
  for (const scenario of [
    {
      claim: "防水",
      quote: "waterproof",
      sourceLine: "Includes a waterproof carrying bag",
    },
    {
      claim: "防水",
      quote: "waterproof",
      sourceLine: "Includes a waterproof travel pouch",
    },
    {
      claim: "快充",
      quote: "Fast charging adapter included",
      sourceLine: "Fast charging adapter included",
    },
    {
      claim: "电池",
      quote: "Battery",
      sourceLine: "Battery for remote",
    },
  ]) {
    globalThis.__productParserTestHooks = {
      fetchWithProxy: async (url) => {
        if (String(url).includes("/chat/completions")) {
          return qwenProductResponse({
            coreFunctions: ["宠物看护", scenario.claim],
            evidenceQuotes: {
              coreFunctions: ["Pet/Dog/Cat Camera", scenario.quote],
            },
          });
        }
        return new Response(structuredCameraPage({
          descriptionTexts: [
            "Pet/Dog/Cat Camera",
            scenario.sourceLine,
          ],
        }), { status: 200 });
      },
    };

    const result = await parser.parsePublicProductPage(cameraUrl, { productName: "室内摄像头", pid: cameraPid });
    assert.deepEqual(result.coreFunctions, ["宠物看护"], scenario.sourceLine);
    assert.ok(result.verification.rejectedFactCount >= 1, scenario.sourceLine);
  }
});

test("accessory-category products may keep their own positively bound facts", async () => {
  const mainProductNames = [
    "Waterproof Travel Pouch",
    "Waterproof Protective Sleeve",
    "Waterproof Phone Cover",
    "Waterproof Holster",
    "Waterproof Camera Mount",
    "Waterproof Phone Stand",
    "Waterproof USB Cable",
    "Waterproof Wall Charger",
    "Waterproof Charging Dock",
    "Waterproof Wrist Strap",
    "Waterproof Phone Holder",
    "Waterproof Mounting Bracket",
  ];
  for (const pageTitle of mainProductNames) {
    globalThis.__productParserTestHooks = {
      fetchWithProxy: async (url) => {
        if (String(url).includes("/chat/completions")) {
          return qwenProductResponse({
            coreFunctions: ["防水"],
            evidenceQuotes: { coreFunctions: ["Waterproof"] },
          });
        }
        return new Response(structuredCameraPage({
          pageTitle,
          descriptionTexts: [`${pageTitle} for daily use`],
          images: [],
          productProperties: [],
          skus: [],
        }), { status: 200 });
      },
    };

    const result = await parser.parsePublicProductPage(cameraUrl, { productName: pageTitle, pid: cameraPid });
    assert.deepEqual(result.coreFunctions, ["防水"], pageTitle);
  }
});

test("short quotes cannot hide negated or contradictory exact-router sentences", async () => {
  const scenarios = [
    {
      lines: ["Pet/Dog/Cat Camera", "This camera is not waterproof."],
      claims: ["宠物看护", "防水"],
      quotes: ["Pet/Dog/Cat Camera", "waterproof"],
      expected: ["宠物看护"],
    },
    {
      lines: ["Pet/Dog/Cat Camera", "This camera does not support night vision."],
      claims: ["宠物看护", "夜视"],
      quotes: ["Pet/Dog/Cat Camera", "night vision"],
      expected: ["宠物看护"],
    },
    {
      lines: [
        "Pet/Dog/Cat Camera",
        "This camera supports night vision.",
        "This camera does not support night vision.",
      ],
      claims: ["宠物看护", "夜视"],
      quotes: ["Pet/Dog/Cat Camera", "night vision"],
      expected: ["宠物看护"],
    },
    {
      lines: ["This camera is waterproof and supports night vision."],
      claims: ["防水", "夜视"],
      quotes: ["waterproof", "night vision"],
      expected: ["防水", "夜视"],
    },
  ];

  for (const scenario of scenarios) {
    globalThis.__productParserTestHooks = {
      fetchWithProxy: async (url) => {
        if (String(url).includes("/chat/completions")) {
          return qwenProductResponse({
            coreFunctions: scenario.claims,
            evidenceQuotes: { coreFunctions: scenario.quotes },
          });
        }
        return new Response(structuredCameraPage({
          pageTitle: "Plain Indoor Camera",
          descriptionTexts: scenario.lines,
          images: [],
          productProperties: [],
          skus: [],
        }), { status: 200 });
      },
    };

    const result = await parser.parsePublicProductPage(cameraUrl, { productName: "室内摄像头", pid: cameraPid });
    assert.deepEqual(result.coreFunctions, scenario.expected, scenario.lines.join(" "));
  }
});

test("no-subscription benefits still require an affirmed source context", async () => {
  const scenarios = [
    {
      line: "Non-subscription mode is not supported.",
      quote: "Non-subscription",
      expected: ["宠物看护"],
    },
    {
      line: "No monthly fee option unavailable.",
      quote: "No monthly fee",
      expected: ["宠物看护"],
    },
    {
      line: "Non-Subscription AI Camera.",
      quote: "Non-Subscription",
      expected: ["宠物看护", "无需订阅"],
    },
  ];
  for (const scenario of scenarios) {
    globalThis.__productParserTestHooks = {
      fetchWithProxy: async (url) => {
        if (String(url).includes("/chat/completions")) {
          return qwenProductResponse({
            coreFunctions: ["宠物看护", "无需订阅"],
            evidenceQuotes: {
              coreFunctions: ["Pet/Dog/Cat Camera", scenario.quote],
            },
          });
        }
        return new Response(structuredCameraPage({
          pageTitle: "Plain Indoor Camera",
          descriptionTexts: ["Pet/Dog/Cat Camera", scenario.line],
          images: [],
          productProperties: [],
          skus: [],
        }), { status: 200 });
      },
    };

    const result = await parser.parsePublicProductPage(cameraUrl, { productName: "室内摄像头", pid: cameraPid });
    assert.deepEqual(result.coreFunctions, scenario.expected, scenario.line);
  }
});

test("an exact-PID URL without a bound router model cannot use recommendation prose as evidence", async () => {
  const unstructuredUrl = `https://www.tiktok.com/shop/pdp/plain-camera/${cameraPid}`;
  let chatCalls = 0;
  globalThis.__productParserTestHooks = {
    fetchWithProxy: async (url) => {
      if (String(url).includes("/chat/completions")) {
        chatCalls += 1;
        return qwenProductResponse({
          coreFunctions: ["防水"],
          evidenceQuotes: { coreFunctions: ["Waterproof"] },
        });
      }
      if (String(url).includes("/responses")) {
        return new Response(JSON.stringify({ output: [] }), { status: 200 });
      }
      return new Response(`<html><head><title>Plain Camera - TikTok Shop</title></head><body>
        <main>Product information is temporarily unavailable. ${"ordinary listing text ".repeat(20)}</main>
        <aside>Customers also liked: Waterproof outdoor camera with night vision.</aside>
      </body></html>`, { status: 200 });
    },
  };

  await assert.rejects(
    parser.parsePublicProductPage(unstructuredUrl, { productName: "室内摄像头", pid: cameraPid }),
    /联网检索.*同 PID|联网检索没有找到/,
  );
  assert.equal(chatCalls, 0, "unstructured body/meta prose must never reach direct AI extraction");
});

test("usage, audience, and scenes reject facts whose quoted subject is an accessory", async () => {
  globalThis.__productParserTestHooks = {
    fetchWithProxy: async (url) => {
      if (String(url).includes("/chat/completions")) {
        return qwenProductResponse({
          coreFunctions: ["宠物看护"],
          usageMethod: "使用充电",
          audience: "家庭用户",
          scenes: "家庭",
          evidenceQuotes: {
            coreFunctions: ["Pet/Dog/Cat Camera"],
            usageMethod: ["Use the included charging adapter"],
            audience: ["Remote control for home users"],
            scenes: ["Remote control for home users"],
          },
        });
      }
      return new Response(structuredCameraPage({
        descriptionTexts: [
          "Pet/Dog/Cat Camera",
          "Use the included charging adapter",
          "Remote control for home users",
        ],
      }), { status: 200 });
    },
  };

  const result = await parser.parsePublicProductPage(cameraUrl, { productName: "室内摄像头", pid: cameraPid });
  assert.deepEqual(result.coreFunctions, ["宠物看护"]);
  assert.equal(result.usageMethod, "");
  assert.equal(result.audience, "");
  assert.equal(result.scenes, "");
  assert.ok(result.verification.rejectedFactCount >= 3);
});

test("deterministic slug facts reject a shockproof carrying case as the camera's capability", async () => {
  const accessorySlug = "pet-camera-with-shockproof-carrying-case";
  const accessoryUrl = `https://shop.tiktok.com/us/pdp/${accessorySlug}/${cameraPid}`;
  globalThis.__productParserTestHooks = {
    fetchWithProxy: async (url) => {
      if (String(url).includes("/chat/completions")) {
        return qwenProductResponse({ coreFunctions: [], evidenceQuotes: {} });
      }
      return new Response(structuredCameraPage({
        pageTitle: "Pet Camera with Shockproof Carrying Case",
        descriptionTexts: ["Pet Camera with Shockproof Carrying Case"],
      }), { status: 200 });
    },
  };

  const result = await parser.parsePublicProductPage(accessoryUrl, { productName: "宠物摄像头", pid: cameraPid });
  assert.doesNotMatch(JSON.stringify(result.coreFunctions), /防震/);
  assert.equal(result.verification.status, "partial");
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
  assert.match(result.productParameters, /视频捕捉分辨率：2\.5K/);
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
  assert.match(result.productParameters, /视频捕捉分辨率：2\.5K/);
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
  assert.match(negated.productParameters, /视频捕捉分辨率：2\.5K/);
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
      if (String(url).includes("/responses")) {
        return new Response(JSON.stringify({ output: [] }), { status: 200 });
      }
      return new Response(structuredCameraPage({
        pageTitle: "Plain Desk Clock",
        metaTitle: "2.5K Indoor Security Camera with AI Detection, 2-Way Audio and Night Vision",
        descriptionTexts: ["Simple clock display"],
        productProperties: [],
        skus: [],
      }), { status: 200 });
    },
  };

  await assert.rejects(
    parser.parsePublicProductPage(
      `https://shop.tiktok.com/us/pdp/${forgedSlug}/${cameraPid}`,
      { productName: "桌面时钟", pid: cameraPid },
    ),
    /Qwen 请求超时.*联网检索/,
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
      if (String(url).includes("/responses")) {
        return new Response(JSON.stringify({ output: [] }), { status: 200 });
      }
      return new Response(structuredCameraPage({
        pageTitle: fuzzyTitle,
        metaTitle: "CINMOORE 2.5K Indoor Security Camera with AI Detection - TikTok Shop",
        productProperties: [],
        skus: [],
      }), { status: 200 });
    },
  };

  const result = await parser.parsePublicProductPage(cameraUrl, { productName: "室内摄像头", pid: cameraPid });
  assert.deepEqual(result.coreFunctions, ["室内安防监控", "AI检测", "双向语音", "夜视"]);
  assert.equal(result.productParameters, "", "meta 2.5K and fuzzy router 2 5K cannot certify exact 2.5K");
  assert.equal(result.verification.status, "partial");
});

test("direct provider HTTP, invalid JSON, and insufficient failures remain diagnosable", async () => {
  const unsupportedUrl = `https://shop.tiktok.com/us/pdp/plain-desk-clock/${cameraPid}`;
  const page = structuredCameraPage({
    pageTitle: "Plain Desk Clock",
    metaTitle: "Plain Desk Clock - TikTok Shop",
    descriptionTexts: ["Simple clock display"],
    images: [],
    productProperties: [],
    skus: [],
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
      fetchWithProxy: async (url) => {
        if (String(url).includes("/chat/completions")) return scenario.providerResponse();
        if (String(url).includes("/responses")) {
          return new Response(JSON.stringify({ output: [] }), { status: 200 });
        }
        return new Response(page, { status: 200 });
      },
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
  assert.equal(directCalls, 9, "the original page and recovered exact PDP each follow the bounded retry schedule");
  assert.equal(searchCalls, 1);
  assert.equal(chatCalls, 0);
  assert.equal(result.productName, "手机壳");
  assert.deepEqual(result.coreFunctions, ["防震保护"]);
  assert.equal(result.productParameters, "材质：硅胶；兼容设备：iPhone、Samsung");
  assert.equal(result.sourceTitle, productTitle);
  assert.equal(result.sourceDescription, "");
  assert.equal(result.visualAnalysisStatus, "unavailable");
  assert.deepEqual(result.sourceImageUrls, []);
  assert.equal(result.verification.status, "partial");
  assert.equal(result.verification.sourceUrl, `https://www.tiktok.com/shop/pdp/${productSlug}/${pid}?source=301`);
  assert.doesNotMatch(JSON.stringify(result), /waterproof|battery/i);
});

test("a view-product endpoint recovers an exact same-PID PDP and parses that fetched router model", async () => {
  const viewUrl = `https://www.tiktok.com/view/product/${pid}`;
  const recoveredUrl = `https://www.tiktok.com/shop/pdp/${productSlug}/${pid}?source=301`;
  let recoveredFetches = 0;
  let searchCalls = 0;
  globalThis.__productParserTestHooks = {
    fetchWithProxy: async (url) => {
      const requestUrl = String(url);
      if (requestUrl.includes("/responses")) {
        searchCalls += 1;
        return new Response(JSON.stringify({
          output: [{
            type: "web_search_call",
            status: "completed",
            action: { sources: [{ url: recoveredUrl }] },
          }],
        }), { status: 200 });
      }
      if (requestUrl.includes("/chat/completions")) {
        return qwenProductResponse({ coreFunctions: [], evidenceQuotes: {} });
      }
      if (requestUrl.includes(`/shop/pdp/${productSlug}/${pid}`)) {
        recoveredFetches += 1;
        return new Response(structuredPhoneCasePage(), { status: 200 });
      }
      return new Response("", { status: 404 });
    },
  };

  const result = await parser.parsePublicProductPage(viewUrl, { productName: "手机壳", pid });
  assert.equal(searchCalls, 1);
  assert.equal(recoveredFetches, 1, "the discovered exact PDP must actually be fetched");
  assert.deepEqual(result.coreFunctions, ["防震保护"]);
  assert.match(result.productParameters, /材质：硅胶/);
  assert.equal(result.verification.sourceUrl, recoveredUrl);
  assert.doesNotMatch(JSON.stringify(result), /printer/i);
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
