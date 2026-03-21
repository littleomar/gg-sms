import { afterEach, describe, expect, it } from "bun:test";

import { applyTelegramProxyEnvironment, createTelegramProxyAgent } from "../src/bot/proxy-agent";

const originalProxyEnvironment = {
  ALL_PROXY: process.env.ALL_PROXY,
  all_proxy: process.env.all_proxy,
  HTTP_PROXY: process.env.HTTP_PROXY,
  http_proxy: process.env.http_proxy,
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  https_proxy: process.env.https_proxy,
};

afterEach(() => {
  process.env.ALL_PROXY = originalProxyEnvironment.ALL_PROXY;
  process.env.all_proxy = originalProxyEnvironment.all_proxy;
  process.env.HTTP_PROXY = originalProxyEnvironment.HTTP_PROXY;
  process.env.http_proxy = originalProxyEnvironment.http_proxy;
  process.env.HTTPS_PROXY = originalProxyEnvironment.HTTPS_PROXY;
  process.env.https_proxy = originalProxyEnvironment.https_proxy;
});

describe("createTelegramProxyAgent", () => {
  it("returns undefined when no proxy is configured", () => {
    expect(createTelegramProxyAgent(undefined)).toBeUndefined();
    expect(createTelegramProxyAgent("")).toBeUndefined();
  });

  it("creates an agent for supported proxy URLs", () => {
    const agent = createTelegramProxyAgent("socks5://127.0.0.1:7890");
    expect(agent).toBeDefined();
  });

  it("applies Bun environment proxy variables for http proxies", () => {
    const configuration = applyTelegramProxyEnvironment("http://127.0.0.1:7890");

    expect(configuration.enabled).toBe(true);
    expect(configuration.bunEnvProxyApplied).toBe(true);
    expect(process.env.ALL_PROXY).toBe("http://127.0.0.1:7890");
    expect(process.env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
    expect(process.env.HTTP_PROXY).toBe("http://127.0.0.1:7890");
  });

  it("keeps ALL_PROXY for socks proxies but skips Bun http(s) fallback", () => {
    const configuration = applyTelegramProxyEnvironment("socks5://127.0.0.1:7890");

    expect(configuration.enabled).toBe(true);
    expect(configuration.bunEnvProxyApplied).toBe(false);
    expect(process.env.ALL_PROXY).toBe("socks5://127.0.0.1:7890");
    expect(process.env.HTTPS_PROXY).toBe(originalProxyEnvironment.HTTPS_PROXY);
  });

  it("throws on invalid proxy URLs", () => {
    expect(() => createTelegramProxyAgent("not-a-url")).toThrow();
    expect(() => applyTelegramProxyEnvironment("not-a-url")).toThrow();
  });
});
