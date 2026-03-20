import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { NotImplementedAccountProvider } from "../src/account/not-implemented-account-provider";
import { AppDatabase } from "../src/storage/database";

const cleanupPaths: string[] = [];

function createDatabase(): AppDatabase {
  const dir = mkdtempSync(join(tmpdir(), "gg-sms-account-"));
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

describe("NotImplementedAccountProvider", () => {
  it("returns the placeholder summary contract", async () => {
    const database = createDatabase();
    const provider = new NotImplementedAccountProvider(database);

    const summary = await provider.getSummary();

    expect(summary.implementationStatus).toBe("not_implemented");
    expect(summary.trackingStatus).toBe("unavailable");
    expect(summary.airtimeCredit).toBeNull();
    expect(summary.lastBalanceChangeAt).toBeNull();
    expect(summary.nextKeepaliveDeadlineAt).toBeNull();
    database.close();
  });

  it("records the last account attempt timestamp", async () => {
    const database = createDatabase();
    const provider = new NotImplementedAccountProvider(database);

    await provider.recordAttempt();
    const summary = await provider.getSummary();

    expect(summary.lastAttemptAt).not.toBeNull();
    database.close();
  });
});
