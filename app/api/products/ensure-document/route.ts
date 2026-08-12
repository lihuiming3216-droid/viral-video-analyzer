import { NextRequest, NextResponse } from "next/server";
import { createProduct, getProductByPid, mergeVerifiedProductFacts, updateProduct } from "@/lib/database";
import { ensureProductDocument } from "@/lib/feishu/document";
import { ensureFeishuConnection, getConnectedFeishuChannel } from "@/lib/feishu/runtime";
import { isExactTikTokProductSource, parsePublicProductPage } from "@/lib/product-parser";

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
      && product.verifiedPid === pid
      && product.evidenceVersion
      && product.factsVerifiedAt);
    if (body.parseProduct !== false && (body.forceProductParse === true || !hasCachedProductInfo)) {
      // Parsing fails closed: invalid links and transient fetch failures must
      // not replace a verified URL, erase evidence, or rewrite an old document.
      parsed = await parsePublicProductPage(productUrl, { productName: name, pid });
    }
    // Explicit parseProduct:false preserves the manual creation workflow. In
    // the default path this line is reached only after parsing succeeds.
    product = product || createProduct({ name, pid, productUrl });
    if (parsed) {
      product = updateProduct(product.id, { name, pid, productUrl }) || product;
      const verification = parsed.verification;
      const acceptedFactCount = verification
        ? verification.acceptedFactCount ?? verification.safeFactCount ?? verification.verifiedFactCount
        : 0;
      if (!verification
        || acceptedFactCount <= 0
        || !verification.evidenceVersion
        || !isExactTikTokProductSource(verification.sourceUrl, pid)) {
        throw new Error("商品资料解析失败：没有取得任何通过安全校验的商品信息");
      }
      const acceptedFields = new Set(verification.acceptedFields || verification.verifiedFields);
      product = mergeVerifiedProductFacts(product.id, {
        pid,
        sourceUrl: verification.sourceUrl,
        evidenceVersion: verification.evidenceVersion,
        verifiedAt: new Date().toISOString(),
        sku: acceptedFields.has("sku") && parsed.sku ? parsed.sku : undefined,
        coreFunctions: acceptedFields.has("coreFunctions") && parsed.coreFunctions.length ? parsed.coreFunctions : undefined,
        productParameters: acceptedFields.has("productParameters") && parsed.productParameters ? parsed.productParameters : undefined,
        usageMethod: acceptedFields.has("usageMethod") && parsed.usageMethod ? parsed.usageMethod : undefined,
        targetAudience: acceptedFields.has("audience") && parsed.audience ? parsed.audience : undefined,
        usageScenes: acceptedFields.has("scenes") && parsed.scenes ? parsed.scenes : undefined,
        sourceTitle: parsed.sourceTitle || undefined,
        sourceDescription: parsed.sourceDescription || undefined,
        sourceImageUrls: parsed.sourceImageUrls.length ? parsed.sourceImageUrls : undefined,
        visualEvidence: parsed.visualEvidence || undefined,
        visualAnalysisStatus: parsed.visualAnalysisStatus === "completed" ? "completed" : undefined,
        factProvenance: verification.factProvenance,
      });
    }
    let currentProduct = getProductByPid(pid) || product;
    if (Array.isArray(body.propImages)) {
      currentProduct = updateProduct(currentProduct.id, { propImages: body.propImages.map(String).slice(0, 3) }) || currentProduct;
    }
    const channel = getConnectedFeishuChannel() || await ensureFeishuConnection();
    if (!channel) return NextResponse.json({ error: "飞书应用尚未连接" }, { status: 400 });
    const result = await ensureProductDocument(channel.rawClient, currentProduct, {
      sellingPoints: String(body.sellingPoints || currentProduct.sellingPoints || ""),
      // mergeVerifiedProductFacts has already combined this click's atomic
      // evidence with the same PID/evidence-version snapshot. Always render
      // that complete certified snapshot; rendering only `parsed` would drop
      // older still-valid facts whenever a refresh returns a partial result.
      productParameters: String(body.productParameters || currentProduct.productParameters || ""),
      usageMethod: String(body.usageMethod || currentProduct.usageMethod || ""),
      audience: String(body.audience || currentProduct.targetAudience || ""),
      scenes: String(body.scenes || currentProduct.usageScenes || ""),
      coreFunctions: Array.isArray(body.coreFunctions) ? body.coreFunctions.map(String) : currentProduct.coreFunctions || [],
      propImages: Array.isArray(body.propImages) ? body.propImages.map(String).slice(0, 3) : currentProduct.propImages,
    });
    return NextResponse.json({ ok: true, product: currentProduct, parsed, result });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "创建产品文档失败" }, { status: 500 });
  }
}
