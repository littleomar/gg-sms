import type { InboundSms, ModemProvider, ModemStatus, OutboundSmsInput, OutboundSmsResult } from "./types";

function nowIso(): string {
  return new Date().toISOString();
}

export class MockModemProvider implements ModemProvider {
  #onInboundSms: ((message: InboundSms) => Promise<void> | void) | null = null;
  #pendingInbox: InboundSms[] = [];
  #status: ModemStatus = {
    connected: true,
    simReady: true,
    registered: true,
    operatorName: "Mock Carrier",
    signalQuality: 25,
    smsReady: true,
    dataAttached: false,
    pdpActive: false,
    ipAddress: null,
    modemModel: "Mock Modem",
    lastUpdatedAt: nowIso(),
  };
  sentMessages: OutboundSmsInput[] = [];

  async start(onInboundSms: (message: InboundSms) => Promise<void> | void): Promise<void> {
    this.#onInboundSms = onInboundSms;
  }

  async drainInbox(): Promise<void> {
    const pending = [...this.#pendingInbox];
    this.#pendingInbox = [];
    for (const message of pending) {
      await this.#onInboundSms?.(message);
    }
  }

  async stop(): Promise<void> {}

  async getStatus(): Promise<ModemStatus> {
    return this.#status;
  }

  async setDataEnabled(enabled: boolean): Promise<void> {
    this.#status = {
      ...this.#status,
      dataAttached: enabled,
      pdpActive: enabled,
      ipAddress: enabled ? "10.0.0.2" : null,
      lastUpdatedAt: nowIso(),
    };
  }

  async waitForDataReady(): Promise<void> {}

  async sendSms(input: OutboundSmsInput): Promise<OutboundSmsResult> {
    this.sentMessages.push(input);
    return {
      modemMessageId: `${this.sentMessages.length}`,
      sentAt: nowIso(),
    };
  }

  async emitInboundSms(message: InboundSms): Promise<void> {
    await this.#onInboundSms?.(message);
  }

  seedInbox(messages: InboundSms[]): void {
    this.#pendingInbox.push(...messages);
  }
}
