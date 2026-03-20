import type { AccountTrackingStatus } from "../account/provider";
import type { InboundSms, SmsDeliveryStatus } from "../modem/types";
import type { SmsDraftSession } from "../sms/draft-session-service";

export type StoredSmsMessage = {
  id: number;
  direction: "inbound" | "outbound";
  remoteNumber: string;
  body: string;
  messageAt: string;
  status: SmsDeliveryStatus;
  modemMessageId: string | null;
  sessionId: string | null;
};

export type InsertOutboundSmsInput = {
  remoteNumber: string;
  body: string;
  messageAt: string;
  status: SmsDeliveryStatus;
  modemMessageId?: string | null;
  sessionId?: string | null;
};

export type AccountTrackingState = {
  lastAccountAttemptAt: string | null;
  lastAccountSyncAt: string | null;
  lastKnownAirtimeCredit: string | null;
  lastBalanceChangeAt: string | null;
  nextKeepaliveDeadlineAt: string | null;
  trackingStatus: AccountTrackingStatus;
};

export type JobRunStatus = "running" | "success" | "failed";

export type AlertLevel = "info" | "warning" | "error";

export type DatabaseDraftStore = {
  getDraft(chatId: string): SmsDraftSession | null;
  saveDraft(session: SmsDraftSession): void;
  deleteDraft(chatId: string): void;
  pruneExpired(nowIso: string): void;
};

export function mapInboundToStoredSms(message: InboundSms, id: number): StoredSmsMessage {
  return {
    id,
    direction: "inbound",
    remoteNumber: message.remoteNumber,
    body: message.body,
    messageAt: message.receivedAt,
    status: "received",
    modemMessageId: message.modemMessageId ?? null,
    sessionId: null,
  };
}
