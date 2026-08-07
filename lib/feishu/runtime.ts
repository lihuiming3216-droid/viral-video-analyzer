import "server-only";

import { createLarkChannel, Domain, LoggerLevel, type LarkChannel } from "@larksuiteoapi/node-sdk";
import { decryptSecret } from "@/lib/crypto";
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

function credentials() {
  const raw = getRawFeishuSettings();
  return {
    appId: String(raw.app_id || ""),
    appSecret: decryptSecret(raw.encrypted_app_secret ? String(raw.encrypted_app_secret) : ""),
    enabled: Boolean(raw.enabled),
  };
}

function signature(appId: string, appSecret: string) {
  return `${appId}:${appSecret.slice(-8)}`;
}

async function disconnectCurrent() {
  const current = state.__feishuChannel;
  state.__feishuChannel = null;
  state.__feishuSignature = "";
  if (current) await current.disconnect().catch(() => undefined);
}

export async function ensureFeishuConnection(force = false): Promise<LarkChannel | null> {
  const config = credentials();
  if (!config.enabled || !config.appId || !config.appSecret) {
    if (state.__feishuChannel) await disconnectCurrent();
    setFeishuConnectionStatus("disconnected", "");
    return null;
  }
  const nextSignature = signature(config.appId, config.appSecret);
  if (!force && state.__feishuChannel && state.__feishuSignature === nextSignature) return state.__feishuChannel;
  if (!force && state.__feishuConnectPromise) return state.__feishuConnectPromise;

  const connectPromise = (async () => {
    await disconnectCurrent();
    setFeishuConnectionStatus("connecting", "");
    const channel = createLarkChannel({
      appId: config.appId,
      appSecret: config.appSecret,
      domain: Domain.Feishu,
      transport: "websocket",
      loggerLevel: LoggerLevel.warn,
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
    channel.on("reconnecting", () => setFeishuConnectionStatus("reconnecting", "连接中断，正在自动恢复"));
    channel.on("reconnected", () => setFeishuConnectionStatus("connected", ""));
    channel.on("error", (error) => setFeishuConnectionStatus("failed", error.message));
    try {
      await channel.connect();
      state.__feishuChannel = channel;
      state.__feishuSignature = nextSignature;
      setFeishuConnectionStatus("connected", "");
      return channel;
    } catch (error) {
      await channel.disconnect().catch(() => undefined);
      const message = error instanceof Error ? error.message : "飞书连接失败";
      setFeishuConnectionStatus("failed", message);
      throw new Error(message);
    }
  })();
  state.__feishuConnectPromise = connectPromise;
  try {
    return await connectPromise;
  } finally {
    state.__feishuConnectPromise = null;
  }
}

export async function restartFeishuConnection() {
  return ensureFeishuConnection(true);
}

export function getConnectedFeishuChannel() {
  return state.__feishuChannel || null;
}

export async function stopFeishuConnection() {
  await disconnectCurrent();
  setFeishuConnectionStatus("disconnected", "");
}

export function getFeishuRuntimeStatus() {
  const saved = getFeishuSettings();
  const live = state.__feishuChannel?.getConnectionStatus();
  if (!live) return saved;
  return { ...saved, connectionStatus: live.state };
}
