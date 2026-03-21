import { describe, expect, test } from "bun:test";

import { loadConfig } from "../src/config";

function baseEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    BOT_TOKEN: "token",
    BOT_ADMIN_ID: "123456",
    SMS_SEND_PASSWORD: "secret",
    MODEM_PORT: "mock",
    MODEM_BAUD: "115200",
    APN_NAME: "giffgaff.com",
    KEEPALIVE_URL: "https://example.com/204",
    DB_PATH: "./data/test.sqlite",
    ...overrides,
  };
}

describe("loadConfig", () => {
  test("uses the default inbox poll interval when not configured", () => {
    const config = loadConfig(baseEnv());

    expect(config.smsPollIntervalMs).toBe(15_000);
    expect(config.logLevel).toBe("info");
  });

  test("allows overriding the inbox poll interval", () => {
    const config = loadConfig(baseEnv({ SMS_POLL_INTERVAL_MS: "5000" }));

    expect(config.smsPollIntervalMs).toBe(5_000);
  });

  test("allows disabling inbox polling with zero", () => {
    const config = loadConfig(baseEnv({ SMS_POLL_INTERVAL_MS: "0" }));

    expect(config.smsPollIntervalMs).toBe(0);
  });

  test("allows overriding the log level", () => {
    const config = loadConfig(baseEnv({ LOG_LEVEL: "debug" }));

    expect(config.logLevel).toBe("debug");
  });
});
