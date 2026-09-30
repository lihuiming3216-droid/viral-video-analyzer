import "server-only";

import { createHash } from "node:crypto";
import { createLarkChannel, Domain, LoggerLevel, type LarkChannel } from "@larksuiteoapi/node-sdk";
export { getChatgptFeishuClient } from "@/lib/feishu/chatgpt-app";
import { decryptSecret } from "@/lib/crypto";
import { safeFeishuLogger } from "@/lib/feishu/safe-logger";
import { feishuHttp } from "@/lib/feishu/http";
import { getMediaRoot } from "@/lib/video-processing";
import { registerFeishuHandlers } from "@/lib/feishu/handler";
import { getFeishuSettings, getRawFeishuSettings, setFeishuConnectionStatus } from "@/lib/feishu/store";

type RuntimeGlobal = typeof globalThis & {
  __feishuChannel?: LarkChannel | null;
  __feishuSignature?: string;
  __feishuConnectPromise?: Promise<LarkChannel | null> | null;
};

const state = globalThis as RuntimeGlobal;
state.__feishuChannel ||= null;
state.__feishuSignature ||= "";
state.__feishuConnectPromise ||= null;

async function credentials() {
  const raw = await getRawFeishuSettings();
  return {
    appId: String(raw.app_id || ""),
    appSecret: decryptSecret(raw.encrypted_app_secret ? String(raw.encrypted_app_secret) : ""),
    enabled: Boolean(raw.enabled),
  };
}

function signature(appId: string, appSecret: string) {
  return createHash("sha256").update(appId).update("\0").update(appSecret).digest("hex");
}

async function disconnectCurrent() {
  const current = state.__feishuChannel;
  state.__feishuChannel = null;
  state.__feishuSignature = "";
  if (current) await current.disconnect().catch(() => undefined);
}

export async function ensureFeishuConnection(force = false): Promise<LarkChannel | null> {
  const config = await credentials();
  if (state.__feishuConnectPromise) {
    // Even forced restarts share an in-flight connect. Re-read the saved
    // credentials afterward so a simultaneous settings change is not lost.
    await state.__feishuConnectPromise.catch(() => undefined);
    return ensureFeishuConnection(false);
  }
  if (!config.enabled || !config.appId || !config.appSecret) {
    if (state.__feishuChannel) await disconnectCurrent();
    await setFeishuConnectionStatus("disconnected", "");
    return null;
  }
  const nextSignature = signature(config.appId, config.appSecret);
  if (!force && state.__feishuChannel && state.__feishuSignature === nextSignature) return state.__feishuChannel;

  const connectPromise = (async () => {
    await disconnectCurrent();
    await setFeishuConnectionStatus("connecting", "");
    const channel = createLarkChannel({
      appId: config.appId,
      appSecret: config.appSecret,
      domain: Domain.Feishu,
      transport: "websocket",
      loggerLevel: LoggerLevel.warn,
      logger: safeFeishuLogger,
      httpInstance: feishuHttp,
      handshakeTimeoutMs: 15_000,
      wsConfig: { pingTimeout: 15 },
      includeRawEvent: true,
      policy: {
        requireMention: true,
        dmMode: "open",
        respondToMentionAll: false,
      },
      safety: {
        dedup: { ttl: 24 * 60 * 60 * 1000, maxEntries: 10_000 },
        chatQueue: { enabled: true },
        staleMessageWindowMs: 10 * 60 * 1000,
      },
      outbound: {
        allowedFileDirs: [getMediaRoot()],
        retry: { maxAttempts: 3, baseDelayMs: 500 },
      },
    });
    registerFeishuHandlers(channel);
    channel.on("reconnecting", () => void setFeishuConnectionStatus("reconnecting", "连接中断，正在自动恢复").catch(() => undefined));
    channel.on("reconnected", () => void setFeishuConnectionStatus("connected", "").catch(() => undefined));
    channel.on("error", (error) => void setFeishuConnectionStatus("failed", error.message).catch(() => undefined));
    try {
      await channel.connect();
      state.__feishuChannel = channel;
      state.__feishuSignature = nextSignature;
      await setFeishuConnectionStatus("connected", "");
      return channel;
    } catch (error) {
      await channel.disconnect().catch(() => undefined);
      const message = error instanceof Error ? error.message : "飞书连接失败";
      await setFeishuConnectionStatus("failed", message);
      throw new Error(message);
    }
  })();
  state.__feishuConnectPromise = connectPromise;
  try {
    return await connectPromise;
  } finally {
    if (state.__feishuConnectPromise === connectPromise) state.__feishuConnectPromise = null;
  }
}

export async function restartFeishuConnection() {
  return ensureFeishuConnection(true);
}

export function getConnectedFeishuChannel() {
  return state.__feishuChannel || null;
}

export async function stopFeishuConnection() {
  await state.__feishuConnectPromise?.catch(() => undefined);
  await disconnectCurrent();
  await setFeishuConnectionStatus("disconnected", "");
}

export async function getFeishuRuntimeStatus() {
  const saved = await getFeishuSettings();
  const live = state.__feishuChannel?.getConnectionStatus();
  if (!live) return saved;
  return { ...saved, connectionStatus: live.state };
}
