import { createLogger } from "../logger";
import type {
  InboundSms,
  KeepaliveRequestResult,
  ModemProvider,
  ModemStatus,
  OutboundSmsInput,
  OutboundSmsResult,
} from "./types";

const logger = createLogger("modem.mock");

function nowIso(): string {
  return new Date().toISOString();
}

export class MockModemProvider implements ModemProvider {
  #onInboundSms: ((message: InboundSms) => Promise<void> | void) | null = null;
  #pendingInbox: InboundSms[] = [];
  #busy = false;
  #status: ModemStatus = {
    connected: true,
    simReady: true,
    registered: true,
    phoneNumber: "+447700900123",
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
  keepaliveRequests: Array<{ url: string; timeoutMs: number }> = [];
  keepaliveHandler: ((url: string, timeoutMs: number) => Promise<KeepaliveRequestResult>) | null = null;

  async start(onInboundSms: (message: InboundSms) => Promise<void> | void): Promise<void> {
    this.#onInboundSms = onInboundSms;
    logger.info("Mock modem started.");
  }

  async drainInbox(): Promise<void> {
    const pending = [...this.#pendingInbox];
    this.#pendingInbox = [];
    logger.info("Mock modem draining inbox.", { count: pending.length });
    for (const message of pending) {
      await this.#onInboundSms?.(message);
    }
  }

  async stop(): Promise<void> {
    logger.info("Mock modem stopped.");
  }

  async getStatus(): Promise<ModemStatus> {
    return this.#status;
  }

  isBusy(): boolean {
    return this.#busy;
  }

  async setDataEnabled(enabled: boolean): Promise<void> {
    this.#status = {
      ...this.#status,
      dataAttached: enabled,
      pdpActive: enabled,
      ipAddress: enabled ? "10.0.0.2" : null,
      lastUpdatedAt: nowIso(),
    };
    logger.info("Mock modem data state updated.", { enabled });
  }

  async waitForDataReady(): Promise<void> {}

  async sendSms(input: OutboundSmsInput): Promise<OutboundSmsResult> {
    this.sentMessages.push(input);
    logger.info("Mock modem sent SMS.", {
      remoteNumber: input.remoteNumber,
      bodyLength: input.body.length,
      sessionId: input.sessionId ?? null,
    });
    return {
      modemMessageId: `${this.sentMessages.length}`,
      sentAt: nowIso(),
    };
  }

  async performKeepaliveRequest(url: string, timeoutMs: number): Promise<KeepaliveRequestResult> {
    this.keepaliveRequests.push({ url, timeoutMs });
    this.#busy = true;
    logger.info("Mock modem keepalive started.", { url, timeoutMs });
    this.#status = {
      ...this.#status,
      dataAttached: true,
      pdpActive: true,
      ipAddress: "10.0.0.2",
      lastUpdatedAt: nowIso(),
    };

    try {
      if (this.keepaliveHandler) {
        return await this.keepaliveHandler(url, timeoutMs);
      }

      return {
        httpStatus: 204,
        responseLength: 0,
        protocol: url.toLowerCase().startsWith("https://") ? "https" : "http",
      };
    } finally {
      this.#busy = false;
      logger.info("Mock modem keepalive finished.", { url });
      this.#status = {
        ...this.#status,
        dataAttached: false,
        pdpActive: false,
        ipAddress: null,
        lastUpdatedAt: nowIso(),
      };
    }
  }

  async emitInboundSms(message: InboundSms): Promise<void> {
    await this.#onInboundSms?.(message);
  }

  seedInbox(messages: InboundSms[]): void {
    this.#pendingInbox.push(...messages);
  }
}
