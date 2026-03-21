import type { AppConfig } from "./config";
import { NotImplementedAccountProvider } from "./account/not-implemented-account-provider";
import { TelegramBotService } from "./bot/telegram-bot";
import { KeepaliveJob } from "./jobs/keepalive-job";
import { Ec200ModemProvider } from "./modem/ec200-modem-provider";
import { MockModemProvider } from "./modem/mock-modem-provider";
import type { ModemProvider } from "./modem/types";
import { DraftSessionService } from "./sms/draft-session-service";
import { AppDatabase, DatabaseDraftSessionStore } from "./storage/database";

export class GgSmsApp {
  readonly #config: AppConfig;
  readonly #database: AppDatabase;
  readonly #modem: ModemProvider;
  readonly #accountProvider: NotImplementedAccountProvider;
  readonly #draftSessions: DraftSessionService;
  readonly #keepaliveJob: KeepaliveJob;
  readonly #bot: TelegramBotService;

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
      telegramProxyUrl: config.telegramProxyUrl,
      modem: this.#modem,
      database: this.#database,
      drafts: this.#draftSessions,
      accountProvider: this.#accountProvider,
      keepaliveJob: this.#keepaliveJob,
    });
  }

  async start(): Promise<void> {
    await this.#bot.start();

    try {
      await this.#modem.start(async (message) => {
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
      });
    } catch (error) {
      await this.#bot.stop("startup_failed");
      throw error;
    }

    try {
      await this.#modem.drainInbox();
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      console.error(`Failed to drain modem inbox during startup: ${details}`);
      this.#database.insertAlert("warning", "sms_drain_failed", "Startup inbox scan failed.", {
        error: details,
      });
    }
  }

  async stop(): Promise<void> {
    await Promise.allSettled([
      this.#bot.stop(),
      this.#modem.stop(),
    ]);
    this.#database.close();
  }
}
