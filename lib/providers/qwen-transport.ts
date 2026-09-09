import "server-only";

import { Agent, fetch as undiciFetch, type RequestInit } from "undici";

// Qwen can take more than Node fetch's default 300 seconds before sending
// headers or the next SSE chunk. The caller's mandatory deadline covers the
// entire request, including its body; do not install a global dispatcher or
// change timeouts for TokScript, Feishu or other providers.
const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

export async function fetchQwen(url: string, init: RequestInit & { signal: AbortSignal }): Promise<Response> {
  init.signal.throwIfAborted();
  return await undiciFetch(url, { ...init, dispatcher }) as unknown as Response;
}
