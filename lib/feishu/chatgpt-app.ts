import "server-only";

import { timingSafeEqual } from "node:crypto";
import { Client, Domain, LoggerLevel } from "@larksuiteoapi/node-sdk";

export type ChatgptActionKind = "handcard" | "video";

const DEFAULT_APP_ID = "cli_aabd673313b85be3";
const DEFAULT_EXTENSIONS: Record<ChatgptActionKind, string> = {
  handcard: "blk_6a37db2eb2808bec14ca19e8",
  video: "blk_6a37db2eb2808bec14b0763f",
};

type ChatgptAppGlobal = typeof globalThis & {
  __chatgptFeishuClient?: Client;
  __chatgptFeishuClientSignature?: string;
};

const state = globalThis as ChatgptAppGlobal;

function credentials() {
  const appId = (process.env.FEISHU_CHATGPT_APP_ID || DEFAULT_APP_ID).trim();
  const appSecret = process.env.FEISHU_CHATGPT_APP_SECRET?.trim() || "";
  if (!appId || !appSecret) throw new Error("chatgpt 飞书应用尚未配置");
  return { appId, appSecret };
}

function expectedExtension(kind: ChatgptActionKind) {
  const envName = kind === "handcard"
    ? "FEISHU_CHATGPT_HANDCARD_EXTENSION_ID"
    : "FEISHU_CHATGPT_VIDEO_EXTENSION_ID";
  return process.env[envName]?.trim() || DEFAULT_EXTENSIONS[kind];
}

function equalSecret(left: string, right: string) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

async function currentTenantAccessToken(appId: string, appSecret: string) {
  const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    cache: "no-store",
  });
  const result = await response.json() as { code?: number; msg?: string; tenant_access_token?: string };
  if (!response.ok || result.code || !result.tenant_access_token) {
    throw new Error(result.msg || "无法验证 chatgpt 飞书应用身份");
  }
  return result.tenant_access_token;
}

/**
 * Authenticate a Base automation action without putting a reusable webhook
 * secret in the uploaded action package. Feishu injects a tenant token only
 * when `useTenantAccessToken` is enabled; the server independently obtains the
 * token for this exact app and compares the two over HTTPS.
 */
export async function assertChatgptActionRequest(input: {
  authorization: string | null;
  packId: string;
  extensionId: string;
  kind: ChatgptActionKind;
}) {
  const { appId, appSecret } = credentials();
  if (input.packId.trim() !== appId) throw new Error("飞书应用身份不匹配");
  if (input.extensionId.trim() !== expectedExtension(input.kind)) throw new Error("飞书自动化动作身份不匹配");
  const match = /^Bearer\s+(.+)$/i.exec(input.authorization?.trim() || "");
  if (!match?.[1]) throw new Error("飞书自动化动作没有携带应用授权");
  const expectedToken = await currentTenantAccessToken(appId, appSecret);
  if (!equalSecret(match[1], expectedToken)) throw new Error("飞书自动化动作授权无效");
}

export function getChatgptFeishuClient() {
  const { appId, appSecret } = credentials();
  const signature = `${appId}:${appSecret.slice(-8)}`;
  if (!state.__chatgptFeishuClient || state.__chatgptFeishuClientSignature !== signature) {
    state.__chatgptFeishuClient = new Client({
      appId,
      appSecret,
      domain: Domain.Feishu,
      loggerLevel: LoggerLevel.warn,
    });
    state.__chatgptFeishuClientSignature = signature;
  }
  return state.__chatgptFeishuClient;
}
