import { NextRequest, NextResponse } from "next/server";
import { testOpenAIConnection } from "@/lib/providers/openai";
import { testQwenConnection } from "@/lib/providers/qwen";
import { testTokScriptConnection } from "@/lib/providers/tokscript";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const { provider } = await request.json();
    const result = provider === "openai"
      ? await testOpenAIConnection()
      : provider === "qwen"
        ? await testQwenConnection()
        : provider === "tokscript"
          ? await testTokScriptConnection()
          : null;
    if (!result) return NextResponse.json({ error: "服务类型无效" }, { status: 400 });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "连接测试失败" }, { status: 500 });
  }
}
