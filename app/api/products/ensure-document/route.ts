import { NextRequest, NextResponse } from "next/server";
import { createProduct, getProductByPid, updateProduct } from "@/lib/database";
import { ensureProductDocument } from "@/lib/feishu/document";
import { ensureFeishuConnection, getConnectedFeishuChannel } from "@/lib/feishu/runtime";
import { hasUsableProductInfo, parsePublicProductPage } from "@/lib/product-parser";
import { canonicalTikTokProductUrl } from "@/lib/tiktok-product";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const name = String(body.name || "").trim();
    const pid = String(body.pid || "").trim();
    const productUrl = canonicalTikTokProductUrl(String(body.productUrl || "").trim(), pid);
    if (!name || !pid || !productUrl) {
      return NextResponse.json({ error: "产品名称和商品ID必须同时填写" }, { status: 400 });
    }

    let product = getProductByPid(pid) || createProduct({ name, pid, productUrl });
    let parsed = null;
    const hasCachedProductInfo = product.productUrl === productUrl
      && hasUsableProductInfo(product)
      && Boolean(product.visualAnalyzedAt);
    if (body.parseProduct !== false && (body.forceProductParse === true || !hasCachedProductInfo)) {
      try {
        parsed = await parsePublicProductPage(productUrl, { productName: name, pid });
      } catch (error) {
        product = updateProduct(product.id, {
          name,
          pid,
          productUrl,
          sku: "",
          sellingPoints: "",
          targetAudience: "",
          coreFunctions: [],
          productParameters: "",
          usageMethod: "",
          usageScenes: "",
          sourceTitle: "",
          sourceDescription: "",
          sourceImageUrls: [],
          visualEvidence: "",
          visualAnalysisStatus: "unavailable",
          visualAnalyzedAt: null,
        }) || product;
        if (product.documentId && product.documentUrl) {
          const cleanupChannel = getConnectedFeishuChannel() || await ensureFeishuConnection();
          if (cleanupChannel) await ensureProductDocument(cleanupChannel.rawClient, product).catch(() => undefined);
        }
        throw error;
      }
    }
    if (parsed) {
      updateProduct(product.id, {
        productUrl,
        sku: parsed.sku,
        sellingPoints: "",
        targetAudience: parsed.audience,
        coreFunctions: parsed.coreFunctions,
        productParameters: parsed.productParameters,
        usageMethod: parsed.usageMethod,
        usageScenes: parsed.scenes,
        sourceTitle: parsed.sourceTitle,
        sourceDescription: parsed.sourceDescription,
        sourceImageUrls: parsed.sourceImageUrls,
        visualEvidence: parsed.visualEvidence,
        visualAnalysisStatus: parsed.visualAnalysisStatus,
        visualAnalyzedAt: new Date().toISOString(),
      });
    }
    let currentProduct = getProductByPid(pid) || product;
    if (Array.isArray(body.propImages)) {
      currentProduct = updateProduct(currentProduct.id, { propImages: body.propImages.map(String).slice(0, 3) }) || currentProduct;
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
    return NextResponse.json({ ok: true, product: currentProduct, parsed, result });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "创建产品文档失败" }, { status: 500 });
  }
}
