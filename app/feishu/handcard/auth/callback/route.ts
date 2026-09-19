import { NextRequest, NextResponse } from "next/server";
import { appConfig } from "@/lib/feishu/handcard-app/core";
import { completeLogin, loginVerifier, stateCookie, sessionCookie, cookieOptions } from "@/lib/feishu/handcard-app/auth";
import { appError, privateHeaders, rateLimit } from "@/lib/feishu/handcard-app/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  let response: NextResponse;
  try {
    rateLimit(`callback:${request.headers.get("x-real-ip") || "unknown"}`);
    const verifier = loginVerifier(request.cookies.get(stateCookie)?.value || "", request.nextUrl.searchParams.get("state") || "");
    const result = await completeLogin(request.nextUrl.searchParams.get("code") || "", verifier, request.cookies.get(sessionCookie)?.value);
    response = NextResponse.redirect(`${appConfig().origin}/feishu/handcard`);
    response.cookies.set(sessionCookie, result.session, { ...cookieOptions, maxAge: result.maxAge });
  } catch {
    try { response = NextResponse.redirect(`${appConfig().origin}/feishu/handcard?loginError=1`); }
    catch (error) { response = appError(error); }
  }
  response.cookies.set(stateCookie, "", { ...cookieOptions, maxAge: 0 });
  for (const [name, value] of Object.entries(privateHeaders)) response.headers.set(name, value);
  return response;
}
