import "server-only";
import { createHash, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
type Credential = { username: string; salt: string; passwordHash: string };
const accepted = new Map<string, number>();
const failedLogins = new Map<string, { count: number; expires: number }>();
let activeChecks = 0;

export function publicMachineRoute(pathname: string, method: string, serverAction = false) {
  if (serverAction) return false;
  if ((method === "GET" || method === "HEAD") && (pathname.startsWith("/_next/static/") || pathname === "/_next/image" || pathname === "/favicon.ico")) return true;
  if ((method === "GET" || method === "HEAD") && (pathname === "/api/health" || pathname.startsWith("/api/media/")
    || /^\/api\/products\/[^/]+\/image$/.test(pathname))) return true;
  return method === "POST" && [
    "/api/feishu/automation", "/api/feishu/product-doc-sync",
    "/feishu/subtitle", "/feishu/tokscript-subtitle", "/feishu/link-subtitle",
  ].includes(pathname);
}

/** Passwords are salted scrypt hashes, stored only in the private persisted volume. */
export async function checkAdminAuthorization(header: string | null, client = "unknown"): Promise<"ok" | "unauthorized" | "unconfigured" | "busy"> {
  let credential: Credential;
  try {
    const file = path.join(process.cwd(), ".data", "admin-auth.json");
    credential = JSON.parse(await readFile(file, "utf8")) as Credential;
    if (typeof credential.username !== "string" || !credential.username || !/^[a-f0-9]{32}$/.test(credential.salt) || !/^[a-f0-9]{128}$/.test(credential.passwordHash)) return "unconfigured";
  } catch { return "unconfigured"; }
  if (!header?.startsWith("Basic ") || header.length > 8192) return "unauthorized";
  const prior = failedLogins.get(client);
  if (prior && prior.expires > Date.now() && prior.count >= 10) return "busy";
  const rejectLogin = () => {
    const current = failedLogins.get(client);
    if (failedLogins.size >= 4096 && !failedLogins.has(client)) {
      for (const [key, entry] of failedLogins) if (entry.expires <= Date.now()) failedLogins.delete(key);
      if (failedLogins.size >= 4096) return "busy" as const;
    }
    failedLogins.set(client, { count: current && current.expires > Date.now() ? current.count + 1 : 1, expires: current && current.expires > Date.now() ? current.expires : Date.now() + 15 * 60_000 });
    return "unauthorized" as const;
  };
  const text = Buffer.from(header.slice(6), "base64").toString("utf8");
  const colon = text.indexOf(":");
  if (colon < 1) return rejectLogin();
  const digest = (value: string) => createHash("sha256").update(value).digest();
  if (!timingSafeEqual(digest(text.slice(0, colon)), digest(credential.username))) return rejectLogin();
  const fingerprint = createHash("sha256").update(header).update(credential.salt).update(credential.passwordHash).digest("hex");
  if ((accepted.get(fingerprint) || 0) > Date.now()) return "ok";
  if (activeChecks >= 4) return "busy";
  activeChecks++;
  try {
    const key = await scrypt(text.slice(colon + 1), credential.salt, 64) as Buffer;
    if (!timingSafeEqual(key, Buffer.from(credential.passwordHash, "hex"))) return rejectLogin();
    failedLogins.delete(client);
    if (accepted.size >= 64) accepted.clear();
    accepted.set(fingerprint, Date.now() + 60_000);
    return "ok";
  } finally { activeChecks--; }
}
