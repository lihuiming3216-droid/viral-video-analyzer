import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { encryptSecret, decryptSecret } from "@/lib/crypto";
import { getDb } from "@/lib/database";
import { execute, queryRow } from "@/lib/db/query";
import { appConfig, HandcardAppError } from "@/lib/feishu/handcard-app/core";

export const sessionCookie = "__Host-handcard-session";
export const stateCookie = "__Host-handcard-login";
export const cookieOptions = { httpOnly: true, secure: true, sameSite: "lax" as const, path: "/" };
// bitable:app covers both field listing and drive permission.member.auth.
// No write OpenAPI is called with this user token.
export const oauthScopes = "bitable:app wiki:wiki:readonly";
const apiOrigin = "https://open.feishu.cn";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Never return provider error text: it may contain credentials or request details. */
export async function feishuJson<T>(url: string, init: RequestInit, hint: string): Promise<T> {
  try {
    const res = await fetch(url, { ...init, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000) });
    const value = await res.json();
    if (!res.ok || (value.code !== undefined && value.code !== 0) || value.error) throw new Error("upstream");
    return value as T;
  } catch { throw new HandcardAppError(hint, 502); }
}

export async function userApi<T>(token: string, path: string) {
  if (!path.startsWith("/open-apis/")) throw new Error("Invalid API path");
  return feishuJson<{ data: T }>(`${apiOrigin}${path}`, { headers: { Authorization: `Bearer ${token}` } },
    "飞书读取失败：请确认应用权限已发布、你有表格权限；登录过期时请重新登录。");
}

export function startLogin() {
  const config = appConfig();
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const cookie = encryptSecret(JSON.stringify({ state, verifier, appId: config.appId, expires: Date.now() + 300_000 }));
  const url = new URL("https://accounts.feishu.cn/open-apis/authen/v1/authorize");
  url.search = new URLSearchParams({ client_id: config.appId, redirect_uri: config.callback,
    response_type: "code", scope: oauthScopes, state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" }).toString();
  return { cookie, url: url.toString() };
}

export function loginVerifier(cookie: string, state: string) {
  const config = appConfig();
  try {
    if (cookie.length > 4096 || !/^[A-Za-z0-9_-]{43}$/.test(state)) throw new Error();
    const parts = cookie.split(":");
    if (parts.length !== 4 || parts[0] !== "v1" || parts.slice(1).some(part => Buffer.from(part, "base64").toString("base64") !== part)) throw new Error();
    const value = JSON.parse(decryptSecret(cookie));
    if (value.appId !== config.appId || !Number.isFinite(value.expires) || value.expires <= Date.now()
      || typeof value.state !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.verifier)
      || !timingSafeEqual(Buffer.from(digest(state)), Buffer.from(digest(value.state)))) throw new Error();
    return value.verifier as string;
  } catch { throw new HandcardAppError("登录验证已过期或不匹配，请重新登录。", 401); }
}

export async function currentIdentity(token: string) {
  const config = appConfig();
  const { data } = await userApi<{ open_id?: string; name?: string; tenant_key?: string }>(token, "/open-apis/authen/v1/user_info");
  if (!data?.open_id || data.tenant_key !== config.tenantKey) throw new HandcardAppError("此应用仅限本公司成员使用。", 403);
  return { openId: data.open_id, name: data.name || "同事", tenantKey: data.tenant_key };
}

export async function completeLogin(code: string, verifier: string, oldSession?: string) {
  const config = appConfig();
  if (!code || code.length > 2048) throw new HandcardAppError("未获得飞书授权，请重新登录。", 401);
  const started = Date.now();
  const token = await feishuJson<{ access_token?: string; expires_in?: number }>("https://accounts.feishu.cn/oauth/v3/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: config.appId, client_secret: config.appSecret,
      code, redirect_uri: config.callback, code_verifier: verifier }).toString(),
  }, "飞书登录失败，请检查应用可用范围、重定向地址和已发布权限，然后重新登录。");
  if (typeof token.access_token !== "string" || !token.access_token || !Number.isFinite(token.expires_in) || token.expires_in! <= 60) {
    throw new HandcardAppError("飞书未返回有效的登录凭证。", 502);
  }
  const user = await currentIdentity(token.access_token);
  const expires = started + Math.min(token.expires_in! - 30, 7200) * 1000;
  const session = randomBytes(32).toString("base64url");
  const db = await getDb();
  await execute(db, "DELETE FROM feishu_handcard_sessions WHERE expires_at <= ?", [Date.now()]);
  await execute(db, `INSERT INTO feishu_handcard_sessions
    (session_hash, app_id, tenant_key, open_id, display_name, encrypted_token, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  [digest(session), config.appId, user.tenantKey, user.openId, user.name, encryptSecret(token.access_token), expires]);
  if (oldSession) await logout(oldSession);
  return { session, maxAge: Math.max(1, Math.floor((expires - Date.now()) / 1000)) };
}

export async function readSession(session: string | undefined) {
  const config = appConfig();
  if (!session || !/^[A-Za-z0-9_-]{43}$/.test(session)) throw new HandcardAppError("请先使用飞书登录。", 401);
  const row = await queryRow(await getDb(), "SELECT * FROM feishu_handcard_sessions WHERE session_hash=? AND expires_at>?",
    [digest(session), Date.now()]);
  if (!row || row.app_id !== config.appId || row.tenant_key !== config.tenantKey) throw new HandcardAppError("登录已过期，请重新登录。", 401);
  return { openId: String(row.open_id), name: String(row.display_name), token: decryptSecret(String(row.encrypted_token)) };
}

export async function logout(session?: string) {
  if (session && /^[A-Za-z0-9_-]{43}$/.test(session)) await execute(await getDb(), "DELETE FROM feishu_handcard_sessions WHERE session_hash=?", [digest(session)]);
}
