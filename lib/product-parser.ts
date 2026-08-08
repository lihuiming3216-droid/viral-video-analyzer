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
  required: ["sku", "coreFunctions", "productParameters", "usageMethod", "audience", "scenes", "sellingPoints"],
  properties: {
    sku: { type: "string" },
    coreFunctions: { type: "array", items: { type: "string" }, maxItems: 5 },
    productParameters: { type: "string" },
    usageMethod: { type: "string" },
    audience: { type: "string" },
    scenes: { type: "string" },
    sellingPoints: { type: "string" },
  },
} as const;

function clean(value: unknown) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function cleanFunction(value: unknown) {
  return clean(value).replace(/^[A-EＡ-Ｅ]\s*[.．、:：]\s*/i, "");
}

function useful(value: unknown) {
  const normalized = clean(value);
  return Boolean(normalized && !/^(?:页面|网页|商品页)?(?:暂未|未)(?:提供|说明|展示|找到)|^不确定$|^未知$/i.test(normalized));
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

function meta(html: string, key: string) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["']`, "i"));
  return clean(match?.[1]);
}

function baseInfo(title: string, description: string, hints: ProductParseHints): ParsedProductInfo {
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
  };
}

function parsedValue(parsed: Partial<ParsedProductInfo>, aliases: string[]) {
  const record = parsed as Record<string, unknown>;
  for (const key of aliases) {
    if (record[key] != null) return record[key];
  }
  return undefined;
}

function normalizeParsed(parsed: Partial<ParsedProductInfo>, base: ParsedProductInfo): ParsedProductInfo {
  const rawFunctions = parsedValue(parsed, ["coreFunctions", "核心功能", "核心功能（按重要程度）"]);
  const functions = Array.isArray(rawFunctions)
    ? rawFunctions
    : String(rawFunctions || "").split(/[；;\n]+/);
  return {
    ...base,
    sku: clean(parsedValue(parsed, ["sku", "SKU", "产品SKU"])) || "页面未说明",
    coreFunctions: [...new Set(functions.map(cleanFunction).filter(Boolean))].slice(0, 5),
    productParameters: clean(parsedValue(parsed, ["productParameters", "产品参数"])) || base.productParameters || "页面未说明",
    usageMethod: clean(parsedValue(parsed, ["usageMethod", "使用方法"])),
    audience: clean(parsedValue(parsed, ["audience", "适用人群", "目标人群"])),
    scenes: clean(parsedValue(parsed, ["scenes", "使用场景", "适用场景"])),
    sellingPoints: clean(parsedValue(parsed, ["sellingPoints", "产品卖点", "卖点"])),
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
    if (!response.ok) return { title: "", description: "", text: "", error: `HTTP ${response.status}` };
    const html = await response.text();
    const title = meta(html, "og:title") || clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
    const description = meta(html, "og:description") || meta(html, "description");
    const text = htmlText(html).slice(0, 8_000);
    const blocked = /captcha|verify to continue|access denied|登录后继续|安全验证/i.test(`${title} ${description} ${text.slice(0, 1_000)}`);
    if (blocked || (!title && !description && text.length < 300)) {
      return { title, description, text: "", error: blocked ? "商品页要求验证" : "商品页没有公开资料" };
    }
    return { title, description, text, error: "" };
  } catch (error) {
    return { title: "", description: "", text: "", error: error instanceof Error ? error.message : "fetch failed" };
  }
}

function extractionPrompt(input: {
  productUrl: string;
  hints: ProductParseHints;
  title: string;
  description: string;
  pageText: string;
  searchMode: boolean;
}) {
  const identity = `团队中文名称：${clean(input.hints.productName) || "未提供"}\n商品 PID：${clean(input.hints.pid) || extractProductIdFromUrl(input.productUrl) || "未提供"}\n商品链接：${input.productUrl}`;
  const evidence = input.searchMode
    ? `阿里云服务器无法直连商品页。请联网搜索上述 PID、商品链接和产品名称，优先采用 TikTok 商品页、商家页及同一 PID 的公开资料。`
    : `页面标题：${input.title}\n页面描述：${input.description}\n页面正文：${input.pageText}`;
  return `你在整理 TikTok Shop 产品手卡。\n${identity}\n${evidence}\n\n请输出以下字段：SKU、3至5条核心功能、产品参数、使用方法、适用人群、使用场景、产品卖点。核心功能按重要程度排序，但内容中不要写 A/B/C/D/E 前缀。不得编造精确尺寸、功率、材质、兼容型号或认证；公开资料没有精确参数时，产品参数写“页面未说明”，其他字段可以根据已确认的产品品类进行保守归纳。产品卖点要具体、便于短视频拍摄，不写治疗、预防或控制疾病等违规功效。只返回合法 JSON，不要使用 Markdown 代码块。JSON 键名必须严格使用以下英文键：{"sku":"","coreFunctions":[""],"productParameters":"","usageMethod":"","audience":"","scenes":"","sellingPoints":""}。`;
}

async function qwenExtract(prompt: string, enableSearch: boolean) {
  const qwen = getProviderConfig("qwen");
  if (!qwen.enabled || !qwen.apiKey) return null;
  const response = await fetch(`${qwen.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${qwen.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: qwen.model || "qwen-plus",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      enable_thinking: false,
      ...(enableSearch ? {
        enable_search: true,
        search_options: { forced_search: true, enable_source: false },
      } : {}),
    }),
    signal: AbortSignal.timeout(enableSearch ? 90_000 : 60_000),
  });
  if (!response.ok) return null;
  return parseJsonLoose<Partial<ParsedProductInfo>>(readTextFromModelResponse(await response.json() as Record<string, unknown>));
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
  const base = baseInfo(page.title, page.description, hints);
  const searchMode = !page.text;
  const prompt = extractionPrompt({
    productUrl,
    hints: { ...hints, pid: hints.pid || extractProductIdFromUrl(productUrl) },
    title: page.title,
    description: page.description,
    pageText: page.text,
    searchMode,
  });

  // One model call in the normal path: page extraction when reachable, or
  // Qwen web search when the mainland server cannot reach TikTok directly.
  let parsed = await qwenExtract(prompt, searchMode).catch(() => null);
  let normalized = parsed ? normalizeParsed(parsed, base) : null;

  // Some Qwen model variants may not accept web-search parameters. Retry once
  // without search so a category-level card can still be produced from the
  // team's Chinese product name, while keeping exact unknown parameters honest.
  if (searchMode && (!normalized || !hasUsableProductInfo(normalized))) {
    parsed = await qwenExtract(prompt, false).catch(() => null);
    normalized = parsed ? normalizeParsed(parsed, base) : null;
  }

  // OpenAI is only a failure fallback, not part of the ordinary token spend.
  if (!normalized || !hasUsableProductInfo(normalized)) {
    parsed = await openAiExtract(prompt);
    normalized = parsed ? normalizeParsed(parsed, base) : normalized;
  }

  if (!normalized || !hasUsableProductInfo(normalized)) {
    throw new Error(`商品资料解析失败：${page.error || "AI 没有返回足够的可用资料"}`);
  }
  return normalized;
}
