export type AccountTrackingStatus = "unavailable" | "unconfirmed" | "tracked" | "overdue";

export type AccountSummary = {
  implementationStatus: "not_implemented" | "available";
  lastAttemptAt: string | null;
  airtimeCredit: string | null;
  lastBalanceChangeAt: string | null;
  nextKeepaliveDeadlineAt: string | null;
  trackingStatus: AccountTrackingStatus;
};

export interface AccountProvider {
  getSummary(): Promise<AccountSummary>;
  recordAttempt(): Promise<void>;
  refresh(): Promise<AccountSummary>;
}
