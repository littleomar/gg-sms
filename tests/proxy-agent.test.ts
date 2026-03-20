import { describe, expect, it } from "bun:test";

import { createTelegramProxyAgent } from "../src/bot/proxy-agent";

describe("createTelegramProxyAgent", () => {
  it("returns undefined when no proxy is configured", () => {
    expect(createTelegramProxyAgent(undefined)).toBeUndefined();
    expect(createTelegramProxyAgent("")).toBeUndefined();
  });

  it("creates an agent for supported proxy URLs", () => {
    const agent = createTelegramProxyAgent("socks5://127.0.0.1:7890");
    expect(agent).toBeDefined();
  });

  it("throws on invalid proxy URLs", () => {
    expect(() => createTelegramProxyAgent("not-a-url")).toThrow();
  });
});
