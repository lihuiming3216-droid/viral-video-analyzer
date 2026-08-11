import { NextRequest, NextResponse } from "next/server";
import { createProduct, getProductByPid, updateProduct } from "@/lib/database";
import { ensureProductDocument } from "@/lib/feishu/document";
import { ensureFeishuConnection, getConnectedFeishuChannel } from "@/lib/feishu/runtime";
import { hasUsableProductInfo, isExactTikTokProductSource, parsePublicProductPage } from "@/lib/product-parser";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const name = String(body.name || "").trim();
    const pid = String(body.pid || "").trim();
    const productUrl = String(body.productUrl || "").trim();
    if (!name || !pid || !productUrl) {
      return NextResponse.json({ error: "产品名称和商品ID必须同时填写" }, { status: 400 });
    }
    if (!isExactTikTokProductSource(productUrl, pid)) {
      return NextResponse.json({ error: "产品链接必须是 HTTPS TikTok 官方商品详情页，且链接 PID 必须与商品ID一致" }, { status: 400 });
    }

    let product = getProductByPid(pid);
    let parsed = null;
    const hasCachedProductInfo = Boolean(product
      && product.productUrl === productUrl
      && hasUsableProductInfo(product)
      && product.visualAnalyzedAt);
    if (body.parseProduct !== false && (body.forceProductParse === true || !hasCachedProductInfo)) {
      // Parsing fails closed: invalid links and transient fetch failures must
      // not replace a verified URL, erase evidence, or rewrite an old document.
      parsed = await parsePublicProductPage(productUrl, { productName: name, pid });
    }
    // Explicit parseProduct:false preserves the manual creation workflow. In
    // the default path this line is reached only after parsing succeeds.
    product = product || createProduct({ name, pid, productUrl });
    if (parsed) {
      updateProduct(product.id, {
        name,
        pid,
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
