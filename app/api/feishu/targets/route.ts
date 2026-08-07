import { NextResponse } from "next/server";
import { ensureFeishuConnection } from "@/lib/feishu/runtime";
import { listFeishuTargets } from "@/lib/feishu/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  await ensureFeishuConnection().catch(() => undefined);
  return NextResponse.json({ targets: listFeishuTargets() });
}
