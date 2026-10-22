import { createHash } from "node:crypto";

type Request = { url?: string; method?: string; headers?: unknown; signal?: AbortSignal };
type Budget = { nextAt: number; blockedUntil: number };

export function isFeishuRateLimit(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const item = value as { code?: unknown; feishuCode?: unknown; status?: unknown; response?: { status?: unknown; data?: { code?: unknown } } };
  return [item.status, item.response?.status].some(code => code === 429 || code === "429")
    || [item.code, item.feishuCode, item.response?.data?.code].some(code => code === 99991400 || code === "99991400");
}

function quotaKey(options: Request) {
  const path = new URL(options.url || "", "https://open.feishu.cn").pathname;
  const method = String(options.method || "GET").toUpperCase();
  let group = "";
  if (method === "POST" && path === "/open-apis/drive/v1/metas/batch_query") group = "metadata";
  if (method === "GET" && /^\/open-apis\/docx\/v1\/documents\/[^/]+$/.test(path)) group = "revision";
  if (method === "GET" && /^\/open-apis\/docx\/v1\/documents\/[^/]+\/blocks(?:\/|$)/.test(path)) group = "blocks";
  if (!group) return null;
  const headers = options.headers as { get?: (key: string) => unknown } | undefined;
  const auth = headers?.get?.("Authorization") ?? Object.entries(headers || {}).find(([key]) => key.toLowerCase() === "authorization")?.[1];
  // Independent apps must not queue behind each other; never retain/log tokens.
  return `${group}:${createHash("sha256").update(String(auth || "")).digest("hex").slice(0, 16)}`;
}

function pause(ms: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const finish = () => { signal?.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function retryDelay(value: unknown) {
  const item = value as { response?: { headers?: Record<string, unknown> } };
  const raw = item.response?.headers?.["retry-after"];
  const seconds = Number(raw);
  const delay = raw != null && Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(String(raw)) - Date.now();
  // Malformed/unbounded headers must not suspend the worker indefinitely.
  return Number.isFinite(delay) ? Math.max(2_000, Math.min(60_000, delay)) : 2_000;
}

/** Pace read starts (not whole responses). Writes/provider requests are never retried here. */
export class FeishuReadControl {
  private budgets = new Map<string, Budget>();

  async run<T>(options: Request, send: () => Promise<T>): Promise<T> {
    const key = quotaKey(options);
    if (!key) return send();
    const signal = options.signal;
    let budget = this.budgets.get(key);
    if (!budget) {
      for (const [oldKey, old] of this.budgets) {
        if (Math.max(old.nextAt, old.blockedUntil) < Date.now() - 60_000) this.budgets.delete(oldKey);
      }
      budget = { nextAt: 0, blockedUntil: 0 };
      this.budgets.set(key, budget);
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      // Recheck after every wait: a different in-flight request may have just
      // extended the shared cooldown. Caller deadlines include this queueing.
      while (true) {
        signal?.throwIfAborted();
        const wait = Math.max(budget.nextAt, budget.blockedUntil) - Date.now();
        if (wait <= 0) { budget.nextAt = Date.now() + 500; break; }
        await pause(wait, signal);
      }
      try {
        const response = await send();
        if (isFeishuRateLimit(response)) {
          throw Object.assign(new Error("飞书读取被限流，请稍后重试"), { feishuCode: 99991400 });
        }
        return response;
      } catch (error) {
        if (!isFeishuRateLimit(error)) throw error;
        budget.blockedUntil = Math.max(budget.blockedUntil, Date.now() + retryDelay(error));
        if (attempt === 1) throw error;
      }
    }
    throw new Error("飞书读取未完成");
  }
}
