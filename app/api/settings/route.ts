import { NextRequest, NextResponse } from "next/server";
import { encryptSecret } from "@/lib/crypto";
import { listProviderSettings, saveProviderSetting } from "@/lib/database";
import type { ProviderName } from "@/lib/types";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ providers: listProviderSettings() });
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const provider = String(body.provider || "") as ProviderName;
    if (!(["tokscript", "openai", "qwen"] as string[]).includes(provider)) {
      return NextResponse.json({ error: "服务类型无效" }, { status: 400 });
    }
    const encryptedApiKey = body.clearKey
      ? null
      : typeof body.apiKey === "string" && body.apiKey.trim()
        ? encryptSecret(body.apiKey.trim())
        : undefined;
    const setting = saveProviderSetting({
      provider,
      encryptedApiKey,
      baseUrl: String(body.baseUrl || "").trim(),
      model: String(body.model || "").trim(),
      enabled: body.enabled !== false,
    });
    return NextResponse.json({ setting });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "保存设置失败" }, { status: 500 });
  }
}
