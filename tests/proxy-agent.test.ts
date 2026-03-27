import { afterEach, describe, expect, it } from "bun:test";

import { applyTelegramProxyEnv } from "../src/bot/telegram-proxy-env";

const savedEnv = {
  HTTP_PROXY: process.env.HTTP_PROXY,
  http_proxy: process.env.http_proxy,
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  https_proxy: process.env.https_proxy,
  NO_PROXY: process.env.NO_PROXY,
  no_proxy: process.env.no_proxy,
};

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("applyTelegramProxyEnv", () => {
  it("does nothing when no proxy URL is provided", () => {
    applyTelegramProxyEnv(undefined);
    expect(process.env.HTTP_PROXY).toBe(savedEnv.HTTP_PROXY);
  });

  it("does nothing for empty string", () => {
    applyTelegramProxyEnv("  ");
    expect(process.env.HTTP_PROXY).toBe(savedEnv.HTTP_PROXY);
  });

  it("sets proxy env vars", () => {
    applyTelegramProxyEnv("http://127.0.0.1:7890");

    expect(process.env.HTTP_PROXY).toBe("http://127.0.0.1:7890");
    expect(process.env.http_proxy).toBe("http://127.0.0.1:7890");
    expect(process.env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
    expect(process.env.https_proxy).toBe("http://127.0.0.1:7890");
  });

  it("adds dashboard hostname to NO_PROXY", () => {
    applyTelegramProxyEnv("http://127.0.0.1:7890", "https://www.giffgaff.com/dashboard");

    expect(process.env.NO_PROXY).toContain("www.giffgaff.com");
    expect(process.env.NO_PROXY).toContain("connectivitycheck.gstatic.com");
  });

  it("includes keepalive host in NO_PROXY even without dashboard", () => {
    applyTelegramProxyEnv("http://127.0.0.1:7890");

    expect(process.env.NO_PROXY).toContain("connectivitycheck.gstatic.com");
  });
});
