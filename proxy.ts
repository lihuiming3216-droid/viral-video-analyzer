import { NextRequest, NextResponse } from "next/server";
import { checkAdminAuthorization, publicMachineRoute } from "@/lib/admin-auth";

export async function proxy(request: NextRequest) {
  if (publicMachineRoute(request.nextUrl.pathname, request.method, request.headers.has("next-action"))) return NextResponse.next();
  const scheme = request.headers.get("x-forwarded-proto") || request.nextUrl.protocol.replace(":", "");
  if (process.env.NODE_ENV === "production" && scheme !== "https") {
    return new NextResponse("后台需要HTTPS，请使用HTTPS地址登录", { status: 426 });
  }
  const auth = await checkAdminAuthorization(request.headers.get("authorization"), request.headers.get("x-real-ip") || "unknown");
  if (auth !== "ok") {
    return new NextResponse(auth === "unconfigured" ? "后台登录尚未配置，请联系管理员" : auth === "busy" ? "登录请求过多，请稍后再试" : "请登录后台", {
      status: auth === "unconfigured" ? 503 : auth === "busy" ? 429 : 401,
      headers: { "Cache-Control": "no-store", ...(auth === "unauthorized" ? { "WWW-Authenticate": 'Basic realm="Viral Admin", charset="UTF-8"' } : {}) },
    });
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    const origin = request.headers.get("origin");
    if (origin) {
      try { if (new URL(origin).host !== request.headers.get("host")) return new NextResponse("跨站请求已拒绝", { status: 403 }); }
      catch { return new NextResponse("请求来源无效", { status: 403 }); }
    }
    if (request.headers.get("sec-fetch-site") === "cross-site") return new NextResponse("跨站请求已拒绝", { status: 403 });
  }
  return NextResponse.next();
}

export const config = { matcher: ["/:path*"] };
