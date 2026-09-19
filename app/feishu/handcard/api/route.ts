import { NextRequest, NextResponse } from "next/server";
import { appConfig, assertSameOrigin, HandcardAppError } from "@/lib/feishu/handcard-app/core";
import { readSession, sessionCookie, cookieOptions, logout } from "@/lib/feishu/handcard-app/auth";
import { discoverTables, loadTable, saveTable } from "@/lib/feishu/handcard-app/tables";
import { appError, privateHeaders, rateLimit, smallJson } from "@/lib/feishu/handcard-app/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const session = await readSession(request.cookies.get(sessionCookie)?.value);
    return NextResponse.json({ name: session.name }, { headers: privateHeaders });
  } catch (error) { return appError(error); }
}

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request.headers, appConfig().origin);
    const session = await readSession(request.cookies.get(sessionCookie)?.value);
    rateLimit(`config:${session.openId}`);
    const body = await smallJson(request);
    let data;
    if (body.action === "discover") data = await discoverTables(session, body.link);
    else if (body.action === "load") data = await loadTable(session, body.link, body.tableId);
    else if (body.action === "save") data = await saveTable(session, body);
    else throw new HandcardAppError("不支持此操作。");
    return NextResponse.json(data, { headers: privateHeaders });
  } catch (error) { return appError(error); }
}

export async function DELETE(request: NextRequest) {
  try {
    assertSameOrigin(request.headers, appConfig().origin);
    await logout(request.cookies.get(sessionCookie)?.value);
    const response = NextResponse.json({ ok: true }, { headers: privateHeaders });
    response.cookies.set(sessionCookie, "", { ...cookieOptions, maxAge: 0 });
    return response;
  } catch (error) { return appError(error); }
}
