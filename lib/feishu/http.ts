import "server-only";
import { defaultHttpInstance, type HttpInstance, type HttpRequestOptions } from "@larksuiteoapi/node-sdk";
import { FeishuReadControl } from "@/lib/feishu/read-control";

const state = globalThis as typeof globalThis & { __feishuReadControl?: FeishuReadControl };
const reads = state.__feishuReadControl ||= new FeishuReadControl();

/** Bound all calls; only explicitly safe document reads have one rate-limit retry. */
function request<T, R = T, D = unknown>(options: HttpRequestOptions<D>): Promise<R> {
  const upload = /\/open-apis\/(?:drive\/v1\/(?:medias|files)\/upload|im\/v1\/(?:files|images))(?:[\/_?]|$)/.test(options.url || "");
  const limit = upload ? 120_000 : 30_000;
  const timeout = Number.isFinite(options.timeout) && options.timeout! > 0
    ? Math.min(options.timeout!, limit) : limit;
  const deadline = AbortSignal.timeout(timeout);
  const callerSignal = (options as HttpRequestOptions<D> & { signal?: AbortSignal }).signal;
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
  // The SDK's response interceptor returns the body (R), not AxiosResponse.
  return reads.run({ ...options, signal }, () => defaultHttpInstance.request<T, R, D>({
    ...options, timeout,
    signal,
  }) as Promise<R>);
}

export const feishuHttp: HttpInstance = {
  request,
  get: (url, options) => request({ ...options, url, method: "GET" }),
  delete: (url, options) => request({ ...options, url, method: "DELETE" }),
  head: (url, options) => request({ ...options, url, method: "HEAD" }),
  options: (url, options) => request({ ...options, url, method: "OPTIONS" }),
  post: (url, data, options) => request({ ...options, url, data, method: "POST" }),
  put: (url, data, options) => request({ ...options, url, data, method: "PUT" }),
  patch: (url, data, options) => request({ ...options, url, data, method: "PATCH" }),
};
