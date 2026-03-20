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
  it("enables data, performs the HTTP request, and disables data again", async () => {
    const modem = new MockModemProvider();
    const database = createDatabase();
    const job = new KeepaliveJob({
      modem,
      database,
      keepaliveUrl: "https://example.com/generate_204",
      timeoutMs: 5_000,
      fetchImpl: async () => new Response("", { status: 204 }),
    });

    const result = await job.run();
    const status = await modem.getStatus();

    expect(result.ok).toBe(true);
    expect(status.dataAttached).toBe(false);
    expect(status.pdpActive).toBe(false);
    database.close();
  });
});
