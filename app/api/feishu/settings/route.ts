import { NextRequest, NextResponse } from "next/server";
import { encryptSecret } from "@/lib/crypto";
import { validateProductDocumentFolder } from "@/lib/feishu/document";
import {
  getConnectedFeishuChannel, getFeishuRuntimeStatus, restartFeishuConnection, stopFeishuConnection,
} from "@/lib/feishu/runtime";
import { clearFeishuFolderCache, getRawFeishuSettings, saveFeishuSettings } from "@/lib/feishu/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

class ProductFolderValidationError extends Error {}

function rawText(settings: Record<string, unknown>, key: string, fallback = "") {
  return settings[key] == null ? fallback : String(settings[key]);
}

async function restorePreviousSettings(previous: Record<string, unknown>) {
  const restored = saveFeishuSettings({
    appId: rawText(previous, "app_id"),
    encryptedAppSecret: previous.encrypted_app_secret == null ? null : String(previous.encrypted_app_secret),
    enabled: Boolean(previous.enabled),
    publicBaseUrl: rawText(previous, "public_base_url", "http://localhost:3000"),
    rootFolderToken: rawText(previous, "root_folder_token"),
    rootFolderUrl: rawText(previous, "root_folder_url"),
    productFolderToken: rawText(previous, "product_folder_token"),
    productFolderUrl: rawText(previous, "product_folder_url"),
  }, { clearReportFolderCache: false });
  try {
    if (restored.enabled) await restartFeishuConnection();
    else await stopFeishuConnection();
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function parseFeishuFolderInput(value: unknown) {
  const input = typeof value === "string" ? value.trim() : "";
  if (!input) return { token: "", url: "" };

  if (/^[A-Za-z0-9_-]+$/.test(input)) return { token: input, url: "" };

  try {
    const url = new URL(input);
    const hostname = url.hostname.toLowerCase();
    const isFeishuHost = hostname === "feishu.cn" || hostname.endsWith(".feishu.cn")
      || hostname === "larksuite.com" || hostname.endsWith(".larksuite.com");
    if (url.protocol !== "https:" || !isFeishuHost) return null;
    const match = url.pathname.match(/\/drive\/folder\/([^/?#]+)/);
    const token = match ? decodeURIComponent(match[1]).trim() : "";
    if (!token || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
    url.hash = "";
    url.search = "";
    return { token, url: url.toString().replace(/\/$/, "") };
  } catch {
    return null;
  }
}

export async function GET() {
  return NextResponse.json({ settings: getFeishuRuntimeStatus() });
}

export async function PUT(request: NextRequest) {
  try {
    const previous = getRawFeishuSettings();
    const body = await request.json();
    const appId = String(body.appId || "").trim();
    const enabled = body.enabled === true;
    if (enabled && !appId) return NextResponse.json({ error: "请输入飞书 App ID" }, { status: 400 });
    const encryptedAppSecret = body.clearSecret
      ? null
      : typeof body.appSecret === "string" && body.appSecret.trim()
        ? encryptSecret(body.appSecret.trim())
        : undefined;
    const hasProductFolderInput = Object.prototype.hasOwnProperty.call(body, "productFolderUrl")
      || Object.prototype.hasOwnProperty.call(body, "productFolderToken");
    const productFolder = hasProductFolderInput
      ? parseFeishuFolderInput(body.productFolderUrl ?? body.productFolderToken)
      : undefined;
    if (hasProductFolderInput && !productFolder) {
      return NextResponse.json({ error: "请输入正确的飞书文件夹完整链接" }, { status: 400 });
    }
    const settings = saveFeishuSettings({
      appId,
      encryptedAppSecret,
      enabled,
      publicBaseUrl: String(body.publicBaseUrl || "http://localhost:3000"),
      rootFolderToken: typeof body.rootFolderToken === "string" ? body.rootFolderToken : undefined,
      rootFolderUrl: typeof body.rootFolderUrl === "string" ? body.rootFolderUrl : undefined,
      productFolderToken: productFolder?.token,
      productFolderUrl: productFolder?.url,
    }, { clearReportFolderCache: false });
    try {
      if (enabled && !settings.hasAppSecret) throw new ProductFolderValidationError("请输入飞书 App Secret");
      if (enabled) {
        await restartFeishuConnection();
        if (settings.productFolderToken) {
          try {
            const channel = getConnectedFeishuChannel();
            if (!channel) throw new Error("飞书机器人未连接");
            await validateProductDocumentFolder(channel.rawClient, settings.productFolderToken);
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new ProductFolderValidationError(
              `产品说明文档文件夹未共享给包含机器人的群，或机器人权限不足：${detail}`,
            );
          }
        }
      } else await stopFeishuConnection();
      if (rawText(previous, "root_folder_token") !== settings.rootFolderToken) clearFeishuFolderCache();
    } catch (error) {
      const restoreError = await restorePreviousSettings(previous);
      const message = error instanceof Error ? error.message : "保存飞书设置失败";
      const suffix = restoreError ? `；旧设置已恢复，但原连接恢复失败：${restoreError}` : "";
      if (error instanceof ProductFolderValidationError) {
        return NextResponse.json({ error: `${message}${suffix}` }, { status: 400 });
      }
      throw new Error(`${message}${suffix}`);
    }
    return NextResponse.json({ settings: getFeishuRuntimeStatus() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "保存飞书设置失败" }, { status: 500 });
  }
}
