import "server-only";

import { fetchWithProxy } from "@/lib/network";
import { getProviderConfig, requireProvider } from "@/lib/provider-config";
import { NO_PRODUCT_VOICEOVER_TRANSCRIPT } from "@/lib/transcript-validation";

type McpTool = {
  name: string;
  inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
};

type McpEnvelope = {
  result?: Record<string, unknown>;
  error?: { message?: string };
};

type TokScriptToolStage = "download" | "transcript" | "cover";
type TokScriptSetupStage = "resolve_url" | "connect" | "list_tools";
type TokScriptToolErrorCategory =
  | "timeout"
  | "rate_limit"
  | "permission"
  | "invalid_input"
  | "not_found"
  | "network_error"
  | "provider_unavailable"
  | "extraction_failed"
  | "tool_error";

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
    const response = await fetchWithProxy(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: this.signal,
    });
    const session = response.headers.get("mcp-session-id");
    if (session) this.sessionId = session;
    if (!response.ok) throw new Error(`TokScript 连接失败（${response.status}），请检查密钥或接口地址`);
    const envelope = await this.parseResponse(response);
    if (envelope.error) {
      throw new TokScriptProviderResponseError(tokScriptToolErrorCategory(envelope.error.message));
    }
    return envelope.result || {};
  }

  async connect() {
    try {
      await this.post("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "viral-video-analyzer", version: "1.0.0" },
      });
      await this.post("notifications/initialized", {}, true);
    } catch (error) {
      if (this.signal?.aborted) throw error;
      throw tokScriptSetupError("connect", error);
    }
  }

  async listTools() {
    try {
      const result = await this.post("tools/list");
      return (Array.isArray(result.tools) ? result.tools : []) as McpTool[];
    } catch (error) {
      if (this.signal?.aborted) throw error;
      throw tokScriptSetupError("list_tools", error);
    }
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

function tokScriptToolErrorText(result: Record<string, unknown>) {
  const candidates: string[] = [];
  const seen = new Set<unknown>();
  const collect = (value: unknown, depth = 0) => {
    if (depth > 4 || value == null || seen.has(value)) return;
    if (typeof value === "string") {
      const text = value.trim();
      if (!text) return;
      try {
        collect(JSON.parse(text), depth + 1);
      } catch {
        candidates.push(text);
      }
      return;
    }
    if (typeof value !== "object") return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((item) => collect(item, depth + 1));
      return;
    }
    const record = value as Record<string, unknown>;
    for (const key of ["message", "error", "detail", "reason", "text"]) {
      if (key in record) collect(record[key], depth + 1);
    }
  };
  collect(result.structuredContent);
  collect(result.content);
  collect(result.error);
  collect(result.message);
  return candidates[0] || "TokScript 未提供错误详情";
}

function tokScriptToolErrorCategory(value: unknown): TokScriptToolErrorCategory {
  const message = String(value || "").normalize("NFKC").toLowerCase();
  if (/(?:timeout|timed out|超时)/i.test(message)) return "timeout";
  if (/(?:rate limit|too many requests|\b429\b|限流|请求过多)/i.test(message)) return "rate_limit";
  if (/(?:unauthori[sz]ed|forbidden|permission|\b401\b|\b403\b|权限|鉴权)/i.test(message)) return "permission";
  if (/(?:invalid (?:url|link|input|argument)|bad request|\b400\b|无效(?:链接|参数)|参数错误)/i.test(message)) return "invalid_input";
  if (/(?:not found|\b404\b|不存在|未找到)/i.test(message)) return "not_found";
  if (/(?:fetch failed|econnreset|etimedout|socket|und_err|network error|网络错误)/i.test(message)) return "network_error";
  if (/(?:unavailable|temporar(?:y|ily)|\b50[234]\b|服务不可用|稍后重试)/i.test(message)) return "provider_unavailable";
  if (/(?:extract|transcript|sigi_state|universal_data|转写|提取)/i.test(message)) return "extraction_failed";
  return "tool_error";
}

const tokScriptToolErrorMessages: Record<TokScriptToolErrorCategory, string> = {
  timeout: "工具调用超时",
  rate_limit: "服务请求受限",
  permission: "服务权限不足",
  invalid_input: "服务拒绝输入",
  not_found: "未找到视频数据",
  network_error: "服务网络异常",
  provider_unavailable: "服务暂不可用",
  extraction_failed: "内容提取失败",
  tool_error: "工具调用失败",
};

class TokScriptProviderResponseError extends Error {
  constructor(readonly category: TokScriptToolErrorCategory) {
    super(tokScriptToolErrorMessages[category]);
    this.name = "TokScriptProviderResponseError";
  }
}

class TokScriptSetupError extends Error {
  constructor(
    readonly stage: TokScriptSetupStage,
    readonly category: TokScriptToolErrorCategory,
  ) {
    super(`TokScript 前置调用失败（stage=${stage}; category=${category}）：${tokScriptToolErrorMessages[category]}`);
    this.name = category === "timeout" || category === "network_error"
      ? "TokScriptRetryableError"
      : "TokScriptSetupError";
  }
}

function tokScriptSetupError(stage: TokScriptSetupStage, error: unknown) {
  const category = error instanceof TokScriptProviderResponseError
    ? error.category
    : tokScriptToolErrorCategory(error instanceof Error ? error.message : String(error || ""));
  return new TokScriptSetupError(stage, category);
}

class TokScriptToolCallError extends Error {
  constructor(
    readonly stage: TokScriptToolStage,
    readonly category: TokScriptToolErrorCategory,
    readonly attempts: number,
  ) {
    super(`TokScript 工具返回错误（stage=${stage}; category=${category}; attempts=${attempts}）：${tokScriptToolErrorMessages[category]}`);
    this.name = "TokScriptToolCallError";
  }
}

function tokScriptToolCallError(stage: TokScriptToolStage, error: unknown, attempts: number) {
  if (error instanceof TokScriptToolCallError) {
    return new TokScriptToolCallError(stage, error.category, attempts);
  }
  if (error instanceof TokScriptProviderResponseError) {
    return new TokScriptToolCallError(stage, error.category, attempts);
  }
  const providerMessage = error instanceof Error ? error.message : String(error || "");
  return new TokScriptToolCallError(stage, tokScriptToolErrorCategory(providerMessage), attempts);
}

async function callTokScriptToolWithOneRetry<T>(input: {
  client: TokScriptClient;
  tool: McpTool;
  url: string;
  stage: TokScriptToolStage;
  parse: (result: Record<string, unknown>) => T;
  requestSignal: AbortSignal;
  userSignal?: AbortSignal;
}) {
  let attempt = 1;
  while (true) {
    try {
      const result = await input.client.callTool(input.tool, input.url);
      if (result.isError === true) {
        const providerMessage = tokScriptToolErrorText(result);
        throw new TokScriptToolCallError(
          input.stage,
          tokScriptToolErrorCategory(providerMessage),
          attempt,
        );
      }
      return input.parse(result);
    } catch (error) {
      if (input.userSignal?.aborted) throw error;
      if (input.requestSignal.aborted) {
        throw new TokScriptToolCallError(input.stage, "timeout", attempt);
      }
      const failure = tokScriptToolCallError(input.stage, error, attempt);
      if (attempt === 2) throw failure;
      attempt += 1;
    }
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

type TranscriptToolPayload = {
  payload: unknown;
  plainText: string;
};

/**
 * Transcript tool output has a stricter trust boundary than download output.
 * A structured response is kept structured, while a single non-JSON MCP text
 * block is marked separately for the narrowly-scoped labelled parser below.
 */
function parseTranscriptToolPayload(result: Record<string, unknown>): TranscriptToolPayload {
  if (Object.prototype.hasOwnProperty.call(result, "structuredContent")) {
    return { payload: result.structuredContent, plainText: "" };
  }

  const content = Array.isArray(result.content) ? result.content : [];
  if (content.length === 1 && content[0] && typeof content[0] === "object") {
    const block = content[0] as Record<string, unknown>;
    if (typeof block.text === "string") {
      const text = block.text.trim();
      try {
        return { payload: JSON.parse(text), plainText: "" };
      } catch {
        return { payload: {}, plainText: text };
      }
    }
    if (block.resource && typeof block.resource === "object") {
      return { payload: block.resource, plainText: "" };
    }
  }

  return { payload: result, plainText: "" };
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
  const candidate = findValue(root, ["segments", "transcript_segments", "transcriptSegments"]);
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

function explicitTranscript(root: unknown) {
  const value = findValue(root, ["transcript", "full_transcript", "fullTranscript"]);
  return typeof value === "string" ? value.trim() : "";
}

function audioTrackName(root: unknown) {
  const seen = new Set<unknown>();
  const visit = (value: unknown): string => {
    if (!value || typeof value !== "object" || seen.has(value)) return "";
    seen.add(value);
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (/^(?:audio|music|sound)(?:_info|Info|_track|Track)?$/i.test(key) && child && typeof child === "object") {
        const row = child as Record<string, unknown>;
        const name = row.name ?? row.title ?? row.audio_name ?? row.music_name;
        if (typeof name === "string" && name.trim()) return name.trim();
      }
    }
    for (const child of Object.values(value as Record<string, unknown>)) {
      const found = Array.isArray(child)
        ? child.map(visit).find(Boolean) || ""
        : visit(child);
      if (found) return found;
    }
    return "";
  };
  return visit(root);
}

function speechTokens(value: string) {
  return value.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}']+/gu) || [];
}

export function tokScriptTranscriptIsNoProductVoiceover(transcript: string, audioName = "") {
  const normalized = String(transcript || "").normalize("NFKC").trim().replace(/\s+/g, " ");
  if (tokScriptExplicitNoSpeech(normalized)) {
    return true;
  }
  const tokens = speechTokens(normalized);
  if (tokens.length <= 1) return true;
  const unique = new Set(tokens);
  if (tokens.length >= 4 && unique.size <= 2) return true;

  const audioTokens = [...new Set(speechTokens(audioName).filter((token) => !/^(?:original|sound|music|audio|sped|up)$/.test(token)))];
  if (audioTokens.length >= 3) {
    const transcriptSet = new Set(tokens);
    const overlap = audioTokens.filter((token) => transcriptSet.has(token)).length;
    if (overlap >= 3 && overlap / audioTokens.length >= 0.6) return true;
  }
  return false;
}

function tokScriptExplicitNoSpeech(value: string) {
  return /^(?:there (?:is|was) no (?:speech|spoken audio|voice[ -]?over|narration)|no (?:speech|spoken audio|voice[ -]?over|narration)(?:\b.*)?|(?:only )?(?:background )?music(?: only)?|only music)(?:[.!！。]|$)/i.test(value);
}

/**
 * Some MCP clients serialize a transcript as one labelled text block instead
 * of JSON. Accept only an explicit Transcript section, never arbitrary text or
 * provider messages. Structured payloads do not enter this path.
 */
function labelledPlainTextTranscript(value: string) {
  const normalized = String(value || "").replace(/\r\n?/g, "\n").trim();
  const match = normalized.match(/^(?:#{1,6}\s*)?(?:full\s+)?transcript\s*:\s*([\s\S]*)$/i);
  if (!match) return "";
  const body = match[1].trim();
  const metadataStart = body.search(
    /\n(?:#{1,6}\s*)?(?:title|author|creator|duration|views?|likes?|comments?|shares?|bookmarks?|publish(?:ed)?(?:\s+date)?|hashtags?|audio(?:\s+track)?(?:\s+name|\s+url)?|thumbnail)\s*:/i,
  );
  return (metadataStart >= 0 ? body.slice(0, metadataStart) : body).trim();
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

function timeoutLike(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /(?:timeout|timed out|aborted due to timeout|etimedout)/i.test(message);
}

function isOfficialTikTokHttpsUrl(value: string) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && !url.port
      && (hostname === "tiktok.com" || hostname.endsWith(".tiktok.com"));
  } catch {
    return false;
  }
}

function isCanonicalTikTokVideoUrl(value: string) {
  if (!isOfficialTikTokHttpsUrl(value)) return false;
  try {
    return /^\/@[^/]+\/video\/\d+\/?$/.test(new URL(value).pathname);
  } catch {
    return false;
  }
}

function isTikTokShortVideoUrl(value: string) {
  if (!isOfficialTikTokHttpsUrl(value)) return false;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return (hostname === "www.tiktok.com" && /^\/t\/[^/]+\/?$/.test(url.pathname))
      || ((hostname === "vm.tiktok.com" || hostname === "vt.tiktok.com") && url.pathname !== "/");
  } catch {
    return false;
  }
}

/**
 * TokScript is the only transcript provider for TikTok links. Resolve official
 * TikTok short links first so the transcript tool receives the stable video
 * page instead of the lightweight redirect shell.
 */
export async function resolveTokScriptVideoUrl(
  input: string,
  signal?: AbortSignal,
  request: typeof fetchWithProxy = fetchWithProxy,
) {
  if (isCanonicalTikTokVideoUrl(input) || !isTikTokShortVideoUrl(input)) return input;
  let current = new URL(input);
  const timeoutSignal = AbortSignal.timeout(20_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const seen = new Set<string>();
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    const currentUrl = current.toString();
    if (seen.has(currentUrl) || !isOfficialTikTokHttpsUrl(currentUrl)) break;
    seen.add(currentUrl);
    const response = await request(current, {
      method: "GET",
      redirect: "manual",
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: requestSignal,
    });
    try {
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) break;
        const next = new URL(location, current);
        if (!isOfficialTikTokHttpsUrl(next.toString())) break;
        current = next;
        if (isCanonicalTikTokVideoUrl(current.toString())) return current.toString();
        continue;
      }
      if (response.ok && isCanonicalTikTokVideoUrl(current.toString())) return current.toString();
      break;
    } finally {
      await response.body?.cancel().catch(() => undefined);
    }
  }
  throw new Error("TokScript 短链接未解析到官方 TikTok 视频地址");
}

/** Plain-text provider diagnostics must never be treated as spoken words. */
export function tokScriptTranscriptFailure(value: string) {
  const normalized = String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ");
  return /^(?:error|failed|failure|unable|could not|cannot|service unavailable|rate limit(?:ed)?|too many requests)\b/i.test(normalized)
    || /(?:failed to extract transcript|transcript extraction (?:failed|error)|no transcript (?:data|available)|transcript (?:unavailable|not found)|SIGI_STATE|UNIVERSAL_DATA_FOR_REHYDRATION)/i.test(normalized)
    || /^(?:(?:full )?transcript\s*:\s*)?(?:\(\s*empty\s*\)|empty|none|null|n\/?a)\s*$/i.test(normalized);
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
    let resolvedUrl = "";
    try {
      resolvedUrl = await resolveTokScriptVideoUrl(url, requestSignal);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof Error && error.message === "TokScript 短链接未解析到官方 TikTok 视频地址") {
        throw error;
      }
      throw tokScriptSetupError("resolve_url", error);
    }
    await client.connect();
    const tools = await client.listTools();
    const pick = (names: string[]) => tools.find((tool) => names.includes(tool.name));
    const transcriptTool = pick(["get_tiktok_transcript", "get_transcript"]);
    const downloadTool = pick(["download_video", "download_tiktok_video"]);
    const coverTool = pick(["download_cover_image", "get_cover_image"]);
    if (!transcriptTool || !downloadTool) {
      throw new Error("TokScript 当前账号没有返回转写或下载工具，请检查套餐权限");
    }
    // Obtain both outputs from TokScript. TikTok-link jobs never re-transcribe
    // the downloaded media with another provider.
    const downloadRaw = await callTokScriptToolWithOneRetry({
      client,
      tool: downloadTool,
      url: resolvedUrl,
      stage: "download",
      parse: parseToolPayload,
      requestSignal,
      userSignal: signal,
    });
    const parsedTranscript = await callTokScriptToolWithOneRetry({
      client,
      tool: transcriptTool,
      url: resolvedUrl,
      stage: "transcript",
      parse: parseTranscriptToolPayload,
      requestSignal,
      userSignal: signal,
    });
    const transcriptRaw = parsedTranscript.payload;
    const coverRaw = options.includeCover !== false && coverTool && !timeoutSignal.aborted
      ? await callTokScriptToolWithOneRetry({
        client,
        tool: coverTool,
        url: resolvedUrl,
        stage: "cover",
        parse: parseToolPayload,
        requestSignal,
        userSignal: signal,
      })
      : null;
    const segments = normalizeSegments(transcriptRaw);
    const transcript = explicitTranscript(transcriptRaw)
      || labelledPlainTextTranscript(parsedTranscript.plainText)
      || segments.map((segment) => segment.text).join(" ");
    const normalizedTranscript = transcript.trim();
    if (!normalizedTranscript || tokScriptTranscriptFailure(normalizedTranscript)) {
      throw new Error("TokScript 未返回有效口播文案");
    }
    const noProductVoiceover = tokScriptTranscriptIsNoProductVoiceover(
      normalizedTranscript,
      audioTrackName(transcriptRaw),
    );
    return {
      transcript: noProductVoiceover ? NO_PRODUCT_VOICEOVER_TRANSCRIPT : normalizedTranscript,
      language: textValue(transcriptRaw, ["language", "detected_language", "detectedLanguage"]),
      segments: noProductVoiceover ? [] : segments,
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
    if (error instanceof TokScriptToolCallError) throw error;
    if (timeoutSignal.aborted || timeoutLike(error)) {
      throw new Error("TokScript 获取视频超时");
    }
    throw error;
  }
}

export function tokScriptIsConfigured() {
  const config = getProviderConfig("tokscript");
  return config.enabled && Boolean(config.apiKey);
}
