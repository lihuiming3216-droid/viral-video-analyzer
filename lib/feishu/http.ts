import "server-only";
import { defaultHttpInstance, type HttpInstance, type HttpRequestOptions } from "@larksuiteoapi/node-sdk";

/** Bound the SDK's otherwise unlimited HTTP calls without adding retries. */
function request<T, R = T, D = unknown>(options: HttpRequestOptions<D>): Promise<R> {
  const upload = /\/open-apis\/(?:drive\/v1\/(?:medias|files)\/upload|im\/v1\/(?:files|images))(?:[\/_?]|$)/.test(options.url || "");
  const limit = upload ? 120_000 : 30_000;
  const timeout = Number.isFinite(options.timeout) && options.timeout! > 0
    ? Math.min(options.timeout!, limit) : limit;
  const deadline = AbortSignal.timeout(timeout);
  const callerSignal = (options as HttpRequestOptions<D> & { signal?: AbortSignal }).signal;
  // The SDK's response interceptor returns the body (R), not AxiosResponse.
  return defaultHttpInstance.request<T, R, D>({
    ...options, timeout,
    signal: callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline,
  }) as Promise<R>;
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
