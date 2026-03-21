import type { AccountProvider, AccountSummary } from "./provider";
import type { AppDatabase } from "../storage/database";

export class NotImplementedAccountProvider implements AccountProvider {
  readonly #database: AppDatabase;

  constructor(database: AppDatabase) {
    this.#database = database;
  }

  async getSummary(): Promise<AccountSummary> {
    const tracking = this.#database.getAccountTrackingState();
    return {
      implementationStatus: "not_implemented",
      lastAttemptAt: tracking.lastAccountAttemptAt,
      airtimeCredit: tracking.lastKnownAirtimeCredit,
      lastBalanceChangeAt: tracking.lastBalanceChangeAt,
      nextKeepaliveDeadlineAt: tracking.nextKeepaliveDeadlineAt,
      trackingStatus: tracking.trackingStatus,
    };
  }

  async recordAttempt(): Promise<void> {
    this.#database.recordAccountAttempt(new Date().toISOString());
  }

  async refresh(): Promise<AccountSummary> {
    return this.getSummary();
  }
}
