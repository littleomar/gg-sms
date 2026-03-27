import { describe, expect, it } from "bun:test";

import { canUseBunFetchTelegramProxy, createBunTelegramCallApi } from "../src/bot/telegram-transport";

describe("telegram bun transport", () => {
  it("only enables Bun native Telegram proxy for http(s) proxies", () => {
    expect(canUseBunFetchTelegramProxy(undefined)).toBe(false);
    expect(canUseBunFetchTelegramProxy("socks5://127.0.0.1:7890")).toBe(false);
    expect(canUseBunFetchTelegramProxy("http://127.0.0.1:7890")).toBe(true);
    expect(canUseBunFetchTelegramProxy("https://127.0.0.1:7890")).toBe(true);
  });

  it("builds Telegram API requests through Bun fetch proxy", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; proxy: unknown; method: string; body: string | null }> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        proxy: (init as RequestInit & { proxy?: unknown } | undefined)?.proxy,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : null,
      });

      return new Response(JSON.stringify({ ok: true, result: { id: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const callApi = createBunTelegramCallApi({
        botToken: "123:token",
        apiRoot: "https://api.telegram.org",
        apiMode: "bot",
        testEnv: false,
        proxyUrl: "http://127.0.0.1:7890",
      });

      const result = await callApi("getMe", {});
      expect(result).toEqual({ id: 1 });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toContain("/bot123:token/getMe");
      expect(calls[0]?.proxy).toBe("http://127.0.0.1:7890");
      expect(calls[0]?.method).toBe("POST");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
