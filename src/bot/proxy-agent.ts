import type { Agent } from "node:http";

import { ProxyAgent } from "proxy-agent";

export type TelegramProxyConfiguration = {
  enabled: boolean;
  protocol?: string;
  host?: string;
  port?: string;
  bunEnvProxyApplied: boolean;
};

function parseProxyUrl(proxyUrl?: string): { trimmed: string; parsed: URL } | null {
  const trimmed = proxyUrl?.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = new URL(trimmed);
  if (!parsed.protocol) {
    throw new Error("TELEGRAM_PROXY_URL must include a protocol");
  }

  return { trimmed, parsed };
}

export function createTelegramProxyAgent(proxyUrl?: string): Agent | undefined {
  const proxy = parseProxyUrl(proxyUrl);
  if (!proxy) {
    return undefined;
  }

  return new ProxyAgent({
    getProxyForUrl: () => proxy.trimmed,
  });
}

export function applyTelegramProxyEnvironment(proxyUrl?: string): TelegramProxyConfiguration {
  const proxy = parseProxyUrl(proxyUrl);
  if (!proxy) {
    return {
      enabled: false,
      bunEnvProxyApplied: false,
    };
  }

  const { trimmed, parsed } = proxy;
  const protocol = parsed.protocol.replace(/:$/, "");
  const host = parsed.hostname;
  const port = parsed.port || undefined;

  process.env.ALL_PROXY = trimmed;
  process.env.all_proxy = trimmed;

  let bunEnvProxyApplied = false;
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    process.env.HTTP_PROXY = trimmed;
    process.env.http_proxy = trimmed;
    process.env.HTTPS_PROXY = trimmed;
    process.env.https_proxy = trimmed;
    bunEnvProxyApplied = true;
  }

  return {
    enabled: true,
    protocol,
    host,
    port,
    bunEnvProxyApplied,
  };
}
