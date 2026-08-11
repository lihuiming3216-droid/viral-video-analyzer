import { NextRequest, NextResponse } from "next/server";
import { listProducts } from "@/lib/database";
import {
  migrateProductDocument,
  validateProductDocumentFolder,
} from "@/lib/feishu/document";
import {
  ProductDocumentMigrationBusyError,
  withProductDocumentMigrationLock,
} from "@/lib/feishu/product-document-migration-lock.mjs";
import { ensureFeishuConnection, getConnectedFeishuChannel } from "@/lib/feishu/runtime";
import { getFeishuSettings } from "@/lib/feishu/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CONFIRMATION = "move_and_transfer_all_product_documents";
const MIGRATION_INTERVAL_MS = 3_200;

function authorized(request: NextRequest, body: Record<string, unknown>) {
  const expected = process.env.FEISHU_AUTOMATION_WEBHOOK_SECRET?.trim();
  if (!expected) return null;
  return request.headers.get("x-feishu-automation-secret") === expected
    || String(body.secret || "") === expected;
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requestedProductId(body: Record<string, unknown>) {
  if (!("productId" in body) || body.productId == null) return "";
  if (typeof body.productId !== "string" || !body.productId.trim()) return null;
  return body.productId.trim();
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const auth = authorized(request, body);
    if (auth === null) return NextResponse.json({ error: "云端尚未配置迁移接口密钥" }, { status: 503 });
    if (!auth) return NextResponse.json({ error: "迁移接口密钥不正确" }, { status: 401 });

    const productId = requestedProductId(body);
    if (productId === null) {
      return NextResponse.json({ error: "productId 必须是非空字符串" }, { status: 400 });
    }

    const dryRun = body.confirm !== CONFIRMATION;
    const handleRequest = async () => {
      const settings = getFeishuSettings();
      const folderToken = settings.productFolderToken?.trim();
      if (!folderToken) {
        return NextResponse.json({ error: "尚未配置产品说明文档文件夹" }, { status: 503 });
      }

      const availableProducts = listProducts().filter((product) => product.documentId && product.documentUrl);
      const products = productId
        ? availableProducts.filter((product) => product.id === productId)
        : availableProducts;
      if (productId && products.length === 0) {
        return NextResponse.json({ error: "未找到该产品，或该产品尚无飞书文档", productId }, { status: 404 });
      }

      const channel = getConnectedFeishuChannel() || await ensureFeishuConnection();
      if (!channel) return NextResponse.json({ error: "飞书应用尚未连接" }, { status: 503 });

      // This read-only check also resolves the personal folder's owner. The app
      // must have access through the group that the folder was shared with.
      const target = await validateProductDocumentFolder(channel.rawClient, folderToken);
      if (dryRun) {
        return NextResponse.json({
          ok: true,
          dryRun: true,
          requiredConfirm: CONFIRMATION,
          target,
          total: products.length,
          products: products.map((product) => ({
            productId: product.id,
            name: product.name,
            pid: product.pid,
            documentId: product.documentId,
            documentUrl: product.documentUrl,
            action: "move_and_transfer",
          })),
        });
      }

      const results = [];
      for (let index = 0; index < products.length; index += 1) {
        const product = products[index];
        // Feishu allows at most 20 file moves per minute. Waiting 3.2 seconds
        // between attempts leaves a small buffer and applies even after errors.
        if (index > 0) await sleep(MIGRATION_INTERVAL_MS);
        try {
          const migration = await migrateProductDocument(channel.rawClient, {
            documentToken: String(product.documentId),
            folderToken: target.folderToken,
          });
          results.push({
            productId: product.id,
            name: product.name,
            pid: product.pid,
            documentId: product.documentId,
            documentUrl: product.documentUrl,
            // The helper treats an already-moved or already-transferred document
            // as success, making retries safe after a partial earlier run.
            ok: true,
            ...migration,
          });
        } catch (error) {
          results.push({
            productId: product.id,
            name: product.name,
            pid: product.pid,
            documentId: product.documentId,
            documentUrl: product.documentUrl,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return NextResponse.json({
        ok: results.every((result) => result.ok),
        dryRun: false,
        target,
        total: results.length,
        succeeded: results.filter((result) => result.ok).length,
        failed: results.filter((result) => !result.ok).length,
        results,
      });
    };

    // Planning remains available while a migration runs and never acquires the
    // mutating lock. Confirmed requests contend before any setup or API work.
    if (dryRun) return await handleRequest();
    try {
      return await withProductDocumentMigrationLock(handleRequest);
    } catch (error) {
      if (error instanceof ProductDocumentMigrationBusyError) {
        return NextResponse.json({ error: "已有产品文档迁移正在执行，请稍后再试" }, { status: 409 });
      }
      throw error;
    }
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "迁移产品文档失败",
    }, { status: 500 });
  }
}
