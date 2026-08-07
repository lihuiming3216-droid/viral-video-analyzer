import { NextRequest, NextResponse } from "next/server";
import { encryptSecret } from "@/lib/crypto";
import { getFeishuRuntimeStatus, restartFeishuConnection, stopFeishuConnection } from "@/lib/feishu/runtime";
import { saveFeishuSettings } from "@/lib/feishu/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ settings: getFeishuRuntimeStatus() });
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const appId = String(body.appId || "").trim();
    const enabled = body.enabled === true;
    if (enabled && !appId) return NextResponse.json({ error: "请输入飞书 App ID" }, { status: 400 });
    const encryptedAppSecret = body.clearSecret
      ? null
      : typeof body.appSecret === "string" && body.appSecret.trim()
        ? encryptSecret(body.appSecret.trim())
        : undefined;
    const settings = saveFeishuSettings({
      appId,
      encryptedAppSecret,
      enabled,
      publicBaseUrl: String(body.publicBaseUrl || "http://localhost:3000"),
      rootFolderToken: typeof body.rootFolderToken === "string" ? body.rootFolderToken : undefined,
      rootFolderUrl: typeof body.rootFolderUrl === "string" ? body.rootFolderUrl : undefined,
    });
    if (enabled && !settings.hasAppSecret) {
      return NextResponse.json({ error: "请输入飞书 App Secret" }, { status: 400 });
    }
    if (enabled) await restartFeishuConnection();
    else await stopFeishuConnection();
    return NextResponse.json({ settings: getFeishuRuntimeStatus() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "保存飞书设置失败" }, { status: 500 });
  }
}
