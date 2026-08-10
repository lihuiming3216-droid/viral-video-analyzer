export function normalizeProductPid(pid: string) {
  return String(pid || "").trim().replace(/\D/g, "");
}

export function isTikTokUrl(value: string) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === "https:"
      && (hostname === "tiktok.com" || hostname.endsWith(".tiktok.com"));
  } catch {
    return false;
  }
}

/** TikTok's stable PID entrypoint redirects to the product's real PDP slug. */
export function tiktokProductUrlFromPid(pid: string) {
  const normalized = normalizeProductPid(pid);
  return normalized
    ? `https://www.tiktok.com/view/product/${normalized}`
    : "";
}

/**
 * TikTok's own response advertises shop.tiktokw.us as its bypass/origin host.
 * Mainland ECS can read this host even when shop.tiktok.com is reset.
 */
export function tiktokProductFetchUrls(productUrl: string) {
  try {
    const url = new URL(productUrl);
    if (url.hostname !== "shop.tiktok.com") return [productUrl];
    const originUrl = new URL(productUrl);
    originUrl.hostname = "shop.tiktokw.us";
    return [originUrl.toString(), productUrl];
  } catch {
    return [productUrl];
  }
}

export function canonicalTikTokProductUrl(productUrl: string, pid = "") {
  const candidate = productUrl.trim();
  const urlPid = normalizeProductPid(
    (candidate.match(/\d{6,}/g) || []).sort((a, b) => b.length - a.length)[0] || "",
  );
  const normalized = normalizeProductPid(pid) || urlPid;
  if (candidate && isTikTokUrl(candidate) && (!normalized || !urlPid || urlPid === normalized)) return candidate;
  return tiktokProductUrlFromPid(normalized);
}
