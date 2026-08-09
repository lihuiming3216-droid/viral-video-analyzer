import "server-only";

import { fetchOpenAI } from "@/lib/network";
import { getProviderConfig, requireProvider } from "@/lib/provider-config";
import { parseJsonLoose, readTextFromModelResponse } from "@/lib/json-utils";
import { canonicalTikTokProductUrl, tiktokProductFetchUrls } from "@/lib/tiktok-product";

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

type ProductEvidenceQuotes = {
  sku?: string[];
  coreFunctions?: string[];
  productParameters?: string[];
  usageMethod?: string[];
  audience?: string[];
  scenes?: string[];
};

type ParsedProductModel = Partial<ParsedProductInfo> & {
  evidenceQuotes?: ProductEvidenceQuotes;
};

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
  required: ["sourceTitle", "sourceDescription", "sku", "coreFunctions", "productParameters", "usageMethod", "audience", "scenes", "sellingPoints", "visualEvidence", "evidenceQuotes"],
  properties: {
    sourceTitle: { type: "string" },
    sourceDescription: { type: "string" },
    sku: { type: "string" },
    coreFunctions: { type: "array", items: { type: "string" }, maxItems: 5 },
    productParameters: { type: "string" },
    usageMethod: { type: "string" },
    audience: { type: "string" },
    scenes: { type: "string" },
    sellingPoints: { type: "string" },
    visualEvidence: { type: "string" },
    evidenceQuotes: {
      type: "object",
      additionalProperties: false,
      required: ["sku", "coreFunctions", "productParameters", "usageMethod", "audience", "scenes"],
      properties: {
        sku: { type: "array", items: { type: "string" } },
        coreFunctions: { type: "array", items: { type: "string" }, maxItems: 5 },
        productParameters: { type: "array", items: { type: "string" } },
        usageMethod: { type: "array", items: { type: "string" } },
        audience: { type: "array", items: { type: "string" } },
        scenes: { type: "array", items: { type: "string" } },
      },
    },
  },
} as const;

const MAX_PRODUCT_IMAGES = 4;
const MAX_IMAGE_PIXELS = 768 * 768;

function clean(value: unknown) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function cleanFieldValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(cleanFieldValue).filter(Boolean).join("；");
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => {
        const normalized = cleanFieldValue(item);
        return normalized ? `${clean(key)}：${normalized}` : "";
      })
      .filter(Boolean)
      .join("；");
  }
  return clean(value);
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
  sourceTitle?: string;
  sourceDescription?: string;
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
  const hasSourceEvidence = useful(info.sourceTitle) || useful(info.sourceDescription);
  return hasSourceEvidence && functions.length >= 1 && descriptiveFields.length >= 2;
}

function explicitBundleCount(evidenceText: string) {
  const matches = [
    ...evidenceText.matchAll(/\b([2-9])\s*[-‑–]?in[-‑–]?1\b/gi),
    ...evidenceText.matchAll(/\b([2-9])\s+things?\s+in\s+one\b/gi),
  ];
  return Math.max(0, ...matches.map((match) => Number(match[1]) || 0));
}

function enumeratedBundleFeatures(evidenceText: string) {
  const bundleCount = explicitBundleCount(evidenceText);
  if (bundleCount < 2) return [];
  const expected = Math.min(5, bundleCount);
  const patterns = [
    new RegExp(`\\b${bundleCount}\\s+things?\\s+in\\s+one\\s*:\\s*([^\\n\\r]+)`, "i"),
    new RegExp(`\\b${bundleCount}\\s*[-‑–]?in[-‑–]?1(?:\\s+[a-z]+){0,3}\\s*:\\s*([^\\n\\r]+)`, "i"),
  ];
  for (const pattern of patterns) {
    const segment = clean(evidenceText.match(pattern)?.[1]).split(/\.(?:\s|$)/)[0];
    const features = segment
      .split(/\s*(?:\/|\+|\||•|;)\s*/)
      .map((item) => clean(item).replace(/[.,:]+$/g, ""))
      .filter(Boolean);
    if (features.length >= expected) return features.slice(0, expected);
  }
  return [];
}

function numericSpecificationCount(evidenceText: string) {
  const matches = evidenceText.match(/\b\d+(?:\.\d+)?\s*(?:mAh|W|V|mmHg|mm|cm|kg|g|inch(?:es)?|ft|Gbps|Mbps|x)\b/gi) || [];
  return new Set(matches.map((item) => item.toLowerCase().replace(/\s+/g, ""))).size;
}

function needsCompletenessRetry(info: ParsedProductInfo | null, evidenceText: string) {
  if (!info || !hasUsableProductInfo(info)) return true;
  const expectedFunctions = Math.min(5, explicitBundleCount(evidenceText));
  if (expectedFunctions && info.coreFunctions.length < expectedFunctions) return true;
  return numericSpecificationCount(evidenceText) >= 2 && !useful(info.productParameters);
}

function productInfoScore(info: ParsedProductInfo | null) {
  if (!info) return -1;
  return info.coreFunctions.length * 5
    + (useful(info.productParameters) ? 4 : 0)
    + (useful(info.usageMethod) ? 3 : 0)
    + (useful(info.audience) ? 2 : 0)
    + (useful(info.scenes) ? 2 : 0)
    + (useful(info.sku) ? 1 : 0);
}

function preferMoreCompleteProductInfo(current: ParsedProductInfo | null, candidate: ParsedProductInfo | null) {
  if (!current) return candidate;
  if (!candidate) return current;
  const preferred = productInfoScore(candidate) > productInfoScore(current) ? candidate : current;
  const moreDetailed = (left: string, right: string) => {
    if (!useful(left)) return right;
    if (!useful(right)) return left;
    return clean(left).length >= clean(right).length ? left : right;
  };
  return {
    ...preferred,
    sku: moreDetailed(current.sku, candidate.sku),
    coreFunctions: current.coreFunctions.length >= candidate.coreFunctions.length
      ? current.coreFunctions
      : candidate.coreFunctions,
    productParameters: moreDetailed(current.productParameters, candidate.productParameters),
    usageMethod: moreDetailed(current.usageMethod, candidate.usageMethod),
    audience: moreDetailed(current.audience, candidate.audience),
    scenes: moreDetailed(current.scenes, candidate.scenes),
    visualEvidence: hasReliableVisualEvidence(current.visualEvidence)
      ? current.visualEvidence
      : candidate.visualEvidence,
  };
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

function baseInfo(
  title: string,
  description: string,
  hints: ProductParseHints,
  sourceImageUrls: string[],
  sku = "",
): ParsedProductInfo {
  return {
    productName: clean(hints.productName) || title,
    sku,
    coreFunctions: [],
    productParameters: "",
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

function evidenceList(parsed: ParsedProductModel, field: keyof ProductEvidenceQuotes) {
  const quotes = parsed.evidenceQuotes?.[field];
  return Array.isArray(quotes) ? quotes.map(clean).filter(Boolean) : [];
}

function quotesExistInSource(quotes: string[], sourceText: string) {
  const source = clean(sourceText).toLowerCase();
  return Boolean(quotes.length) && quotes.every((quote) => source.includes(clean(quote).toLowerCase()));
}

function normalizeParsed(
  parsed: ParsedProductModel,
  base: ParsedProductInfo,
  productId: string,
  evidenceText: string,
): ParsedProductInfo {
  const rawFunctions = parsedValue(parsed, ["coreFunctions", "核心功能", "核心功能（按重要程度）"]);
  const functions = Array.isArray(rawFunctions)
    ? rawFunctions
    : String(rawFunctions || "").split(/[；;\n]+/);
  const rawSku = clean(parsedValue(parsed, ["sku", "SKU", "产品SKU"]));
  const skuWithoutLabel = rawSku.replace(/^(?:SKU|PID|商品ID|产品ID)\s*[:：#-]?\s*/i, "");
  const sourceTitle = base.sourceTitle || clean(parsedValue(parsed, ["sourceTitle", "title", "页面标题"]));
  const sourceDescription = base.sourceDescription || clean(parsedValue(parsed, ["sourceDescription", "description", "页面描述"]));
  const source = evidenceText || `${sourceTitle}\n${sourceDescription}`;
  const supportedFunctions = functions
    .map((value, index) => ({ value: cleanFunction(value), quote: evidenceList(parsed, "coreFunctions")[index] || "" }))
    .filter((item) => /[\u3400-\u9fff]/.test(item.value) && quotesExistInSource([item.quote], source))
    .map((item) => item.value);
  const supportedString = (value: unknown, field: keyof ProductEvidenceQuotes) => {
    const normalized = cleanFieldValue(value);
    return /[\u3400-\u9fff]/.test(normalized) && quotesExistInSource(evidenceList(parsed, field), source) ? normalized : "";
  };
  return {
    ...base,
    sourceTitle,
    sourceDescription,
    sku: base.sku || (rawSku && skuWithoutLabel !== clean(productId) && quotesExistInSource(evidenceList(parsed, "sku"), source) ? rawSku : ""),
    coreFunctions: [...new Set(supportedFunctions)].slice(0, 5),
    productParameters: supportedString(parsedValue(parsed, ["productParameters", "产品参数"]), "productParameters") || base.productParameters,
    usageMethod: supportedString(parsedValue(parsed, ["usageMethod", "使用方法"]), "usageMethod"),
    audience: supportedString(parsedValue(parsed, ["audience", "适用人群", "目标人群"]), "audience"),
    scenes: supportedString(parsedValue(parsed, ["scenes", "使用场景", "适用场景"]), "scenes"),
    // 产品卖点暂不由 AI 生成，避免把品类常识包装成未经证实的商品卖点。
    sellingPoints: "",
    visualEvidence: clean(parsedValue(parsed, ["visualEvidence", "图片证据", "视觉证据", "图片分析"])),
  };
}

type ProductPageResult = {
  title: string;
  description: string;
  text: string;
  imageUrls: string[];
  sku: string;
  error: string;
};

function embeddedJson(html: string, id: string) {
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (attribute(match[1], "id") !== id) continue;
    try {
      return JSON.parse(match[2].trim()) as unknown;
    } catch {
      return null;
    }
  }
  return null;
}

function productModelFromRouterData(routerData: unknown, productId: string) {
  const models: Array<Record<string, unknown>> = [];
  const stack: unknown[] = [routerData];
  while (stack.length) {
    const value = stack.pop();
    if (Array.isArray(value)) {
      stack.push(...value);
      continue;
    }
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    const model = record.product_model;
    if (model && typeof model === "object") {
      const candidate = model as Record<string, unknown>;
      if (!productId || clean(candidate.product_id) === productId) models.push(candidate);
    }
    stack.push(...Object.values(record));
  }
  return models.sort((a, b) => {
    const score = (item: Record<string, unknown>) => ["name", "description", "images", "skus", "product_properties"]
      .filter((key) => item[key] != null).length;
    return score(b) - score(a);
  })[0] || null;
}

function descriptionEvidence(value: unknown) {
  let parsed = value;
  if (typeof parsed === "string" && /^[\s]*[\[{]/.test(parsed)) {
    try { parsed = JSON.parse(parsed); } catch { return { texts: [clean(parsed)], imageUrls: [] }; }
  }
  const texts: string[] = [];
  const imageUrls: string[] = [];
  const stack: unknown[] = [parsed];
  while (stack.length) {
    const item = stack.pop();
    if (Array.isArray(item)) {
      stack.push(...[...item].reverse());
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const content = clean(record.text || record.t);
    if (content && !texts.includes(content)) texts.push(content);
    const image = record.image;
    if (image && typeof image === "object") {
      const raw = Array.isArray((image as Record<string, unknown>).url_list)
        ? ((image as Record<string, unknown>).url_list as unknown[])[0]
        : "";
      const url = clean(raw);
      if (/^https?:\/\//i.test(url) && !imageUrls.includes(url)) imageUrls.push(url);
    }
    stack.push(...Object.values(record));
  }
  return { texts, imageUrls };
}

function structuredProductEvidence(html: string, productUrl: string) {
  const productId = extractProductIdFromUrl(productUrl);
  const model = productModelFromRouterData(embeddedJson(html, "__MODERN_ROUTER_DATA__"), productId);
  if (!model || clean(model.product_id) !== productId || !clean(model.name)) return null;

  const description = descriptionEvidence(model.description);
  const properties = (Array.isArray(model.product_properties) ? model.product_properties : [])
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const property = item as Record<string, unknown>;
      const propertyName = clean(property.property_name);
      if (/(?:CA Prop|Aerosol|Dangerous|Hazardous|Magnetic Field|Country of origin|Batter(?:y|ies)|Cells?\?)/i.test(propertyName)) return "";
      const values = (Array.isArray(property.property_values) ? property.property_values : [])
        .map((value) => value && typeof value === "object" ? clean((value as Record<string, unknown>).property_value_name) : "")
        .filter(Boolean);
      return values.length ? `${propertyName}：${values.join("、")}` : "";
    })
    .filter(Boolean);
  const skus = (Array.isArray(model.skus) ? model.skus : [])
    .map((item) => item && typeof item === "object" ? clean((item as Record<string, unknown>).sku_name) : "")
    .filter((value, index, all) => Boolean(value) && all.indexOf(value) === index);
  const imageUrls = [
    ...(Array.isArray(model.images) ? model.images : []).flatMap((image) => {
      if (!image || typeof image !== "object") return [];
      const urls = (image as Record<string, unknown>).url_list;
      return Array.isArray(urls) && urls.length ? [clean(urls[0])] : [];
    }),
    ...description.imageUrls,
  ].filter((url, index, all) => /^https?:\/\//i.test(url) && all.indexOf(url) === index);
  const title = clean(model.name);
  const detail = description.texts.join("\n").slice(0, 7_000);
  const propertyText = properties.join("\n").slice(0, 3_000);
  return {
    title,
    description: detail,
    text: [`商品标题：${title}`, detail && `商品详情：\n${detail}`, propertyText && `商品属性：\n${propertyText}`, skus.length && `SKU：${skus.join("；")}`]
      .filter(Boolean)
      .join("\n")
      .slice(0, 11_000),
    imageUrls: imageUrls.slice(0, MAX_PRODUCT_IMAGES),
    sku: skus.join("；"),
  };
}

async function readProductPage(productUrl: string): Promise<ProductPageResult> {
  let lastError = "商品页没有公开资料";
  for (const [index, fetchUrl] of tiktokProductFetchUrls(productUrl).entries()) {
    try {
      const response = await fetchOpenAI(fetchUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(index === 0 ? 20_000 : 10_000),
      });
      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
        continue;
      }
      const html = await response.text();
      const title = meta(html, "og:title") || clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
      const metaDescription = meta(html, "og:description") || meta(html, "description");
      const visibleText = htmlText(html).slice(0, 8_000);
      const blocked = /captcha|verify to continue|access denied|security check|登录后继续|安全验证/i
        .test(`${title} ${metaDescription} ${visibleText.slice(0, 1_000)}`);
      if (blocked) {
        lastError = "商品页要求安全验证";
        continue;
      }
      const structured = structuredProductEvidence(html, productUrl);
      if (structured) return { ...structured, error: "" };
      if (title || metaDescription || visibleText.length >= 300) {
        return {
          title,
          description: metaDescription,
          text: visibleText,
          imageUrls: extractProductImageUrls(html, productUrl),
          sku: "",
          error: "",
        };
      }
      lastError = "商品页没有公开资料";
    } catch (error) {
      lastError = error instanceof Error ? error.message : "fetch failed";
    }
  }
  return { title: "", description: "", text: "", imageUrls: [], sku: "", error: lastError };
}

function extractionPrompt(input: {
  productUrl: string;
  hints: ProductParseHints;
  title: string;
  description: string;
  pageText: string;
  visualMode: "direct" | "search" | "none";
}) {
  const identity = `团队中文名称（仅用于文档标题，不是产品事实证据）：${clean(input.hints.productName) || "未提供"}\n商品 PID：${clean(input.hints.pid) || extractProductIdFromUrl(input.productUrl) || "未提供"}\n商品链接：${input.productUrl}`;
  const evidence = input.visualMode === "search"
    ? "请只使用联网搜索中 URL 与上述 TikTok Shop 商品链接完全对应（可忽略查询参数）的结果。其他商品、同品类页面和团队中文名都不是证据。"
    : `页面标题：${input.title}\n页面描述：${input.description}\n页面正文：${input.pageText}`;
  const visualInstruction = input.visualMode === "direct"
    ? "下方会附带商品图片。必须结合图片确认产品外观结构、接口/按键、随附配件、可见文字和使用方式，并把这些可靠信息融入各字段。"
    : input.visualMode === "search"
      ? "当前没有经过 PID 校验的商品图片，visualEvidence 必须留空，不得用相似商品图片推断。"
      : "当前没有可靠商品图片，只能根据公开文字资料整理。";
  const bundleCount = explicitBundleCount(input.pageText);
  const bundleOutputCount = Math.min(5, bundleCount);
  const bundleInstruction = bundleCount
    ? bundleCount <= 5
      ? `本页文字明确列出 ${bundleCount}-in-1 功能清单，因此 coreFunctions 必须恰好返回 ${bundleOutputCount} 条，逐项覆盖清单，不得遗漏、合并或只移到其他字段。`
      : `本页文字明确列出 ${bundleCount}-in-1 组合功能；受字段上限影响，coreFunctions 必须返回其中最重要且有原文证据的 ${bundleOutputCount} 条。`
    : "若页面明确写有 N-in-1 或 N things in one 并逐项列出功能，coreFunctions 必须逐项覆盖清单中的每一项（最多5项），不得省略，也不得只把某项放入产品参数。";
  return `你在整理 TikTok Shop 产品手卡。\n${identity}\n${evidence}\n${visualInstruction}\n\n只能把上述页面文字中明确出现的信息翻译、归纳成中文。不得使用常识补齐，不得根据团队中文名推断，不得把相似商品的功能写进来。商品图片只用于 visualEvidence，不得用来扩写 coreFunctions、productParameters、usageMethod、audience 或 scenes。某字段没有直接文字证据时必须返回空字符串或空数组。请输出：页面原始标题 sourceTitle、页面原始描述 sourceDescription、真实 SKU、1至5条产品主要功能、产品参数、使用方法、适用人群、使用场景，以及简短图片证据 visualEvidence。除 sourceTitle、sourceDescription 和 evidenceQuotes 保留英文原文外，其余所有字段值必须使用中文。产品主要功能按重要程度排序，每项只表达一个有证据的功能，不要写 A/B/C/D/E 前缀；页面有足够证据时应整理3至5项。${bundleInstruction}productParameters、usageMethod、audience、scenes 必须返回字符串，不得返回对象或数组；多项用中文分号分隔。产品参数只保留3至8项与购买或使用直接相关的信息，忽略合规声明、危险品声明和无意义的否定属性。SKU 不得填写 PID 或商品ID。精确尺寸、功率、材质、兼容型号、认证和包装数量必须能在证据中找到；页面文字与图片冲突时省略该字段，不要添加冲突说明。sellingPoints 暂不生成，必须返回空字符串。evidenceQuotes 必须为每个输出字段提供页面英文原文逐字短引文：coreFunctions 与引文数组按下标一一对应，其余字段列出支持其中每个事实的引文；中文值必须只是引文的直接翻译或压缩，不得扩大含义。只返回合法 JSON，不要使用 Markdown 代码块。JSON 键名必须严格使用：{"sourceTitle":"","sourceDescription":"","sku":"","coreFunctions":[""],"productParameters":"","usageMethod":"","audience":"","scenes":"","sellingPoints":"","visualEvidence":"","evidenceQuotes":{"sku":[""],"coreFunctions":[""],"productParameters":[""],"usageMethod":[""],"audience":[""],"scenes":[""]}}。`;
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
      temperature: 0,
      max_tokens: 1_800,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) return null;
  return parseJsonLoose<ParsedProductModel>(readTextFromModelResponse(await response.json() as Record<string, unknown>));
}

async function qwenTranslateBundleFeatures(features: string[]) {
  const qwen = getProviderConfig("qwen");
  if (!qwen.enabled || !qwen.apiKey || !features.length) return [];
  const response = await fetchOpenAI(`${qwen.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${qwen.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: qwen.model || "qwen-plus",
      messages: [{
        role: "user",
        content: `把下面 ${features.length} 个英文商品功能逐项直译为简洁中文。必须保持原顺序和原数量，不得合并、扩写或补充。只返回 JSON：{"features":[""]}。输入：${JSON.stringify(features)}`,
      }],
      response_format: { type: "json_object" },
      enable_thinking: false,
      temperature: 0,
      max_tokens: 400,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) return [];
  const parsed = parseJsonLoose<{ features?: unknown }>(readTextFromModelResponse(await response.json() as Record<string, unknown>));
  const translated = Array.isArray(parsed?.features)
    ? parsed.features.map(cleanFunction).filter((item) => /[\u3400-\u9fff]/.test(item))
    : [];
  return translated.length === features.length ? translated : [];
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
      temperature: 0,
      max_tokens: 1_800,
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) return null;
  return parseJsonLoose<ParsedProductModel>(readTextFromModelResponse(await response.json() as Record<string, unknown>));
}

async function qwenWebSearchExtract(prompt: string, productUrl: string) {
  const qwen = getProviderConfig("qwen");
  if (!qwen.enabled || !qwen.apiKey) return null;
  const response = await fetchOpenAI(`${qwen.baseUrl.replace(/\/$/, "")}/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${qwen.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: qwen.model || "qwen3.7-plus",
      input: prompt,
      tools: [{ type: "web_search" }],
      enable_thinking: false,
      max_output_tokens: 1_200,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) return null;
  const payload = await response.json() as Record<string, unknown>;
  const productId = extractProductIdFromUrl(productUrl);
  let exactSourceMatched = false;
  for (const item of Array.isArray(payload.output) ? payload.output : []) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.type !== "web_search_call" || record.status !== "completed") continue;
    const action = record.action;
    if (!action || typeof action !== "object") continue;
    for (const source of Array.isArray((action as Record<string, unknown>).sources)
      ? (action as Record<string, unknown>).sources as unknown[]
      : []) {
      if (!source || typeof source !== "object") continue;
      const sourceUrl = clean((source as Record<string, unknown>).url);
      try {
        const parsed = new URL(sourceUrl);
        if (parsed.hostname === "shop.tiktok.com" && extractProductIdFromUrl(sourceUrl) === productId) {
          exactSourceMatched = true;
        }
      } catch {
        // Ignore malformed search-source URLs.
      }
    }
  }
  return {
    parsed: parseJsonLoose<ParsedProductModel>(readTextFromModelResponse(payload)),
    exactSourceMatched,
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
    return parseJsonLoose<ParsedProductModel>(readTextFromModelResponse(await response.json() as Record<string, unknown>));
  } catch {
    return null;
  }
}

export async function parsePublicProductPage(
  productUrl: string,
  hints: ProductParseHints = {},
): Promise<ParsedProductInfo> {
  const canonicalUrl = canonicalTikTokProductUrl(productUrl, hints.pid);
  const page = await readProductPage(canonicalUrl);
  const base = baseInfo(page.title, page.description, hints, page.imageUrls, page.sku);
  const searchMode = !page.text;
  const visualMode = searchMode ? "search" : page.imageUrls.length ? "direct" : "none";
  const productId = hints.pid || extractProductIdFromUrl(canonicalUrl);
  const prompt = extractionPrompt({
    productUrl: canonicalUrl,
    hints: { ...hints, pid: productId },
    title: page.title,
    description: page.description,
    pageText: page.text,
    visualMode,
  });

  // The exact public page is the primary evidence. On mainland ECS we read
  // TikTok's own origin host first; web search is only a strict last resort.
  const searchResult = searchMode ? await qwenWebSearchExtract(prompt, canonicalUrl).catch(() => null) : null;
  let parsed = searchMode
    ? searchResult?.exactSourceMatched ? searchResult.parsed : null
    : page.imageUrls.length
      ? await qwenVisualExtract(prompt, page.imageUrls).catch(() => null)
      : await qwenExtract(prompt).catch(() => null);
  let normalized = parsed ? normalizeParsed(parsed, base, productId, page.text) : null;
  let visualAnalysisStatus: ParsedProductInfo["visualAnalysisStatus"] = !searchMode
    && normalized
    && hasUsableProductInfo(normalized)
    && hasReliableVisualEvidence(normalized.visualEvidence)
    && page.imageUrls.length
    ? "completed"
    : "unavailable";

  if (!searchMode && needsCompletenessRetry(normalized, page.text)) {
    parsed = await qwenExtract(prompt).catch(() => null);
    const candidate = parsed ? normalizeParsed(parsed, base, productId, page.text) : null;
    normalized = preferMoreCompleteProductInfo(normalized, candidate);
  }

  // Explicit "N-in-1" lists are stronger than model summarization. If the
  // evidence contains a complete slash/plus-separated list, translate that
  // exact list with one small call so no verified function is silently lost.
  const bundleFeatures = searchMode ? [] : enumeratedBundleFeatures(page.text);
  if (normalized && bundleFeatures.length && normalized.coreFunctions.length < bundleFeatures.length) {
    const translated = await qwenTranslateBundleFeatures(bundleFeatures).catch(() => []);
    if (translated.length === bundleFeatures.length) normalized = { ...normalized, coreFunctions: translated };
  }

  // OpenAI may organize already-downloaded evidence, but it is never allowed
  // to invent a product from only a PID or the team's Chinese name.
  if (!searchMode && needsCompletenessRetry(normalized, page.text)) {
    parsed = await openAiExtract(prompt);
    const candidate = parsed ? normalizeParsed(parsed, base, productId, page.text) : null;
    normalized = preferMoreCompleteProductInfo(normalized, candidate);
  }

  if (!normalized || !hasUsableProductInfo(normalized)) {
    throw new Error(`商品资料解析失败：${page.error || (searchResult?.exactSourceMatched ? "AI 没有返回足够的可验证资料" : "没有找到与该 PID 完全匹配的公开商品页资料")}`);
  }
  if (searchMode) {
    normalized = { ...normalized, sourceImageUrls: [], visualEvidence: "" };
    visualAnalysisStatus = "unavailable";
  }
  return { ...normalized, sellingPoints: "", visualAnalysisStatus };
}
