import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/require-admin";
import { getChatgptFeishuClient } from "@/lib/feishu/runtime";
import { backfillProductCard } from "@/lib/products/backfill";

export const runtime = "nodejs";
export const maxDuration = 600;

export async function POST(request: Request) {
  await requireAdmin();
  const body = await request.json() as { pid?: unknown; documentId?: unknown };
  const result = await backfillProductCard(
    getChatgptFeishuClient(), String(body.pid || ""), String(body.documentId || ""),
  );
  return NextResponse.json(result.body, { status: result.status });
}
