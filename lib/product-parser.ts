import "server-only";

import { fetchOpenAI } from "@/lib/network";
import { getProviderConfig, requireProvider } from "@/lib/provider-config";
import { parseJsonLoose, readTextFromModelResponse } from "@/lib/json-utils";

export interface ParsedProductInfo {
  productName: string;
  sku: string;
  coreFunctions: string[];
  productParameters: string;
  usageMethod: string;
  audience: string;
  scenes: string;
  sellingPoints: string;
  sourceTitle: string;
  sourceDescription: string;
  sourceImageUrls: string[];
  visualEvidence: string;
  visualAnalysisStatus: "completed" | "unavailable";
}

export interface ProductParseHints {
  productName?: string;
  pid?: string;
}

/** Extract a TikTok Shop product identifier when the public URL exposes it. */
export function extractProductIdFromUrl(productUrl: string) {
  try {
    const url = new URL(productUrl);
    for (const key of ["pid", "product_id", "productId", "item_id", "itemId"]) {
      const value = url.searchParams.get(key)?.trim();
      if (value) return value;
    }
    const candidates = url.pathname.match(/\d{6,}/g) || [];
    return candidates.sort((a, b) => b.length - a.length)[0] || "";
  } catch {
    return (productUrl.match(/\d{6,}/g) || []).sort((a, b) => b.length - a.length)[0] || "";
  }
}

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["sku", "coreFunctions", "productParameters", "usageMethod", "audience", "scenes", "sellingPoints", "visualEvidence"],
  properties: {
    sku: { type: "string" },
    coreFunctions: { type: "array", items: { type: "string" }, maxItems: 5 },
    productParameters: { type: "string" },
    usageMethod: { type: "string" },
    audience: { type: "string" },
    scenes: { type: "string" },
    sellingPoints: { type: "string" },
    visualEvidence: { type: "string" },
  },
} as const;

const MAX_PRODUCT_IMAGES = 4;
const MAX_IMAGE_PIXELS = 768 * 768;

function clean(value: unknown) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function cleanFunction(value: unknown) {
  return clean(value).replace(/^[A-EＡ-Ｅ]\s*[.．、:：]\s*/i, "");
}

function useful(value: unknown) {
  const normalized = clean(value);
  return Boolean(normalized && !/^(?:(?:页面|网页|商品页)?(?:暂未|未)(?:提供|说明|展示|找到)|无法(?:确认|判断|识别)|无可靠|不确定$|未知$)/i.test(normalized));
}

function hasReliableVisualEvidence(value: unknown) {
  const normalized = clean(value);
  return useful(normalized)
    && !/(?:未发现|未能找到|没有找到|没有可靠|无可靠|无法确认|无法判断|无法作为|不能作为|仅为.+示意|与.+不对应|缺乏.+(?:图片|图像))/i.test(normalized);
}

export function hasUsableProductInfo(info: {
  coreFunctions: string[];
  productParameters: string;
  usageMethod: string;
  sellingPoints: string;
  audience?: string;
  scenes?: string;
  targetAudience?: string;
  usageScenes?: string;
}) {
  const functions = (info.coreFunctions || []).map(cleanFunction).filter(useful);
  const descriptiveFields = [
    info.productParameters,
    info.usageMethod,
    info.audience || info.targetAudience,
    info.scenes || info.usageScenes,
    info.sellingPoints,
  ]
    .filter(useful);
  return functions.length >= 2 && descriptiveFields.length >= 3;
}

function htmlText(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function attribute(tag: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = tag.match(new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
}

function meta(html: string, key: string) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const label = attribute(tag, "property") || attribute(tag, "name");
    if (clean(label).toLowerCase() === key.toLowerCase()) return clean(attribute(tag, "content"));
  }
  return "";
}

function decodeMarkupValue(value: string) {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\\u002f|\\x2f/gi, "/")
    .replace(/\\\//g, "/")
    .trim();
}

function normalizeImageUrl(value: string, productUrl: string) {
  let candidate = decodeMarkupValue(value).split(/\s+/)[0]?.trim() || "";
  if (/^https?%3a%2f%2f/i.test(candidate)) {
    try {
      candidate = decodeURIComponent(candidate);
    } catch {
      return "";
    }
  }
  if (candidate.startsWith("//")) candidate = `https:${candidate}`;
  try {
    const url = new URL(candidate, productUrl);
    if (!/^https?:$/.test(url.protocol)) return "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function looksLikeProductImage(url: string) {
  const lower = url.toLowerCase();
  if (/(?:avatar|favicon|logo|sprite|emoji|tracking|pixel|placeholder|loading)[_./?=-]/.test(lower)) return false;
  return /\.(?:avif|gif|jpe?g|png|webp)(?:$|[?&#])/i.test(lower)
    || /(?:byteimg|tiktokcdn|akamaized|alicdn|image|img|tos-)/i.test(lower);
}

export function extractProductImageUrls(html: string, productUrl: string) {
  const prioritized: string[] = [];
  const discovered: string[] = [];
  for (const key of ["og:image", "og:image:url", "twitter:image", "twitter:image:src"]) {
    const value = meta(html, key);
    if (value) prioritized.push(value);
  }
  for (const tag of html.match(/<img\b[^>]*>/gi) || []) {
    for (const name of ["src", "data-src", "data-lazy-src", "data-original", "data-url", "srcset"]) {
      const value = attribute(tag, name);
      if (value) discovered.push(...value.split(",").map((item) => item.trim().split(/\s+/)[0]));
    }
  }
  const normalizedHtml = decodeMarkupValue(html);
  discovered.push(...(normalizedHtml.match(/https?:\/\/[^\s"'<>\\)]+/gi) || []));

  const result: string[] = [];
  for (const raw of [...prioritized, ...discovered]) {
    const url = normalizeImageUrl(raw, productUrl);
    if (!url || result.includes(url)) continue;
    const isPriority = prioritized.includes(raw);
    if ((!isPriority || /(?:avatar|favicon|logo|sprite|emoji|tracking|pixel|placeholder|loading)/i.test(url))
      && !looksLikeProductImage(url)) continue;
    result.push(url);
    if (result.length >= MAX_PRODUCT_IMAGES) break;
  }
  return result;
}

function baseInfo(title: string, description: string, hints: ProductParseHints, sourceImageUrls: string[]): ParsedProductInfo {
  return {
    productName: clean(hints.productName) || title,
    sku: "",
    coreFunctions: [],
    productParameters: description,
    usageMethod: "",
    audience: "",
    scenes: "",
    sellingPoints: "",
    sourceTitle: title,
    sourceDescription: description,
    sourceImageUrls,
    visualEvidence: "",
    visualAnalysisStatus: "unavailable",
  };
}

function parsedValue(parsed: Partial<ParsedProductInfo>, aliases: string[]) {
  const record = parsed as Record<string, unknown>;
  for (const key of aliases) {
    if (record[key] != null) return record[key];
  }
  return undefined;
}

function normalizeParsed(
  parsed: Partial<ParsedProductInfo>,
  base: ParsedProductInfo,
  productId: string,
): ParsedProductInfo {
  const rawFunctions = parsedValue(parsed, ["coreFunctions", "核心功能", "核心功能（按重要程度）"]);
  const functions = Array.isArray(rawFunctions)
    ? rawFunctions
    : String(rawFunctions || "").split(/[；;\n]+/);
  const rawSku = clean(parsedValue(parsed, ["sku", "SKU", "产品SKU"]));
  const skuWithoutLabel = rawSku.replace(/^(?:SKU|PID|商品ID|产品ID)\s*[:：#-]?\s*/i, "");
  return {
    ...base,
    sku: rawSku && skuWithoutLabel !== clean(productId) ? rawSku : "页面未说明",
    coreFunctions: [...new Set(functions.map(cleanFunction).filter(Boolean))].slice(0, 5),
    productParameters: clean(parsedValue(parsed, ["productParameters", "产品参数"])) || base.productParameters || "页面未说明",
    usageMethod: clean(parsedValue(parsed, ["usageMethod", "使用方法"])),
    audience: clean(parsedValue(parsed, ["audience", "适用人群", "目标人群"])),
    scenes: clean(parsedValue(parsed, ["scenes", "使用场景", "适用场景"])),
    // 产品卖点暂不由 AI 生成，避免把品类常识包装成未经证实的商品卖点。
    sellingPoints: "",
    visualEvidence: clean(parsedValue(parsed, ["visualEvidence", "图片证据", "视觉证据", "图片分析"])),
  };
}

async function readProductPage(productUrl: string) {
  try {
    const response = await fetchOpenAI(productUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return { title: "", description: "", text: "", imageUrls: [], error: `HTTP ${response.status}` };
    const html = await response.text();
    const title = meta(html, "og:title") || clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
    const description = meta(html, "og:description") || meta(html, "description");
    const text = htmlText(html).slice(0, 8_000);
    const blocked = /captcha|verify to continue|access denied|登录后继续|安全验证/i.test(`${title} ${description} ${text.slice(0, 1_000)}`);
    if (blocked || (!title && !description && text.length < 300)) {
      return { title, description, text: "", imageUrls: [], error: blocked ? "商品页要求验证" : "商品页没有公开资料" };
    }
    return { title, description, text, imageUrls: extractProductImageUrls(html, productUrl), error: "" };
  } catch (error) {
    return { title: "", description: "", text: "", imageUrls: [], error: error instanceof Error ? error.message : "fetch failed" };
  }
}

function extractionPrompt(input: {
  productUrl: string;
  hints: ProductParseHints;
  title: string;
  description: string;
  pageText: string;
  visualMode: "direct" | "search" | "none";
}) {
  const identity = `团队中文名称：${clean(input.hints.productName) || "未提供"}\n商品 PID：${clean(input.hints.pid) || extractProductIdFromUrl(input.productUrl) || "未提供"}\n商品链接：${input.productUrl}`;
  const evidence = input.visualMode === "search"
    ? `阿里云服务器无法直连商品页。请只调用一次图片搜索，搜索上述 PID、商品链接和产品名称；只有能与 PID 或商品可靠对应的图片才可作为证据，普通同品类图片不得作为该商品证据。`
    : `页面标题：${input.title}\n页面描述：${input.description}\n页面正文：${input.pageText}`;
  const visualInstruction = input.visualMode === "direct"
    ? "下方会附带商品图片。必须结合图片确认产品外观结构、接口/按键、随附配件、可见文字和使用方式，并把这些可靠信息融入各字段。"
    : input.visualMode === "search"
      ? "使用可靠图片确认产品外观结构、接口/按键、随附配件、可见文字和使用方式，并把这些可靠信息融入各字段。如果没有可靠图片，visualEvidence 必须严格写“页面未说明”，且不得使用相似商品图推断该商品功能。"
      : "当前没有可靠商品图片，只能根据公开文字资料整理。";
  return `你在整理 TikTok Shop 产品手卡。\n${identity}\n${evidence}\n${visualInstruction}\n\n请输出以下字段：SKU、2至5条产品主要功能、产品参数、使用方法、适用人群、使用场景，以及一条简短的图片证据摘要 visualEvidence。产品主要功能按重要程度排序，但内容中不要写 A/B/C/D/E 前缀。SKU 不得填写 PID 或商品ID；找不到真实 SKU 时写“页面未说明”。不得根据图片猜测精确尺寸、功率、材质、兼容型号、认证或包装数量；公开资料没有精确参数时，产品参数写“页面未说明”。无法从可靠图片确认时 visualEvidence 写“页面未说明”。其他字段可以根据已确认的产品品类进行保守归纳。sellingPoints 暂不生成，必须严格返回空字符串。只返回合法 JSON，不要使用 Markdown 代码块。JSON 键名必须严格使用以下英文键：{"sku":"","coreFunctions":[""],"productParameters":"","usageMethod":"","audience":"","scenes":"","sellingPoints":"","visualEvidence":""}。`;
}

function categoryFallbackPrompt(productUrl: string, hints: ProductParseHints) {
  const productName = clean(hints.productName) || "未命名产品";
  const productId = clean(hints.pid) || extractProductIdFromUrl(productUrl) || "未提供";
  return `你在整理 TikTok Shop 产品手卡，但目前没有可验证的商品页文字或商品图片。唯一可用证据是团队中文品类名“${productName}”和 PID ${productId}。请只做被这个品类名直接支持的保守归纳：输出2至4条最基础产品主要功能、通用使用方法、适用人群和使用场景。不得写入品类名没有明确表达的屏幕、接口、遥控器、配件、材质、尺寸、容量、功率、芯片、型号、兼容标准、包装数量或其他精确特征；不得出现品类名中没有的数字或型号。SKU、产品参数和 visualEvidence 必须严格写“页面未说明”，sellingPoints 必须严格返回空字符串。只返回合法 JSON，不要使用 Markdown 代码块。JSON 键名必须严格使用以下英文键：{"sku":"页面未说明","coreFunctions":[""],"productParameters":"页面未说明","usageMethod":"","audience":"","scenes":"","sellingPoints":"","visualEvidence":"页面未说明"}。`;
}

async function qwenExtract(prompt: string) {
  const qwen = getProviderConfig("qwen");
  if (!qwen.enabled || !qwen.apiKey) return null;
  const response = await fetchOpenAI(`${qwen.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${qwen.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: qwen.model || "qwen-plus",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      enable_thinking: false,
      max_tokens: 1_800,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) return null;
  return parseJsonLoose<Partial<ParsedProductInfo>>(readTextFromModelResponse(await response.json() as Record<string, unknown>));
}

async function qwenVisualExtract(prompt: string, imageUrls: string[]) {
  const qwen = getProviderConfig("qwen");
  if (!qwen.enabled || !qwen.apiKey || !imageUrls.length) return null;
  const response = await fetchOpenAI(`${qwen.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${qwen.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: qwen.model || "qwen3.7-plus",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: prompt },
          ...imageUrls.slice(0, MAX_PRODUCT_IMAGES).map((url) => ({
            type: "image_url",
            image_url: { url },
            max_pixels: MAX_IMAGE_PIXELS,
          })),
        ],
      }],
      response_format: { type: "json_object" },
      enable_thinking: false,
      max_tokens: 1_800,
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) return null;
  return parseJsonLoose<Partial<ParsedProductInfo>>(readTextFromModelResponse(await response.json() as Record<string, unknown>));
}

async function qwenSearchVisualExtract(prompt: string) {
  const qwen = getProviderConfig("qwen");
  if (!qwen.enabled || !qwen.apiKey) return null;
  const response = await fetchOpenAI(`${qwen.baseUrl.replace(/\/$/, "")}/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${qwen.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: qwen.model || "qwen3.7-plus",
      input: prompt,
      tools: [{ type: "web_search_image" }],
      enable_thinking: false,
      max_output_tokens: 1_800,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) return null;
  const payload = await response.json() as Record<string, unknown>;
  const imageUrls: string[] = [];
  let usedImageSearch = false;
  for (const item of Array.isArray(payload.output) ? payload.output : []) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.type !== "web_search_image_call" || record.status !== "completed") continue;
    usedImageSearch = true;
    try {
      const images = typeof record.output === "string" ? JSON.parse(record.output) : record.output;
      if (!Array.isArray(images)) continue;
      for (const image of images) {
        if (!image || typeof image !== "object") continue;
        const url = clean((image as Record<string, unknown>).url);
        if (/^https?:\/\//i.test(url) && !imageUrls.includes(url)) imageUrls.push(url);
        if (imageUrls.length >= MAX_PRODUCT_IMAGES) break;
      }
    } catch {
      // The model can still use image search even when its tool payload is not JSON.
    }
  }
  return {
    parsed: parseJsonLoose<Partial<ParsedProductInfo>>(readTextFromModelResponse(payload)),
    imageUrls,
    usedImageSearch,
  };
}

async function openAiExtract(prompt: string) {
  try {
    const config = requireProvider("openai");
    const response = await fetchOpenAI(`${config.baseUrl}/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.model || "gpt-4.1-mini",
        input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
        text: { format: { type: "json_schema", name: "product_info", strict: true, schema } },
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) return null;
    return parseJsonLoose<Partial<ParsedProductInfo>>(readTextFromModelResponse(await response.json() as Record<string, unknown>));
  } catch {
    return null;
  }
}

export async function parsePublicProductPage(
  productUrl: string,
  hints: ProductParseHints = {},
): Promise<ParsedProductInfo> {
  const page = await readProductPage(productUrl);
  const base = baseInfo(page.title, page.description, hints, page.imageUrls);
  const searchMode = !page.text;
  const visualMode = searchMode ? "search" : page.imageUrls.length ? "direct" : "none";
  const productId = hints.pid || extractProductIdFromUrl(productUrl);
  const prompt = extractionPrompt({
    productUrl,
    hints: { ...hints, pid: productId },
    title: page.title,
    description: page.description,
    pageText: page.text,
    visualMode,
  });

  // One model call when the page or an exact product image is available. When
  // image search cannot verify this exact product, use one cheap text-only
  // fallback instead of keeping details inferred from similar products.
  const searchResult = searchMode ? await qwenSearchVisualExtract(prompt).catch(() => null) : null;
  if (searchResult?.imageUrls.length) base.sourceImageUrls = searchResult.imageUrls;
  let parsed = searchMode
    ? searchResult?.parsed || null
    : page.imageUrls.length
      ? await qwenVisualExtract(prompt, page.imageUrls).catch(() => null)
      : await qwenExtract(prompt).catch(() => null);
  let normalized = parsed ? normalizeParsed(parsed, base, productId) : null;
  let visualAnalysisStatus: ParsedProductInfo["visualAnalysisStatus"] = normalized
    && hasUsableProductInfo(normalized)
    && hasReliableVisualEvidence(normalized.visualEvidence)
    && (searchMode ? searchResult?.usedImageSearch : page.imageUrls.length)
    ? "completed"
    : "unavailable";

  // Search results may contain visually similar but unrelated products. If
  // Qwen cannot tie an image back to this PID/product, discard all image-based
  // details and generate only conservative category-level copy.
  const fallbackPrompt = searchMode ? categoryFallbackPrompt(productUrl, hints) : prompt;
  if (searchMode && visualAnalysisStatus !== "completed") {
    base.sourceImageUrls = [];
    parsed = await qwenExtract(fallbackPrompt).catch(() => null);
    normalized = parsed ? normalizeParsed(parsed, base, productId) : null;
    if (normalized) {
      normalized = {
        ...normalized,
        sku: "页面未说明",
        productParameters: "页面未说明",
        sourceImageUrls: [],
        visualEvidence: "页面未说明",
      };
    }
    visualAnalysisStatus = "unavailable";
  } else if (!normalized || !hasUsableProductInfo(normalized)) {
    parsed = await qwenExtract(prompt).catch(() => null);
    normalized = parsed ? normalizeParsed(parsed, base, productId) : null;
  }

  // OpenAI is only a failure fallback, not part of the ordinary token spend.
  if (!normalized || !hasUsableProductInfo(normalized)) {
    parsed = await openAiExtract(fallbackPrompt);
    normalized = parsed ? normalizeParsed(parsed, base, productId) : normalized;
    if (searchMode && normalized) {
      normalized = {
        ...normalized,
        sku: "页面未说明",
        productParameters: "页面未说明",
        sourceImageUrls: [],
        visualEvidence: "页面未说明",
      };
    }
    visualAnalysisStatus = "unavailable";
  }

  if (!normalized || !hasUsableProductInfo(normalized)) {
    throw new Error(`商品资料解析失败：${page.error || "AI 没有返回足够的可用资料"}`);
  }
  return { ...normalized, visualAnalysisStatus };
}
