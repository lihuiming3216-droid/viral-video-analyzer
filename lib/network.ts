import "server-only";

import { execFileSync } from "node:child_process";
import { fetch as undiciFetch, ProxyAgent } from "undici";

let detectedProxy: string | null | undefined;
let proxyAgent: ProxyAgent | null | undefined;

function macSystemProxy() {
  if (process.platform !== "darwin") return null;
  try {
    const output = execFileSync("/usr/sbin/scutil", ["--proxy"], {
      encoding: "utf8",
      timeout: 2_000,
    });
    const enabled = /HTTPSEnable\s*:\s*1/.test(output);
    const host = output.match(/HTTPSProxy\s*:\s*([^\s]+)/)?.[1];
    const port = output.match(/HTTPSPort\s*:\s*(\d+)/)?.[1];
    return enabled && host && port ? `http://${host}:${port}` : null;
  } catch {
    return null;
  }
}

export function getOutboundProxyUrl() {
  if (detectedProxy !== undefined) return detectedProxy;
  detectedProxy = process.env.HTTPS_PROXY
    || process.env.https_proxy
    || process.env.HTTP_PROXY
    || process.env.http_proxy
    || macSystemProxy();
  return detectedProxy;
}

function getProxyAgent() {
  if (proxyAgent !== undefined) return proxyAgent;
  const proxyUrl = getOutboundProxyUrl();
  proxyAgent = proxyUrl ? new ProxyAgent(proxyUrl) : null;
  return proxyAgent;
}

export async function fetchOpenAI(input: string | URL | Request, init: RequestInit = {}) {
  const dispatcher = getProxyAgent();
  if (!dispatcher) return fetch(input, init);
  return undiciFetch(
    input as Parameters<typeof undiciFetch>[0],
    { ...init, dispatcher } as Parameters<typeof undiciFetch>[1],
  ) as unknown as Promise<Response>;
}
