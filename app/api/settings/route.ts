import { NextRequest, NextResponse } from "next/server";
import { listProviderSettings } from "@/lib/database";
import { saveSharedProvider } from "@/lib/ai/shared-settings";
import { AiConfigurationError } from "@/lib/ai/types";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ providers: await listProviderSettings() });
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const setting = await saveSharedProvider({
      provider: String(body.provider || ""),
      apiKey: typeof body.apiKey === "string" ? body.apiKey : "",
      clearKey: body.clearKey === true,
      baseUrl: String(body.baseUrl || "").trim(),
      model: String(body.model || "").trim(),
      enabled: body.enabled !== false,
    });
    return NextResponse.json({ setting });
  } catch (error) {
    return NextResponse.json({ error: error instanceof AiConfigurationError ? error.message : "保存设置失败" }, { status: error instanceof AiConfigurationError ? 400 : 500 });
  }
}
