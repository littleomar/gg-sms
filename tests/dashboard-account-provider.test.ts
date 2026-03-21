import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { DashboardAccountProvider, extractAirtimeCreditFromDashboard } from "../src/account/dashboard-account-provider";
import { AppDatabase } from "../src/storage/database";

const DASHBOARD_HTML = `
  <div class="gg-c-widget balance-section">
    <div id="balance-value" class="balance-box">
      <div class="box-left">
        <h4>&pound;10.00</h4>
      </div>
    </div>
  </div>
`;

describe("DashboardAccountProvider", () => {
  const originalFetch = globalThis.fetch;
  const databasePath = join(process.cwd(), "data", "dashboard-account-provider.test.sqlite");
  let database: AppDatabase;

  beforeEach(() => {
    rmSync(databasePath, { force: true });
    database = new AppDatabase(databasePath);
    database.init();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    database.close();
    rmSync(databasePath, { force: true });
  });

  test("extracts the airtime credit from the dashboard HTML", () => {
    expect(extractAirtimeCreditFromDashboard(DASHBOARD_HTML)).toBe("£10.00");
  });

  test("refreshes the account summary from the dashboard cookie request", async () => {
    globalThis.fetch = mock(async () =>
      new Response(DASHBOARD_HTML, {
        status: 200,
        headers: {
          "content-type": "text/html",
        },
      }),
    ) as unknown as typeof fetch;

    const provider = new DashboardAccountProvider({
      database,
      bootstrapCookie: "giffgaff=session",
    });

    await provider.recordAttempt();
    const summary = await provider.refresh();

    expect(summary.implementationStatus).toBe("available");
    expect(summary.airtimeCredit).toBe("£10.00");
    expect(summary.trackingStatus).toBe("unconfirmed");
    expect(summary.lastAttemptAt).not.toBeNull();
  });

  test("marks balance changes and computes the 180-day deadline", async () => {
    globalThis.fetch = mock(async () =>
      new Response(DASHBOARD_HTML.replace("10.00", "12.00"), {
        status: 200,
        headers: {
          "content-type": "text/html",
        },
      }),
    ) as unknown as typeof fetch;

    database.updateAccountTrackingState({
      lastAccountSyncAt: "2026-03-20T00:00:00.000Z",
      lastKnownAirtimeCredit: "£10.00",
      lastBalanceChangeAt: null,
      nextKeepaliveDeadlineAt: null,
      trackingStatus: "unconfirmed",
    });

    const provider = new DashboardAccountProvider({
      database,
      bootstrapCookie: "giffgaff=session",
    });

    const summary = await provider.refresh();

    expect(summary.airtimeCredit).toBe("£12.00");
    expect(summary.trackingStatus).toBe("tracked");
    expect(summary.lastBalanceChangeAt).not.toBeNull();
    expect(summary.nextKeepaliveDeadlineAt).not.toBeNull();
  });

  test("fails with a clear message when no dashboard cookie is configured", async () => {
    const provider = new DashboardAccountProvider({
      database,
    });

    await expect(provider.refresh()).rejects.toThrow("/accountcookie <cookie>");
  });

  test("uses a cookie that was stored after provider construction", async () => {
    globalThis.fetch = mock(async () =>
      new Response(DASHBOARD_HTML, {
        status: 200,
        headers: {
          "content-type": "text/html",
        },
      }),
    ) as unknown as typeof fetch;

    const provider = new DashboardAccountProvider({
      database,
    });

    database.setAccountDashboardCookie("giffgaff=session");

    const summary = await provider.refresh();

    expect(summary.implementationStatus).toBe("available");
    expect(summary.airtimeCredit).toBe("£10.00");
  });
});
