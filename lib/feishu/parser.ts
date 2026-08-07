export interface ParsedFeishuSubmission {
  productName: string;
  pid: string;
  urls: string[];
  unsupportedUrls: string[];
  error: string;
}

const urlPattern = /https?:\/\/[^\s<>"']+/gi;

function cleanUrl(value: string) {
  return value.replace(/[，。；;、!！?？)）\]】}]+$/g, "");
}

function cleanProductName(value: string) {
  return value
    .replace(/<at\b[^>]*>.*?<\/at>/gi, " ")
    .replace(/@爆片分析机器人/gi, " ")
    .replace(/(?:帮我|请|麻烦|分析一下|分析|拆解一下|拆解|链接|视频)/gi, " ")
    .replace(/^[\s:：,，;；\-—]+|[\s:：,，;；\-—]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseFeishuSubmission(content: string): ParsedFeishuSubmission {
  const allUrls = (content.match(urlPattern) || []).map(cleanUrl);
  const urls = [...new Set(allUrls.filter((value) => {
    try {
      return new URL(value).hostname.toLowerCase().endsWith("tiktok.com");
    } catch {
      return false;
    }
  }))].slice(0, 10);
  const unsupportedUrls = allUrls.filter((value) => {
    try {
      return !new URL(value).hostname.toLowerCase().endsWith("tiktok.com");
    } catch {
      return true;
    }
  });
  let remaining = content;
  allUrls.forEach((url) => { remaining = remaining.replace(url, " "); });

  const labeledPid = remaining.match(/\bPID\s*[:：]?\s*([A-Za-z0-9_-]+)/i);
  let pid = labeledPid?.[1]?.trim() || "";
  if (labeledPid) remaining = remaining.replace(labeledPid[0], " ");

  const labeledProduct = remaining.match(/产品(?:名称)?\s*[:：]\s*([^\n,，;；]+)/i);
  let productName = labeledProduct?.[1]?.trim() || "";
  if (labeledProduct) remaining = remaining.replace(labeledProduct[0], " ");

  if (!productName) {
    const cleaned = cleanProductName(remaining);
    const lines = cleaned.split(/\r?\n/).map(cleanProductName).filter(Boolean);
    productName = lines[0] || cleaned;
  }

  if (!pid && productName) {
    const implicitPid = productName.match(/^(.+?)\s+([0-9]{4,})$/);
    if (implicitPid) {
      productName = implicitPid[1].trim();
      pid = implicitPid[2];
    }
  }

  let error = "";
  if (!urls.length) error = unsupportedUrls.length ? "目前只支持 TikTok 链接" : "没有识别到 TikTok 链接";
  else if (!productName) error = "没有识别到产品名称，请发送“产品名称 + TikTok 链接”";
  else if (allUrls.filter((value) => {
    try { return new URL(value).hostname.toLowerCase().endsWith("tiktok.com"); } catch { return false; }
  }).length > 10) error = "一次最多提交 10 条 TikTok 链接";

  return { productName, pid, urls, unsupportedUrls, error };
}
