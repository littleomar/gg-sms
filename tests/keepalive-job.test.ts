import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { KeepaliveJob } from "../src/jobs/keepalive-job";
import { MockModemProvider } from "../src/modem/mock-modem-provider";
import { AppDatabase } from "../src/storage/database";

const cleanupPaths: string[] = [];

function createDatabase(): AppDatabase {
  const dir = mkdtempSync(join(tmpdir(), "gg-sms-keepalive-"));
  cleanupPaths.push(dir);
  const database = new AppDatabase(join(dir, "test.sqlite"));
  database.init();
  return database;
}

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (path) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

describe("KeepaliveJob", () => {
  it("uses the modem keepalive transport and leaves data disabled afterwards", async () => {
    const modem = new MockModemProvider();
    const database = createDatabase();
    const job = new KeepaliveJob({
      modem,
      database,
      keepaliveUrl: "https://example.com/generate_204",
      timeoutMs: 5_000,
    });

    const result = await job.run();
    const status = await modem.getStatus();

    expect(result.ok).toBe(true);
    expect(modem.keepaliveRequests).toEqual([
      {
        url: "https://example.com/generate_204",
        timeoutMs: 5_000,
      },
    ]);
    expect(status.dataAttached).toBe(false);
    expect(status.pdpActive).toBe(false);
    database.close();
  });

  it("records failures from the modem keepalive transport", async () => {
    const modem = new MockModemProvider();
    modem.keepaliveHandler = async () => {
      throw new Error("sim network unavailable");
    };

    const database = createDatabase();
    const job = new KeepaliveJob({
      modem,
      database,
      keepaliveUrl: "https://example.com/generate_204",
      timeoutMs: 5_000,
    });

    const result = await job.run();
    const status = await modem.getStatus();

    expect(result.ok).toBe(false);
    expect(result.message).toContain("sim network unavailable");
    expect(status.dataAttached).toBe(false);
    expect(status.pdpActive).toBe(false);
    database.close();
  });

  it("prevents concurrent keepalive runs", async () => {
    const modem = new MockModemProvider();
    let release!: () => void;
    modem.keepaliveHandler = async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        httpStatus: 204,
        responseLength: 0,
        protocol: "https",
      };
    };

    const database = createDatabase();
    const job = new KeepaliveJob({
      modem,
      database,
      keepaliveUrl: "https://example.com/generate_204",
      timeoutMs: 5_000,
    });

    const firstRun = job.run();
    const secondRun = await job.run();
    release();
    const firstResult = await firstRun;

    expect(firstResult.ok).toBe(true);
    expect(secondRun.ok).toBe(false);
    expect(secondRun.message).toContain("正在执行中");
    database.close();
  });
});
