import { NextRequest, NextResponse } from "next/server";
import { getProduct, updateProduct } from "@/lib/database";
import { refreshProductLearning } from "@/lib/learning";

export const runtime = "nodejs";

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const product = await getProduct(id);
  return product ? NextResponse.json({ product }) : NextResponse.json({ error: "产品不存在" }, { status: 404 });
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const product = await updateProduct(id, await request.json());
  if (product) await refreshProductLearning(id);
  return product ? NextResponse.json({ product }) : NextResponse.json({ error: "产品不存在" }, { status: 404 });
}
