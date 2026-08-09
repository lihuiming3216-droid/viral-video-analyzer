const TIKTOK_SHOP_SLUG = "zhenmi-cordless-blender-33oz-bpa-free-usb-rechargeable";

export function normalizeProductPid(pid: string) {
  return String(pid || "").trim().replace(/\D/g, "");
}

/**
 * Public link shown to employees. TikTok routes by PID, so the fixed slug is
 * intentionally shared by every product.
 */
export function tiktokProductUrlFromPid(pid: string) {
  const normalized = normalizeProductPid(pid);
  return normalized
    ? `https://shop.tiktok.com/us/pdp/${TIKTOK_SHOP_SLUG}/${normalized}?source=anchor`
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
  const normalized = normalizeProductPid(pid) || normalizeProductPid(
    (productUrl.match(/\d{6,}/g) || []).sort((a, b) => b.length - a.length)[0] || "",
  );
  return tiktokProductUrlFromPid(normalized) || productUrl.trim();
}
