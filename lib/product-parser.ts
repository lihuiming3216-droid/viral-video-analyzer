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

function fallback(title: string, description: string, text: string): ParsedProductInfo {
  const source = `${title} ${description} ${text}`;
  const functions = [...new Set((source.match(/\b(?:FHD|1080P|144Hz|60Hz|IPS|HDR|103% sRGB|portable|便携|高清|高刷新率)\b/gi) || []).map(clean))].slice(0, 5);
  return {
    productName: title,
    sku: "",
    coreFunctions: functions,
    productParameters: description || title,
    usageMethod: "连接对应设备后，按照产品说明完成设置并使用。",
    audience: "需要便携使用或扩展设备功能的用户。",
    scenes: "家庭、办公、出差和户外使用。",
    sellingPoints: [title, ...functions].filter(Boolean).join("；"),
    sourceTitle: title,
    sourceDescription: description,
  };
}

export async function parsePublicProductPage(productUrl: string): Promise<ParsedProductInfo> {
  const response = await fetchOpenAI(productUrl, {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36" },
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`商品页读取失败（${response.status}）`);
  const html = await response.text();
  const title = meta(html, "og:title") || clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
  const description = meta(html, "og:description") || meta(html, "description");
  // Product pages often contain duplicated tracking/variant markup. Sending
  // all of it to the model adds cost without improving the extracted fields.
  const text = htmlText(html).slice(0, 8_000);
  const base = fallback(title, description, text);

  const prompt = `请从以下 TikTok Shop 公开商品页资料中整理产品资料。不要臆造页面没有提供的精确参数；不确定时写“页面未说明”。核心功能按重要程度输出最多5条，并在每条前加 A、B、C、D 或 E。

标题：${title}
描述：${description}
页面文本：${text}`;
  const parseResponse = (payload: Record<string, unknown>) => {
    const parsed = parseJsonLoose<Partial<ParsedProductInfo>>(readTextFromModelResponse(payload));
    return {
      ...base,
      sku: clean(parsed.sku),
      coreFunctions: (parsed.coreFunctions || base.coreFunctions).map(clean).filter(Boolean).slice(0, 5),
      productParameters: clean(parsed.productParameters) || base.productParameters,
      usageMethod: clean(parsed.usageMethod) || base.usageMethod,
      audience: clean(parsed.audience) || base.audience,
      scenes: clean(parsed.scenes) || base.scenes,
      sellingPoints: clean(parsed.sellingPoints) || base.sellingPoints,
    };
  };

  try {
    const qwen = getProviderConfig("qwen");
    if (qwen.enabled && qwen.apiKey) {
      const response = await fetch(`${qwen.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${qwen.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: qwen.model || "qwen3.7-plus",
          messages: [{ role: "user", content: `${prompt}\n只返回合法 JSON，不要使用 Markdown 代码块。` }],
          response_format: { type: "json_object" },
          enable_thinking: false,
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (response.ok) return parseResponse(await response.json() as Record<string, unknown>);
    }
  } catch {
    // Fall through to the optional OpenAI fallback.
  }

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
    if (!response.ok) return base;
    const payload = await response.json() as Record<string, unknown>;
    return parseResponse(payload);
  } catch {
    return base;
  }
}
