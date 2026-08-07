import { NextRequest, NextResponse } from "next/server";
import { getDashboard } from "@/lib/database";
import { ensureFeishuConnection } from "@/lib/feishu/runtime";
import { resumePendingVideos } from "@/lib/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  void ensureFeishuConnection().catch(() => undefined);
  resumePendingVideos();
  const search = request.nextUrl.searchParams;
  return NextResponse.json(
    getDashboard({
      search: search.get("search") || "",
      productId: search.get("productId") || "",
      account: search.get("account") || "",
      date: search.get("date") || "",
    }),
  );
}
