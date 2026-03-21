import type { AppConfig } from "./config";
import { NotImplementedAccountProvider } from "./account/not-implemented-account-provider";
import { TelegramBotService } from "./bot/telegram-bot";
import { KeepaliveJob } from "./jobs/keepalive-job";
import { Ec200ModemProvider } from "./modem/ec200-modem-provider";
import { MockModemProvider } from "./modem/mock-modem-provider";
import type { ModemProvider } from "./modem/types";
import { DraftSessionService } from "./sms/draft-session-service";
import { AppDatabase, DatabaseDraftSessionStore } from "./storage/database";

const STARTUP_STEP_TIMEOUT_MS = 30_000;

async function withTimeout<T>(label: string, operation: Promise<T>, timeoutMs = STARTUP_STEP_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export class GgSmsApp {
  readonly #config: AppConfig;
  readonly #database: AppDatabase;
  readonly #modem: ModemProvider;
  readonly #accountProvider: NotImplementedAccountProvider;
  readonly #draftSessions: DraftSessionService;
  readonly #keepaliveJob: KeepaliveJob;
  readonly #bot: TelegramBotService;
  #smsPollTimer: ReturnType<typeof setTimeout> | null = null;
  #smsPollInFlight = false;
  #stopping = false;

  constructor(config: AppConfig) {
    this.#config = config;
    this.#database = new AppDatabase(config.dbPath);
    this.#database.init();

    this.#modem =
      config.modemPort === "mock"
        ? new MockModemProvider()
        : new Ec200ModemProvider({
            portPath: config.modemPort,
            baudRate: config.modemBaud,
            apnName: config.apnName,
            apnUser: config.apnUser,
            apnPass: config.apnPass,
            simPin: config.simPin,
            debug: config.modemDebug,
          });

    this.#accountProvider = new NotImplementedAccountProvider(this.#database);
    this.#draftSessions = new DraftSessionService({
      store: new DatabaseDraftSessionStore(this.#database),
      ttlMs: config.smsDraftTtlMs,
      password: config.smsSendPassword,
    });
    this.#keepaliveJob = new KeepaliveJob({
      modem: this.#modem,
      database: this.#database,
      keepaliveUrl: config.keepaliveUrl,
      timeoutMs: config.keepaliveTimeoutMs,
    });
    this.#bot = new TelegramBotService({
      botToken: config.botToken,
      adminId: config.botAdminId,
      initialNotifyChatId: config.botNotifyChatId,
      telegramProxyUrl: config.telegramProxyUrl,
      modem: this.#modem,
      database: this.#database,
      drafts: this.#draftSessions,
      accountProvider: this.#accountProvider,
      keepaliveJob: this.#keepaliveJob,
    });
  }

  async start(): Promise<void> {
    this.#stopping = false;

    console.log("Starting Telegram bot...");
    await withTimeout("Telegram bot startup", this.#bot.start());
    console.log("Telegram bot started.");

    try {
      console.log(`Starting modem on ${this.#config.modemPort}...`);
      await withTimeout("Modem startup", this.#modem.start(async (message) => {
        const storedMessage = this.#database.insertInboundSms(message);
        try {
          await this.#bot.pushInboundSms(storedMessage.id);
        } catch (error) {
          const details = error instanceof Error ? error.message : String(error);
          console.error(`Failed to push inbound SMS ${storedMessage.id} to Telegram: ${details}`);
          this.#database.insertAlert("error", "sms_push_failed", "Inbound SMS push to Telegram failed.", {
            messageId: storedMessage.id,
            remoteNumber: storedMessage.remoteNumber,
            error: details,
          });
        }
      }));
      console.log("Modem started.");
    } catch (error) {
      await this.#bot.stop("startup_failed");
      throw error;
    }

    try {
      console.log("Scanning modem inbox for unread SMS...");
      await withTimeout("Modem inbox scan", this.#modem.drainInbox());
      console.log("Modem inbox scan completed.");
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      console.error(`Failed to drain modem inbox during startup: ${details}`);
      this.#database.insertAlert("warning", "sms_drain_failed", "Startup inbox scan failed.", {
        error: details,
      });
    }

    if (this.#config.smsPollIntervalMs > 0) {
      console.log(`Starting background inbox polling every ${this.#config.smsPollIntervalMs}ms...`);
      this.#scheduleSmsPoll();
    }
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#smsPollTimer) {
      clearTimeout(this.#smsPollTimer);
      this.#smsPollTimer = null;
    }

    await Promise.allSettled([
      this.#bot.stop(),
      this.#modem.stop(),
    ]);
    this.#database.close();
  }

  #scheduleSmsPoll(): void {
    if (this.#stopping || this.#smsPollTimer || this.#config.smsPollIntervalMs <= 0) {
      return;
    }

    this.#smsPollTimer = setTimeout(async () => {
      this.#smsPollTimer = null;
      await this.#runSmsPoll();
      this.#scheduleSmsPoll();
    }, this.#config.smsPollIntervalMs);
  }

  async #runSmsPoll(): Promise<void> {
    if (this.#stopping || this.#smsPollInFlight) {
      return;
    }

    this.#smsPollInFlight = true;
    try {
      await withTimeout("Modem inbox poll", this.#modem.drainInbox());
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      console.error(`Failed to poll modem inbox: ${details}`);
      this.#database.insertAlert("warning", "sms_poll_failed", "Background inbox poll failed.", {
        error: details,
      });
    } finally {
      this.#smsPollInFlight = false;
    }
  }
}
