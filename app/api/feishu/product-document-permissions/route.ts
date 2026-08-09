import { NextRequest, NextResponse } from "next/server";
import { listProducts } from "@/lib/database";
import { getCompanyDocumentPermission, setCompanyManaged } from "@/lib/feishu/document";
import { ensureFeishuConnection, getConnectedFeishuChannel } from "@/lib/feishu/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(request: NextRequest, body: Record<string, unknown>) {
  const expected = process.env.FEISHU_AUTOMATION_WEBHOOK_SECRET?.trim();
  if (!expected) return null;
  return request.headers.get("x-feishu-automation-secret") === expected
    || String(body.secret || "") === expected;
}

function permissionMatches(permission: Awaited<ReturnType<typeof getCompanyDocumentPermission>>) {
  return permission?.external_access_entity === "closed"
    && permission.link_share_entity === "tenant_editable"
    && permission.share_entity === "same_tenant"
    && permission.manage_collaborator_entity === "collaborator_can_edit"
    && permission.security_entity === "anyone_can_edit";
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const auth = authorized(request, body);
    if (auth === null) return NextResponse.json({ error: "云端尚未配置权限接口密钥" }, { status: 503 });
    if (!auth) return NextResponse.json({ error: "权限接口密钥不正确" }, { status: 401 });
    if (body.confirm !== "company_manage_all_generated_documents") {
      return NextResponse.json({ error: "缺少批量权限变更确认" }, { status: 400 });
    }

    const channel = getConnectedFeishuChannel() || await ensureFeishuConnection();
    if (!channel) return NextResponse.json({ error: "飞书应用尚未连接" }, { status: 503 });
    const products = listProducts().filter((product) => product.documentId && product.documentUrl);
    const results = [];
    for (const product of products) {
      try {
        await setCompanyManaged(channel.rawClient, String(product.documentId));
        const permission = await getCompanyDocumentPermission(channel.rawClient, String(product.documentId));
        results.push({
          name: product.name,
          pid: product.pid,
          documentUrl: product.documentUrl,
          ok: permissionMatches(permission),
          permission,
        });
      } catch (error) {
        results.push({
          name: product.name,
          pid: product.pid,
          documentUrl: product.documentUrl,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return NextResponse.json({
      ok: results.every((result) => result.ok),
      total: results.length,
      succeeded: results.filter((result) => result.ok).length,
      failed: results.filter((result) => !result.ok).length,
      results,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "批量设置文档权限失败" }, { status: 500 });
  }
}
