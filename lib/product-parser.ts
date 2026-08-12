import "server-only";

import { existsSync } from "node:fs";
import { fetchWithProxy } from "@/lib/network";
import { getProviderConfig } from "@/lib/provider-config";
import { parseJsonLoose, readTextFromModelResponse } from "@/lib/json-utils";
import { tiktokProductFetchUrls } from "@/lib/tiktok-product";

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

const MAX_PRODUCT_IMAGES = 8;
const MAX_IMAGE_PIXELS = 768 * 768;

function clean(value: unknown) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

const PRODUCT_SECURITY_CHALLENGE = /(?:captcha|verify to continue|verify you are human|human verification|just a moment|access denied|security check|checking your browser|unusual traffic|登录后继续|安全验证|人机验证|请完成验证)/i;
const PRODUCT_ID_QUERY_KEYS = ["pid", "product_id", "productId", "item_id", "itemId"];

/** A challenge page is transport-successful HTML, but it is not product evidence. */
export function isProductSecurityChallenge(title: string, description = "", text = "") {
  return PRODUCT_SECURITY_CHALLENGE.test(`${clean(title)} ${clean(description)} ${clean(text).slice(0, 1_500)}`);
}

function officialTikTokProductPath(url: URL) {
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  if (url.hostname.toLowerCase() === "shop.tiktok.com") {
    const match = pathname.match(/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?pdp\/([^/]+)\/(\d{6,})$/i);
    return match ? { slug: match[1], pid: match[2] } : null;
  }
  if (url.hostname.toLowerCase() !== "www.tiktok.com") return null;
  const shopMatch = pathname.match(/^\/shop\/pdp\/([^/]+)\/(\d{6,})$/i);
  if (shopMatch) return { slug: shopMatch[1], pid: shopMatch[2] };
  const viewMatch = pathname.match(/^\/view\/product\/(\d{6,})$/i);
  return viewMatch ? { slug: "", pid: viewMatch[1] } : null;
}

export function productIdFromOfficialTikTokPath(sourceUrl: string) {
  try {
    return officialTikTokProductPath(new URL(sourceUrl))?.pid || "";
  } catch {
    return "";
  }
}

/**
 * Only an official TikTok product page with the exact requested PID can make
 * a web-search/model response eligible as product evidence.
 */
export function isExactTikTokProductSource(sourceUrl: string, productId: string) {
  const expectedPid = clean(productId);
  if (!/^\d{6,}$/.test(expectedPid)) return false;
  try {
    const url = new URL(sourceUrl);
    if (url.protocol !== "https:") return false;
    const productPath = officialTikTokProductPath(url);
    if (!productPath || productPath.pid !== expectedPid) return false;
    return PRODUCT_ID_QUERY_KEYS.every((key) => url.searchParams.getAll(key)
      .every((queryPid) => clean(queryPid) === expectedPid));
  } catch {
    return false;
  }
}

/** Decode only the verified PDP slug; query strings and model prose are never evidence. */
export function trustedProductPathEvidence(sourceUrl: string, productId: string) {
  if (!isExactTikTokProductSource(sourceUrl, productId)) return "";
  try {
    const productPath = officialTikTokProductPath(new URL(sourceUrl));
    if (!productPath?.slug) return "";
    const decoded = clean(decodeURIComponent(productPath.slug).replace(/[-_+]+/g, " "));
    // Never truncate a seller-controlled slug: doing so could discard a
    // trailing negation and turn the remaining prefix into a false claim.
    return decoded.length >= 4 && decoded.length <= 500 && /\p{L}/u.test(decoded) ? decoded : "";
  } catch {
    return "";
  }
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
}, minimumDescriptiveFields = 2) {
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
  return hasSourceEvidence && functions.length >= 1 && descriptiveFields.length >= minimumDescriptiveFields;
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

const NON_PRODUCT_SECTION = /(?:全球评价|客户评价|商品评价|买家评价|Reviews?|Ratings?|Coupon center|优惠券|运输和退货|发货和配送|退货|TikTok Shop 保障|About this shop|关于店铺|安全支付|配送保障|数据隐私|全天候应用内支持|退款保障)/i;

function productDetailText(value: string) {
  const text = value.replace(/\r/g, "\n");
  const startMarkers = ["商品描述", "产品描述", "Product description", "About this item"];
  const starts = startMarkers
    .map((marker) => text.toLowerCase().indexOf(marker.toLowerCase()))
    .filter((index) => index >= 0);
  const start = starts.length ? Math.min(...starts) : 0;
  const tail = text.slice(start);
  const endMatch = tail.match(NON_PRODUCT_SECTION);
  return clean(endMatch ? tail.slice(0, endMatch.index) : tail).slice(0, 18_000);
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
  productParameters = "",
): ParsedProductInfo {
  return {
    productName: clean(hints.productName) || title,
    sku,
    coreFunctions: [],
    productParameters,
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

function hasAffirmedSlugPhrase(evidence: string, phrase: RegExp) {
  const matcher = new RegExp(phrase.source, `${phrase.flags.replace(/g/g, "")}g`);
  let affirmed = false;
  for (const match of evidence.matchAll(matcher)) {
    const prefix = clean(evidence.slice(0, match.index))
      .toLowerCase()
      .replace(/[\s,;:()\[\]{}\/|–—-]+$/, "");
    const suffix = clean(evidence.slice((match.index || 0) + match[0].length))
      .toLowerCase()
      .replace(/^[\s,;:()\[\]{}\/|–—-]+/, "");
    const prefixNegated = /(?:^|\s)(?:no|non|anti|unsupported|disabled|unavailable)\s*$/.test(prefix)
      || /(?:^|\s)not(?:\s+(?:supported|included|available|enabled)|\s+at\s+all)?\s*$/.test(prefix)
      || /(?:^|\s)no\s+longer\s+(?:supported|included|available|enabled)\s*$/.test(prefix)
      || /(?:^|\s)(?:without|no)\s+support\s+for\s*$/.test(prefix)
      || /(?:^|\s)without(?:\s+support)?\s*$/.test(prefix);
    const suffixNegated = /^(?:is\s+)?(?:not\s+(?:supported|included|available|enabled)|no\s+longer\s+(?:supported|included|available|enabled)|anti|unsupported|disabled|unavailable)\b/.test(suffix);
    // If the same evidence contains both a positive occurrence and an
    // explicit negative occurrence, fail closed for that fact as a whole.
    if (prefixNegated || suffixNegated) return false;
    affirmed = true;
  }
  return affirmed;
}

/**
 * A strictly verified TikTok PDP slug may contribute only facts whose exact
 * English token/phrase is listed here. This is deliberately deterministic:
 * unlisted and directly negated phrases never become product claims.
 */
function productInfoFromTrustedSlug(
  base: ParsedProductInfo,
  trustedSlug: string,
  options: { sourceTitle?: string; corroboratingEvidence?: string } = {},
): ParsedProductInfo {
  const evidence = clean(trustedSlug).toLowerCase();
  const pageEvidence = clean(options.corroboratingEvidence).toLowerCase();
  const coreFunctions: string[] = [];
  const parameters: string[] = [];
  const scenes: string[] = [];
  const confirmed = (slugPhrase: RegExp, pagePhrase: RegExp = slugPhrase) => hasAffirmedSlugPhrase(evidence, slugPhrase)
    && (!options.corroboratingEvidence || hasAffirmedSlugPhrase(pageEvidence, pagePhrase));

  if (confirmed(/\bshockproof\b/)) coreFunctions.push("防震保护");
  const isIndoorSecurityCamera = confirmed(
    /\bindoor\s+security\s+camera\b/,
    /\b(?:indoor\s+security\s+camera|security\s+camera\s+indoor)\b/,
  );
  if (isIndoorSecurityCamera) {
    coreFunctions.push("室内安防监控");
    scenes.push("室内");
    if (confirmed(/\bai\s+detection\b/, /\bai(?:\s+person\/pet\/cry)?\s+detection\b/)) coreFunctions.push("AI检测");
    if (confirmed(/\b2\s+way\s+audio\b/, /\b2(?:-|\s)+way\s+audio\b/)) coreFunctions.push("双向语音");
    if (confirmed(/\bnight\s+vision\b/)) coreFunctions.push("夜视");
    // TikTok slugs replace the decimal point in "2.5K" with a hyphen, which
    // trustedProductPathEvidence decodes to the exact token pair "2 5k".
    if (confirmed(/\b2\s+5k\b/, /\b2\.5k\b/)) parameters.push("分辨率：2.5K");
  }
  if (confirmed(/\bsilicone\s+(?:phone\s+)?case\b/)) parameters.push("材质：硅胶");

  // Compatibility is accepted only from an explicit "for <known device>"
  // phrase. Unlisted words in the slug never become product facts.
  const compatibilityPattern = /\bfor\s+((?:iphone|samsung)(?:\s+(?:iphone|samsung))*)\b/;
  const compatibilityPhrase = confirmed(compatibilityPattern)
    ? evidence.match(compatibilityPattern)?.[1] || ""
    : "";
  const compatibleDevices = [...new Set(compatibilityPhrase.match(/\b(?:iphone|samsung)\b/g) || [])]
    .map((device) => device === "iphone" ? "iPhone" : "Samsung");
  if (compatibleDevices.length) parameters.push(`兼容设备：${compatibleDevices.join("、")}`);

  return {
    ...base,
    sku: "",
    coreFunctions,
    productParameters: base.productParameters || parameters.join("；"),
    scenes: scenes.join("；"),
    sourceTitle: clean(options.sourceTitle) || clean(trustedSlug),
    sourceDescription: "",
    sourceImageUrls: [],
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
  // Preserve empty entries so malformed arrays cannot shift later quotes onto
  // earlier claims and accidentally pass the strict index-by-index binding.
  return Array.isArray(quotes) ? quotes.map(clean) : [];
}

function normalizedEvidence(value: unknown) {
  return clean(value).normalize("NFKC").toLowerCase();
}

function quoteExistsInSource(quote: string, sourceText: string) {
  const needle = normalizedEvidence(quote);
  const source = normalizedEvidence(sourceText);
  if (needle.length < 3 || !/[\p{L}\p{N}]/u.test(needle)) return false;
  let index = source.indexOf(needle);
  while (index >= 0) {
    const before = index > 0 ? source[index - 1] : "";
    const after = source[index + needle.length] || "";
    const startsWithWord = /^[a-z0-9]/i.test(needle);
    const endsWithWord = /[a-z0-9]$/i.test(needle);
    if ((!startsWithWord || !/[a-z0-9]/i.test(before))
      && (!endsWithWord || !/[a-z0-9]/i.test(after))) return true;
    index = source.indexOf(needle, index + 1);
  }
  return false;
}

function fieldClaims(value: unknown) {
  return cleanFieldValue(value)
    .split(/[；;\n]+/)
    .map(clean)
    .filter(Boolean);
}

const CLAIM_EVIDENCE_RULES: Array<{ claim: RegExp; evidence: RegExp }> = [
  { claim: /(?:无需|免)(?:付费|订阅)|无月费/, evidence: /\b(?:non[- ]subscription|no\s+(?:monthly\s+)?(?:fees?|subscription)|without\s+(?:a\s+)?subscription)\b/i },
  { claim: /\bAI\b|人工智能/i, evidence: /\bAI\b|artificial intelligence/i },
  { claim: /人(?=[/、，,与和]|检测)|人员|人体|人形|人物/, evidence: /\b(?:human|person|people)\b/i },
  { claim: /宠物/, evidence: /\b(?:pet|dog|cat)s?\b/i },
  { claim: /哭声|哭泣/, evidence: /\bcry(?:ing)?\b/i },
  { claim: /检测|侦测/, evidence: /\bdetect(?:ion|s|ed|ing)?\b/i },
  { claim: /自定义|自设/, evidence: /\bcustom(?:ize|ized|izable|ization)?\b/i },
  { claim: /(?:检测|监控)?区域/, evidence: /\b(?:zone|area|region)s?\b/i },
  { claim: /红外/, evidence: /\b(?:IR|infrared)\b/i },
  { claim: /夜视/, evidence: /\bnight\s+vision\b/i },
  { claim: /全景/, evidence: /\bpanoramic\b|\b360\s*[°-]?\s*(?:pan|coverage|view)?\b/i },
  { claim: /云台|平移|俯仰/, evidence: /\bpan(?:\s*(?:and|&|\/)\s*tilt)?\b|\btilt\b/i },
  { claim: /双向/, evidence: /\b(?:2|two)[- ]?way\b|\bfull[- ]duplex\b/i },
  { claim: /全双工/, evidence: /\bfull[- ]duplex\b/i },
  { claim: /音频|语音/, evidence: /\baudio\b|\bvoice\b/i },
  { claim: /通话|呼叫/, evidence: /\b(?:call|speak|talk)(?:ing)?\b/i },
  { claim: /本地/, evidence: /\blocal(?:ly)?\b/i },
  { claim: /云端|云存储/, evidence: /\bcloud\b/i },
  { claim: /存储|保存/, evidence: /\b(?:stor(?:age|e)|save(?:d|s|ing)?)\b/i },
  { claim: /手机/, evidence: /\bphone\b|\bmobile\b/i },
  { claim: /应用|App\b/i, evidence: /\bapp(?:lication)?\b/i },
  { claim: /连接/, evidence: /\bconnect(?:ion|ed|s|ing)?\b/i },
  { claim: /Wi[- ]?Fi/i, evidence: /\bwi[- ]?fi\b/i },
  { claim: /一键|点击|轻触/, evidence: /\b(?:one[- ](?:tap|touch)|tap(?:\s+once)?|click|press)\b/i },
  { claim: /开启|打开|启动/, evidence: /\b(?:turn\s+on|enable|start|activate)(?:s|d|ed|ing)?\b/i },
  { claim: /睡眠模式/, evidence: /\bsleep\s+mode\b/i },
  { claim: /关闭(?:监控)?/, evidence: /\bturn\s+off\b|\bdisable\b|\bshut\s+off\b/i },
  { claim: /支持|可用/, evidence: /\b(?:support(?:s|ed|ing)?|works?\s+with|compatible)\b/i },
  { claim: /室内/, evidence: /\bindoor\b/i },
  { claim: /家庭|家中|居家/, evidence: /\b(?:home|household|family)\b/i },
  { claim: /安防|安全监控/, evidence: /\bsecurity\b/i },
  { claim: /婴儿|婴幼儿|宝宝/, evidence: /\b(?:baby|babies|infant)s?\b/i },
  { claim: /前门/, evidence: /\bfront\s+door\b/i },
  { claim: /看护|监护|监控/, evidence: /\b(?:monitor|watch|check\s+in|camera|coverage)\b/i },
  { claim: /智能/, evidence: /\b(?:smart|AI|intelligent)\b/i },
  { claim: /增强/, evidence: /\b(?:enhanced|improved)\b/i },
  { claim: /实时/, evidence: /\b(?:real[- ]time|live)\b/i },
  { claim: /清晰/, evidence: /\b(?:clear|sharp)\b/i },
  { claim: /平滑/, evidence: /\bsmooth\b/i },
  { claim: /覆盖/, evidence: /\b(?:coverage|cover(?:s|ed|ing)?)\b/i },
  { claim: /分辨率/, evidence: /\b(?:resolution|\d+(?:\.\d+)?\s*[km]p?)\b/i },
  { claim: /超高清|超清/, evidence: /\b(?:ultra\s+hd|uhd)\b/i },
  { claim: /高清/, evidence: /\b(?:hd|high\s+definition)\b/i },
  { claim: /电源|供电/, evidence: /\b(?:power|powered)\b/i },
  { claim: /有线/, evidence: /\b(?:wired|corded)\b/i },
  { claim: /电动/, evidence: /\b(?:electric|powered)\b/i },
  { claim: /插头/, evidence: /\bplug\b/i },
  { claim: /美标/, evidence: /\b(?:US|American)(?:\s+standard)?\s+plug\b/i },
  { claim: /输入电压|电压/, evidence: /\b(?:input\s+voltage|voltage|volts?)\b/i },
  { claim: /材质/, evidence: /\bmaterial\b/i },
  { claim: /硅胶/, evidence: /\bsilicone\b/i },
  { claim: /ABS\b/i, evidence: /\bABS\b/i },
  { claim: /型号/, evidence: /\b(?:model|C\d[A-Z0-9-]*)\b/i },
  { claim: /兼容|适配|适用于/, evidence: /\b(?:compatible|compatibility|for)\b/i },
  { claim: /防水/, evidence: /\bwaterproof\b|\bwater[- ]resistant\b/i },
  { claim: /防震|抗震/, evidence: /\bshockproof\b|\bshock[- ]resistant\b/i },
  { claim: /抗菌/, evidence: /\banti[- ]?bacterial\b|\bantimicrobial\b/i },
  { claim: /电池/, evidence: /\bbatter(?:y|ies)\b/i },
  { claim: /续航/, evidence: /\b(?:runtime|battery\s+life|endurance)\b/i },
  { claim: /快充/, evidence: /\b(?:fast|quick|rapid)[- ]?charg(?:e|ed|er|ing)\b/i },
  { claim: /充电/, evidence: /\bcharg(?:e|ed|er|ing)\b/i },
  { claim: /加热|发热/, evidence: /\bheat(?:ed|ing)?\b|\bwarm(?:ing)?\b/i },
  { claim: /震动|振动/, evidence: /\bvibrat(?:e|ing|ion)\b/i },
  { claim: /蓝牙/, evidence: /\bbluetooth\b/i },
  { claim: /无线/, evidence: /\bwireless\b/i },
];

function numericFactsMatch(claim: string, quote: string) {
  const normalizedClaim = normalizedEvidence(claim).replace(/度/g, "°");
  const evidence = normalizedEvidence(quote).replace(/degrees?/g, "°");
  const numbers = normalizedClaim.match(/\d+(?:\.\d+)?/g) || [];
  if (!numbers.every((number) => {
    const escaped = number.replace(".", "\\.");
    return new RegExp(`(?:^|[^\\d.])${escaped}(?![\\d.])`).test(evidence);
  })) return false;
  const specifications = [...normalizedClaim.matchAll(/(\d+(?:\.\d+)?)\s*(ghz|mhz|khz|mah|mp|kp|k|w|v|gb|tb|mb|mm|cm|kg|ft|inch(?:es)?|°)\b/g)]
    .map((match) => ({ number: match[1], unit: match[2] }));
  return specifications.every(({ number, unit }) => {
    const escaped = number.replace(".", "\\.");
    return new RegExp(`(?:^|[^\\d.])${escaped}\\s*${unit}(?![a-z])`, "i").test(evidence);
  });
}

function asciiFactsMatch(claim: string, quote: string) {
  const compact = (value: string) => normalizedEvidence(value).replace(/[^a-z0-9.]+/g, "");
  const evidence = compact(quote);
  const withoutSpecifications = normalizedEvidence(claim)
    .replace(/\d+(?:\.\d+)?\s*(?:ghz|mhz|khz|mah|mp|kp|k|w|v|gb|tb|mb|mm|cm|kg|ft|inch(?:es)?|°)/gi, " ");
  const tokens = withoutSpecifications.match(/[a-z][a-z0-9.-]+/gi) || [];
  return tokens.every((token) => evidence.includes(compact(token)));
}

function claimHasOnlyMappedMeaning(claim: string, quote: string) {
  if (!asciiFactsMatch(claim, quote)) return false;
  let residue = claim.normalize("NFKC");
  for (const rule of CLAIM_EVIDENCE_RULES) {
    const flags = [...new Set(`${rule.claim.flags.replace(/[gy]/g, "")}g`)].join("");
    residue = residue.replace(new RegExp(rule.claim.source, flags), " ");
  }
  residue = residue
    .replace(/\d+(?:\.\d+)?(?:\s*[-~至]\s*\d+(?:\.\d+)?)?\s*(?:GHz|MHz|kHz|mAh|MP|KP|K|W|V|GB|TB|MB|mm|cm|kg|ft|inch(?:es)?|°|度)?/gi, " ")
    .replace(/[A-Za-z][A-Za-z0-9._/-]*/g, " ")
    .replace(/(?:视频捕捉|连接技术|电源类型|插头类型|输入电压|产品|商品|设备|功能|能力|选项|模式|通过|即可|进行|采用|适用|提供|用于|使用|的|与|和|及|并|或|为)/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "");
  return !/[\u3400-\u9fff]/u.test(residue);
}

function quoteAffirmsClaim(claim: string, quote: string) {
  const beneficialAbsence = /(?:无需|免)(?:付费|订阅)|无月费/.test(claim)
    && /\b(?:non[- ]subscription|no\s+(?:monthly\s+)?(?:fees?|subscription)|without\s+(?:paying|a\s+subscription))\b/i.test(quote);
  const chineseNegation = /(?:不|无|未|免|无需|非)/.test(claim);
  const englishNegation = /\b(?:no|not|without|unsupported|disabled|unavailable|incompatible|cannot|can't|won't|will\s+not|doesn't|does\s+not|isn't|is\s+not|aren't|are\s+not|fails?\s+to|doesn't\s+work|does\s+not\s+work|not[- ]included|not[- ]supported)\b/i.test(quote)
    || /\bnon[- ](?!subscription\b)/i.test(quote);
  // The hand card intentionally omits negative attributes. The sole accepted
  // absence claim is the explicit no-subscription/no-monthly-fee benefit.
  if (chineseNegation && !beneficialAbsence) return false;
  return !englishNegation || beneficialAbsence;
}

function claimMeaningIsSupported(
  claim: string,
  quote: string,
  field: keyof ProductEvidenceQuotes,
) {
  if (!numericFactsMatch(claim, quote)) return false;
  if (!quoteAffirmsClaim(claim, quote)) return false;
  let matchedRule = false;
  for (const rule of CLAIM_EVIDENCE_RULES) {
    rule.claim.lastIndex = 0;
    if (!rule.claim.test(claim)) continue;
    matchedRule = true;
    rule.evidence.lastIndex = 0;
    if (!rule.evidence.test(quote)) return false;
  }
  // Unknown model-authored concepts are rejected instead of being accepted
  // merely because the model supplied some unrelated real page quote.
  if (!matchedRule) return false;
  if (!claimHasOnlyMappedMeaning(claim, quote)) return false;
  if (field === "usageMethod") {
    if (!/(?:连接|点击|轻触|按|开启|关闭|安装|使用|放置|设置|选择|插入|移除|充电|保存|查看|通话|呼叫|佩戴|涂抹|拉|推|旋转|调节)/.test(claim)) return false;
    if (!/\b(?:connect|tap|click|press|turn|install|use|place|set|select|choose|insert|remove|charge|save|view|access|call|speak|wear|apply|pull|push|rotate|adjust)(?:s|ed|ing)?\b/i.test(quote)) return false;
  }
  if (field === "audience") {
    const audienceRules = [
      { claim: /家庭|家中/, evidence: /\b(?:famil(?:y|ies)|households?|home\s+(?:users?|owners?))\b/i },
      { claim: /宠物主人/, evidence: /\bpet\s+owners?\b/i },
      { claim: /父母|家长/, evidence: /\bparents?\b/i },
      { claim: /独居/, evidence: /\b(?:living\s+alone|people\s+who\s+live\s+alone|single[- ]person)\b/i },
      { claim: /用户/, evidence: /\b(?:users?|customers?|owners?|parents?)\b/i },
    ];
    const matched = audienceRules.filter((rule) => rule.claim.test(claim));
    if (!matched.length || matched.some((rule) => !rule.evidence.test(quote))) return false;
  }
  return true;
}

function supportedClaimField(
  value: unknown,
  quotes: string[],
  sourceText: string,
  field: keyof ProductEvidenceQuotes,
) {
  const claims = fieldClaims(value);
  if (!claims.length || claims.length !== quotes.length) return "";
  const valid = claims.every((claim, index) => {
    const quote = quotes[index];
    return quoteExistsInSource(quote, sourceText)
      && claimMeaningIsSupported(claim, quote, field);
  });
  return valid ? claims.join("；") : "";
}

function normalizeParsed(
  parsed: ParsedProductModel,
  base: ParsedProductInfo,
  evidenceText: string,
  options: { allowVisualEvidence?: boolean } = {},
): ParsedProductInfo {
  const rawFunctions = parsedValue(parsed, ["coreFunctions", "核心功能", "核心功能（按重要程度）"]);
  const functions = Array.isArray(rawFunctions)
    ? rawFunctions
    : String(rawFunctions || "").split(/[；;\n]+/);
  const sourceTitle = base.sourceTitle || clean(parsedValue(parsed, ["sourceTitle", "title", "页面标题"]));
  const sourceDescription = base.sourceDescription || clean(parsedValue(parsed, ["sourceDescription", "description", "页面描述"]));
  const visualEvidence = options.allowVisualEvidence === false
    ? ""
    : clean(parsedValue(parsed, ["visualEvidence", "图片证据", "视觉证据", "图片分析"]));
  // Model-authored visualEvidence is useful as a human-readable observation,
  // but it can never certify another model-authored fact. Only exact-PID page
  // text may satisfy evidenceQuotes.
  const source = evidenceText || `${sourceTitle}\n${sourceDescription}`;
  const functionQuotes = evidenceList(parsed, "coreFunctions");
  const normalizedFunctions = functions.map(cleanFunction).filter(Boolean);
  const supportedFunctions = normalizedFunctions.length === functionQuotes.length
    && normalizedFunctions.every((value, index) => /[\u3400-\u9fff]/.test(value)
      && quoteExistsInSource(functionQuotes[index], source)
      && claimMeaningIsSupported(value, functionQuotes[index], "coreFunctions"))
    ? normalizedFunctions
    : [];
  const supportedString = (value: unknown, field: keyof ProductEvidenceQuotes) => {
    const normalized = supportedClaimField(value, evidenceList(parsed, field), source, field);
    return /[\u3400-\u9fff]/.test(normalized) ? normalized : "";
  };
  return {
    ...base,
    sourceTitle,
    sourceDescription,
    // SKU is copied only from the exact-PID router model. A free-form model
    // value plus an unrelated real quote is not a trustworthy identifier.
    sku: base.sku,
    coreFunctions: [...new Set(supportedFunctions)].slice(0, 5),
    // Product parameters come only from the exact-PID router model's explicit
    // property label/value pairs. Free-form AI text cannot bind a value to the
    // wrong product attribute or an accessory mentioned in the same sentence.
    productParameters: base.productParameters,
    usageMethod: supportedString(parsedValue(parsed, ["usageMethod", "使用方法"]), "usageMethod"),
    audience: supportedString(parsedValue(parsed, ["audience", "适用人群", "目标人群"]), "audience"),
    scenes: supportedString(parsedValue(parsed, ["scenes", "使用场景", "适用场景"]), "scenes"),
    // 产品卖点暂不由 AI 生成，避免把品类常识包装成未经证实的商品卖点。
    sellingPoints: "",
    visualEvidence,
  };
}

type ProductPageResult = {
  title: string;
  description: string;
  text: string;
  imageUrls: string[];
  sku: string;
  productParameters?: string;
  error: string;
  structured: boolean;
  corroboratingText: string;
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

function deterministicStructuredParameters(properties: Array<{ name: string; values: string[] }>) {
  const parameters: string[] = [];
  const add = (label: string, value: string) => {
    const normalized = clean(value).slice(0, 120);
    if (normalized && !parameters.some((item) => item.startsWith(`${label}：`))) {
      parameters.push(`${label}：${normalized}`);
    }
  };
  for (const property of properties) {
    const name = property.name.toLowerCase();
    const value = property.values.map(clean).filter(Boolean).join("、");
    if (!value) continue;
    if (name === "video capture resolution") add("视频捕捉分辨率", value);
    else if (name === "connectivity technology" || name === "connectivity protocol") add("连接技术", value);
    else if (name === "power source") {
      const translated = /^corded electric$/i.test(value)
        ? "有线电动"
        : /^battery(?: powered)?$/i.test(value) ? "电池供电" : value;
      add("电源类型", translated);
    } else if (name === "plug type") {
      const translated = /^us plug$/i.test(value)
        ? "美标插头"
        : /^eu plug$/i.test(value) ? "欧标插头"
          : /^uk plug$/i.test(value) ? "英标插头" : value;
      add("插头类型", translated);
    } else if (/^input voltage(?:\(v\))?$/.test(name)) {
      add("输入电压", /^\d+(?:\.\d+)?(?:\s*[-~]\s*\d+(?:\.\d+)?)?$/.test(value) ? `${value}V` : value);
    } else if (name === "material") {
      const translated = /^silicone$/i.test(value) ? "硅胶" : value;
      add("材质", translated);
    } else if (name === "model") add("型号", value);
    else if (name === "compatible devices") {
      const translated = /^smartphones?$/i.test(value) ? "智能手机" : value;
      add("兼容设备", translated);
    }
  }
  return parameters.slice(0, 8).join("；");
}

function structuredProductEvidence(html: string, productUrl: string) {
  const productId = productIdFromOfficialTikTokPath(productUrl);
  const model = productModelFromRouterData(embeddedJson(html, "__MODERN_ROUTER_DATA__"), productId);
  if (!model || clean(model.product_id) !== productId || !clean(model.name)) return null;

  const description = descriptionEvidence(model.description);
  const propertyRecords = (Array.isArray(model.product_properties) ? model.product_properties : [])
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const property = item as Record<string, unknown>;
      const propertyName = clean(property.property_name);
      if (/(?:CA Prop|Aerosol|Dangerous|Hazardous|Magnetic Field|Country of origin|Batter(?:y|ies)|Cells?\?)/i.test(propertyName)) return null;
      const values = (Array.isArray(property.property_values) ? property.property_values : [])
        .map((value) => value && typeof value === "object" ? clean((value as Record<string, unknown>).property_value_name) : "")
        .filter(Boolean);
      return values.length ? { name: propertyName, values } : null;
    })
    .filter((item): item is { name: string; values: string[] } => Boolean(item));
  const properties = propertyRecords.map((property) => `${property.name}：${property.values.join("、")}`);
  const skus = (Array.isArray(model.skus) ? model.skus : [])
    .map((item) => item && typeof item === "object" ? clean((item as Record<string, unknown>).sku_name) : "")
    .filter((value, index, all) => Boolean(value) && all.indexOf(value) === index);
  const coverImages = (Array.isArray(model.images) ? model.images : []).flatMap((image) => {
      if (!image || typeof image !== "object") return [];
      const urls = (image as Record<string, unknown>).url_list;
      return Array.isArray(urls) && urls.length ? [clean(urls[0])] : [];
    });
  const imageUrls = [
    coverImages[0],
    ...description.imageUrls,
    ...coverImages.slice(1),
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
    productParameters: deterministicStructuredParameters(propertyRecords),
    structured: true,
    corroboratingText: title,
  };
}

function browserExecutable() {
  const candidates = [
    process.env.PRODUCT_BROWSER_EXECUTABLE_PATH,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean) as string[];
  return candidates.find((candidate) => existsSync(candidate)) || "";
}

let browserQueue: Promise<void> = Promise.resolve();

async function readExpandedProductPage(productUrl: string) {
  const previous = browserQueue;
  let release!: () => void;
  browserQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    const executablePath = browserExecutable();
    if (!executablePath) return null;
    const { chromium } = await import("playwright-core");
    const profileDir = process.env.TIKTOK_CHROMIUM_PROFILE_DIR?.trim()
      || "/app/.data/tiktok-chromium-interactive";
    const persistent = existsSync(profileDir)
      ? await chromium.launchPersistentContext(profileDir, {
          executablePath,
          headless: true,
          locale: "en-US",
          userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
          viewport: { width: 1280, height: 900 },
          args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
        })
      : null;
    const browser = persistent ? null : await chromium.launch({
      executablePath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    try {
      const page = persistent
        ? persistent.pages()[0] || await persistent.newPage()
        : await browser!.newPage({
            locale: "en-US",
            userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
            viewport: { width: 1280, height: 900 },
          });
      await page.goto(productUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      const moreText = /^(?:查看更多|View more|See more|Show more|Load more)$/i;
      for (let round = 0; round < 12; round += 1) {
        const controls = page.locator("button, [role=button]").filter({ hasText: moreText });
        const textControls = page.getByText(moreText, { exact: true });
        for (const locator of [controls, textControls]) {
          const count = Math.min(await locator.count(), 6);
          for (let index = 0; index < count; index += 1) {
            await locator.nth(index).click({ timeout: 1_500 }).catch(() => undefined);
          }
        }
        const reachedBottom = await page.evaluate(() => {
          const before = window.scrollY;
          window.scrollBy(0, Math.max(700, window.innerHeight * 0.8));
          return before + window.innerHeight >= document.documentElement.scrollHeight - 10;
        });
        await page.waitForTimeout(250);
        if (reachedBottom) break;
      }
      await page.waitForTimeout(500);
      const [html, text, imageCandidates] = await Promise.all([
        page.content(),
        page.locator("body").innerText().catch(() => ""),
        page.locator("img").evaluateAll((images) => images.flatMap((image) => {
          const element = image as HTMLImageElement;
          const srcset = element.getAttribute("srcset")?.split(",").map((part) => part.trim().split(/\s+/)[0]) || [];
          let parent: HTMLElement | null = element;
          for (let level = 0; level < 4 && parent?.parentElement; level += 1) parent = parent.parentElement;
          const context = (parent?.innerText || element.alt || "").slice(0, 500);
          return [element.currentSrc, element.src, element.getAttribute("data-src") || "", ...srcset]
            .filter(Boolean)
            .map((url) => ({ url, context }));
        }).filter(Boolean)),
      ]);
      const normalizedImages = imageCandidates
        .filter((candidate) => !NON_PRODUCT_SECTION.test(candidate.context))
        .map((candidate) => normalizeImageUrl(candidate.url, productUrl))
        .filter((url, index, all) => Boolean(url) && looksLikeProductImage(url) && all.indexOf(url) === index);
      return { html, text: productDetailText(text), imageUrls: normalizedImages };
    } finally {
      if (persistent) await persistent.close();
      else await browser?.close();
    }
  } catch {
    return null;
  } finally {
    release();
  }
}

export function expandedProductResult(
  expanded: NonNullable<Awaited<ReturnType<typeof readExpandedProductPage>>>,
  productUrl: string,
): ProductPageResult | null {
  const title = meta(expanded.html, "og:title") || clean(expanded.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
  const description = meta(expanded.html, "og:description") || meta(expanded.html, "description");
  if (isProductSecurityChallenge(title, description, expanded.text)) return null;
  const structured = structuredProductEvidence(expanded.html, productUrl);
  if (structured) {
    return {
      ...structured,
      text: [structured.text, expanded.text].filter(Boolean).join("\n").slice(0, 20_000),
      imageUrls: [...structured.imageUrls, ...expanded.imageUrls]
        .filter((url, index, all) => all.indexOf(url) === index)
        .slice(0, MAX_PRODUCT_IMAGES),
      error: "",
      corroboratingText: structured.corroboratingText,
    };
  }
  if (!title && !description && expanded.text.length < 300) return null;
  return {
    title,
    description,
    text: expanded.text.slice(0, 20_000),
    imageUrls: expanded.imageUrls.slice(0, MAX_PRODUCT_IMAGES),
    sku: "",
    error: "",
    structured: false,
    corroboratingText: "",
  };
}

async function readProductPage(productUrl: string): Promise<ProductPageResult> {
  let lastError = "商品页没有公开资料";
  for (const [index, fetchUrl] of tiktokProductFetchUrls(productUrl).entries()) {
    try {
      const response = await fetchWithProxy(fetchUrl, {
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
      const blocked = isProductSecurityChallenge(title, metaDescription, visibleText);
      if (blocked) {
        const expanded = await readExpandedProductPage(fetchUrl);
        const browserResult = expanded ? expandedProductResult(expanded, productUrl) : null;
        if (browserResult) return browserResult;
        lastError = "商品页要求安全验证";
        continue;
      }
      const structured = structuredProductEvidence(html, productUrl);
      const expanded = await readExpandedProductPage(fetchUrl);
      const expandedResult = expanded ? expandedProductResult(expanded, productUrl) : null;
      const bestStructured = expandedResult?.structured ? expandedResult : structured || expandedResult;
      if (bestStructured) {
        const imageUrls = [
          ...bestStructured.imageUrls,
          ...(expanded?.imageUrls || []),
        ].filter((url, imageIndex, all) => all.indexOf(url) === imageIndex).slice(0, MAX_PRODUCT_IMAGES);
        return {
          ...bestStructured,
          text: [bestStructured.text, expanded?.text].filter(Boolean).join("\n").slice(0, 20_000),
          imageUrls,
          error: "",
          corroboratingText: bestStructured.corroboratingText,
        };
      }
      if (title || metaDescription || visibleText.length >= 300) {
        return {
          title,
          description: metaDescription,
          text: [visibleText, expanded?.text].filter(Boolean).join("\n").slice(0, 20_000),
          imageUrls: [...extractProductImageUrls(html, productUrl), ...(expanded?.imageUrls || [])]
            .filter((url, imageIndex, all) => all.indexOf(url) === imageIndex)
            .slice(0, MAX_PRODUCT_IMAGES),
          sku: "",
          error: "",
          structured: false,
          corroboratingText: "",
        };
      }
      lastError = "商品页没有公开资料";
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const name = error instanceof Error ? error.name : "";
      lastError = /timeout/i.test(name) || /(?:timed?\s*out|timeout)/i.test(message)
        ? "商品页请求超时"
        : "商品页请求失败";
    }
  }
  return { title: "", description: "", text: "", imageUrls: [], sku: "", error: lastError, structured: false, corroboratingText: "" };
}

async function readProductPageWithRetry(productUrl: string): Promise<ProductPageResult> {
  const retryDelays = [0, 1_500, 3_000];
  let page: ProductPageResult | null = null;
  for (const delay of retryDelays) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    page = await readProductPage(productUrl);
    if (page.text || page.error !== "商品页要求安全验证") return page;
  }
  return page || { title: "", description: "", text: "", imageUrls: [], sku: "", error: "商品页没有公开资料", structured: false, corroboratingText: "" };
}

function extractionPrompt(input: {
  productUrl: string;
  hints: ProductParseHints;
  title: string;
  description: string;
  pageText: string;
  visualMode: "direct" | "none";
}) {
  const identity = `团队中文名称（仅用于文档标题，不是产品事实证据）：${clean(input.hints.productName) || "未提供"}\n商品 PID：${clean(input.hints.pid) || extractProductIdFromUrl(input.productUrl) || "未提供"}\n商品链接：${input.productUrl}`;
  const evidence = `页面标题：${input.title}\n页面描述：${input.description}\n页面正文：${input.pageText}`;
  const visualInstruction = input.visualMode === "direct"
    ? "下方会附带商品图片。必须结合图片确认产品外观结构、接口/按键、随附配件、可见文字和使用方式。图片中清晰可见的原文可以作为字段证据，但不得根据外观猜测看不见的性能、材质或参数；引用图片文字时，把逐字可见文字同时放入对应 evidenceQuotes 和 visualEvidence。visualEvidence 必须保留引用到的英文原文，不要只写中文概括。"
    : "当前没有可靠商品图片，只能根据公开文字资料整理。";
  const bundleCount = explicitBundleCount(input.pageText);
  const bundleOutputCount = Math.min(5, bundleCount);
  const bundleInstruction = bundleCount
    ? bundleCount <= 5
      ? `本页文字明确列出 ${bundleCount}-in-1 功能清单，因此 coreFunctions 必须恰好返回 ${bundleOutputCount} 条，逐项覆盖清单，不得遗漏、合并或只移到其他字段。`
      : `本页文字明确列出 ${bundleCount}-in-1 组合功能；受字段上限影响，coreFunctions 必须返回其中最重要且有原文证据的 ${bundleOutputCount} 条。`
    : "若页面明确写有 N-in-1 或 N things in one 并逐项列出功能，coreFunctions 必须逐项覆盖清单中的每一项（最多5项），不得省略，也不得只把某项放入产品参数。";
  return `你在整理 TikTok Shop 产品手卡。\n${identity}\n${evidence}\n${visualInstruction}\n\n只能把上述页面文字和商品图片中明确可读的文字翻译、归纳成中文。不得使用常识补齐，不得根据团队中文名推断，不得把相似商品的功能写进来。某字段没有直接文字或清晰图片文字证据时必须返回空字符串或空数组。请输出：页面原始标题 sourceTitle、页面原始描述 sourceDescription、真实 SKU、1至5条产品主要功能、产品参数、使用方法、适用人群、使用场景，以及简短图片证据 visualEvidence。除 sourceTitle、sourceDescription 和 evidenceQuotes 保留英文原文外，其余所有字段值必须使用中文。产品主要功能按重要程度排序，每项只表达一个有证据的功能，不要写 A/B/C/D/E 前缀；页面有足够证据时应整理3至5项。${bundleInstruction}productParameters、usageMethod、audience、scenes 必须返回字符串，不得返回对象或数组；多项用中文分号分隔。产品参数只保留3至8项与购买或使用直接相关的信息，忽略合规声明、危险品声明和无意义的否定属性。SKU 不得填写 PID 或商品ID。精确尺寸、功率、材质、兼容型号、认证和包装数量必须能在证据中找到；页面文字与图片冲突时省略该字段，不要添加冲突说明。sellingPoints 暂不生成，必须返回空字符串。evidenceQuotes 必须为每个输出字段提供页面或图片中的英文逐字短引文：coreFunctions 与引文数组按下标一一对应，其余字段列出支持其中每个事实的引文；中文值必须只是引文的直接翻译或压缩，不得扩大含义。只返回合法 JSON，不要使用 Markdown 代码块。JSON 键名必须严格使用：{"sourceTitle":"","sourceDescription":"","sku":"","coreFunctions":[""],"productParameters":"","usageMethod":"","audience":"","scenes":"","sellingPoints":"","visualEvidence":"","evidenceQuotes":{"sku":[""],"coreFunctions":[""],"productParameters":[""],"usageMethod":[""],"audience":[""],"scenes":[""]}}。`;
}

function parsedQwenProductModel(payload: Record<string, unknown>) {
  try {
    const parsed = parseJsonLoose<ParsedProductModel>(readTextFromModelResponse(payload));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // The caller records this as invalid_json without logging provider output.
  }
  throw new Error("Qwen 返回的商品资料 JSON 不是对象");
}

async function parsedQwenProductResponse(response: Response) {
  try {
    return parsedQwenProductModel(await response.json() as Record<string, unknown>);
  } catch {
    throw new Error("Qwen 返回的商品资料不是有效 JSON");
  }
}

async function qwenExtract(prompt: string) {
  const qwen = getProviderConfig("qwen");
  if (!qwen.enabled || !qwen.apiKey) throw new Error("Qwen 商品资料抽取未配置");
  const response = await fetchWithProxy(`${qwen.baseUrl.replace(/\/$/, "")}/chat/completions`, {
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
  if (!response.ok) throw new Error(`Qwen HTTP ${response.status}`);
  return parsedQwenProductResponse(response);
}

async function qwenTranslateBundleFeatures(features: string[]) {
  const qwen = getProviderConfig("qwen");
  if (!qwen.enabled || !qwen.apiKey || !features.length) return [];
  const response = await fetchWithProxy(`${qwen.baseUrl.replace(/\/$/, "")}/chat/completions`, {
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
  if (!qwen.enabled || !qwen.apiKey) throw new Error("Qwen 商品图片抽取未配置");
  if (!imageUrls.length) throw new Error("没有可供 Qwen 分析的商品图片");
  const response = await fetchWithProxy(`${qwen.baseUrl.replace(/\/$/, "")}/chat/completions`, {
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
  if (!response.ok) throw new Error(`Qwen HTTP ${response.status}`);
  return parsedQwenProductResponse(response);
}

async function qwenFindExactProductSources(productUrl: string) {
  const qwen = getProviderConfig("qwen");
  if (!qwen.enabled || !qwen.apiKey) throw new Error("Qwen 联网检索未配置");
  const productId = productIdFromOfficialTikTokPath(productUrl);
  const search = async (input: string) => {
    const response = await fetchWithProxy(`${qwen.baseUrl.replace(/\/$/, "")}/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${qwen.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: qwen.model || "qwen3.7-plus",
        input,
        tools: [{ type: "web_search" }],
        enable_thinking: false,
        max_output_tokens: 1_200,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json() as Record<string, unknown>;
    const sourceUrls: string[] = [];
    for (const item of Array.isArray(payload.output) ? payload.output : []) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      if (record.status !== "completed" || record.type !== "web_search_call") continue;
      const action = record.action;
      if (!action || typeof action !== "object") continue;
      for (const source of Array.isArray((action as Record<string, unknown>).sources)
        ? (action as Record<string, unknown>).sources as unknown[]
        : []) {
        const sourceUrl = source && typeof source === "object" ? clean((source as Record<string, unknown>).url) : "";
        if (sourceUrl && !sourceUrls.includes(sourceUrl)) sourceUrls.push(sourceUrl);
      }
    }
    return sourceUrls;
  };
  const sourceUrls = await search(`只查找 PID ${productId} 对应的 TikTok 官方商品详情页。目标链接：${productUrl}。必须寻找带商品名称路径的 /pdp/ 链接，不要只返回 /view/product/，也不要使用同类或相似商品替代。`);
  const exactSourceUrls = sourceUrls.filter((sourceUrl) => isExactTikTokProductSource(sourceUrl, productId));
  const trustedSource = exactSourceUrls
    .map((sourceUrl) => ({ sourceUrl, evidence: trustedProductPathEvidence(sourceUrl, productId) }))
    .find((source) => Boolean(source.evidence));
  return {
    exactSourceMatched: exactSourceUrls.length > 0,
    trustedEvidence: trustedSource?.evidence || "",
    trustedSourceTitle: trustedSource?.evidence || "",
    trustedSourceUrl: trustedSource?.sourceUrl || "",
  };
}

type ProviderFailure = {
  outcome: "timeout" | "http" | "invalid_json" | "request_error" | "insufficient";
  detail: string;
};

function providerFailure(error: unknown): ProviderFailure {
  const message = error instanceof Error ? clean(error.message) : clean(error);
  const name = error instanceof Error ? error.name : "";
  if (/timeout/i.test(name) || /(?:timed?\s*out|timeout)/i.test(message)) {
    return { outcome: "timeout", detail: "Qwen 请求超时" };
  }
  const httpStatus = message.match(/\bHTTP\s+(\d{3})\b/i)?.[1];
  if (httpStatus) {
    return { outcome: "http", detail: `Qwen HTTP ${httpStatus}` };
  }
  if (/(?:JSON|可读取的文本结果|valid json)/i.test(message)) {
    return { outcome: "invalid_json", detail: "Qwen 返回的商品资料不是有效 JSON" };
  }
  if (/未配置/.test(message)) return { outcome: "request_error", detail: "Qwen 未配置" };
  return { outcome: "request_error", detail: "Qwen 请求失败" };
}

function preferredProviderFailure(failures: ProviderFailure[]) {
  for (const outcome of ["timeout", "http", "invalid_json", "request_error", "insufficient"] as const) {
    const failure = failures.find((item) => item.outcome === outcome);
    if (failure) return failure.detail;
  }
  return "";
}

export function productParseFailureReason(input: {
  searchMode: boolean;
  pageError: string;
  exactSourceMatched: boolean;
  trustedEvidenceAvailable?: boolean;
  searchError?: string;
  providerError?: string;
}) {
  if (!input.searchMode) {
    if (input.providerError) {
      return `${input.pageError ? `${input.pageError}；` : ""}AI 提取未得到足够的可验证资料（${input.providerError}）；官方商品页路径也没有足够的确定性白名单资料`;
    }
    return input.pageError || "AI 没有返回足够的可验证商品资料";
  }
  if (input.searchError) {
    return `${input.pageError ? `${input.pageError}；` : ""}联网检索失败：${input.searchError}`;
  }
  if (input.exactSourceMatched && !input.trustedEvidenceAvailable) {
    return "联网检索找到了同 PID 的官方商品页，但链接路径没有可独立验证的商品资料";
  }
  if (input.exactSourceMatched) return "联网检索找到了同 PID 的官方商品页，但链接路径没有足够的白名单商品资料";
  if (input.pageError === "商品页要求安全验证") {
    return "商品页要求安全验证，联网检索也未找到与该 PID 完全匹配的官方公开商品页";
  }
  return input.pageError
    ? `${input.pageError}；联网检索也未找到与该 PID 完全匹配的官方公开商品页`
    : "联网检索没有找到与该 PID 完全匹配的官方公开商品页";
}

export async function parsePublicProductPage(
  productUrl: string,
  hints: ProductParseHints = {},
): Promise<ParsedProductInfo> {
  const canonicalUrl = productUrl.trim();
  const pathProductId = productIdFromOfficialTikTokPath(canonicalUrl);
  const productId = clean(hints.pid) || pathProductId;
  if (!isExactTikTokProductSource(canonicalUrl, productId)) {
    throw new Error("商品资料解析失败：产品链接必须是 HTTPS TikTok 官方商品详情页，且链接 PID 必须与商品 PID 一致");
  }
  // TikTok occasionally returns a short-lived verification page for a valid
  // product. Retry only that transient response; permanent errors still fail
  // immediately so a button click cannot occupy a worker unnecessarily.
  const page = await readProductPageWithRetry(canonicalUrl);
  const base = baseInfo(page.title, page.description, hints, page.imageUrls, page.sku, page.productParameters);
  const searchMode = !page.text;
  let searchResult: Awaited<ReturnType<typeof qwenFindExactProductSources>> | null = null;
  let searchError = "";
  if (searchMode) {
    try {
      searchResult = await qwenFindExactProductSources(canonicalUrl);
    } catch (error) {
      searchError = providerFailure(error).detail;
    }
  }
  const trustedSearchEvidence = searchResult?.trustedEvidence || "";
  const evidenceBase = searchMode && searchResult?.trustedSourceTitle
    ? { ...base, sourceTitle: searchResult.trustedSourceTitle, sourceDescription: "" }
    : base;
  const prompt = searchMode ? "" : extractionPrompt({
    productUrl: canonicalUrl,
    hints: { ...hints, pid: productId },
    title: base.sourceTitle,
    description: base.sourceDescription,
    pageText: page.text,
    visualMode: page.imageUrls.length ? "direct" : "none",
  });
  const trustedDirectSlug = !searchMode && page.structured
    ? trustedProductPathEvidence(canonicalUrl, productId)
    : "";
  const directDeterministicCandidate = trustedDirectSlug
    ? productInfoFromTrustedSlug(base, trustedDirectSlug, {
        sourceTitle: base.sourceTitle,
        corroboratingEvidence: page.corroboratingText,
      })
    : null;
  const directDeterministicUsable = Boolean(
    directDeterministicCandidate && hasUsableProductInfo(directDeterministicCandidate),
  );

  // The exact public page is the primary evidence. On mainland ECS we read
  // TikTok's own origin host first. Web search is only a URL-discovery
  // fallback: Responses prose is ignored and no second chat call may turn a
  // seller-controlled slug into free-form product claims.
  const providerFailures: ProviderFailure[] = [];
  let providerReturnedModel = false;
  let visualProviderSucceeded = false;
  const initialUsedVisualModel = !searchMode && page.imageUrls.length > 0;
  const attemptProductModel = async (label: string, request: () => Promise<ParsedProductModel>) => {
    const startedAt = Date.now();
    try {
      const result = await request();
      providerReturnedModel = true;
      if (label === "Qwen 图片抽取") visualProviderSucceeded = true;
      console.info("[product-parser] provider attempt", {
        pid: productId,
        stage: label,
        outcome: "success",
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      const failure = providerFailure(error);
      providerFailures.push(failure);
      console.warn("[product-parser] provider attempt", {
        pid: productId,
        stage: label,
        outcome: failure.outcome,
        durationMs: Date.now() - startedAt,
      });
      return null;
    }
  };
  let parsed = searchMode
    ? null
    : page.imageUrls.length
      ? await attemptProductModel("Qwen 图片抽取", () => qwenVisualExtract(prompt, page.imageUrls))
      : await attemptProductModel("Qwen 文本抽取", () => qwenExtract(prompt));
  let normalized = searchMode
    ? trustedSearchEvidence ? productInfoFromTrustedSlug(evidenceBase, trustedSearchEvidence) : null
    : parsed ? normalizeParsed(parsed, base, page.text) : null;
  let visualAnalysisStatus: ParsedProductInfo["visualAnalysisStatus"] = "unavailable";

  if (!searchMode
    && needsCompletenessRetry(normalized, page.text)
    && (providerReturnedModel || (initialUsedVisualModel && !directDeterministicUsable))) {
    parsed = await attemptProductModel("Qwen 文本重试", () => qwenExtract(prompt));
    const candidate = parsed ? normalizeParsed(parsed, base, page.text) : null;
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

  // A usable AI result always wins. Only after all direct extraction attempts
  // fail completeness/evidence checks may a strictly verified router-data
  // page use the deterministic slug allowlist. Every mapped fact must also be
  // present (and not directly negated) in that same page's structured text.
  if (!searchMode && (!normalized || !hasUsableProductInfo(normalized))) {
    if (providerReturnedModel) {
      providerFailures.push({ outcome: "insufficient", detail: "Qwen 返回资料未通过证据引文与字段完整性校验" });
      console.warn("[product-parser] provider attempt", {
        pid: productId,
        stage: "evidence_validation",
        outcome: "insufficient",
        durationMs: 0,
      });
    }
    const fallbackStartedAt = Date.now();
    console.info("[product-parser] provider attempt", {
      pid: productId,
      stage: "direct_deterministic_fallback",
      outcome: directDeterministicUsable ? "success" : "insufficient",
      durationMs: Date.now() - fallbackStartedAt,
    });
    if (directDeterministicUsable) normalized = directDeterministicCandidate;
  }

  // The 1+1 threshold is local to this strictly grounded search result. The
  // public cache predicate keeps its historical two-field threshold so legacy
  // rows cannot be silently promoted.
  const minimumDescriptiveFields = searchMode ? 1 : 2;
  if (!normalized || !hasUsableProductInfo(normalized, minimumDescriptiveFields)) {
    throw new Error(`商品资料解析失败：${productParseFailureReason({
      searchMode,
      pageError: page.error,
      exactSourceMatched: searchResult?.exactSourceMatched === true,
      trustedEvidenceAvailable: Boolean(trustedSearchEvidence),
      searchError,
      providerError: preferredProviderFailure(providerFailures),
    })}`);
  }
  if (searchMode) {
    normalized = { ...normalized, sourceImageUrls: [], visualEvidence: "" };
  }
  // Recompute after the optional text retry and deterministic fallback. A
  // completed status means an actual visual request succeeded and its final
  // retained observation is non-empty; text-only output cannot manufacture it.
  visualAnalysisStatus = !searchMode
    && initialUsedVisualModel
    && visualProviderSucceeded
    && hasReliableVisualEvidence(normalized.visualEvidence)
    && normalized.sourceImageUrls.length > 0
    ? "completed"
    : "unavailable";
  return { ...normalized, sellingPoints: "", visualAnalysisStatus };
}
