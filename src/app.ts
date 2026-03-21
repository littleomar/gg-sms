import { DashboardAccountProvider } from "./account/dashboard-account-provider";
import type { AccountProvider } from "./account/provider";
import type { AppConfig } from "./config";
import { TelegramBotService } from "./bot/telegram-bot";
import { KeepaliveJob } from "./jobs/keepalive-job";
import { Ec200ModemProvider } from "./modem/ec200-modem-provider";
import { MockModemProvider } from "./modem/mock-modem-provider";
import type { ModemProvider } from "./modem/types";
import { DraftSessionService } from "./sms/draft-session-service";
import { AppDatabase, DatabaseDraftSessionStore } from "./storage/database";

const STARTUP_STEP_TIMEOUT_MS = 30_000;
const COMPONENT_RETRY_DELAY_MS = 30_000;

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
  readonly #accountProvider: AccountProvider;
  readonly #draftSessions: DraftSessionService;
  readonly #keepaliveJob: KeepaliveJob;
  readonly #bot: TelegramBotService;
  #botRetryTimer: ReturnType<typeof setTimeout> | null = null;
  #modemRetryTimer: ReturnType<typeof setTimeout> | null = null;
  #botStarting = false;
  #modemStarting = false;
  #botStarted = false;
  #modemStarted = false;
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

    this.#accountProvider = new DashboardAccountProvider({
      database: this.#database,
      bootstrapCookie: config.accountDashboardCookie,
      dashboardUrl: config.accountDashboardUrl,
      acceptLanguage: config.accountDashboardAcceptLanguage,
      userAgent: config.accountDashboardUserAgent,
    });
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
      onRuntimeError: (error) => {
        void this.#handleBotRuntimeFailure(error);
      },
    });
  }

  async start(): Promise<void> {
    this.#stopping = false;

    await Promise.allSettled([
      this.#ensureBotStarted("startup"),
      this.#ensureModemStarted("startup"),
    ]);

    if (this.#config.smsPollIntervalMs > 0) {
      console.log(`Starting background inbox polling every ${this.#config.smsPollIntervalMs}ms...`);
      this.#scheduleSmsPoll();
    }
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#botStarted = false;
    this.#modemStarted = false;
    this.#botStarting = false;
    this.#modemStarting = false;

    if (this.#botRetryTimer) {
      clearTimeout(this.#botRetryTimer);
      this.#botRetryTimer = null;
    }
    if (this.#modemRetryTimer) {
      clearTimeout(this.#modemRetryTimer);
      this.#modemRetryTimer = null;
    }

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

    if (this.#modem.isBusy()) {
      return;
    }

    if (!this.#modemStarted) {
      await this.#ensureModemStarted("poll");
      return;
    }

    this.#smsPollInFlight = true;
    try {
      await withTimeout("Modem inbox poll", this.#modem.drainInbox());
    } catch (error) {
      await this.#handleModemFailure(error, "Background inbox poll failed.", "sms_poll_failed");
    } finally {
      this.#smsPollInFlight = false;
    }
  }

  async #ensureBotStarted(reason: "startup" | "retry"): Promise<void> {
    if (this.#stopping || this.#botStarted || this.#botStarting) {
      return;
    }

    this.#botStarting = true;
    try {
      console.log(reason === "startup" ? "Starting Telegram bot..." : "Retrying Telegram bot startup...");
      await withTimeout("Telegram bot startup", this.#bot.start());
      this.#botStarted = true;
      if (this.#botRetryTimer) {
        clearTimeout(this.#botRetryTimer);
        this.#botRetryTimer = null;
      }
      console.log("Telegram bot started.");
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      console.error(`Telegram bot startup failed: ${details}`);
      this.#database.insertAlert("warning", "telegram_start_failed", "Telegram bot startup failed.", {
        error: details,
      });
      await this.#bot.stop("startup_failed").catch(() => undefined);
      this.#scheduleBotRetry();
    } finally {
      this.#botStarting = false;
    }
  }

  async #ensureModemStarted(reason: "startup" | "retry" | "poll"): Promise<void> {
    if (this.#stopping || this.#modemStarted || this.#modemStarting) {
      return;
    }

    this.#modemStarting = true;
    try {
      console.log(reason === "startup" ? `Starting modem on ${this.#config.modemPort}...` : `Retrying modem on ${this.#config.modemPort}...`);
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

      this.#modemStarted = true;
      if (this.#modemRetryTimer) {
        clearTimeout(this.#modemRetryTimer);
        this.#modemRetryTimer = null;
      }
      console.log("Modem started.");
      await this.#scanInboxAfterStartup();
    } catch (error) {
      await this.#handleModemFailure(error, "Modem startup failed.", "modem_start_failed");
    } finally {
      this.#modemStarting = false;
    }
  }

  async #scanInboxAfterStartup(): Promise<void> {
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
  }

  async #handleBotRuntimeFailure(error: Error): Promise<void> {
    if (this.#stopping) {
      return;
    }

    this.#botStarted = false;
    this.#database.insertAlert("warning", "telegram_runtime_failed", "Telegram bot stopped unexpectedly.", {
      error: error.message,
    });
    await this.#bot.stop("runtime_failed").catch(() => undefined);
    this.#scheduleBotRetry();
  }

  async #handleModemFailure(error: unknown, message: string, code: string): Promise<void> {
    const details = error instanceof Error ? error.message : String(error);
    console.error(`${message} ${details}`);
    this.#database.insertAlert("warning", code, message, {
      error: details,
    });
    this.#modemStarted = false;
    await this.#modem.stop().catch(() => undefined);
    this.#scheduleModemRetry();
  }

  #scheduleBotRetry(): void {
    if (this.#stopping || this.#botRetryTimer) {
      return;
    }

    console.log(`Telegram bot will retry in ${COMPONENT_RETRY_DELAY_MS}ms.`);
    this.#botRetryTimer = setTimeout(() => {
      this.#botRetryTimer = null;
      void this.#ensureBotStarted("retry");
    }, COMPONENT_RETRY_DELAY_MS);
  }

  #scheduleModemRetry(): void {
    if (this.#stopping || this.#modemRetryTimer) {
      return;
    }

    console.log(`Modem will retry in ${COMPONENT_RETRY_DELAY_MS}ms.`);
    this.#modemRetryTimer = setTimeout(() => {
      this.#modemRetryTimer = null;
      void this.#ensureModemStarted("retry");
    }, COMPONENT_RETRY_DELAY_MS);
  }
}
