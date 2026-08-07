import { NextRequest, NextResponse } from "next/server";
import { getProduct, updateProduct } from "@/lib/database";
import { saveProductImage } from "@/lib/video-processing";

export const runtime = "nodejs";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    if (!getProduct(id)) return NextResponse.json({ error: "产品不存在" }, { status: 404 });
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "请选择产品图片" }, { status: 400 });
    const imagePath = await saveProductImage(id, file);
    return NextResponse.json({ product: updateProduct(id, { imagePath }) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "图片保存失败" }, { status: 500 });
  }
}
