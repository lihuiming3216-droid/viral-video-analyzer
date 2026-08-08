import { NextRequest, NextResponse } from "next/server";
import { createProduct, getProductByPid, updateProduct } from "@/lib/database";
import { ensureProductDocument } from "@/lib/feishu/document";
import { ensureFeishuConnection, getConnectedFeishuChannel } from "@/lib/feishu/runtime";
import { parsePublicProductPage } from "@/lib/product-parser";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const name = String(body.name || "").trim();
    const pid = String(body.pid || "").trim();
    const productUrl = String(body.productUrl || "").trim();
    if (!name || !pid || !productUrl) {
      return NextResponse.json({ error: "产品名称、商品ID和产品链接必须同时填写" }, { status: 400 });
    }

    const product = getProductByPid(pid) || createProduct({ name, pid, productUrl });
    let parsed = null;
    const hasCachedProductInfo = product.productUrl === productUrl
      && (product.productParameters || product.usageMethod || product.coreFunctions.length);
    if (body.parseProduct !== false && !hasCachedProductInfo) {
      try { parsed = await parsePublicProductPage(productUrl); } catch { parsed = null; }
    }
    if (parsed) {
      updateProduct(product.id, {
        productUrl,
        sku: parsed.sku || product.sku,
        sellingPoints: parsed.sellingPoints,
        targetAudience: parsed.audience,
        coreFunctions: parsed.coreFunctions,
        productParameters: parsed.productParameters,
        usageMethod: parsed.usageMethod,
        usageScenes: parsed.scenes,
        sourceTitle: parsed.sourceTitle,
        sourceDescription: parsed.sourceDescription,
      });
    }
    const currentProduct = getProductByPid(pid) || product;
    if (Array.isArray(body.propImages)) {
      updateProduct(currentProduct.id, { propImages: body.propImages.map(String).slice(0, 3) });
    }
    const channel = getConnectedFeishuChannel() || await ensureFeishuConnection();
    if (!channel) return NextResponse.json({ error: "飞书应用尚未连接" }, { status: 400 });
    const result = await ensureProductDocument(channel.rawClient, currentProduct, {
      sellingPoints: String(body.sellingPoints || parsed?.sellingPoints || currentProduct.sellingPoints || ""),
      productParameters: String(body.productParameters || parsed?.productParameters || currentProduct.productParameters || ""),
      usageMethod: String(body.usageMethod || parsed?.usageMethod || currentProduct.usageMethod || ""),
      audience: String(body.audience || parsed?.audience || currentProduct.targetAudience || ""),
      scenes: String(body.scenes || parsed?.scenes || currentProduct.usageScenes || ""),
      coreFunctions: Array.isArray(body.coreFunctions) ? body.coreFunctions.map(String) : parsed?.coreFunctions || currentProduct.coreFunctions || [],
      propImages: Array.isArray(body.propImages) ? body.propImages.map(String).slice(0, 3) : currentProduct.propImages,
    });
    return NextResponse.json({ ok: true, product, parsed, result });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "创建产品文档失败" }, { status: 500 });
  }
}
