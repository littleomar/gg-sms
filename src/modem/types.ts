export type SmsDirection = "inbound" | "outbound";
export type SmsDeliveryStatus = "received" | "sent" | "failed";

export type ModemStatus = {
  connected: boolean;
  simReady: boolean;
  registered: boolean;
  operatorName?: string | null;
  signalQuality?: number | null;
  smsReady: boolean;
  dataAttached: boolean;
  pdpActive: boolean;
  ipAddress?: string | null;
  modemModel?: string | null;
  lastUpdatedAt: string;
};

export type InboundSms = {
  remoteNumber: string;
  body: string;
  receivedAt: string;
  modemMessageId?: string | null;
};

export type OutboundSmsInput = {
  remoteNumber: string;
  body: string;
  sessionId?: string | null;
};

export type OutboundSmsResult = {
  modemMessageId?: string | null;
  sentAt: string;
};

export interface ModemProvider {
  start(onInboundSms: (message: InboundSms) => Promise<void> | void): Promise<void>;
  drainInbox(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): Promise<ModemStatus>;
  setDataEnabled(enabled: boolean): Promise<void>;
  waitForDataReady(timeoutMs: number): Promise<void>;
  sendSms(input: OutboundSmsInput): Promise<OutboundSmsResult>;
}
