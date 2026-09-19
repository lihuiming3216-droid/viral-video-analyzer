import { NextRequest, NextResponse } from "next/server";
import { startLogin, stateCookie, cookieOptions } from "@/lib/feishu/handcard-app/auth";
import { appError, privateHeaders, rateLimit } from "@/lib/feishu/handcard-app/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    rateLimit(`login:${request.headers.get("x-real-ip") || "unknown"}`);
    const login = startLogin();
    const response = NextResponse.redirect(login.url);
    for (const [name, value] of Object.entries(privateHeaders)) response.headers.set(name, value);
    response.cookies.set(stateCookie, login.cookie, { ...cookieOptions, maxAge: 300 });
    return response;
  } catch (error) { return appError(error); }
}
