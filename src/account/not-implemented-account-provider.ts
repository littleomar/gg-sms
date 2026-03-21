import type { AccountProvider, AccountSummary } from "./provider";
import { createLogger } from "../logger";
import type { AppDatabase } from "../storage/database";

const logger = createLogger("account.placeholder");

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
    const attemptAt = new Date().toISOString();
    this.#database.recordAccountAttempt(attemptAt);
    logger.debug("Recorded placeholder account attempt.", { attemptAt });
  }

  async refresh(): Promise<AccountSummary> {
    logger.info("Placeholder account refresh requested.");
    return this.getSummary();
  }
}
