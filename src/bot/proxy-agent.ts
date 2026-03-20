import type { Agent } from "node:http";

import { ProxyAgent } from "proxy-agent";

export function createTelegramProxyAgent(proxyUrl?: string): Agent | undefined {
  const trimmed = proxyUrl?.trim();
  if (!trimmed) {
    return undefined;
  }

  const parsed = new URL(trimmed);
  if (!parsed.protocol) {
    throw new Error("TELEGRAM_PROXY_URL must include a protocol");
  }

  return new ProxyAgent({
    getProxyForUrl: () => trimmed,
  });
}
