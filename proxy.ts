import { NextRequest, NextResponse } from "next/server";

const WEBHOOK_PATHS = new Set([
  "/api/feishu/automation",
  "/api/feishu/product-doc-sync",
  "/api/feishu/product-document-permissions",
]);

function unauthorized(message = "需要登录") {
  return new NextResponse(message, {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Viral Video Analyzer", charset="UTF-8"' },
  });
}

function credentials(request: NextRequest) {
  const header = request.headers.get("authorization") || "";
  if (!header.startsWith("Basic ")) return null;
  try {
    const decoded = atob(header.slice(6));
    const separator = decoded.indexOf(":");
    if (separator < 0) return null;
    return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
  } catch {
    return null;
  }
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname === "/api/health" || WEBHOOK_PATHS.has(pathname)) return NextResponse.next();

  const expectedUsername = process.env.APP_BASIC_AUTH_USER?.trim() || "";
  const expectedPassword = process.env.APP_BASIC_AUTH_PASSWORD || "";
  if (!expectedUsername || !expectedPassword) {
    if (process.env.NODE_ENV !== "production") return NextResponse.next();
    return new NextResponse("后台访问认证尚未配置", { status: 503 });
  }

  const supplied = credentials(request);
  if (!supplied || supplied.username !== expectedUsername || supplied.password !== expectedPassword) {
    return unauthorized();
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
