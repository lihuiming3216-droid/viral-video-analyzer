import { NextRequest, NextResponse } from "next/server";
import { createProduct, listProducts } from "@/lib/database";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ products: listProducts() });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    if (!String(body.name || "").trim()) return NextResponse.json({ error: "请输入产品名称" }, { status: 400 });
    return NextResponse.json({ product: createProduct(body) }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "创建产品失败" }, { status: 500 });
  }
}
