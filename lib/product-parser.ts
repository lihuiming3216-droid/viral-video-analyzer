import "server-only";

import { existsSync } from "node:fs";
import type { Page } from "playwright-core";
import { fetchWithProxy } from "@/lib/network";
import {
  analyzeProductCaptureWithOpenAI,
  createProductCaptureDigest,
  formatProductFactsForCard,
} from "@/lib/openai-product-analyzer";
import { getProviderConfig } from "@/lib/provider-config";
import { parseJsonLoose, readTextFromModelResponse } from "@/lib/json-utils";
import { tiktokProductFetchUrls } from "@/lib/tiktok-product";
import type { ProductFactBasis, ProductFactField, ProductFactProvenance } from "@/lib/types";

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
  verification?: {
    status: "complete" | "partial";
    verifiedFactCount: number;
    rejectedFactCount: number;
    verifiedFields: string[];
    missingFields: string[];
    sourceUrl: string;
    evidenceVersion: string;
    /** Facts permitted to be written to the card, including clearly labelled AI inference. */
    safeFactCount?: number;
    acceptedFactCount?: number;
    acceptedFields?: string[];
    /** Direct text/OCR evidence only; never includes AI inference. */
    inferredFactCount?: number;
    inferredFields?: string[];
    /** Basis for each OpenAI-managed fact, carried into the durable product snapshot. */
    factProvenance?: ProductFactProvenance;
  };
}

export interface ProductParseHints {
  productName?: string;
  pid?: string;
}

export type ProductPageCaptureErrorCode =
  | "page_unavailable"
  | "page_incomplete"
  | "all_product_images_unavailable";

export class ProductPageCaptureError extends Error {
  constructor(public readonly code: ProductPageCaptureErrorCode, safeMessage: string) {
    super(safeMessage);
    this.name = "ProductPageCaptureError";
  }
}

function productPageCaptureMessage(code: ProductPageCaptureErrorCode) {
  if (code === "page_incomplete") return "商品详情页没有完成展开并稳定滚动到底";
  if (code === "all_product_images_unavailable") return "商品详情页没有可下载并解码的主体图片";
  return "无法打开并确认同 PID 的 TikTok Shop 商品详情页";
}

export interface ProductPageCoverage {
  identity: "exact";
  details: "converged" | "not_required";
  scroll: "converged";
  expectedImageCount: number;
  usableImageCount: number;
}

export interface CapturedProductFragment {
  id: string;
  kind: "router_text" | "router_property" | "scoped_dom";
  text: string;
}

export interface CapturedProductImage {
  id: string;
  dataUrl: string;
  role: "cover" | "detail";
  ocrText?: string;
}

export interface CapturedProductPage {
  captureId: string;
  sourceDigest: string;
  canonicalUrl: string;
  pid: string;
  fragments: CapturedProductFragment[];
  images: CapturedProductImage[];
  coverage: ProductPageCoverage;
}

export type ProductPageCaptureResult =
  | { ok: true; capture: CapturedProductPage; errorCode: "" }
  | {
      ok: false;
      capture: CapturedProductPage | null;
      errorCode: ProductPageCaptureErrorCode;
    };

export interface ProductPageCollectionSnapshot {
  atBottom: boolean;
  scrollHeight: number;
  detailHash: string;
  productImageKeys: string[];
  pendingDetailControls?: number;
}

export interface ProductPageCollectionDriver {
  navigate(url: string): Promise<{ ok: boolean; finalUrl: string; status: number }>;
  expandProductDetails(labels: readonly string[]): Promise<{
    found: boolean;
    expanded: boolean;
    pendingCount?: number;
  }>;
  resetToTop(): Promise<void>;
  snapshot(): Promise<ProductPageCollectionSnapshot>;
  scrollNext(): Promise<void>;
  wait(milliseconds: number): Promise<void>;
  collect(): Promise<{
    html: string;
    text: string;
    detailTextTruncated?: boolean;
    /** Visible body text used only to classify security challenges, never as fact evidence. */
    securityText?: string;
  }>;
  probeImage(url: string): Promise<{ dataUrl: string } | null>;
}

function isTrustedProductNavigationUrl(sourceUrl: string, productId: string) {
  if (isExactTikTokProductSource(sourceUrl, productId)) return true;
  try {
    const url = new URL(sourceUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    if (url.hostname.toLowerCase() !== "shop.tiktokw.us") return false;
    const canonical = new URL(url.toString());
    canonical.hostname = "shop.tiktok.com";
    return isExactTikTokProductSource(canonical.toString(), productId);
  } catch {
    return false;
  }
}

function isObviouslyPrivateNetworkUrl(sourceUrl: string) {
  try {
    const url = new URL(sourceUrl);
    if (!["http:", "https:"].includes(url.protocol)) return false;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "0.0.0.0") return true;
    if (/^(?:127|10)\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return true;
    const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4) {
      const octets = ipv4.slice(1).map(Number);
      if (octets.some((octet) => octet > 255)) return true;
      if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
      if (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) return true;
    }
    return /^(?:fc|fd|fe8|fe9|fea|feb)[0-9a-f:]*$/i.test(host);
  } catch {
    return true;
  }
}

export interface ProductPageCollectionResult {
  capture: CapturedProductPage | null;
  errorCode: ProductPageCaptureErrorCode | "";
  html: string;
  text: string;
  sourceImageUrls: string[];
  imageDataUrls: string[];
  diagnostics: {
    details: "converged" | "not_required" | "incomplete";
    scroll: "converged" | "incomplete";
    stableRounds: number;
    expectedImageCount: number;
    usableImageCount: number;
  };
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

// Keep the whole normal TikTok product gallery available to the sealed
// multimodal capture. The OpenAI analyzer enforces the same hard upper bound.
const MAX_PRODUCT_IMAGES = 20;
const MAX_IMAGE_PIXELS = 768 * 768;
const PRODUCT_EVIDENCE_VERSION = "exact-pdp-atomic-v1";
const VERIFIED_PRODUCT_FIELDS = [
  "sku", "coreFunctions", "productParameters", "usageMethod", "audience", "scenes",
] as const;

const OPENAI_MANAGED_PRODUCT_FIELDS = [
  "coreFunctions", "usageMethod", "audience", "scenes",
] as const satisfies readonly ProductFactField[];

function clean(value: unknown) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

const PRODUCT_SECURITY_CHALLENGE = /(?:captcha|verify to continue|verify you are human|human verification|just a moment|access denied|security check|checking your browser|unusual traffic|登录后继续|安全验证|人机验证|请完成验证)/i;
const PRODUCT_ID_QUERY_KEYS = ["pid", "product_id", "productId", "item_id", "itemId"];

/** A challenge page is transport-successful HTML, but it is not product evidence. */
export function isProductSecurityChallenge(title: string, description = "", text = "") {
  return PRODUCT_SECURITY_CHALLENGE.test(`${clean(title)} ${clean(description)} ${clean(text).slice(0, 1_500)}`);
}

type OfficialTikTokProductPath = {
  kind: "pdp" | "view";
  slug: string;
  pid: string;
};

function officialTikTokProductPath(url: URL): OfficialTikTokProductPath | null {
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  if (url.hostname.toLowerCase() === "shop.tiktok.com") {
    const localized = String.raw`(?:[a-z]{2}(?:-[a-z]{2})?\/)?`;
    const namedMatch = pathname.match(new RegExp(`^\\/${localized}pdp\\/([^/]+)\\/(\\d{6,})$`, "i"));
    if (namedMatch) return { kind: "pdp", slug: namedMatch[1], pid: namedMatch[2] };
    const sluglessMatch = pathname.match(new RegExp(`^\\/${localized}pdp\\/(\\d{6,})$`, "i"));
    return sluglessMatch ? { kind: "pdp", slug: "", pid: sluglessMatch[1] } : null;
  }
  if (url.hostname.toLowerCase() !== "www.tiktok.com") return null;
  const shopMatch = pathname.match(/^\/shop\/pdp\/([^/]+)\/(\d{6,})$/i);
  if (shopMatch) return { kind: "pdp", slug: shopMatch[1], pid: shopMatch[2] };
  const sluglessShopMatch = pathname.match(/^\/shop\/pdp\/(\d{6,})$/i);
  if (sluglessShopMatch) return { kind: "pdp", slug: "", pid: sluglessShopMatch[1] };
  const viewMatch = pathname.match(/^\/view\/product\/(\d{6,})$/i);
  return viewMatch ? { kind: "view", slug: "", pid: viewMatch[1] } : null;
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
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    const productPath = officialTikTokProductPath(url);
    if (!productPath || productPath.kind !== "pdp" || productPath.pid !== expectedPid) return false;
    return PRODUCT_ID_QUERY_KEYS.every((key) => url.searchParams.getAll(key)
      .every((queryPid) => clean(queryPid) === expectedPid));
  } catch {
    return false;
  }
}

/** View-product URLs may help discover a PDP, but never certify product facts. */
export function isTikTokProductDiscoverySource(sourceUrl: string, productId: string) {
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

function productFactGroups(info: Pick<ParsedProductInfo,
  "sku" | "coreFunctions" | "productParameters" | "usageMethod" | "audience" | "scenes"
>) {
  return {
    sku: fieldClaims(info.sku),
    coreFunctions: (info.coreFunctions || []).map(cleanFunction).filter(Boolean),
    productParameters: fieldClaims(info.productParameters),
    usageMethod: fieldClaims(info.usageMethod),
    audience: fieldClaims(info.audience),
    scenes: fieldClaims(info.scenes),
  };
}

function factValuesForField(
  groups: ReturnType<typeof productFactGroups>,
  field: ProductFactField,
) {
  return groups[field] || [];
}

function normalizedFactValue(value: string) {
  return clean(value);
}

function basisFromRenderedFact(value: string): ProductFactBasis {
  return /（AI推断）\s*$/.test(value) ? "ai_inference" : "verified_text";
}

function productFactProvenance(
  info: ParsedProductInfo,
  groups: ReturnType<typeof productFactGroups>,
): ProductFactProvenance {
  const existing = info.verification?.factProvenance || {};
  const provenance: ProductFactProvenance = {};
  for (const field of OPENAI_MANAGED_PRODUCT_FIELDS) {
    const previous = new Map((existing[field] || []).map((fact) => [normalizedFactValue(fact.value), fact.basis]));
    const facts = factValuesForField(groups, field).map((value) => ({
      value,
      basis: previous.get(normalizedFactValue(value)) || basisFromRenderedFact(value),
    }));
    if (facts.length) provenance[field] = facts;
  }
  return provenance;
}

function withProductVerification(
  info: ParsedProductInfo,
  sourceUrl: string,
  rejectedFactCount = 0,
  requiredFields: readonly string[] = VERIFIED_PRODUCT_FIELDS,
) {
  const groups = productFactGroups(info);
  const factProvenance = productFactProvenance(info, groups);
  const acceptedFields = VERIFIED_PRODUCT_FIELDS.filter((field) => groups[field].length > 0);
  const inferredFields = OPENAI_MANAGED_PRODUCT_FIELDS.filter((field) => (
    (factProvenance[field] || []).some((fact) => fact.basis === "ai_inference")
  ));
  const verifiedFields = VERIFIED_PRODUCT_FIELDS.filter((field) => {
    if (!OPENAI_MANAGED_PRODUCT_FIELDS.includes(field as ProductFactField)) return groups[field].length > 0;
    return (factProvenance[field as ProductFactField] || []).some((fact) => fact.basis !== "ai_inference");
  });
  const missingFields = requiredFields.filter((field) => !acceptedFields.includes(field as typeof acceptedFields[number]));
  const acceptedFactCount = VERIFIED_PRODUCT_FIELDS.reduce((total, field) => total + groups[field].length, 0);
  const inferredFactCount = OPENAI_MANAGED_PRODUCT_FIELDS.reduce(
    (total, field) => total + (factProvenance[field] || []).filter((fact) => fact.basis === "ai_inference").length,
    0,
  );
  const verifiedFactCount = acceptedFactCount - inferredFactCount;
  const sourcePid = productIdFromOfficialTikTokPath(sourceUrl);
  const exactSourceUrl = sourcePid && isExactTikTokProductSource(sourceUrl, sourcePid) ? sourceUrl : "";
  return {
    ...info,
    verification: {
      status: missingFields.length === 0 && rejectedFactCount === 0 ? "complete" as const : "partial" as const,
      verifiedFactCount,
      rejectedFactCount: Math.max(0, rejectedFactCount),
      verifiedFields: [...verifiedFields],
      missingFields: [...missingFields],
      sourceUrl: exactSourceUrl,
      evidenceVersion: info.verification?.evidenceVersion || PRODUCT_EVIDENCE_VERSION,
      acceptedFactCount,
      acceptedFields: [...acceptedFields],
      inferredFactCount,
      inferredFields: [...inferredFields],
      factProvenance,
    },
  };
}

function hasVerifiedProductFacts(info: ParsedProductInfo | null | undefined) {
  if (!info) return false;
  if (info.verification) return info.verification.verifiedFactCount > 0;
  const groups = productFactGroups(info);
  return VERIFIED_PRODUCT_FIELDS.reduce((total, field) => total + groups[field].length, 0) > 0;
}

function mergeAtomicText(left: string, right: string) {
  return [...new Set([...fieldClaims(left), ...fieldClaims(right)])].join("；");
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
  const merged = {
    ...preferred,
    sku: mergeAtomicText(current.sku, candidate.sku),
    coreFunctions: [...new Set([...current.coreFunctions, ...candidate.coreFunctions])].slice(0, 5),
    productParameters: mergeAtomicText(current.productParameters, candidate.productParameters),
    usageMethod: mergeAtomicText(current.usageMethod, candidate.usageMethod),
    audience: mergeAtomicText(current.audience, candidate.audience),
    scenes: mergeAtomicText(current.scenes, candidate.scenes),
    visualEvidence: hasReliableVisualEvidence(current.visualEvidence)
      ? current.visualEvidence
      : candidate.visualEvidence,
  };
  const sourceUrl = current.verification?.sourceUrl || candidate.verification?.sourceUrl || "";
  // A completeness retry re-evaluates the same requested facts. Counting both
  // passes would inflate rejection telemetry rather than describe distinct
  // rejected claims, so retain the larger independently observed count.
  const rejectedFactCount = Math.max(
    current.verification?.rejectedFactCount || 0,
    candidate.verification?.rejectedFactCount || 0,
  );
  return withProductVerification(merged, sourceUrl, rejectedFactCount);
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

const TRUSTED_TIKTOK_IMAGE_HOST_SUFFIXES = [
  "ibyteimg.com",
  "byteimg.com",
  "tiktokcdn.com",
  "tiktokcdn-us.com",
  "tiktokcdn-eu.com",
  "muscdn.com",
] as const;

/** Router image URLs are still seller-controlled input; keep probes off private/arbitrary hosts. */
export function safeTikTokProductImageUrl(value: string) {
  const normalized = normalizeImageUrl(value, "https://www.tiktok.com/");
  if (!normalized) return "";
  try {
    const url = new URL(normalized);
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || url.port) return "";
    if (!TRUSTED_TIKTOK_IMAGE_HOST_SUFFIXES.some((suffix) => (
      hostname === suffix || hostname.endsWith(`.${suffix}`)
    ))) return "";
    return url.toString();
  } catch {
    return "";
  }
}

export function hasUsableProductImageDimensions(width: number, height: number) {
  return Number.isFinite(width) && Number.isFinite(height)
    && width >= 32 && height >= 32
    && width * height >= 1_024 && width * height <= 40_000_000;
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

const OPENAI_REQUIRED_PRODUCT_FIELDS = [
  "coreFunctions",
  "usageMethod",
  "audience",
  "scenes",
] as const;

/**
 * Convert one sealed, exact-PID browser capture into the managed product-card
 * snapshot. This helper stays independently testable: capture completeness is
 * established before the model call, while SKU and parameters continue to
 * come only from TikTok's exact-PID structured fields.
 */
export async function parsedProductInfoFromOpenAICapture(input: {
  capture: CapturedProductPage;
  productNameHint: string;
  base: ParsedProductInfo;
}): Promise<ParsedProductInfo> {
  const productNameHint = clean(input.productNameHint) || input.base.productName;
  const captureWithoutDigest = {
    captureId: input.capture.captureId,
    pid: input.capture.pid,
    canonicalUrl: input.capture.canonicalUrl,
    fragments: input.capture.fragments,
    images: input.capture.images,
    coverage: input.capture.coverage,
  };
  const analysis = await analyzeProductCaptureWithOpenAI({
    ...input.capture,
    productNameHint,
    sourceDigest: createProductCaptureDigest({
      ...captureWithoutDigest,
      productNameHint,
    }),
  });
  const formatFacts = (facts: typeof analysis.coreFunctions.facts) => facts
    .map((fact) => formatProductFactsForCard({ facts: [fact] }))
    .filter(Boolean);
  const coreFunctions = formatFacts(analysis.coreFunctions.facts);
  const usageMethod = formatFacts(analysis.usageMethod.facts).join("；");
  const audience = formatFacts(analysis.audience.facts).join("；");
  const scenes = formatFacts(analysis.scenes.facts).join("；");
  if (!coreFunctions.length || !usageMethod || !audience || !scenes) {
    // The analyzer already enforces this, but the parser repeats the boundary
    // so a future provider adapter cannot publish an apparently completed card
    // with one of the four business-required fields missing.
    throw Object.assign(new Error("OpenAI 没有返回四个必填商品字段"), {
      code: "insufficient_safe_facts",
    });
  }
  const factProvenance: ProductFactProvenance = {
    coreFunctions: analysis.coreFunctions.facts.map((fact, index) => ({
      value: coreFunctions[index] || "",
      basis: fact.basis,
    })).filter((fact) => Boolean(fact.value)),
    usageMethod: analysis.usageMethod.facts.map((fact) => ({
      value: formatProductFactsForCard({ facts: [fact] }),
      basis: fact.basis,
    })).filter((fact) => Boolean(fact.value)),
    audience: analysis.audience.facts.map((fact) => ({
      value: formatProductFactsForCard({ facts: [fact] }),
      basis: fact.basis,
    })).filter((fact) => Boolean(fact.value)),
    scenes: analysis.scenes.facts.map((fact) => ({
      value: formatProductFactsForCard({ facts: [fact] }),
      basis: fact.basis,
    })).filter((fact) => Boolean(fact.value)),
  };
  return withProductVerification({
    ...input.base,
    coreFunctions,
    usageMethod,
    audience,
    scenes,
    sellingPoints: "",
    visualEvidence: input.capture.images.length
      ? `已完成 ${input.capture.images.length} 张同 PID 商品主体图片分析`
      : "无商品主体图片，已基于完整商品详情文字分析",
    visualAnalysisStatus: input.capture.images.length ? "completed" : "unavailable",
    verification: {
      // withProductVerification recomputes all counters from this basis map.
      status: "partial",
      verifiedFactCount: 0,
      rejectedFactCount: 0,
      verifiedFields: [],
      missingFields: [],
      sourceUrl: input.capture.canonicalUrl,
      evidenceVersion: "complete-pdp-openai-v1",
      factProvenance,
    },
  }, input.capture.canonicalUrl, 0, OPENAI_REQUIRED_PRODUCT_FIELDS);
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

const ACCESSORY_NOUNS: Array<{ key: string; pattern: RegExp }> = [
  { key: "accessory", pattern: /\baccessor(?:y|ies)\b/i },
  { key: "pouch", pattern: /\b(?:travel\s+)?pouch(?:es)?\b/i },
  { key: "sleeve", pattern: /\bsleeves?\b/i },
  { key: "cover", pattern: /\bcovers?\b/i },
  { key: "holster", pattern: /\bholsters?\b/i },
  { key: "mount", pattern: /\bmounts?\b/i },
  { key: "stand", pattern: /\bstands?\b/i },
  { key: "cable", pattern: /\bcables?\b/i },
  { key: "charger", pattern: /\bchargers?\b/i },
  { key: "dock", pattern: /\bdocks?\b/i },
  { key: "strap", pattern: /\bstraps?\b/i },
  { key: "holder", pattern: /\bholders?\b/i },
  { key: "bracket", pattern: /\bbrackets?\b/i },
  { key: "case", pattern: /\b(?:carry(?:ing)?\s+|travel\s+)?cases?\b/i },
  { key: "bag", pattern: /\b(?:carry(?:ing)?\s+|travel\s+)?bags?\b/i },
  { key: "adapter", pattern: /\badapters?\b/i },
  { key: "remote", pattern: /\bremote(?:\s+controls?)?\b/i },
];

function accessoryNouns(value: string) {
  return new Set(ACCESSORY_NOUNS
    .filter(({ pattern }) => pattern.test(clean(value)))
    .map(({ key }) => key));
}

function mainProductAccessoryNouns(sourceText: string) {
  const explicitTitle = String(sourceText || "").match(/(?:^|\n)商品标题[：:]\s*([^\n]+)/i)?.[1];
  const title = clean(explicitTitle || sourceText);
  // Nouns after a bundle relation describe secondary objects, not the main
  // product category (for example, "camera with travel pouch").
  const head = title.split(/\b(?:with|includes?|included|comes?\s+with|bundled\s+with|supplied\s+with)\b/i)[0];
  return accessoryNouns(head);
}

/**
 * Product cards describe the purchased main product, not an included/optional
 * accessory. Until accessory facts have their own modeled subject, any claim
 * whose local evidence assigns the capability to a bag, carrying case,
 * adapter, remote, or separately sold accessory must fail closed.
 */
function hasAccessorySubjectContext(value: string, sourceText = value) {
  const context = clean(value);
  const nouns = accessoryNouns(context);
  if (!nouns.size) return /\b(?:sold\s+separately|for\s+accessor(?:y|ies))\b/i.test(context);
  const mainNouns = mainProductAccessoryNouns(sourceText);
  const secondaryNouns = [...nouns].filter((noun) => !mainNouns.has(noun));
  if (secondaryNouns.length) return true;
  // Even a noun that matches the main category is secondary when a sentence
  // explicitly introduces another instance as bundled/optional equipment.
  return /\b(?:includes?|included|comes?\s+with|bundled\s+with|supplied\s+with|sold\s+separately|for)\b[^.!?;\n]{0,80}\b(?:accessor(?:y|ies)|pouch(?:es)?|sleeves?|covers?|holsters?|mounts?|stands?|cables?|chargers?|docks?|straps?|holders?|brackets?|cases?|bags?|adapters?|remote(?:\s+controls?)?)\b/i.test(context)
    || /\b(?:accessor(?:y|ies)|pouch(?:es)?|sleeves?|covers?|holsters?|mounts?|stands?|cables?|chargers?|docks?|straps?|holders?|brackets?|cases?|bags?|adapters?|remote(?:\s+controls?)?)\b[^.!?;\n]{0,40}\b(?:included|bundled|supplied|sold\s+separately)\b/i.test(context);
}

function sourceContextsForQuote(quote: string, sourceText: string) {
  const needle = normalizedEvidence(quote);
  if (!needle) return [];
  const segments = String(sourceText || quote)
    .split(/[\r\n]+|(?<=[.!?;。！？；])\s*/)
    .map((segment) => clean(segment))
    .filter((segment) => normalizedEvidence(segment).includes(needle));
  if (segments.length) return segments;

  // Structured text normally preserves line/sentence boundaries. Keep this
  // bounded fallback for an exact quote that crosses formatting whitespace.
  const source = normalizedEvidence(sourceText);
  const contexts: string[] = [];
  let index = source.indexOf(needle);
  while (index >= 0) {
    contexts.push(source.slice(Math.max(0, index - 96), index + needle.length + 96));
    index = source.indexOf(needle, index + 1);
  }
  return contexts;
}

function quoteHasAccessorySubjectContext(quote: string, sourceText: string) {
  if (hasAccessorySubjectContext(quote, sourceText)) return true;
  return sourceContextsForQuote(quote, sourceText)
    .some((context) => hasAccessorySubjectContext(context, sourceText));
}

/**
 * A strictly verified TikTok PDP slug may contribute only facts whose exact
 * English token/phrase is listed here. This is deliberately deterministic:
 * unlisted and directly negated phrases never become product claims.
 */
function productInfoFromTrustedSlug(
  base: ParsedProductInfo,
  trustedSlug: string,
  options: { sourceTitle?: string; corroboratingEvidence?: string; sourceUrl?: string } = {},
): ParsedProductInfo {
  const evidence = clean(trustedSlug).toLowerCase();
  const pageEvidence = clean(options.corroboratingEvidence).toLowerCase();
  const coreFunctions: string[] = [];
  const parameters: string[] = [];
  const scenes: string[] = [];
  const subjectSource = options.corroboratingEvidence || evidence;
  const accessoryContext = hasAccessorySubjectContext(evidence, subjectSource)
    || Boolean(options.corroboratingEvidence && hasAccessorySubjectContext(pageEvidence, pageEvidence));
  const confirmed = (slugPhrase: RegExp, pagePhrase: RegExp = slugPhrase) => !accessoryContext
    && hasAffirmedSlugPhrase(evidence, slugPhrase)
    && (!options.corroboratingEvidence || hasAffirmedSlugPhrase(pageEvidence, pagePhrase));

  // Shock resistance is mapped only when the slug independently identifies
  // the main product as a case. A camera "with shockproof carrying case" is
  // an accessory statement and can never make the camera itself shockproof.
  const isMainCaseProduct = confirmed(
    /\b(?:phone\s+case|silicone\s+(?:phone\s+)?case|protective\s+(?:phone\s+)?case|case\s+for\s+(?:iphone|samsung))\b/,
  );
  if (isMainCaseProduct && confirmed(/\bshockproof\b/)) coreFunctions.push("防震保护");
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

  return withProductVerification({
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
  }, options.sourceUrl || "");
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

function regexMatches(regex: RegExp, value: string) {
  regex.lastIndex = 0;
  return regex.test(value);
}

function occurrenceContext(source: string, index: number, length: number) {
  const boundary = /[\r\n.!?;。！？；]/;
  let start = Math.max(0, index - 160);
  for (let cursor = index - 1; cursor >= start; cursor -= 1) {
    if (boundary.test(source[cursor])) {
      start = cursor + 1;
      break;
    }
  }
  let end = Math.min(source.length, index + length + 160);
  for (let cursor = index + length; cursor < end; cursor += 1) {
    if (boundary.test(source[cursor])) {
      end = cursor;
      break;
    }
  }
  return {
    context: clean(source.slice(start, end)),
    prefix: clean(source.slice(start, index)).toLowerCase(),
    suffix: clean(source.slice(index + length, end)).toLowerCase(),
  };
}

function occurrenceIsExplicitlyNegated(source: string, index: number, length: number) {
  const { prefix, suffix } = occurrenceContext(source, index, length);
  const prefixNegated = /(?:^|\b)(?:no|without|lacks?|lacking)(?:\s+(?:any|the|a|an))?\s*$/i.test(prefix)
    || /(?:^|\b)(?:not|never)(?:\s+(?:support(?:s|ed|ing)?|offer(?:s|ed|ing)?|include(?:s|d|ing)?|provide(?:s|d|ing)?|feature(?:s|d|ing)?))?\s*$/i.test(prefix)
    || /(?:^|\b)(?:does|do|did|can|could|will|would|is|are|was|were|has|have)\s+(?:not|never)(?:\s+(?:support|offer|include|provide|feature))?\s*$/i.test(prefix)
    || /(?:^|\b)(?:doesn't|don't|didn't|can't|cannot|couldn't|won't|wouldn't|isn't|aren't|wasn't|weren't|hasn't|haven't)(?:\s+(?:support|offer|include|provide|feature))?\s*$/i.test(prefix)
    || /(?:^|\b)(?:unsupported|disabled|unavailable|incompatible)\s*$/i.test(prefix);
  const suffixNegated = /^(?:[a-z0-9-]+\s+){0,4}(?:(?:is|are|was|were|remains?)\s+)?(?:not\s+(?:supported|available|enabled|included|offered|provided)|unsupported|disabled|unavailable|absent|not\s+included)\b/i.test(suffix)
    || /^\s*(?:isn't|aren't|wasn't|weren't)\s+(?:supported|available|enabled|included|offered|provided)\b/i.test(suffix);
  return prefixNegated || suffixNegated;
}

/**
 * A short model quote such as "waterproof" cannot hide the sentence around
 * it. Inspect every occurrence of the quoted fact in the exact router model:
 * any explicit contradiction fails closed, while accessory ownership is
 * evaluated only for the actual quoted occurrence so an unrelated accessory
 * elsewhere cannot taint a fully bound main-product sentence.
 */
function claimSourceContextIsSafe(
  claim: string,
  quote: string,
  sourceText: string,
  field: keyof ProductEvidenceQuotes,
) {
  const relevantRules = CLAIM_EVIDENCE_RULES.filter((rule) => regexMatches(rule.claim, claim)
    && regexMatches(rule.evidence, quote));
  if (!relevantRules.length) return false;

  if (field !== "sku" && quoteHasAccessorySubjectContext(quote, sourceText)) return false;

  for (const rule of relevantRules) {
    const flags = [...new Set(`${rule.evidence.flags.replace(/[gy]/g, "")}g`)].join("");
    const matcher = new RegExp(rule.evidence.source, flags);
    for (const match of sourceText.matchAll(matcher)) {
      if (occurrenceIsExplicitlyNegated(sourceText, match.index || 0, match[0].length)) return false;
    }
  }
  return true;
}

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
  sourceText = quote,
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
  if (!claimSourceContextIsSafe(claim, quote, sourceText, field)) return false;
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
  const verifiedClaims: string[] = [];
  let rejectedFactCount = 0;
  for (const [index, claim] of claims.entries()) {
    const quote = quotes[index] || "";
    if (quoteExistsInSource(quote, sourceText)
      && claimMeaningIsSupported(claim, quote, field, sourceText)) {
      if (!verifiedClaims.includes(claim)) verifiedClaims.push(claim);
    } else {
      rejectedFactCount += 1;
    }
  }
  return {
    value: verifiedClaims.join("；"),
    verifiedClaims,
    rejectedFactCount,
  };
}

function normalizeParsed(
  parsed: ParsedProductModel,
  base: ParsedProductInfo,
  evidenceText: string,
  options: { allowVisualEvidence?: boolean; sourceUrl?: string } = {},
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
  const supportedFunctions: string[] = [];
  let rejectedFactCount = 0;
  for (const [index, value] of normalizedFunctions.entries()) {
    const quote = functionQuotes[index] || "";
    if (/[\u3400-\u9fff]/.test(value)
      && quoteExistsInSource(quote, source)
      && claimMeaningIsSupported(value, quote, "coreFunctions", source)) {
      if (!supportedFunctions.includes(value)) supportedFunctions.push(value);
    } else {
      rejectedFactCount += 1;
    }
  }
  const supportedString = (value: unknown, field: keyof ProductEvidenceQuotes) => {
    const result = supportedClaimField(value, evidenceList(parsed, field), source, field);
    rejectedFactCount += result.rejectedFactCount;
    return /[\u3400-\u9fff]/.test(result.value) ? result.value : "";
  };
  const normalized = {
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
  return withProductVerification(normalized, options.sourceUrl || "", rejectedFactCount);
}

export type ProductPageResult = {
  title: string;
  description: string;
  text: string;
  imageUrls: string[];
  imageDataUrls?: string[];
  sku: string;
  productParameters?: string;
  error: string;
  structured: boolean;
  corroboratingText: string;
  capture?: CapturedProductPage | null;
  captureErrorCode?: ProductPageCaptureErrorCode | "";
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
    try { parsed = JSON.parse(parsed); } catch {
      return { texts: [clean(parsed)], imageUrls: [], imageUrlGroups: [] as string[][] };
    }
  }
  const texts: string[] = [];
  const imageUrls: string[] = [];
  const imageUrlGroups: string[][] = [];
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
      const urls = (Array.isArray((image as Record<string, unknown>).url_list)
        ? (image as Record<string, unknown>).url_list as unknown[]
        : [])
        .map((raw) => safeTikTokProductImageUrl(clean(raw)))
        .filter((url, index, all) => Boolean(url) && all.indexOf(url) === index);
      if (urls.length) {
        imageUrlGroups.push(urls);
        if (!imageUrls.includes(urls[0])) imageUrls.push(urls[0]);
      }
    }
    stack.push(...Object.values(record));
  }
  return { texts, imageUrls, imageUrlGroups };
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
  const coverImageGroups = (Array.isArray(model.images) ? model.images : []).flatMap((image) => {
    if (!image || typeof image !== "object") return [];
    const urls = (Array.isArray((image as Record<string, unknown>).url_list)
      ? (image as Record<string, unknown>).url_list as unknown[]
      : [])
      .map((raw) => safeTikTokProductImageUrl(clean(raw)))
      .filter((url, index, all) => Boolean(url) && all.indexOf(url) === index);
    return urls.length ? [urls] : [];
  });
  const imageCandidates = [
    coverImageGroups[0],
    ...description.imageUrlGroups,
    ...coverImageGroups.slice(1),
  ].filter((urls): urls is string[] => Boolean(urls?.length))
    .filter((urls, index, all) => all.findIndex((candidate) => candidate.join("\n") === urls.join("\n")) === index)
    .slice(0, MAX_PRODUCT_IMAGES);
  const imageUrls = imageCandidates.map((urls) => urls[0]);
  const title = clean(model.name);
  const detail = description.texts.join("\n").slice(0, 7_000);
  const propertyText = properties.join("\n").slice(0, 3_000);
  const fragments: CapturedProductFragment[] = [
    { id: "router-title", kind: "router_text", text: title },
  ];
  for (const [index, text] of description.texts.entries()) {
    const normalized = clean(text).slice(0, 2_000);
    if (normalized) fragments.push({ id: `router-description-${index + 1}`, kind: "router_text", text: normalized });
  }
  for (const [index, property] of propertyRecords.entries()) {
    const propertyTextFragment = `${property.name}：${property.values.join("、")}`.slice(0, 1_000);
    if (propertyTextFragment) fragments.push({
      id: `router-property-${index + 1}`,
      kind: "router_property",
      text: propertyTextFragment,
    });
  }
  fragments.splice(64);
  return {
    title,
    description: detail,
    text: [`商品标题：${title}`, detail && `商品详情：\n${detail}`, propertyText && `商品属性：\n${propertyText}`, skus.length && `SKU：${skus.join("；")}`]
      .filter(Boolean)
      .join("\n")
      .slice(0, 11_000),
    imageUrls: imageUrls.slice(0, MAX_PRODUCT_IMAGES),
    imageCandidates,
    sku: skus.join("；"),
    productParameters: deterministicStructuredParameters(propertyRecords),
    structured: true,
    corroboratingText: title,
    fragments,
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

export const PRODUCT_DETAIL_CONTROL_LABELS = [
  "详细内容",
  "商品详情",
  "产品详情",
  "查看更多",
  "展开",
  "View more",
  "See more",
  "Show more",
  "Read more",
  "Product details",
] as const;

function unavailableCollectionResult(
  errorCode: ProductPageCaptureErrorCode,
  overrides: Partial<ProductPageCollectionResult> = {},
): ProductPageCollectionResult {
  return {
    capture: null,
    errorCode,
    html: "",
    text: "",
    sourceImageUrls: [],
    imageDataUrls: [],
    diagnostics: {
      details: "not_required",
      scroll: "incomplete",
      stableRounds: 0,
      expectedImageCount: 0,
      usableImageCount: 0,
    },
    ...overrides,
  };
}

function canonicalProductCaptureUrl(productUrl: string) {
  const url = new URL(productUrl);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function canonicalTrustedProductNavigationUrl(sourceUrl: string, productId: string) {
  if (!isTrustedProductNavigationUrl(sourceUrl, productId)) return "";
  try {
    const url = new URL(sourceUrl);
    if (url.hostname.toLowerCase() === "shop.tiktokw.us") {
      url.hostname = "shop.tiktok.com";
    }
    if (!isExactTikTokProductSource(url.toString(), productId)) return "";
    return canonicalProductCaptureUrl(url.toString());
  } catch {
    return "";
  }
}

export async function collectProductPageWithDriver(
  driver: ProductPageCollectionDriver,
  productUrl: string,
  options: {
    stableRounds?: number;
    maxRounds?: number;
    waitMilliseconds?: number;
    captureId?: string;
  } = {},
): Promise<ProductPageCollectionResult> {
  const pid = productIdFromOfficialTikTokPath(productUrl);
  if (!pid || !isExactTikTokProductSource(productUrl, pid)) {
    return unavailableCollectionResult("page_unavailable");
  }

  let navigation: Awaited<ReturnType<ProductPageCollectionDriver["navigate"]>>;
  try {
    navigation = await driver.navigate(productUrl);
  } catch {
    return unavailableCollectionResult("page_unavailable");
  }
  const finalUrl = navigation.finalUrl || productUrl;
  const canonicalFinalUrl = canonicalTrustedProductNavigationUrl(finalUrl, pid);
  if (!navigation.ok || navigation.status >= 400 || !canonicalFinalUrl) {
    return unavailableCollectionResult("page_unavailable");
  }

  let detailFound = false;
  let detailExpansionComplete = true;
  let pendingDetailControls = 0;
  const expandVisibleDetails = async () => {
    try {
      const expansion = await driver.expandProductDetails(PRODUCT_DETAIL_CONTROL_LABELS);
      if (expansion.found) detailFound = true;
      pendingDetailControls = Math.max(0, expansion.pendingCount || 0);
      detailExpansionComplete = !expansion.found
        ? !detailFound || detailExpansionComplete
        : expansion.expanded && pendingDetailControls === 0;
    } catch {
      detailExpansionComplete = false;
      pendingDetailControls = Math.max(1, pendingDetailControls);
    }
  };
  await expandVisibleDetails();
  const currentDetailState = (): "converged" | "not_required" | "incomplete" => (
    !detailExpansionComplete || pendingDetailControls > 0
      ? "incomplete"
      : detailFound ? "converged" : "not_required"
  );

  try {
    await driver.resetToTop();
  } catch {
    return unavailableCollectionResult("page_incomplete", {
      diagnostics: {
        details: currentDetailState(),
        scroll: "incomplete",
        stableRounds: 0,
        expectedImageCount: 0,
        usableImageCount: 0,
      },
    });
  }

  const requiredStableRounds = Math.max(3, options.stableRounds || 3);
  const maxRounds = Math.max(requiredStableRounds, options.maxRounds || 36);
  let stableRounds = 0;
  let previousSignature = "";
  for (let round = 0; round < maxRounds; round += 1) {
    // Detail controls are themselves lazy-loaded on some TikTok storefronts.
    // Re-scan before every stability observation; a newly expanded section
    // changes the signature and therefore restarts the three-round counter.
    await expandVisibleDetails();
    let snapshot: ProductPageCollectionSnapshot;
    try {
      snapshot = await driver.snapshot();
    } catch {
      break;
    }
    const signature = JSON.stringify([
      Math.max(0, Math.round(snapshot.scrollHeight)),
      clean(snapshot.detailHash),
      [...new Set(snapshot.productImageKeys.map(clean).filter(Boolean))].sort(),
    ]);
    // The snapshot is the current DOM truth. Do not keep an old positive
    // count latched after a lazy control was successfully expanded later.
    pendingDetailControls = Math.max(0, snapshot.pendingDetailControls || 0);
    const noPendingDetails = detailExpansionComplete && pendingDetailControls === 0;
    if (snapshot.atBottom && noPendingDetails) {
      stableRounds = signature === previousSignature ? stableRounds + 1 : 1;
    } else {
      stableRounds = 0;
    }
    previousSignature = signature;
    if (stableRounds >= requiredStableRounds) break;
    try {
      await driver.scrollNext();
      await driver.wait(Math.max(0, options.waitMilliseconds ?? 350));
    } catch {
      break;
    }
  }
  const scrollState = stableRounds >= requiredStableRounds ? "converged" : "incomplete";
  const detailState = currentDetailState();

  let collected: {
    html: string;
    text: string;
    detailTextTruncated?: boolean;
    securityText?: string;
  };
  try {
    collected = await driver.collect();
  } catch {
    return unavailableCollectionResult("page_unavailable");
  }
  const title = meta(collected.html, "og:title")
    || clean(collected.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
  const description = meta(collected.html, "og:description") || meta(collected.html, "description");
  if (isProductSecurityChallenge(title, description, collected.securityText || collected.text)) {
    return unavailableCollectionResult("page_unavailable");
  }
  const structured = structuredProductEvidence(collected.html, canonicalFinalUrl);
  // Navigation succeeded, so a missing exact-PID router model is incomplete
  // product evidence rather than a false "page could not be opened" report.
  if (!structured) return unavailableCollectionResult("page_incomplete", {
    html: collected.html,
    text: collected.text,
    diagnostics: {
      details: collected.detailTextTruncated ? "incomplete" : detailState,
      scroll: scrollState,
      stableRounds,
      expectedImageCount: 0,
      usableImageCount: 0,
    },
  });

  const probed: Array<{ index: number; url: string; dataUrl: string } | null> =
    Array.from({ length: structured.imageCandidates.length }, () => null);
  let nextImageIndex = 0;
  const probeWorker = async () => {
    while (nextImageIndex < structured.imageCandidates.length) {
      const index = nextImageIndex;
      nextImageIndex += 1;
      const candidateUrls = structured.imageCandidates[index];
      let usableImage: { index: number; url: string; dataUrl: string } | null = null;
      for (const url of candidateUrls) {
        try {
          const image = await driver.probeImage(url);
          if (image?.dataUrl) {
            usableImage = { index, url, dataUrl: image.dataUrl };
            break;
          }
        } catch {
          // Try the next trusted CDN variant declared for the same logical image.
        }
      }
      probed[index] = usableImage;
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(4, structured.imageCandidates.length) },
    () => probeWorker(),
  ));
  const usable = probed.filter((item): item is { index: number; url: string; dataUrl: string } => Boolean(item));
  const diagnostics = {
    details: collected.detailTextTruncated ? "incomplete" as const : detailState,
    scroll: scrollState,
    stableRounds,
    expectedImageCount: structured.imageCandidates.length,
    usableImageCount: usable.length,
  } as const;
  if (collected.detailTextTruncated || detailState === "incomplete" || scrollState === "incomplete") {
    return unavailableCollectionResult("page_incomplete", {
      html: collected.html,
      text: collected.text,
      sourceImageUrls: usable.map((item) => item.url),
      imageDataUrls: usable.map((item) => item.dataUrl),
      diagnostics,
    });
  }

  const canonicalUrl = canonicalFinalUrl;
  const captureId = clean(options.captureId) || `product-page-${pid}-${Date.now().toString(36)}`;
  const images: CapturedProductImage[] = usable.map((item) => ({
    id: `product-image-${item.index + 1}`,
    dataUrl: item.dataUrl,
    role: item.index === 0 ? "cover" : "detail",
  }));
  const coverage: ProductPageCoverage = {
    identity: "exact",
    details: detailState,
    scroll: "converged",
    expectedImageCount: structured.imageCandidates.length,
    usableImageCount: images.length,
  };
  const scopedDetailText = clean(collected.text).slice(0, 300_000);
  const fragments: CapturedProductFragment[] = [...structured.fragments];
  if (scopedDetailText
    && !fragments.some((fragment) => clean(fragment.text) === scopedDetailText)) {
    fragments.push({ id: "scoped-dom-details", kind: "scoped_dom", text: scopedDetailText });
  }
  fragments.splice(64);
  const substantiveTextLength = fragments
    .filter((fragment) => fragment.id !== "router-title")
    .reduce((total, fragment) => total + clean(fragment.text).length, 0);
  // A complete exact-PID description is sufficient evidence even when the
  // seller publishes only video media. A bare title plus zero images is not.
  if (!images.length && substantiveTextLength < 200) {
    return unavailableCollectionResult("all_product_images_unavailable", {
      html: collected.html,
      text: collected.text,
      diagnostics,
    });
  }
  const digestInput = {
    captureId,
    pid,
    canonicalUrl,
    fragments,
    images,
    coverage,
  };
  const capture: CapturedProductPage = {
    ...digestInput,
    sourceDigest: createProductCaptureDigest(digestInput),
  };
  return {
    capture,
    errorCode: "",
    html: collected.html,
    text: collected.text,
    sourceImageUrls: usable.map((item) => item.url),
    imageDataUrls: usable.map((item) => item.dataUrl),
    diagnostics,
  };
}

const PRODUCT_DETAIL_ROOT_SELECTORS = [
  '[data-e2e*="product-description" i]',
  '[data-e2e*="pdp-description" i]',
  '[class*="product-description" i]',
  '[class*="pdp-description" i]',
  '[id*="product-description" i]',
] as const;

const PRODUCT_GALLERY_ROOT_SELECTORS = [
  '[data-e2e*="product-image" i]',
  '[data-e2e*="pdp-gallery" i]',
  '[class*="product-gallery" i]',
  '[class*="pdp-gallery" i]',
  '[class*="product-image" i]',
] as const;

const PRODUCT_MAIN_ROOT_SELECTORS = [
  '[data-e2e*="pdp-container" i]',
  '[data-e2e*="product-page" i]',
  "main",
] as const;

const EXCLUDED_PRODUCT_SCOPE_PATTERN = String.raw`(?:customer[-_\s]*reviews?|reviews?|ratings?|recommended|recommendation|you[-_\s]*may[-_\s]*also[-_\s]*like|related[-_\s]*products?|similar[-_\s]*products?|more[-_\s]*products?|comments?|about[-_\s]*this[-_\s]*shop|seller|shop[-_\s]*info|store[-_\s]*info|accessor(?:y|ies)|frequently[-_\s]*bought|评价|评论|推荐|相似商品|更多商品|关于店铺|店铺信息|商家信息|配件)`;

export function isExcludedProductSectionDescriptor(value: string) {
  return new RegExp(EXCLUDED_PRODUCT_SCOPE_PATTERN, "i").test(clean(value));
}

type BrowserScopeInput = {
  detailSelectors: string[];
  gallerySelectors: string[];
  mainSelectors: string[];
  excludedPattern: string;
  detailLabels: string[];
};

function productScopeStateInBrowser(input: BrowserScopeInput) {
  const excluded = new RegExp(input.excludedPattern, "i");
  const labelSet = new Set(input.detailLabels.map((label) => label.replace(/\s+/g, " ").trim().toLowerCase()));
  const descriptor = (element: Element) => [
    element.id,
    element.getAttribute("class") || "",
    element.getAttribute("data-e2e") || "",
    element.getAttribute("data-testid") || "",
    element.getAttribute("aria-label") || "",
  ].join(" ");
  const structuralHeading = (element: Element) => {
    const directHeading = Array.from(element.children).find((child) => (
      /^H[1-6]$/.test(child.tagName) || child.getAttribute("role") === "heading"
    ));
    return (directHeading?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160);
  };
  const excludedElement = (element: Element, boundary?: Element) => {
    let current: Element | null = element;
    while (current && current !== boundary && current !== document.body && current !== document.documentElement) {
      if (excluded.test(descriptor(current)) || excluded.test(structuralHeading(current))) return true;
      current = current.parentElement;
    }
    return false;
  };
  const dedupeOutermost = (items: HTMLElement[]) => [...new Set(items)]
    .filter((candidate, index, all) => !all.some((other, otherIndex) => (
      otherIndex !== index && other.contains(candidate)
    )));
  const detailRoots = Array.from(document.querySelectorAll<HTMLElement>(input.detailSelectors.join(",")))
    .filter((element) => !excludedElement(element));
  for (const heading of Array.from(document.querySelectorAll<HTMLElement>("h1,h2,h3,h4,[role=heading]"))) {
    const label = (heading.innerText || "").replace(/\s+/g, " ").trim();
    if (!/^(?:商品详情|产品详情|Product details)$/i.test(label)) continue;
    const root = heading.closest<HTMLElement>("section,article");
    if (root && root !== document.body && !excludedElement(root)) detailRoots.push(root);
  }
  const trustedDetailRoots = dedupeOutermost(detailRoots);
  const galleryRoots = dedupeOutermost(
    Array.from(document.querySelectorAll<HTMLElement>(input.gallerySelectors.join(",")))
      .filter((element) => !excludedElement(element)),
  );
  const pruneClone = (root: HTMLElement) => {
    const clone = root.cloneNode(true) as HTMLElement;
    for (const node of Array.from(clone.querySelectorAll<HTMLElement>("*"))) {
      if (excluded.test(descriptor(node)) || excluded.test(structuralHeading(node))) node.remove();
    }
    clone.querySelectorAll("script,style,noscript,template,[hidden],[aria-hidden='true']")
      .forEach((node) => node.remove());
    return clone;
  };
  const detailText = trustedDetailRoots
    .map((root) => pruneClone(root).textContent || "")
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
  let hash = 2166136261;
  for (let index = 0; index < detailText.length; index += 1) {
    hash ^= detailText.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const captureRoots = dedupeOutermost([...galleryRoots, ...trustedDetailRoots]);
  const productImageKeys = captureRoots.flatMap((root) => (
    Array.from(root.querySelectorAll<HTMLImageElement>("img"))
      .filter((image) => !excludedElement(image, root))
      .flatMap((image) => [image.currentSrc, image.src, image.getAttribute("data-src") || ""])
  )).filter(Boolean);
  const visible = (element: HTMLElement) => {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden"
      && rect.width > 0 && rect.height > 0
      && !element.hasAttribute("disabled") && element.getAttribute("aria-disabled") !== "true";
  };
  const pendingDetailControls = trustedDetailRoots.reduce((count, root) => {
    const controls = Array.from(root.querySelectorAll<HTMLElement>("button,[role=button],a"))
      .filter((element) => !excludedElement(element, root))
      .filter((control) => {
        const label = (control.innerText || control.getAttribute("aria-label") || "")
          .replace(/\s+/g, " ").trim().toLowerCase();
        return labelSet.has(label) && visible(control);
      });
    const verifiedKeys = new Set((root.getAttribute("data-codex-product-expanded-keys") || "")
      .split("\n").filter(Boolean));
    const pending = controls.filter((control, index) => {
      const label = (control.innerText || control.getAttribute("aria-label") || "")
        .replace(/\s+/g, " ").trim().toLowerCase();
      const identity = control.id || control.getAttribute("aria-controls")
        || control.getAttribute("data-e2e") || control.getAttribute("data-testid")
        || control.getAttribute("data-index") || control.getAttribute("href") || String(index);
      return control.getAttribute("aria-expanded") !== "true"
        && control.getAttribute("data-codex-product-expanded") !== "1"
        && !verifiedKeys.has(`${label}:${identity}`);
    }).length;
    const unresolved = root.getAttribute("data-codex-product-expand-unresolved") === "1" ? 1 : 0;
    return count + pending + unresolved;
  }, 0);
  const unboundDetailControls = Array.from(document.querySelectorAll<HTMLElement>("button,[role=button],a"))
    .filter((element) => !excludedElement(element))
    .filter((control) => {
      const label = (control.innerText || control.getAttribute("aria-label") || "")
        .replace(/\s+/g, " ").trim().toLowerCase();
      return labelSet.has(label) && visible(control)
        && !trustedDetailRoots.some((root) => root.contains(control));
    }).length;

  const mainRoot = input.mainSelectors
    .flatMap((selector) => Array.from(document.querySelectorAll<HTMLElement>(selector)))
    .find((element) => !excludedElement(element));
  let captureBottom = Math.max(window.innerHeight, ...captureRoots.map((root) => (
    root.getBoundingClientRect().bottom + window.scrollY
  )));
  if (mainRoot) {
    let mainBottom = mainRoot.getBoundingClientRect().bottom + window.scrollY;
    const excludedDescendants = Array.from(mainRoot.querySelectorAll<HTMLElement>("section,article,aside,nav,div"))
      .filter((element) => excluded.test(descriptor(element)) || excluded.test(structuralHeading(element)))
      .map((element) => element.getBoundingClientRect().top + window.scrollY)
      .filter((top) => top > 20);
    if (excludedDescendants.length) mainBottom = Math.min(mainBottom, ...excludedDescendants);
    captureBottom = Math.max(captureBottom, mainBottom);
  }
  return {
    atBottom: window.scrollY + window.innerHeight >= captureBottom - 10,
    scrollHeight: Math.max(0, Math.round(captureBottom)),
    detailHash: (hash >>> 0).toString(16),
    productImageKeys: [...new Set(productImageKeys)].sort(),
    pendingDetailControls: pendingDetailControls + unboundDetailControls,
    detailText: detailText.slice(0, 300_000),
    detailTextTruncated: detailText.length > 300_000,
    captureBottom,
  };
}

async function expandProductDetailsInBrowser(input: BrowserScopeInput) {
  const excluded = new RegExp(input.excludedPattern, "i");
  const labelSet = new Set(input.detailLabels.map((label) => label.replace(/\s+/g, " ").trim().toLowerCase()));
  const descriptor = (element: Element) => [
    element.id,
    element.getAttribute("class") || "",
    element.getAttribute("data-e2e") || "",
    element.getAttribute("data-testid") || "",
    element.getAttribute("aria-label") || "",
  ].join(" ");
  const structuralHeading = (element: Element) => {
    const directHeading = Array.from(element.children).find((child) => (
      /^H[1-6]$/.test(child.tagName) || child.getAttribute("role") === "heading"
    ));
    return (directHeading?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160);
  };
  const excludedElement = (element: Element, boundary?: Element) => {
    let current: Element | null = element;
    while (current && current !== boundary && current !== document.body && current !== document.documentElement) {
      if (excluded.test(descriptor(current)) || excluded.test(structuralHeading(current))) return true;
      current = current.parentElement;
    }
    return false;
  };
  const roots = Array.from(document.querySelectorAll<HTMLElement>(input.detailSelectors.join(",")))
    .filter((element) => !excludedElement(element));
  for (const heading of Array.from(document.querySelectorAll<HTMLElement>("h1,h2,h3,h4,[role=heading]"))) {
    const label = (heading.innerText || "").replace(/\s+/g, " ").trim();
    if (!/^(?:商品详情|产品详情|Product details)$/i.test(label)) continue;
    const root = heading.closest<HTMLElement>("section,article");
    if (root && root !== document.body && !excludedElement(root)) roots.push(root);
  }
  const trustedRoots = [...new Set(roots)].filter((candidate, index, all) => !all.some((other, otherIndex) => (
    otherIndex !== index && other.contains(candidate)
  )));
  const safeText = (root: HTMLElement) => {
    const clone = root.cloneNode(true) as HTMLElement;
    for (const node of Array.from(clone.querySelectorAll<HTMLElement>("*"))) {
      if (excluded.test(descriptor(node)) || excluded.test(structuralHeading(node))) node.remove();
    }
    clone.querySelectorAll("script,style,noscript,template,[hidden],[aria-hidden='true']")
      .forEach((node) => node.remove());
    return (clone.textContent || "").replace(/\s+/g, " ").trim();
  };
  const visible = (element: HTMLElement) => {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden"
      && rect.width > 0 && rect.height > 0
      && !element.hasAttribute("disabled") && element.getAttribute("aria-disabled") !== "true";
  };
  const unboundDetailControls = Array.from(document.querySelectorAll<HTMLElement>("button,[role=button],a"))
    .filter((element) => !excludedElement(element))
    .filter((control) => {
      const label = (control.innerText || control.getAttribute("aria-label") || "")
        .replace(/\s+/g, " ").trim().toLowerCase();
      return labelSet.has(label) && visible(control)
        && !trustedRoots.some((root) => root.contains(control));
    }).length;
  let found = unboundDetailControls > 0;
  let failed = unboundDetailControls > 0;
  for (const root of trustedRoots) {
    const controls = Array.from(root.querySelectorAll<HTMLElement>("button,[role=button],a"))
      .filter((element) => !excludedElement(element, root))
      .filter((element) => {
        const label = (element.innerText || element.getAttribute("aria-label") || "")
          .replace(/\s+/g, " ").trim().toLowerCase();
        return labelSet.has(label) && visible(element);
      });
    if (controls.length) found = true;
    for (const [index, control] of controls.entries()) {
      if (control.getAttribute("aria-expanded") === "true"
        || control.getAttribute("data-codex-product-expanded") === "1") continue;
      const label = (control.innerText || control.getAttribute("aria-label") || "")
        .replace(/\s+/g, " ").trim().toLowerCase();
      const identity = control.id || control.getAttribute("aria-controls")
        || control.getAttribute("data-e2e") || control.getAttribute("data-testid")
        || control.getAttribute("data-index") || control.getAttribute("href") || String(index);
      const key = `${label}:${identity}`;
      const verifiedKeys = new Set((root.getAttribute("data-codex-product-expanded-keys") || "").split("\n").filter(Boolean));
      if (verifiedKeys.has(key)) continue;
      const beforeText = safeText(root);
      const marker = `product-expand-${Date.now()}-${index}`;
      control.setAttribute("data-codex-product-expand", marker);
      control.click();
      await new Promise((resolve) => setTimeout(resolve, 450));
      const current = document.querySelector<HTMLElement>(`[data-codex-product-expand="${marker}"]`);
      const afterText = safeText(root);
      const expanded = current?.getAttribute("aria-expanded") === "true"
        || afterText.length > beforeText.length + 5;
      current?.removeAttribute("data-codex-product-expand");
      if (expanded) {
        current?.setAttribute("data-codex-product-expanded", "1");
        verifiedKeys.add(key);
        root.setAttribute("data-codex-product-expanded-keys", [...verifiedKeys].join("\n"));
      } else {
        failed = true;
        root.setAttribute("data-codex-product-expand-unresolved", "1");
      }
    }
    const remainingCandidates = Array.from(root.querySelectorAll<HTMLElement>("button,[role=button],a"))
      .filter((element) => !excludedElement(element, root))
      .filter((element) => {
        const label = (element.innerText || element.getAttribute("aria-label") || "")
          .replace(/\s+/g, " ").trim().toLowerCase();
        return labelSet.has(label) && visible(element);
      });
    const verifiedKeys = new Set((root.getAttribute("data-codex-product-expanded-keys") || "")
      .split("\n").filter(Boolean));
    const remaining = remainingCandidates.filter((element, index) => {
      const label = (element.innerText || element.getAttribute("aria-label") || "")
        .replace(/\s+/g, " ").trim().toLowerCase();
      const identity = element.id || element.getAttribute("aria-controls")
        || element.getAttribute("data-e2e") || element.getAttribute("data-testid")
        || element.getAttribute("data-index") || element.getAttribute("href") || String(index);
      return element.getAttribute("aria-expanded") !== "true"
        && element.getAttribute("data-codex-product-expanded") !== "1"
        && !verifiedKeys.has(`${label}:${identity}`);
    });
    if (!remaining.length && !failed) root.removeAttribute("data-codex-product-expand-unresolved");
  }
  const pendingCount = trustedRoots.reduce((count, root) => {
    const unresolved = root.getAttribute("data-codex-product-expand-unresolved") === "1" ? 1 : 0;
    const candidates = Array.from(root.querySelectorAll<HTMLElement>("button,[role=button],a"))
      .filter((element) => !excludedElement(element, root))
      .filter((element) => {
        const label = (element.innerText || element.getAttribute("aria-label") || "")
          .replace(/\s+/g, " ").trim().toLowerCase();
        return labelSet.has(label) && visible(element);
      });
    const verifiedKeys = new Set((root.getAttribute("data-codex-product-expanded-keys") || "")
      .split("\n").filter(Boolean));
    const controls = candidates.filter((element, index) => {
      const label = (element.innerText || element.getAttribute("aria-label") || "")
        .replace(/\s+/g, " ").trim().toLowerCase();
      const identity = element.id || element.getAttribute("aria-controls")
        || element.getAttribute("data-e2e") || element.getAttribute("data-testid")
        || element.getAttribute("data-index") || element.getAttribute("href") || String(index);
      return element.getAttribute("aria-expanded") !== "true"
        && element.getAttribute("data-codex-product-expanded") !== "1"
        && !verifiedKeys.has(`${label}:${identity}`);
    }).length;
    return count + unresolved + controls;
  }, unboundDetailControls);
  return { found: found || pendingCount > 0, expanded: pendingCount === 0 && !failed, pendingCount };
}

const productBrowserScopeInput = (): BrowserScopeInput => ({
  detailSelectors: [...PRODUCT_DETAIL_ROOT_SELECTORS],
  gallerySelectors: [...PRODUCT_GALLERY_ROOT_SELECTORS],
  mainSelectors: [...PRODUCT_MAIN_ROOT_SELECTORS],
  excludedPattern: EXCLUDED_PRODUCT_SCOPE_PATTERN,
  detailLabels: [...PRODUCT_DETAIL_CONTROL_LABELS],
});

export function createProductPageCollectionDriver(page: Page): ProductPageCollectionDriver {
  let navigationGuardInstalled = false;
  let expectedPid = "";
  return {
    async navigate(url) {
      expectedPid = productIdFromOfficialTikTokPath(url);
      if (!navigationGuardInstalled) {
        await page.route("**/*", async (route, request) => {
          const requestUrl = request.url();
          if (isObviouslyPrivateNetworkUrl(requestUrl)
            || (request.isNavigationRequest() && !isTrustedProductNavigationUrl(requestUrl, expectedPid))) {
            await route.abort("blockedbyclient");
            return;
          }
          await route.continue();
        });
        navigationGuardInstalled = true;
      }
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      return { ok: !response || response.ok(), finalUrl: page.url(), status: response?.status() || 0 };
    },
    async expandProductDetails(labels) {
      return page.evaluate(expandProductDetailsInBrowser, {
        ...productBrowserScopeInput(),
        detailLabels: [...labels],
      });
    },
    async resetToTop() {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(200);
    },
    async snapshot() {
      const state = await page.evaluate(productScopeStateInBrowser, productBrowserScopeInput());
      return {
        atBottom: state.atBottom,
        scrollHeight: state.scrollHeight,
        detailHash: state.detailHash,
        productImageKeys: state.productImageKeys,
        pendingDetailControls: state.pendingDetailControls,
      };
    },
    async scrollNext() {
      const state = await page.evaluate(productScopeStateInBrowser, productBrowserScopeInput());
      await page.evaluate((captureBottom) => {
        const next = Math.min(
          captureBottom,
          window.scrollY + Math.max(700, window.innerHeight * 0.85),
        );
        window.scrollTo(0, next);
      }, state.captureBottom);
    },
    async wait(milliseconds) {
      await page.waitForTimeout(milliseconds);
    },
    async collect() {
      const [html, state, securityText] = await Promise.all([
        page.content(),
        page.evaluate(productScopeStateInBrowser, productBrowserScopeInput()),
        page.locator("body").innerText({ timeout: 2_000 }).catch(() => ""),
      ]);
      return {
        html,
        text: state.detailText,
        detailTextTruncated: state.detailTextTruncated,
        securityText: securityText.slice(0, 3_000),
      };
    },
    async probeImage(url) {
      const safeUrl = safeTikTokProductImageUrl(url);
      if (!safeUrl) return null;
      // Do not follow a CDN redirect to an arbitrary/private host. The router's
      // next trusted url_list entry is the only allowed fallback.
      const response = await page.context().request.get(safeUrl, {
        timeout: 15_000,
        maxRedirects: 0,
      });
      if (!response.ok()) return null;
      const headers = response.headers();
      const contentType = headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() || "";
      if (!/^image\/(?:png|jpeg|jpg|webp)$/.test(contentType)) return null;
      const declaredLength = Number(headers["content-length"] || 0);
      if (Number.isFinite(declaredLength) && declaredLength > 8 * 1024 * 1024) return null;
      const body = await response.body();
      if (body.length < 32 || body.length > 8 * 1024 * 1024) return null;
      const dataUrl = `data:${contentType === "image/jpg" ? "image/jpeg" : contentType};base64,${body.toString("base64")}`;
      const dimensions = await page.evaluate((source) => new Promise<{ width: number; height: number } | null>((resolve) => {
        const image = new Image();
        const timer = window.setTimeout(() => resolve(null), 5_000);
        image.onload = () => {
          window.clearTimeout(timer);
          resolve({ width: image.naturalWidth, height: image.naturalHeight });
        };
        image.onerror = () => {
          window.clearTimeout(timer);
          resolve(null);
        };
        image.src = source;
      }), dataUrl);
      return dimensions && hasUsableProductImageDimensions(dimensions.width, dimensions.height)
        ? { dataUrl }
        : null;
    },
  };
}

let browserQueue: Promise<void> = Promise.resolve();

async function readExpandedProductPage(productUrl: string): Promise<ProductPageCollectionResult | null> {
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
      return collectProductPageWithDriver(createProductPageCollectionDriver(page), productUrl);
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
      // Once an exact-PID router model exists, its own fields are the entire
      // trust boundary. Body/meta text and DOM images can belong to a
      // recommendation, stale hydration block, or different product.
      text: structured.text,
      imageUrls: expanded.sourceImageUrls.length ? expanded.sourceImageUrls : structured.imageUrls,
      imageDataUrls: expanded.imageDataUrls,
      error: "",
      corroboratingText: structured.corroboratingText,
      capture: expanded.capture,
      captureErrorCode: expanded.errorCode,
    };
  }
  if (!title && !description && expanded.text.length < 300) return null;
  return {
    title,
    description,
    text: expanded.text.slice(0, 20_000),
    imageUrls: expanded.sourceImageUrls.slice(0, MAX_PRODUCT_IMAGES),
    imageDataUrls: expanded.imageDataUrls,
    sku: "",
    error: "",
    structured: false,
    corroboratingText: "",
    capture: expanded.capture,
    captureErrorCode: expanded.errorCode,
  };
}

export async function captureProductPage(
  productUrl: string,
  hints: Pick<ProductParseHints, "pid"> = {},
): Promise<ProductPageCaptureResult> {
  const canonicalUrl = productUrl.trim();
  const pathPid = productIdFromOfficialTikTokPath(canonicalUrl);
  const expectedPid = clean(hints.pid) || pathPid;
  if (!isExactTikTokProductSource(canonicalUrl, expectedPid)) {
    return { ok: false, capture: null, errorCode: "page_unavailable" };
  }
  const collected = await readExpandedProductPage(canonicalUrl);
  if (!collected || !collected.capture || collected.errorCode) {
    return {
      ok: false,
      capture: collected?.capture || null,
      errorCode: collected?.errorCode || "page_unavailable",
    };
  }
  return { ok: true, capture: collected.capture, errorCode: "" };
}

export async function fetchTrustedTikTokProductResponse(
  fetchUrl: string,
  productId: string,
  init: RequestInit = {},
) {
  let currentUrl = fetchUrl;
  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    if (!isTrustedProductNavigationUrl(currentUrl, productId)) return null;
    const response = await fetchWithProxy(currentUrl, { ...init, redirect: "manual" });
    const observedUrl = response.url || currentUrl;
    if (!isTrustedProductNavigationUrl(observedUrl, productId)) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, finalUrl: observedUrl };
    }
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (!location || redirectCount === 5) return null;
    try {
      currentUrl = new URL(location, observedUrl).toString();
    } catch {
      return null;
    }
  }
  return null;
}

async function readProductPage(productUrl: string): Promise<ProductPageResult> {
  let lastError = "商品页没有公开资料";
  // Chromium is an independent authenticated source path. Do not make it
  // contingent on a preceding anonymous fetch succeeding: TikTok commonly
  // rejects the latter while the persisted browser session can still open PDPs.
  const expanded = await readExpandedProductPage(productUrl);
  const expandedResult = expanded ? expandedProductResult(expanded, productUrl) : null;
  if (expandedResult?.structured) return expandedResult;
  for (const [index, fetchUrl] of tiktokProductFetchUrls(productUrl).entries()) {
    try {
      const fetched = await fetchTrustedTikTokProductResponse(fetchUrl, productIdFromOfficialTikTokPath(productUrl), {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: AbortSignal.timeout(index === 0 ? 20_000 : 10_000),
      });
      if (!fetched) {
        lastError = "商品页跳转到了不受信任的地址";
        continue;
      }
      const { response } = fetched;
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
        if (expandedResult) return expandedResult;
        lastError = "商品页要求安全验证";
        continue;
      }
      const structured = structuredProductEvidence(html, productUrl);
      const bestStructured = expandedResult?.structured
        ? expandedResult
        : structured
          ? {
              ...structured,
              imageUrls: expanded?.sourceImageUrls.length ? expanded.sourceImageUrls : structured.imageUrls,
              imageDataUrls: expanded?.imageDataUrls || [],
              capture: expanded?.capture || null,
              captureErrorCode: expanded?.errorCode || "page_unavailable" as ProductPageCaptureErrorCode,
            }
          : expandedResult;
      if (bestStructured) {
        return {
          ...bestStructured,
          // Do not append expanded body text/images to an exact structured
          // product. `expandedProductResult` already isolates its router model.
          text: bestStructured.text,
          imageUrls: bestStructured.imageUrls,
          error: "",
          corroboratingText: bestStructured.corroboratingText,
        };
      }
      if (title || metaDescription || visibleText.length >= 300) {
        return {
          title,
          description: metaDescription,
          text: [visibleText, expanded?.text].filter(Boolean).join("\n").slice(0, 20_000),
          imageUrls: [...extractProductImageUrls(html, productUrl), ...(expanded?.sourceImageUrls || [])]
            .filter((url, imageIndex, all) => all.indexOf(url) === imageIndex)
            .slice(0, MAX_PRODUCT_IMAGES),
          imageDataUrls: expanded?.imageDataUrls,
          sku: "",
          error: "",
          structured: false,
          corroboratingText: "",
          capture: expanded?.capture,
          captureErrorCode: expanded?.errorCode,
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
  return {
    title: "",
    description: "",
    text: "",
    imageUrls: [],
    sku: "",
    error: lastError,
    structured: false,
    corroboratingText: "",
    capture: expanded?.capture || null,
    captureErrorCode: expanded?.errorCode || "page_unavailable",
  };
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

function safeProductParserError(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error || "商品页恢复失败");
  return raw
    .replace(/^商品资料解析失败[：:]\s*/i, "")
    .replace(/\bauthorization\s*:\s*(?:bearer|basic)?\s*\S+/gi, "[已隐藏]")
    .replace(/\bbearer\s+\S+/gi, "[已隐藏]")
    .replace(/(?:api[_ -]?key|app[_ -]?secret|webhook[_ -]?secret)\s*[:=]?\s*\S+/gi, "[已隐藏]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 320) || "商品页恢复失败";
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
  const directFailure = input.providerError
    ? `${input.pageError ? `${input.pageError}；` : ""}AI 提取未得到足够的可验证资料（${input.providerError}）`
    : input.pageError;
  if (input.searchError) {
    return `${directFailure ? `${directFailure}；` : ""}联网检索失败：${input.searchError}`;
  }
  if (input.exactSourceMatched && !input.trustedEvidenceAvailable) {
    return `${directFailure ? `${directFailure}；` : ""}联网检索找到了同 PID 的官方商品页，但链接路径没有可独立验证的商品资料`;
  }
  if (input.exactSourceMatched) {
    return `${directFailure ? `${directFailure}；` : ""}联网检索找到了同 PID 的官方商品页，但链接路径没有足够的白名单商品资料`;
  }
  if (input.pageError === "商品页要求安全验证") {
    return "商品页要求安全验证，联网检索也未找到与该 PID 完全匹配的官方公开商品页";
  }
  return directFailure
    ? `${directFailure}；联网检索也未找到与该 PID 完全匹配的官方公开商品页`
    : "联网检索没有找到与该 PID 完全匹配的官方公开商品页";
}

async function parsePublicProductPageInternal(
  productUrl: string,
  hints: ProductParseHints = {},
  options: { allowExactSourceDiscovery: boolean } = { allowExactSourceDiscovery: true },
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
  if (process.env.OPENAI_PRODUCT_ANALYSIS_ENABLED !== "false") {
    const captureErrorCode = page.captureErrorCode || (!page.capture ? "page_unavailable" : "");
    if (captureErrorCode) {
      throw new ProductPageCaptureError(captureErrorCode, productPageCaptureMessage(captureErrorCode));
    }
    const startedAt = Date.now();
    try {
      const result = await parsedProductInfoFromOpenAICapture({
        capture: page.capture!,
        productNameHint: clean(hints.productName),
        base,
      });
      console.info("[product-parser] OpenAI product analysis", {
        pid: productId,
        stage: "complete_page_multimodal",
        outcome: "success",
        durationMs: Date.now() - startedAt,
        imageCount: page.capture!.images.length,
      });
      return result;
    } catch (error) {
      console.warn("[product-parser] OpenAI product analysis", {
        pid: productId,
        stage: "complete_page_multimodal",
        outcome: error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code || "failed")
          : "failed",
        durationMs: Date.now() - startedAt,
        imageCount: page.capture!.images.length,
      });
      throw error;
    }
  }
  // A successful HTML response is not automatically product evidence. Only
  // an exact-PID router `product_model` binds facts to the requested product;
  // body/meta content can be a recommendation carousel or stale page shell.
  // Unstructured pages are therefore URL-discovery inputs only and never
  // reach Qwen extraction or deterministic same-page claim mapping.
  const searchMode = !page.structured || !page.text;
  let searchResult: Awaited<ReturnType<typeof qwenFindExactProductSources>> | null = null;
  let searchError = "";
  let recoveredPageError = "";
  let exactSourceDiscoveryAttempted = false;
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
  const directDeterministicCandidate = !searchMode && page.structured
    ? trustedDirectSlug
      ? productInfoFromTrustedSlug(base, trustedDirectSlug, {
          sourceTitle: base.sourceTitle,
          corroboratingEvidence: page.corroboratingText,
          sourceUrl: canonicalUrl,
        })
      : withProductVerification(base, canonicalUrl)
    : null;
  const directDeterministicUsable = Boolean(
    directDeterministicCandidate && hasVerifiedProductFacts(directDeterministicCandidate),
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
    ? null
    : parsed ? normalizeParsed(parsed, base, page.text, { sourceUrl: canonicalUrl }) : null;
  let visualAnalysisStatus: ParsedProductInfo["visualAnalysisStatus"] = "unavailable";

  if (!searchMode
    && needsCompletenessRetry(normalized, page.text)
    && (providerReturnedModel || (initialUsedVisualModel && !directDeterministicUsable))) {
    parsed = await attemptProductModel("Qwen 文本重试", () => qwenExtract(prompt));
    const candidate = parsed ? normalizeParsed(parsed, base, page.text, { sourceUrl: canonicalUrl }) : null;
    normalized = preferMoreCompleteProductInfo(normalized, candidate);
  }

  // Explicit "N-in-1" lists are stronger than model summarization. If the
  // evidence contains a complete slash/plus-separated list, translate that
  // exact list with one small call so no verified function is silently lost.
  const bundleFeatures = searchMode ? [] : enumeratedBundleFeatures(page.text);
  if (normalized && bundleFeatures.length && normalized.coreFunctions.length < bundleFeatures.length) {
    const translated = await qwenTranslateBundleFeatures(bundleFeatures).catch(() => []);
    const verifiedTranslations = translated.length === bundleFeatures.length
      ? translated.filter((claim, index) => claimMeaningIsSupported(claim, bundleFeatures[index], "coreFunctions"))
      : [];
    if (verifiedTranslations.length) {
      normalized = withProductVerification({
        ...normalized,
        coreFunctions: [...new Set([...normalized.coreFunctions, ...verifiedTranslations])].slice(0, 5),
      }, canonicalUrl, normalized.verification?.rejectedFactCount || 0);
    }
  }

  // A model response with verified facts keeps priority. When it contains no
  // verified function, the deterministic same-page slug allowlist may fill
  // that missing field without replacing any model-grounded atomic fact.
  if (!searchMode
    && normalized
    && normalized.coreFunctions.length === 0
    && directDeterministicUsable) {
    normalized = preferMoreCompleteProductInfo(normalized, directDeterministicCandidate);
  }

  // A usable AI result always wins. Only after all direct extraction attempts
  // fail completeness/evidence checks may a strictly verified router-data
  // page use the deterministic slug allowlist. Every mapped fact must also be
  // present (and not directly negated) in that same page's structured text.
  if (!searchMode && (!normalized || !hasVerifiedProductFacts(normalized))) {
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

  // Discovery is URL-only. When the supplied endpoint is blocked or direct
  // extraction retains no facts, fetch the discovered same-PID PDP and run the
  // exact same strict parser over its actual page. Search prose is never read.
  if (!hasVerifiedProductFacts(normalized) && options.allowExactSourceDiscovery) {
    exactSourceDiscoveryAttempted = true;
    try {
      searchResult = await qwenFindExactProductSources(canonicalUrl);
      const recoveredUrl = searchResult.trustedSourceUrl;
      if (recoveredUrl && recoveredUrl !== canonicalUrl) {
        try {
          return await parsePublicProductPageInternal(recoveredUrl, { ...hints, pid: productId }, {
            allowExactSourceDiscovery: false,
          });
        } catch (error) {
          recoveredPageError = safeProductParserError(error);
        }
      }
      // If the recovered exact-PID PDP is still blocked, retain only the tiny
      // deterministic allowlist derivable from that official URL's slug. The
      // Responses prose, source title, and similar products remain untrusted.
      if (!hasVerifiedProductFacts(normalized)
        && searchResult.trustedEvidence
        && searchResult.trustedSourceUrl) {
        const slugCandidate = productInfoFromTrustedSlug(base, searchResult.trustedEvidence, {
          sourceTitle: searchResult.trustedEvidence,
          sourceUrl: searchResult.trustedSourceUrl,
        });
        if (hasVerifiedProductFacts(slugCandidate)) normalized = slugCandidate;
      }
    } catch (error) {
      searchError = providerFailure(error).detail;
    }
  }

  if (!normalized || !hasVerifiedProductFacts(normalized)) {
    throw new Error(`商品资料解析失败：${productParseFailureReason({
      searchMode: exactSourceDiscoveryAttempted,
      pageError: recoveredPageError || page.error,
      exactSourceMatched: searchResult?.exactSourceMatched === true,
      trustedEvidenceAvailable: Boolean(searchResult?.trustedEvidence),
      searchError,
      providerError: preferredProviderFailure(providerFailures),
    })}`);
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
  return withProductVerification(
    { ...normalized, sellingPoints: "", visualAnalysisStatus },
    normalized.verification?.sourceUrl || canonicalUrl,
    normalized.verification?.rejectedFactCount || 0,
  );
}

export async function parsePublicProductPage(
  productUrl: string,
  hints: ProductParseHints = {},
) {
  return parsePublicProductPageInternal(productUrl, hints, { allowExactSourceDiscovery: true });
}
