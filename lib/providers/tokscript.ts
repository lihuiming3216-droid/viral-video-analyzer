import "server-only";

import { fetchOpenAI } from "@/lib/network";
import { getProviderConfig, requireProvider } from "@/lib/provider-config";

type McpTool = {
  name: string;
  inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
};

type McpEnvelope = {
  result?: Record<string, unknown>;
  error?: { message?: string };
};

export interface TokScriptResult {
  transcript: string;
  language: string;
  segments: Array<{ start: number; end: number; text: string }>;
  downloadUrl: string;
  coverUrl: string;
  title: string;
  accountName: string;
  platformVideoId: string;
  publishedAt: string | null;
  stats: {
    views: number | null;
    likes: number | null;
    comments: number | null;
    shares: number | null;
    favorites: number | null;
    followers: number | null;
  };
  raw: unknown;
}

class TokScriptClient {
  private sessionId = "";
  private requestId = 1;

  constructor(private endpoint: string, private token: string, private signal?: AbortSignal) {}

  private async parseResponse(response: Response) {
    const text = await response.text();
    if (!text.trim()) return {} as McpEnvelope;
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      const events = text
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter((line) => line && line !== "[DONE]");
      return JSON.parse(events.at(-1) || "{}") as McpEnvelope;
    }
    return JSON.parse(text) as McpEnvelope;
  }

  private async post(method: string, params?: Record<string, unknown>, notification = false) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    const body: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (!notification) body.id = this.requestId++;
    if (params) body.params = params;
    // Use the shared outbound client so a cloud deployment can route TikTok
    // dependencies through HTTPS_PROXY when the server region cannot reach
    // them directly.
    const response = await fetchOpenAI(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: this.signal,
    });
    const session = response.headers.get("mcp-session-id");
    if (session) this.sessionId = session;
    if (!response.ok) throw new Error(`TokScript 连接失败（${response.status}），请检查密钥或接口地址`);
    const envelope = await this.parseResponse(response);
    if (envelope.error) throw new Error(envelope.error.message || "TokScript 调用失败");
    return envelope.result || {};
  }

  async connect() {
    await this.post("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "viral-video-analyzer", version: "1.0.0" },
    });
    await this.post("notifications/initialized", {}, true);
  }

  async listTools() {
    const result = await this.post("tools/list");
    return (Array.isArray(result.tools) ? result.tools : []) as McpTool[];
  }

  async callTool(tool: McpTool, url: string) {
    const properties = tool.inputSchema?.properties || {};
    const keys = Object.keys(properties);
    const urlKey = keys.find((key) => /(^|_)(url|link)$/i.test(key)) || keys.find((key) => /url|link/i.test(key)) || "url";
    const args: Record<string, unknown> = { [urlKey]: url };
    if (keys.includes("platform")) args.platform = "tiktok";
    return this.post("tools/call", { name: tool.name, arguments: args });
  }
}

function parseToolPayload(result: Record<string, unknown>) {
  if (result.structuredContent) return result.structuredContent;
  const content = Array.isArray(result.content) ? result.content : [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const block = item as Record<string, unknown>;
    if (typeof block.text === "string") {
      const text = block.text.trim();
      try {
        return JSON.parse(text);
      } catch {
        if (text) return { text };
      }
    }
    if (block.resource && typeof block.resource === "object") return block.resource;
  }
  return result;
}

function findValue(root: unknown, keys: string[]): unknown {
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  const seen = new Set<unknown>();
  const visit = (value: unknown): unknown => {
    if (!value || typeof value !== "object" || seen.has(value)) return undefined;
    seen.add(value);
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (wanted.has(key.toLowerCase()) && child != null && child !== "") return child;
    }
    for (const child of Object.values(value as Record<string, unknown>)) {
      const found = Array.isArray(child)
        ? child.map(visit).find((item) => item !== undefined)
        : visit(child);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return visit(root);
}

function findMediaUrl(root: unknown, kind: "video" | "cover") {
  const preferred = kind === "video"
    ? ["download_url", "downloadUrl", "video_url", "videoUrl", "play_url", "playUrl", "media_url", "mediaUrl", "url", "uri", "href"]
    : ["cover_url", "coverUrl", "thumbnail_url", "thumbnailUrl", "cover", "thumbnail", "image_url", "imageUrl", "url", "uri", "href"];
  const value = findValue(root, preferred);
  if (typeof value === "string" && /^https?:\/\//.test(value)) return value;

  // Some TokScript tools return a plain-text MCP block such as
  // "Download URL: https://..." instead of structured JSON. Collect URLs from
  // every nested string and prefer an actual media/CDN URL over the TikTok page.
  const urls: string[] = [];
  const seen = new Set<unknown>();
  const visit = (candidate: unknown) => {
    if (typeof candidate === "string") {
      const normalized = candidate.replace(/\\\//g, "/");
      for (const match of normalized.match(/https?:\/\/[^\s"'<>]+/gi) || []) {
        const url = match.replace(/[),.;!?\]}]+$/g, "");
        if (!urls.includes(url)) urls.push(url);
      }
      return;
    }
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) return;
    seen.add(candidate);
    if (Array.isArray(candidate)) candidate.forEach(visit);
    else Object.values(candidate as Record<string, unknown>).forEach(visit);
  };
  visit(root);
  const score = (url: string) => {
    const lower = url.toLowerCase();
    if (kind === "cover") {
      return (/(?:cover|thumb|image|poster)/.test(lower) ? 8 : 0)
        + (/\.(?:avif|gif|jpe?g|png|webp)(?:$|[?&#])/.test(lower) ? 6 : 0)
        - (/\.(?:m3u8|mp4|mov|webm)(?:$|[?&#])/.test(lower) ? 8 : 0);
    }
    return (/(?:download|video|play|aweme|byteoversea|tiktokcdn|akamaized)/.test(lower) ? 7 : 0)
      + (/\.(?:m3u8|mp4|mov|webm)(?:$|[?&#])/.test(lower) ? 8 : 0)
      - (/\.(?:avif|gif|jpe?g|png|webp)(?:$|[?&#])/.test(lower) ? 10 : 0)
      - (/^https?:\/\/(?:www\.)?tiktok\.com\/@/.test(lower) ? 5 : 0);
  };
  return urls.sort((left, right) => score(right) - score(left))[0] || "";
}

function normalizeSegments(root: unknown) {
  const candidate = findValue(root, ["segments", "captions", "transcript_segments", "transcriptSegments"]);
  if (!Array.isArray(candidate)) return [];
  return candidate
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const row = item as Record<string, unknown>;
      const start = Number(row.start ?? row.start_time ?? row.startTime ?? 0);
      const end = Number(row.end ?? row.end_time ?? row.endTime ?? start);
      const text = String(row.text ?? row.caption ?? row.content ?? "").trim();
      return text ? { start, end, text } : null;
    })
    .filter(Boolean) as Array<{ start: number; end: number; text: string }>;
}

function numeric(root: unknown, keys: string[]) {
  const value = findValue(root, keys);
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function textValue(root: unknown, keys: string[]) {
  const value = findValue(root, keys);
  return typeof value === "string" ? value : "";
}

export async function testTokScriptConnection() {
  const config = requireProvider("tokscript");
  const client = new TokScriptClient(config.baseUrl, config.apiKey);
  await client.connect();
  const tools = await client.listTools();
  return { ok: true, message: `连接成功，可用工具 ${tools.length} 个` };
}

export async function fetchTikTok(
  url: string,
  signal?: AbortSignal,
  options: { includeCover?: boolean; timeoutMs?: number } = {},
): Promise<TokScriptResult> {
  const config = requireProvider("tokscript");
  const timeoutSignal = AbortSignal.timeout(Math.max(15_000, options.timeoutMs || 180_000));
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const client = new TokScriptClient(config.baseUrl, config.apiKey, requestSignal);
  try {
    await client.connect();
    const tools = await client.listTools();
    const pick = (names: string[]) => tools.find((tool) => names.includes(tool.name));
    const transcriptTool = pick(["get_tiktok_transcript", "get_transcript"]);
    const downloadTool = pick(["download_video", "download_tiktok_video"]);
    const coverTool = pick(["download_cover_image", "get_cover_image"]);
    if (!transcriptTool || !downloadTool) {
      throw new Error("TokScript 当前账号没有返回转写或下载工具，请检查套餐权限");
    }
    const transcriptRaw = parseToolPayload(await client.callTool(transcriptTool, url));
    const downloadRaw = parseToolPayload(await client.callTool(downloadTool, url));
    const coverRaw = options.includeCover !== false && coverTool
      ? parseToolPayload(await client.callTool(coverTool, url))
      : null;
    const transcript = textValue(transcriptRaw, ["transcript", "full_transcript", "fullTranscript", "text", "content"]);
    const segments = normalizeSegments(transcriptRaw);
    return {
      transcript: transcript || segments.map((segment) => segment.text).join(" "),
      language: textValue(transcriptRaw, ["language", "detected_language", "detectedLanguage"]),
      segments,
      downloadUrl: findMediaUrl(downloadRaw, "video"),
      coverUrl: findMediaUrl(coverRaw || downloadRaw, "cover"),
      title: textValue(transcriptRaw, ["title", "description", "caption"]),
      accountName: textValue(transcriptRaw, ["username", "account_name", "accountName", "author", "unique_id", "uniqueId"]),
      platformVideoId: textValue(transcriptRaw, ["video_id", "videoId", "aweme_id", "awemeId"]),
      publishedAt: textValue(transcriptRaw, ["published_at", "publishedAt", "create_time", "createTime"]) || null,
      stats: {
        views: numeric(transcriptRaw, ["view_count", "viewCount", "views", "play_count", "playCount"]),
        likes: numeric(transcriptRaw, ["like_count", "likeCount", "likes", "digg_count", "diggCount"]),
        comments: numeric(transcriptRaw, ["comment_count", "commentCount", "comments"]),
        shares: numeric(transcriptRaw, ["share_count", "shareCount", "shares"]),
        favorites: numeric(transcriptRaw, ["favorite_count", "favoriteCount", "collect_count", "collectCount"]),
        followers: numeric(transcriptRaw, ["follower_count", "followerCount", "followers"]),
      },
      raw: { transcript: transcriptRaw, download: downloadRaw, cover: coverRaw },
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    if (timeoutSignal.aborted) throw new Error("TokScript 获取视频超时，请在分析状态栏输入“重试”后重试");
    throw error;
  }
}

export function tokScriptIsConfigured() {
  const config = getProviderConfig("tokscript");
  return config.enabled && Boolean(config.apiKey);
}
