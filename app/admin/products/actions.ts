"use server";
import { requireAdmin } from "@/lib/require-admin";
import { reorganizeCatalogFromCache } from "@/lib/products/catalog-reorganize";
import { catalogError } from "@/lib/products/catalog-types";
import { AiConfigurationError } from "@/lib/ai/types";

export async function reorganizeProductAction(_previous: { ok: boolean; message: string } | null, data: FormData) {
  await requireAdmin();
  if (data.get("confirmCharge") !== "on") return { ok: false, message: "请确认这次会产生模型费用，但不会再次调用出海匠" };
  try {
    await reorganizeCatalogFromCache(String(data.get("pid") || "").trim(), String(data.get("requestId") || ""));
    return { ok: true, message: "商品资料缓存已更新。请回飞书对应行点击补录手卡，写入新资料；其他手卡不会自动改动。" };
  } catch (error) { return { ok: false, message: error instanceof AiConfigurationError ? error.message : catalogError(error) }; }
}
