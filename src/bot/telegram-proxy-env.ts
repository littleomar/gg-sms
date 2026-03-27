/**
 * Sets HTTP_PROXY / HTTPS_PROXY env vars so that Bun's native fetch
 * routes Telegram API traffic through the configured proxy.
 *
 * Also sets NO_PROXY to exclude the dashboard domain so that
 * non-Telegram fetches (e.g. giffgaff dashboard) go direct.
 */
export function applyTelegramProxyEnv(
  telegramProxyUrl?: string,
  dashboardUrl?: string,
): void {
  const proxyUrl = telegramProxyUrl?.trim();
  if (!proxyUrl) {
    return;
  }

  process.env.HTTP_PROXY = proxyUrl;
  process.env.http_proxy = proxyUrl;
  process.env.HTTPS_PROXY = proxyUrl;
  process.env.https_proxy = proxyUrl;

  const noProxyHosts: string[] = [];
  if (dashboardUrl) {
    try {
      noProxyHosts.push(new URL(dashboardUrl).hostname);
    } catch {
      // ignore invalid URL
    }
  }

  // Always exclude common connectivity-check hosts used for keepalive
  noProxyHosts.push("connectivitycheck.gstatic.com");

  if (noProxyHosts.length > 0) {
    const existing = process.env.NO_PROXY?.trim();
    const merged = existing
      ? `${existing},${noProxyHosts.join(",")}`
      : noProxyHosts.join(",");
    process.env.NO_PROXY = merged;
    process.env.no_proxy = merged;
  }
}
