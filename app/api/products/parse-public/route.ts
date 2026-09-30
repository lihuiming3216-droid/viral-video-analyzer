import { NextResponse } from "next/server";

export const runtime = "nodejs";

/** Retired entry point: never parse input, capture a page, or invoke a provider. */
export async function POST() {
  return NextResponse.json({
    ok: false,
    code: "PRODUCT_LINK_ANALYSIS_RETIRED",
    error: "商品链接分析入口已停用，请通过飞书表格的补录手卡按钮按 PID 获取商品资料",
  }, { status: 410, headers: { "Cache-Control": "no-store" } });
}
