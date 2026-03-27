import { execFile } from "node:child_process";
import {
  closeSync,
  createReadStream,
  createWriteStream,
  openSync,
  type ReadStream,
  type WriteStream,
} from "node:fs";

import { createLogger } from "../logger";
import type {
  InboundSms,
  KeepaliveRequestResult,
  ModemProvider,
  ModemStatus,
  OutboundSmsInput,
  OutboundSmsResult,
} from "./types";

const CTRL_Z = String.fromCharCode(26);
const KEEPALIVE_CONTEXT_ID = 2;
const KEEPALIVE_SSL_CONTEXT_ID = 1;
const logger = createLogger("modem.ec200");

type PendingResponse = {
  command: string;
  lines: string[];
  mode: "standard" | "prompt" | "connect";
  resolve: (lines: string[]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  onPrompt?: () => void;
};

type PendingLineWaiter = {
  prefix: string;
  resolve: (line: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function execFileAsync(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve();
    });
  });
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

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class Ec200ModemProvider implements ModemProvider {
  readonly #portPath: string;
  readonly #baudRate: number;
  readonly #apnName: string;
  readonly #apnUser?: string;
  readonly #apnPass?: string;
  readonly #simPin?: string;
  readonly #commandTimeoutMs: number;
  readonly #debug: boolean;
  #readStream: ReadStream | null = null;
  #writeStream: WriteStream | null = null;
  #readFd: number | null = null;
  #writeFd: number | null = null;
  #buffer = "";
  #pendingResponse: PendingResponse | null = null;
  #pendingLineWaiters: PendingLineWaiter[] = [];
  #commandQueue = Promise.resolve();
  #onInboundSms: ((message: InboundSms) => Promise<void> | void) | null = null;
  #busyOperation: "keepalive" | null = null;
  #ready = false;
  #status: ModemStatus = {
    connected: false,
    simReady: false,
    registered: false,
    phoneNumber: null,
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
    debug?: boolean;
    commandTimeoutMs?: number;
  }) {
    this.#portPath = options.portPath;
    this.#baudRate = options.baudRate;
    this.#apnName = options.apnName;
    this.#apnUser = options.apnUser;
    this.#apnPass = options.apnPass;
    this.#simPin = options.simPin;
    this.#debug = options.debug ?? false;
    this.#commandTimeoutMs = options.commandTimeoutMs ?? 10_000;
  }

  async start(onInboundSms: (message: InboundSms) => Promise<void> | void): Promise<void> {
    this.#onInboundSms = onInboundSms;
    try {
      logger.info("Opening modem serial connection.", {
        portPath: this.#portPath,
        baudRate: this.#baudRate,
      });
      await this.#configurePort();

      this.#readFd = openSync(this.#portPath, "r");
      this.#writeFd = openSync(this.#portPath, "r+");
      this.#readStream = createReadStream(this.#portPath, {
        fd: this.#readFd,
        autoClose: false,
        encoding: "utf8",
      });
      this.#writeStream = createWriteStream(this.#portPath, {
        fd: this.#writeFd,
        autoClose: false,
        encoding: "utf8",
      });

      this.#readStream.on("data", (chunk: string | Buffer) =>
        this.#handleChunk(typeof chunk === "string" ? chunk : chunk.toString("utf8")),
      );
      this.#readStream.on("error", () => {
        this.#handleTransportFailure("Modem read stream failed");
      });
      this.#writeStream.on("error", () => {
        this.#handleTransportFailure("Modem write stream failed");
      });

      this.#status = {
        ...this.#status,
        connected: true,
        lastUpdatedAt: nowIso(),
      };

      await this.#initializeModem();
      await this.#refreshStatusInternal();
      this.#ready = true;
      logger.info("Modem initialization completed.", {
        portPath: this.#portPath,
      });
    } catch (error) {
      logger.error("Modem start failed.", { error, portPath: this.#portPath });
      await this.stop();
      throw error;
    }
  }

  async drainInbox(): Promise<void> {
    this.#debugLog("Scanning modem inbox for unread SMS");
    const lines = await this.#sendCommand('AT+CMGL="REC UNREAD"');
    const indexes = lines
      .map((line) => line.match(/^\+CMGL:\s*(\d+),/))
      .filter((match): match is RegExpMatchArray => match !== null)
      .map((match) => Number.parseInt(match[1], 10));

    if (indexes.length === 0) {
      this.#debugLog("No unread SMS found during startup scan");
      return;
    }

    this.#debugLog(`Found ${indexes.length} unread SMS during startup scan: ${indexes.join(", ")}`);
    for (const index of indexes) {
      await this.#handleInboundMessage(index, "startup_scan");
    }
  }

  async stop(): Promise<void> {
    if (!this.#readStream && !this.#writeStream && this.#readFd === null && this.#writeFd === null) {
      return;
    }

    logger.info("Closing modem serial connection.", { portPath: this.#portPath });
    this.#abortPendingOperations(new Error("Modem serial port closed"));
    this.#busyOperation = null;
    this.#ready = false;

    this.#readStream?.destroy();
    this.#writeStream?.destroy();
    this.#readStream = null;
    this.#writeStream = null;

    if (this.#readFd !== null) {
      closeSync(this.#readFd);
      this.#readFd = null;
    }
    if (this.#writeFd !== null) {
      closeSync(this.#writeFd);
      this.#writeFd = null;
    }

    this.#status = {
      ...this.#status,
      connected: false,
      lastUpdatedAt: nowIso(),
    };
  }

  async getStatus(): Promise<ModemStatus> {
    if (this.#ready && this.#readStream && this.#writeStream) {
      try {
        await this.#enqueue(() => this.#refreshStatusInternal());
      } catch (error) {
        const details = error instanceof Error ? error.message : String(error);
        this.#debugLog("Status refresh failed", details);
        this.#markDisconnected();
      }
    }
    return this.#status;
  }

  isBusy(): boolean {
    return this.#busyOperation !== null;
  }

  async setDataEnabled(enabled: boolean): Promise<void> {
    await this.#enqueue(() => this.#setDataEnabledInternal(enabled));
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

  async performKeepaliveRequest(url: string, timeoutMs: number): Promise<KeepaliveRequestResult> {
    this.#busyOperation = "keepalive";
    logger.info("Starting modem-side keepalive request.", {
      url,
      timeoutMs,
    });
    try {
      const result = await this.#enqueue(() => this.#performKeepaliveRequestInternal(url, timeoutMs));
      logger.info("Modem-side keepalive request completed.", result);
      return result;
    } finally {
      this.#busyOperation = null;
    }
  }

  async #performKeepaliveRequestInternal(url: string, timeoutMs: number): Promise<KeepaliveRequestResult> {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error(`Invalid keepalive URL: ${url}`);
    }

    const protocol = parsedUrl.protocol === "https:" ? "https" : parsedUrl.protocol === "http:" ? "http" : null;
    if (!protocol) {
      throw new Error(`Unsupported keepalive URL protocol: ${parsedUrl.protocol}`);
    }

    await this.#refreshStatusInternal();
    const originalDataAttached = this.#status.dataAttached;
    const originalPdpActive = this.#status.pdpActive;
    const responseTimeoutSeconds = this.#toCommandTimeoutSeconds(timeoutMs);
    let responseLengthHint: number | null = null;
    let requestError: Error | null = null;

    try {
      logger.info("Preparing keepalive data session.", {
        originalDataAttached,
        originalPdpActive,
        protocol,
      });
      await this.#sendCommandInternal(`AT+QICSGP=${KEEPALIVE_CONTEXT_ID},1,"${this.#apnName}","${this.#apnUser ?? ""}","${this.#apnPass ?? ""}",1`);
      await this.#sendCommandInternal("AT+CGATT=1");
      await this.#sendCommandInternal(`AT+QHTTPCFG="contextid",${KEEPALIVE_CONTEXT_ID}`);
      await this.#sendCommandInternal('AT+QHTTPCFG="requestheader",0');
      await this.#sendCommandInternal('AT+QHTTPCFG="responseheader",0');

      if (protocol === "https") {
        await this.#sendCommandInternal(`AT+QHTTPCFG="sslctxid",${KEEPALIVE_SSL_CONTEXT_ID}`);
        await this.#sendCommandInternal(`AT+QSSLCFG="seclevel",${KEEPALIVE_SSL_CONTEXT_ID},0`);
      }

      await this.#sendCommandInternal(`AT+QIACT=${KEEPALIVE_CONTEXT_ID}`);
      await this.#waitForKeepaliveContextReadyInternal(timeoutMs);
      await this.#sendConnectWriteCommandInternal(
        `AT+QHTTPURL=${Buffer.byteLength(url, "utf8")},${responseTimeoutSeconds}`,
        url,
      );

      const httpGetLine = await this.#sendCommandAndWaitForLineInternal(
        `AT+QHTTPGET=${responseTimeoutSeconds}`,
        "+QHTTPGET:",
        timeoutMs,
      );
      const httpGetResult = this.#parseKeepaliveStatusLine(httpGetLine, "+QHTTPGET:");
      if (httpGetResult.err !== 0) {
        throw new Error(`Module HTTP GET failed with error ${httpGetResult.err}`);
      }

      responseLengthHint = httpGetResult.contentLength;
      const responseLength = await this.#discardHttpResponseInternal(timeoutMs, responseLengthHint);

      return {
        httpStatus: httpGetResult.httpStatus,
        responseLength,
        protocol,
      };
    } catch (error) {
      requestError = error instanceof Error ? error : new Error(String(error));
      throw requestError;
    } finally {
      let cleanupError: Error | null = null;
      try {
        await this.#cleanupKeepaliveSessionInternal({
          restoreDetached: !originalDataAttached,
        });
      } catch (error) {
        cleanupError = error instanceof Error ? error : new Error(String(error));
        logger.error("Failed to restore modem state after keepalive.", {
          error: cleanupError,
          restoreDetached: !originalDataAttached,
        });
      }

      try {
        await this.#refreshStatusInternal();
      } catch {
        this.#markDisconnected();
      }

      if (!requestError && cleanupError) {
        throw cleanupError;
      }
    }
  }

  async #setDataEnabledInternal(enabled: boolean): Promise<void> {
    await this.#refreshStatusInternal();
    const alreadyEnabled = this.#status.dataAttached && this.#status.pdpActive;
    const alreadyDisabled = !this.#status.dataAttached && !this.#status.pdpActive;

    if (enabled && alreadyEnabled) {
      logger.info("Data session is already enabled.");
      return;
    }

    if (!enabled && alreadyDisabled) {
      logger.info("Data session is already disabled.");
      return;
    }

    logger.info("Updating modem data state.", {
      enabled,
      dataAttached: this.#status.dataAttached,
      pdpActive: this.#status.pdpActive,
    });

    if (enabled) {
      await this.#sendCommandInternal(`AT+CGDCONT=1,"IP","${this.#apnName}"`);
      await this.#sendCommandInternal(
        `AT+QICSGP=1,1,"${this.#apnName}","${this.#apnUser ?? ""}","${this.#apnPass ?? ""}",1`,
      );
      await this.#sendCommandInternal("AT+CGATT=1");
      await this.#sendCommandInternal("AT+CGACT=1,1");
      await this.#refreshStatusInternal();

      if (!this.#status.dataAttached || !this.#status.pdpActive) {
        throw new Error("Failed to enable modem data session");
      }
      return;
    }

    await this.#sendOptionalCommandInternal("AT+CGACT=0,1");
    await this.#sendOptionalCommandInternal("AT+QIDEACT=1");
    await this.#sendOptionalCommandInternal(`AT+QIDEACT=${KEEPALIVE_CONTEXT_ID}`);
    await this.#sendOptionalCommandInternal("AT+CGATT=0");
    await this.#refreshStatusInternal();

    if (this.#status.dataAttached || this.#status.pdpActive) {
      throw new Error("Failed to disable modem data session");
    }
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

  async #configurePort(): Promise<void> {
    const sttyFlag = process.platform === "darwin" ? "-f" : "-F";
    const commandGroups = [
      [sttyFlag, this.#portPath, String(this.#baudRate)],
      [sttyFlag, this.#portPath, "raw"],
      [sttyFlag, this.#portPath, "-echo"],
      [sttyFlag, this.#portPath, "-ixon"],
      [sttyFlag, this.#portPath, "-ixoff"],
      [sttyFlag, this.#portPath, "cs8"],
      [sttyFlag, this.#portPath, "-parenb"],
      [sttyFlag, this.#portPath, "-cstopb"],
      [sttyFlag, this.#portPath, "cread"],
      [sttyFlag, this.#portPath, "clocal"],
    ];

    const failures: string[] = [];
    for (const args of commandGroups) {
      try {
        await execFileAsync("stty", args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${args.slice(2).join(" ")} -> ${message}`);
      }
    }

    if (failures.length > 0) {
      logger.warn("Some stty options could not be applied.", {
        portPath: this.#portPath,
        failures,
      });
    }
  }

  #debugLog(message: string, details?: string): void {
    if (!this.#debug) {
      return;
    }

    logger.debug(message, details ? { details } : undefined);
  }

  #markDisconnected(): void {
    this.#status = {
      ...this.#status,
      connected: false,
      lastUpdatedAt: nowIso(),
    };
  }

  #handleTransportFailure(message: string): void {
    logger.error("Modem transport failure detected.", { message, portPath: this.#portPath });
    this.#markDisconnected();
    this.#abortPendingOperations(new Error(message));
  }

  #abortPendingOperations(error: Error): void {
    const pending = this.#pendingResponse;
    if (pending) {
      clearTimeout(pending.timer);
      this.#pendingResponse = null;
      pending.reject(error);
    }

    const waiters = this.#pendingLineWaiters;
    this.#pendingLineWaiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  async #refreshStatusInternal(): Promise<void> {
    const cpin = await this.#sendCommandInternal("AT+CPIN?");
    const csq = await this.#sendCommandInternal("AT+CSQ");
    const creg = await this.#sendCommandInternal("AT+CREG?");
    const cgatt = await this.#sendCommandInternal("AT+CGATT?");
    const cgpaddr = await this.#sendCommandInternal("AT+CGPADDR=1");
    const cops = await this.#sendCommandInternal("AT+COPS?");
    const ati = await this.#sendCommandInternal("ATI");
    const cnum = await this.#sendOptionalCommandInternal("AT+CNUM");

    const signalMatch = csq.join("\n").match(/\+CSQ:\s*(\d+),/);
    const registrationMatch = creg.join("\n").match(/\+CREG:\s*\d,(\d)/);
    const attachedMatch = cgatt.join("\n").match(/\+CGATT:\s*(\d)/);
    const addressMatch = cgpaddr.join("\n").match(/\+CGPADDR:\s*1,("?)([^"\r\n]+)\1/);
    const operatorFields = parseQuotedFields(cops.join("\n"));
    const numberFields = parseQuotedFields(cnum.join("\n"));

    const ipAddress = addressMatch?.[2] && addressMatch[2] !== "0.0.0.0" ? addressMatch[2] : null;
    const phoneNumber = numberFields[1]
      ? maybeDecodeUcs2(numberFields[1])
      : numberFields[0]
        ? maybeDecodeUcs2(numberFields[0])
        : this.#status.phoneNumber ?? null;

    this.#status = {
      connected: true,
      simReady: cpin.some((line) => line.includes("READY")),
      registered: registrationMatch ? ["1", "5"].includes(registrationMatch[1]) : false,
      phoneNumber,
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

  async #waitForKeepaliveContextReadyInternal(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const lines = await this.#sendOptionalCommandInternal("AT+QIACT?");
      const match = lines
        .map((line) => line.match(new RegExp(`^\\+QIACT:\\s*${KEEPALIVE_CONTEXT_ID},\\d,\\d,"([^"]+)"`)))
        .find((value): value is RegExpMatchArray => value !== null);

      if (match?.[1] && match[1] !== "0.0.0.0") {
        this.#status = {
          ...this.#status,
          connected: true,
          dataAttached: true,
          pdpActive: true,
          ipAddress: match[1],
          lastUpdatedAt: nowIso(),
        };
        return;
      }

      await sleep(1_000);
    }

    throw new Error("Timed out waiting for keepalive PDP context to become ready");
  }

  async #discardHttpResponseInternal(timeoutMs: number, responseLengthHint: number | null): Promise<number> {
    const readLine = await this.#sendCommandAndWaitForLineInternal(
      `AT+QHTTPREAD=${this.#toCommandTimeoutSeconds(timeoutMs)}`,
      "+QHTTPREAD:",
      timeoutMs,
    );

    const readResult = this.#parseReadStatusLine(readLine);
    if (readResult.err !== 0) {
      throw new Error(`Module HTTP response read failed with error ${readResult.err}`);
    }

    return responseLengthHint ?? readResult.responseLength ?? 0;
  }

  async #cleanupKeepaliveSessionInternal(options: { restoreDetached: boolean }): Promise<void> {
    await this.#sendOptionalCommandInternal("AT+QHTTPSTOP");
    await this.#sendOptionalCommandInternal(`AT+QIDEACT=${KEEPALIVE_CONTEXT_ID}`);
    if (options.restoreDetached) {
      logger.info("Restoring modem data state to detached after keepalive.");
      await this.#sendCommandInternal("AT+CGATT=0");
    }
  }

  #parseKeepaliveStatusLine(line: string, prefix: string): {
    err: number;
    httpStatus: number;
    contentLength: number | null;
  } {
    const match = line.match(new RegExp(`^${escapeRegex(prefix)}\\s*(\\d+)(?:,(\\d+)(?:,(\\d+))?)?$`));
    if (!match) {
      throw new Error(`Unexpected keepalive status line: ${line}`);
    }

    const err = Number.parseInt(match[1], 10);
    const httpStatus = match[2] ? Number.parseInt(match[2], 10) : 0;
    const contentLength = match[3] ? Number.parseInt(match[3], 10) : null;
    return { err, httpStatus, contentLength };
  }

  #parseReadStatusLine(line: string): { err: number; responseLength: number | null } {
    const match = line.match(/^\+QHTTPREAD:\s*(\d+)(?:,(\d+))?$/);
    if (!match) {
      throw new Error(`Unexpected keepalive read status line: ${line}`);
    }

    return {
      err: Number.parseInt(match[1], 10),
      responseLength: match[2] ? Number.parseInt(match[2], 10) : null,
    };
  }

  #toCommandTimeoutSeconds(timeoutMs: number): number {
    return Math.max(1, Math.ceil(timeoutMs / 1000));
  }

  async #handleInboundMessage(index: number, source = "notification"): Promise<void> {
    try {
      this.#debugLog("Reading inbound SMS", `index=${index}, source=${source}`);
      const lines = await this.#sendCommand(`AT+CMGR=${index}`);
      const header = lines.find((line) => line.startsWith("+CMGR:"));
      const body = lines.filter((line) => !line.startsWith("+CMGR:")).at(-1) ?? "";
      const fields = header ? parseQuotedFields(header) : [];
      const remoteNumber = fields[1] ? maybeDecodeUcs2(fields[1]) : "unknown";

      await this.#sendCommand(`AT+CMGD=${index}`);

      if (!this.#onInboundSms) {
        return;
      }

      this.#debugLog("Inbound SMS parsed", `index=${index}, remote=${remoteNumber}, body=${maybeDecodeUcs2(body)}`);
      await this.#onInboundSms({
        remoteNumber,
        body: maybeDecodeUcs2(body),
        receivedAt: nowIso(),
        modemMessageId: String(index),
      });
    } catch (error) {
      const details = error instanceof Error ? error.message : "unknown error";
      logger.error("Failed to process inbound SMS.", {
        error,
        index,
        source,
        details,
      });
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
    this.#debugLog("RX", line);
    if (line.startsWith("+CMTI:")) {
      const match = line.match(/,(\d+)$/);
      if (match) {
        void this.#handleInboundMessage(Number.parseInt(match[1], 10));
      }
      return;
    }

    const waiterMatched = this.#resolveLineWaiter(line);
    const pending = this.#pendingResponse;
    if (!pending && waiterMatched) {
      return;
    }

    if (!pending) {
      return;
    }

    if (line === pending.command) {
      return;
    }

    if (pending.mode === "connect" && line === "CONNECT") {
      pending.onPrompt?.();
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
    return this.#enqueue(() => this.#sendCommandInternal(command));
  }

  async #sendOptionalCommand(command: string): Promise<string[]> {
    try {
      return await this.#sendCommand(command);
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      this.#debugLog("Optional command failed", `${command} -> ${details}`);
      return [];
    }
  }

  async #sendCommandInternal(command: string): Promise<string[]> {
    this.#debugLog("TX", command);
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
  }

  async #sendOptionalCommandInternal(command: string): Promise<string[]> {
    try {
      return await this.#sendCommandInternal(command);
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      this.#debugLog("Optional command failed", `${command} -> ${details}`);
      return [];
    }
  }

  async #sendCommandAndWaitForLineInternal(command: string, prefix: string, timeoutMs: number): Promise<string> {
    const waiter = this.#createLineWaiter(prefix, timeoutMs);
    try {
      await this.#sendCommandInternal(command);
      return await waiter.promise;
    } catch (error) {
      waiter.cancel();
      throw error;
    }
  }

  async #sendConnectWriteCommandInternal(command: string, payload: string): Promise<string[]> {
    this.#debugLog("TX", command);
    const responsePromise = new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingResponse = null;
        reject(new Error(`Timed out waiting for modem CONNECT: ${command}`));
      }, this.#commandTimeoutMs);

      this.#pendingResponse = {
        command,
        lines: [],
        mode: "connect",
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
          current.timer = setTimeout(() => {
            this.#pendingResponse = null;
            current.reject(new Error(`Timed out waiting for modem final response: ${command}`));
          }, this.#commandTimeoutMs);

          this.#debugLog("TX", "<connect-payload>");
          void this.#write(payload).catch((error) => {
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

  async #sendSmsCommand(encodedNumber: string, payload: string): Promise<string[]> {
    const command = `AT+CMGS="${encodedNumber}"`;
    this.#debugLog("TX", command);
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

          this.#debugLog("TX", "<sms-body>");
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

  #createLineWaiter(prefix: string, timeoutMs: number): {
    promise: Promise<string>;
    cancel: () => void;
  } {
    let settled = false;
    let waiter: PendingLineWaiter;

    const promise = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingLineWaiters = this.#pendingLineWaiters.filter((candidate) => candidate !== waiter);
        settled = true;
        reject(new Error(`Timed out waiting for modem URC: ${prefix}`));
      }, timeoutMs);

      waiter = {
        prefix,
        resolve: (line) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve(line);
        },
        reject: (error) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
        timer,
      };
      this.#pendingLineWaiters.push(waiter);
    });

    return {
      promise,
      cancel: () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(waiter.timer);
        this.#pendingLineWaiters = this.#pendingLineWaiters.filter((candidate) => candidate !== waiter);
      },
    };
  }

  #resolveLineWaiter(line: string): boolean {
    const waiter = this.#pendingLineWaiters.find((candidate) => line.startsWith(candidate.prefix));
    if (!waiter) {
      return false;
    }

    this.#pendingLineWaiters = this.#pendingLineWaiters.filter((candidate) => candidate !== waiter);
    clearTimeout(waiter.timer);
    waiter.resolve(line);
    return true;
  }

  async #write(data: string): Promise<void> {
    if (!this.#writeStream) {
      throw new Error("Modem serial port is not open");
    }

    await new Promise<void>((resolve, reject) => {
      this.#writeStream?.write(data, "utf8", (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
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
