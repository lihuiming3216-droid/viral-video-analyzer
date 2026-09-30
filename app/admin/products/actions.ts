"use server";
import { requireAdmin } from "@/lib/require-admin";
import { reorganizeCatalogFromCache } from "@/lib/products/catalog-reorganize";
import { catalogError } from "@/lib/products/catalog-types";
import { AiConfigurationError } from "@/lib/ai/types";
import { getProduct } from "@/lib/database";
import { getChatgptFeishuClient } from "@/lib/feishu/chatgpt-app";
import { refreshProductCard } from "@/lib/products/backfill";
import { safeBackgroundError } from "@/lib/feishu/webhook-shared";

export async function reorganizeProductAction(_previous: { ok: boolean; message: string } | null, data: FormData) {
  await requireAdmin();
  if (data.get("confirmCharge") !== "on") return { ok: false, message: "请确认这次会产生模型费用，但不会再次调用出海匠" };
  try {
    await reorganizeCatalogFromCache(String(data.get("pid") || "").trim(), String(data.get("requestId") || ""));
    return { ok: true, message: "商品资料缓存已更新。已有内容需要替换时，请在下方对应手卡点击“刷新基础资料”；普通补录只补空白，其他手卡不会自动改动。" };
  } catch (error) { return { ok: false, message: error instanceof AiConfigurationError ? error.message : catalogError(error) }; }
}

export async function refreshProductCardAction(_previous: { ok: boolean; message: string } | null, data: FormData) {
  await requireAdmin();
  if (data.get("confirmOverwrite") !== "yes") return { ok: false, message: "请先确认覆盖这份手卡的基础资料" };
  try {
    const product = await getProduct(String(data.get("productId") || ""));
    if (!product?.pid || !product.documentId) return { ok: false, message: "产品没有关联可刷新的手卡" };
    const result = await refreshProductCard(getChatgptFeishuClient(), product.pid, product.documentId);
    if (!result.body.ok) return { ok: false, message: String(result.body.error || "刷新失败，未请求收费接口") };
    const count = Array.isArray(result.body.filled) ? result.body.filled.length : 0;
    return { ok: true, message: `已处理 ${count} 项基础资料${result.body.state === "partial" ? "；部分资料缺失或被编辑，原值已保留" : ""}。视频、翻译和其他区块未改动。` };
  } catch (error) { return { ok: false, message: safeBackgroundError(error) }; }
}
