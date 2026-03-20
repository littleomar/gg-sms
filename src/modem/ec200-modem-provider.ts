import { SerialPort } from "serialport";

import type { InboundSms, ModemProvider, ModemStatus, OutboundSmsInput, OutboundSmsResult } from "./types";

const CTRL_Z = String.fromCharCode(26);

type PendingResponse = {
  command: string;
  lines: string[];
  mode: "standard" | "prompt";
  resolve: (lines: string[]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  onPrompt?: () => void;
};

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function encodeUcs2(text: string): string {
  let result = "";
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0xffff) {
      result += codePoint.toString(16).padStart(4, "0").toUpperCase();
      continue;
    }

    const adjusted = codePoint - 0x10000;
    const high = 0xd800 + (adjusted >> 10);
    const low = 0xdc00 + (adjusted & 0x3ff);
    result += high.toString(16).padStart(4, "0").toUpperCase();
    result += low.toString(16).padStart(4, "0").toUpperCase();
  }
  return result;
}

function decodeUcs2(hex: string): string {
  if (!/^[0-9A-F]+$/i.test(hex) || hex.length % 4 !== 0) {
    return hex;
  }

  const codeUnits: number[] = [];
  for (let index = 0; index < hex.length; index += 4) {
    codeUnits.push(Number.parseInt(hex.slice(index, index + 4), 16));
  }
  return String.fromCharCode(...codeUnits);
}

function maybeDecodeUcs2(value: string): string {
  const trimmed = value.trim();
  return /^[0-9A-F]+$/i.test(trimmed) && trimmed.length >= 4 && trimmed.length % 4 === 0
    ? decodeUcs2(trimmed)
    : trimmed;
}

function parseQuotedFields(input: string): string[] {
  return Array.from(input.matchAll(/"([^"]*)"/g)).map((match) => match[1]);
}

export class Ec200ModemProvider implements ModemProvider {
  readonly #portPath: string;
  readonly #baudRate: number;
  readonly #apnName: string;
  readonly #apnUser?: string;
  readonly #apnPass?: string;
  readonly #simPin?: string;
  readonly #commandTimeoutMs: number;
  #port: SerialPort | null = null;
  #buffer = "";
  #pendingResponse: PendingResponse | null = null;
  #commandQueue = Promise.resolve();
  #onInboundSms: ((message: InboundSms) => Promise<void> | void) | null = null;
  #status: ModemStatus = {
    connected: false,
    simReady: false,
    registered: false,
    operatorName: null,
    signalQuality: null,
    smsReady: false,
    dataAttached: false,
    pdpActive: false,
    ipAddress: null,
    modemModel: null,
    lastUpdatedAt: nowIso(),
  };

  constructor(options: {
    portPath: string;
    baudRate: number;
    apnName: string;
    apnUser?: string;
    apnPass?: string;
    simPin?: string;
    commandTimeoutMs?: number;
  }) {
    this.#portPath = options.portPath;
    this.#baudRate = options.baudRate;
    this.#apnName = options.apnName;
    this.#apnUser = options.apnUser;
    this.#apnPass = options.apnPass;
    this.#simPin = options.simPin;
    this.#commandTimeoutMs = options.commandTimeoutMs ?? 10_000;
  }

  async start(onInboundSms: (message: InboundSms) => Promise<void> | void): Promise<void> {
    this.#onInboundSms = onInboundSms;
    this.#port = new SerialPort({
      path: this.#portPath,
      baudRate: this.#baudRate,
      autoOpen: false,
    });

    this.#port.on("data", (data: Buffer) => this.#handleChunk(data.toString("utf8")));
    this.#port.on("error", () => {
      this.#status = {
        ...this.#status,
        connected: false,
        lastUpdatedAt: nowIso(),
      };
    });

    await new Promise<void>((resolve, reject) => {
      this.#port?.open((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    this.#status = {
      ...this.#status,
      connected: true,
      lastUpdatedAt: nowIso(),
    };

    await this.#initializeModem();
    await this.#refreshStatus();
  }

  async stop(): Promise<void> {
    if (!this.#port) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.#port?.close(() => resolve());
    });
    this.#port = null;
    this.#status = {
      ...this.#status,
      connected: false,
      lastUpdatedAt: nowIso(),
    };
  }

  async getStatus(): Promise<ModemStatus> {
    if (this.#port) {
      await this.#refreshStatus();
    }
    return this.#status;
  }

  async setDataEnabled(enabled: boolean): Promise<void> {
    if (enabled) {
      await this.#sendCommand(`AT+CGDCONT=1,"IP","${this.#apnName}"`);
      await this.#sendCommand(
        `AT+QICSGP=1,1,"${this.#apnName}","${this.#apnUser ?? ""}","${this.#apnPass ?? ""}",1`,
      );
      await this.#sendCommand("AT+CGATT=1");
      await this.#sendCommand("AT+CGACT=1,1");
    } else {
      await this.#sendCommand("AT+CGACT=0,1");
      await this.#sendCommand("AT+CGATT=0");
    }

    await this.#refreshStatus();
  }

  async waitForDataReady(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await this.getStatus();
      if (status.dataAttached && status.pdpActive) {
        return;
      }
      await sleep(1_000);
    }

    throw new Error("Timed out waiting for modem data session to become ready");
  }

  async sendSms(input: OutboundSmsInput): Promise<OutboundSmsResult> {
    const encodedNumber = encodeUcs2(input.remoteNumber);
    const encodedBody = encodeUcs2(input.body);

    const lines = await this.#enqueue(() => this.#sendSmsCommand(encodedNumber, encodedBody));

    const modemMessageId =
      lines.find((line) => line.startsWith("+CMGS:"))?.split(":")[1]?.trim() ?? null;

    return {
      modemMessageId,
      sentAt: nowIso(),
    };
  }

  async #initializeModem(): Promise<void> {
    await this.#sendCommand("ATE0");
    await this.#sendCommand("AT+CMEE=2");
    if (this.#simPin) {
      try {
        await this.#sendCommand(`AT+CPIN="${this.#simPin}"`);
      } catch {
        // SIM may already be unlocked.
      }
    }
    await this.#sendCommand('AT+CSCS="UCS2"');
    await this.#sendCommand("AT+CMGF=1");
    await this.#sendCommand("AT+CSMP=17,167,0,8");
    await this.#sendCommand('AT+CPMS="ME","ME","ME"');
    await this.#sendCommand("AT+CNMI=2,1,0,0,0");
  }

  async #refreshStatus(): Promise<void> {
    const cpin = await this.#sendCommand("AT+CPIN?");
    const csq = await this.#sendCommand("AT+CSQ");
    const creg = await this.#sendCommand("AT+CREG?");
    const cgatt = await this.#sendCommand("AT+CGATT?");
    const cgpaddr = await this.#sendCommand("AT+CGPADDR=1");
    const cops = await this.#sendCommand("AT+COPS?");
    const ati = await this.#sendCommand("ATI");

    const signalMatch = csq.join("\n").match(/\+CSQ:\s*(\d+),/);
    const registrationMatch = creg.join("\n").match(/\+CREG:\s*\d,(\d)/);
    const attachedMatch = cgatt.join("\n").match(/\+CGATT:\s*(\d)/);
    const addressMatch = cgpaddr.join("\n").match(/\+CGPADDR:\s*1,("?)([^"\r\n]+)\1/);
    const operatorFields = parseQuotedFields(cops.join("\n"));

    const ipAddress = addressMatch?.[2] && addressMatch[2] !== "0.0.0.0" ? addressMatch[2] : null;

    this.#status = {
      connected: true,
      simReady: cpin.some((line) => line.includes("READY")),
      registered: registrationMatch ? ["1", "5"].includes(registrationMatch[1]) : false,
      operatorName: operatorFields[0] ? maybeDecodeUcs2(operatorFields[0]) : null,
      signalQuality: signalMatch ? Number.parseInt(signalMatch[1], 10) : null,
      smsReady: true,
      dataAttached: attachedMatch?.[1] === "1",
      pdpActive: Boolean(ipAddress),
      ipAddress,
      modemModel: ati.find((line) => line && !line.startsWith("AT")) ?? this.#status.modemModel,
      lastUpdatedAt: nowIso(),
    };
  }

  async #handleInboundMessage(index: number): Promise<void> {
    try {
      const lines = await this.#sendCommand(`AT+CMGR=${index}`);
      const header = lines.find((line) => line.startsWith("+CMGR:"));
      const body = lines.filter((line) => !line.startsWith("+CMGR:")).at(-1) ?? "";
      const fields = header ? parseQuotedFields(header) : [];
      const remoteNumber = fields[1] ? maybeDecodeUcs2(fields[1]) : "unknown";

      await this.#sendCommand(`AT+CMGD=${index}`);

      if (!this.#onInboundSms) {
        return;
      }

      await this.#onInboundSms({
        remoteNumber,
        body: maybeDecodeUcs2(body),
        receivedAt: nowIso(),
        modemMessageId: String(index),
      });
    } catch {
      // Ignore malformed SMS notifications and continue listening.
    }
  }

  #handleChunk(chunk: string): void {
    const pending = this.#pendingResponse;
    if (pending?.mode === "prompt" && chunk.includes(">")) {
      pending.onPrompt?.();
      chunk = chunk.replace(">", "");
    }

    this.#buffer += chunk;
    let separatorIndex = this.#buffer.indexOf("\r\n");
    while (separatorIndex >= 0) {
      const line = this.#buffer.slice(0, separatorIndex).trim();
      this.#buffer = this.#buffer.slice(separatorIndex + 2);
      if (line) {
        this.#handleLine(line);
      }
      separatorIndex = this.#buffer.indexOf("\r\n");
    }
  }

  #handleLine(line: string): void {
    if (line.startsWith("+CMTI:")) {
      const match = line.match(/,(\d+)$/);
      if (match) {
        void this.#handleInboundMessage(Number.parseInt(match[1], 10));
      }
      return;
    }

    const pending = this.#pendingResponse;
    if (!pending) {
      return;
    }

    if (line === pending.command) {
      return;
    }

    if (line === "OK") {
      clearTimeout(pending.timer);
      this.#pendingResponse = null;
      pending.resolve(pending.lines);
      return;
    }

    if (line === "ERROR" || line.startsWith("+CME ERROR")) {
      clearTimeout(pending.timer);
      this.#pendingResponse = null;
      pending.reject(new Error(line));
      return;
    }

    pending.lines.push(line);
  }

  async #sendCommand(command: string): Promise<string[]> {
    return this.#enqueue(async () => {
      const responsePromise = new Promise<string[]>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.#pendingResponse = null;
          reject(new Error(`Timed out waiting for modem response: ${command}`));
        }, this.#commandTimeoutMs);

        this.#pendingResponse = {
          command,
          lines: [],
          mode: "standard",
          resolve,
          reject,
          timer,
        };
      });

      try {
        await this.#write(`${command}\r`);
      } catch (error) {
        const pending = this.#pendingResponse;
        if (pending) {
          clearTimeout(pending.timer);
          this.#pendingResponse = null;
          pending.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }

      return responsePromise;
    });
  }

  async #sendSmsCommand(encodedNumber: string, payload: string): Promise<string[]> {
    const command = `AT+CMGS="${encodedNumber}"`;
    const responsePromise = new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingResponse = null;
        reject(new Error(`Timed out waiting for SMS prompt: ${command}`));
      }, this.#commandTimeoutMs);

      this.#pendingResponse = {
        command,
        lines: [],
        mode: "prompt",
        resolve,
        reject,
        timer,
        onPrompt: () => {
          const current = this.#pendingResponse;
          if (!current) {
            return;
          }
          clearTimeout(current.timer);
          current.mode = "standard";
          current.command = "AT+CMGS";
          current.timer = setTimeout(() => {
            this.#pendingResponse = null;
            current.reject(new Error("Timed out waiting for modem final response"));
          }, this.#commandTimeoutMs);

          void this.#write(`${payload}${CTRL_Z}`).catch((error) => {
            const active = this.#pendingResponse;
            if (!active) {
              return;
            }
            clearTimeout(active.timer);
            this.#pendingResponse = null;
            active.reject(error instanceof Error ? error : new Error(String(error)));
          });
        },
      };
    });

    try {
      await this.#write(`${command}\r`);
    } catch (error) {
      const pending = this.#pendingResponse;
      if (pending) {
        clearTimeout(pending.timer);
        this.#pendingResponse = null;
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }

    return responsePromise;
  }

  async #write(data: string): Promise<void> {
    if (!this.#port) {
      throw new Error("Modem serial port is not open");
    }

    await new Promise<void>((resolve, reject) => {
      this.#port?.write(data, (error) => {
        if (error) {
          reject(error);
          return;
        }
        this.#port?.drain((drainError) => {
          if (drainError) {
            reject(drainError);
            return;
          }
          resolve();
        });
      });
    });
  }

  async #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#commandQueue.then(operation, operation);
    this.#commandQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
