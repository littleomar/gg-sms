import { Markup, Telegraf, type Context } from "telegraf";

import type { AccountProvider } from "../account/provider";
import type { KeepaliveJob } from "../jobs/keepalive-job";
import { createLogger } from "../logger";
import type { ModemProvider } from "../modem/types";
import { canUseBunFetchTelegramProxy, createBunTelegramCallApi } from "./telegram-transport";
import { isAdminUser } from "./auth";
import type { DraftSessionService } from "../sms/draft-session-service";
import type { AppDatabase } from "../storage/database";
import { formatDisplayTime } from "../time";

type AppContext = Context;

const BOT_MENU_COMMANDS = [
  { command: "help", description: "显示帮助" },
  { command: "status", description: "查看 EC200 和账户状态" },
  { command: "data", description: "控制数据会话: /data on|off" },
  { command: "sms", description: "新建短信草稿或查看 inbox" },
  { command: "keepalive", description: "执行一次最小流量保号" },
  { command: "account", description: "刷新并查看账户信息" },
  { command: "accountcookie", description: "设置 giffgaff dashboard cookie" },
] as const;
const logger = createLogger("bot.telegram");

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatModemStatus(status: Awaited<ReturnType<ModemProvider["getStatus"]>>): string {
  const lines = [
    "EC200 / SIM 状态",
    `连接: ${status.connected ? "online" : "offline"}`,
    `SIM: ${status.simReady ? "ready" : "not ready"}`,
    `注册: ${status.registered ? "registered" : "not registered"}`,
    `本机号码: ${status.phoneNumber ?? "unknown"}`,
    `运营商: ${status.operatorName ?? "unknown"}`,
    `信号: ${status.signalQuality ?? "unknown"}`,
    `短信能力: ${status.smsReady ? "ready" : "not ready"}`,
    `数据附着: ${status.dataAttached ? "on" : "off"}`,
    `PDP: ${status.pdpActive ? "active" : "inactive"}`,
    `IP: ${status.ipAddress ?? "n/a"}`,
    `更新时间: ${formatDisplayTime(status.lastUpdatedAt)}`,
  ];

  return lines.join("\n");
}

function formatAccountSummary(summary: Awaited<ReturnType<AccountProvider["getSummary"]>>): string {
  return [
    "账户跟踪",
    `实现状态: ${summary.implementationStatus}`,
    `最近尝试: ${summary.lastAttemptAt ? formatDisplayTime(summary.lastAttemptAt) : "未发生"}`,
    `余额: ${summary.airtimeCredit ?? "未可用"}`,
    `上次余额变化: ${summary.lastBalanceChangeAt ? formatDisplayTime(summary.lastBalanceChangeAt) : "未可用"}`,
    `下次截止日期: ${summary.nextKeepaliveDeadlineAt ? formatDisplayTime(summary.nextKeepaliveDeadlineAt) : "未可用"}`,
    `追踪状态: ${summary.trackingStatus}`,
  ].join("\n");
}

function formatHelpText(): string {
  return [
    "可用命令",
    "/help - 显示帮助",
    "/status - 查询 EC200、本地状态和账户占位状态",
    "/data on - 打开数据会话",
    "/data off - 关闭数据会话",
    "/sms - 新建短信草稿",
    "/sms inbox [n] - 查看最近短信",
    "/keepalive - 执行一次最小流量保号",
    "/account - 刷新并查看账户信息",
    "/accountcookie <cookie> - 设置 dashboard cookie",
    "/accountcookie clear - 清除 dashboard cookie",
    "",
    "发送短信说明",
    "1. 使用 /sms 新建草稿，或点击入站短信上的 Reply。",
    "2. 输入内容后会先看到预览。",
    "3. 点击 Continue，输入发送密码。",
    "4. 验密通过后还要点击 Confirm 才会真正发送。",
  ].join("\n");
}

function previewButtons(sessionId: string) {
  return Markup.inlineKeyboard([
    Markup.button.callback("Continue", `sms:preview:${sessionId}`),
    Markup.button.callback("Cancel", `sms:cancel:${sessionId}`),
  ]);
}

function confirmButtons(sessionId: string) {
  return Markup.inlineKeyboard([
    Markup.button.callback("Confirm", `sms:confirm:${sessionId}`),
    Markup.button.callback("Cancel", `sms:cancel:${sessionId}`),
  ]);
}

function parseCommandArgs(text: string | undefined): string[] {
  if (!text) {
    return [];
  }
  return text.trim().split(/\s+/);
}

function getCommandRemainder(text: string | undefined): string {
  if (!text) {
    return "";
  }

  const match = text.trim().match(/^\/\S+(?:@\S+)?(?:\s+([\s\S]*))?$/);
  return match?.[1]?.trim() ?? "";
}

function parseCallback(data: string | undefined): { type: string; action: string; value: string } | null {
  if (!data) {
    return null;
  }
  const [type, action, ...rest] = data.split(":");
  if (!type || !action || rest.length === 0) {
    return null;
  }
  return {
    type,
    action,
    value: rest.join(":"),
  };
}

async function safeDeleteMessage(ctx: AppContext): Promise<void> {
  if (!("message" in ctx) || !ctx.message) {
    return;
  }

  try {
    await ctx.deleteMessage(ctx.message.message_id);
  } catch {
    // Best effort only. Some chats may not allow deleting user messages.
  }
}

export class TelegramBotService {
  readonly #bot: Telegraf<AppContext>;
  readonly #adminId: string;
  readonly #modem: ModemProvider;
  readonly #database: AppDatabase;
  readonly #drafts: DraftSessionService;
  readonly #accountProvider: AccountProvider;
  readonly #keepaliveJob: KeepaliveJob;
  readonly #onRuntimeError?: (error: Error) => void;
  #notifyChatId: string;
  #pollingTask: Promise<void> | null = null;

  constructor(options: {
    botToken: string;
    adminId: string;
    initialNotifyChatId?: string;
    telegramProxyUrl?: string;
    modem: ModemProvider;
    database: AppDatabase;
    drafts: DraftSessionService;
    accountProvider: AccountProvider;
    keepaliveJob: KeepaliveJob;
    onRuntimeError?: (error: Error) => void;
  }) {
    this.#bot = new Telegraf<AppContext>(options.botToken);

    const proxyUrl = options.telegramProxyUrl?.trim();
    if (proxyUrl) {
      if (!canUseBunFetchTelegramProxy(proxyUrl)) {
        logger.warn(
          "Telegram proxy uses a non-HTTP protocol which is not supported by Bun's fetch. Proxy will not take effect.",
          { proxyUrl },
        );
      } else {
        const telegramClient = this.#bot.telegram as any;
        const callApiViaBun = createBunTelegramCallApi({
          botToken: options.botToken,
          apiRoot: telegramClient.options.apiRoot,
          apiMode: telegramClient.options.apiMode,
          testEnv: telegramClient.options.testEnv,
          proxyUrl,
        });

        telegramClient.callApi = async (method: string, payload: Record<string, unknown>, apiOptions?: { signal?: AbortSignal }) => {
          return callApiViaBun(method, payload, apiOptions);
        };

        logger.info("Enabled Bun native Telegram API proxy transport.", { proxyUrl });
      }
    }

    this.#adminId = options.adminId;
    this.#modem = options.modem;
    this.#database = options.database;
    this.#drafts = options.drafts;
    this.#accountProvider = options.accountProvider;
    this.#keepaliveJob = options.keepaliveJob;
    this.#onRuntimeError = options.onRuntimeError;
    this.#notifyChatId =
      options.initialNotifyChatId ??
      this.#database.getNotifyChatId() ??
      options.adminId;

    if (options.initialNotifyChatId) {
      this.#database.setNotifyChatId(options.initialNotifyChatId);
    }

    this.#bot.catch(async (error, ctx) => {
      const details = error instanceof Error ? error.message : String(error);
      logger.error("Telegram handler failed.", {
        error,
        updateType: ctx.updateType,
        chatId: ctx.chat?.id,
        userId: ctx.from?.id,
      });
      this.#database.insertAlert("error", "telegram_handler_failed", "Telegram handler failed.", {
        error: details,
        updateType: ctx.updateType,
      });

      if ("reply" in ctx) {
        try {
          await ctx.reply(`操作失败: ${details}`);
        } catch {
          // Ignore secondary Telegram failures.
        }
      }
    });

    this.#registerHandlers();
  }

  async start(): Promise<void> {
    logger.info("Starting Telegram bot service.");
    const botInfo = await this.#bot.telegram.getMe();
    this.#bot.botInfo = botInfo;
    await this.#bot.telegram.deleteWebhook();
    await this.#bot.telegram.setMyCommands(BOT_MENU_COMMANDS);
    await this.#bot.telegram.setChatMenuButton({
      menuButton: {
        type: "commands",
      },
    });

    const internalBot = this.#bot as any;
    this.#pollingTask = (internalBot.startPolling as (allowedUpdates?: string[]) => Promise<void>)([]).catch((error: unknown) => {
      const runtimeError = error instanceof Error ? error : new Error(String(error));
      logger.error("Telegram polling stopped unexpectedly.", { error: runtimeError });
      this.#onRuntimeError?.(runtimeError);
    });
    logger.info("Telegram bot polling started.", {
      botUsername: botInfo.username,
      notifyChatId: this.#notifyChatId,
    });
  }

  async stop(reason = "shutdown"): Promise<void> {
    try {
      await this.#bot.stop(reason);
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      if (!details.includes("Bot is not running")) {
        throw error;
      }
    }

    this.#pollingTask = null;
    logger.info("Telegram bot stopped.", { reason });
  }

  async pushInboundSms(messageId: number): Promise<void> {
    const message = this.#database.getSmsById(messageId);
    if (!message) {
      logger.warn("Attempted to push an SMS that does not exist in storage.", { messageId });
      return;
    }

    const payload = [
      "收到新短信",
      `号码: ${message.remoteNumber}`,
      `时间: ${formatDisplayTime(message.messageAt)}`,
      `内容: ${message.body}`,
    ].join("\n");

    await this.#bot.telegram.sendMessage(this.#notifyChatId, payload, {
      reply_markup: Markup.inlineKeyboard([
        Markup.button.callback("Reply", `sms:reply:${message.id}`),
      ]).reply_markup,
    });
    logger.info("Inbound SMS pushed to Telegram.", {
      messageId,
      notifyChatId: this.#notifyChatId,
      remoteNumber: message.remoteNumber,
    });
  }

  async pushAlert(title: string, body: string): Promise<void> {
    await this.#bot.telegram.sendMessage(this.#notifyChatId, `${title}\n${body}`);
    logger.warn("Alert pushed to Telegram.", {
      notifyChatId: this.#notifyChatId,
      title,
    });
  }

  #registerHandlers(): void {
    this.#bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;
      if (!isAdminUser(userId, this.#adminId)) {
        logger.warn("Rejected unauthorized Telegram access.", {
          userId,
          chatId: ctx.chat?.id,
        });
        if ("reply" in ctx) {
          await ctx.reply("未授权访问。");
        }
        return;
      }

      const currentChatId = String(ctx.chat?.id ?? this.#adminId);
      if (currentChatId !== this.#notifyChatId) {
        this.#notifyChatId = currentChatId;
        this.#database.setNotifyChatId(currentChatId);
        logger.info("Updated Telegram notify chat.", { notifyChatId: currentChatId });
      }

      await next();
    });

    this.#bot.command("help", async (ctx) => {
      await ctx.reply(formatHelpText());
    });

    this.#bot.command("status", async (ctx) => {
      logger.info("Handling /status command.", { chatId: ctx.chat?.id });
      const [modemStatus, accountSummary] = await Promise.all([
        this.#modem.getStatus(),
        this.#accountProvider.getSummary(),
      ]);
      logger.info("Status data collected, sending reply.", { chatId: ctx.chat?.id });
      await ctx.reply(`${formatModemStatus(modemStatus)}\n\n${formatAccountSummary(accountSummary)}`);
      logger.info("Status reply sent.", { chatId: ctx.chat?.id });
    });

    this.#bot.command("data", async (ctx) => {
      const args = parseCommandArgs("message" in ctx && "text" in ctx.message ? ctx.message.text : undefined);
      const action = args[1];
      if (action !== "on" && action !== "off") {
        await ctx.reply("请使用 /data on 或 /data off。");
        return;
      }

      logger.info("Handling /data command.", {
        action,
        chatId: ctx.chat?.id,
      });
      await this.#modem.setDataEnabled(action === "on");
      await ctx.reply(`数据会话已${action === "on" ? "打开" : "关闭"}。`);
    });

    this.#bot.command("keepalive", async (ctx) => {
      logger.info("Handling /keepalive command.", { chatId: ctx.chat?.id });
      const result = await this.#keepaliveJob.run();
      await ctx.reply(result.message);
    });

    this.#bot.command("account", async (ctx) => {
      logger.info("Handling /account command.", { chatId: ctx.chat?.id });
      await this.#accountProvider.recordAttempt();

      try {
        const summary = await this.#accountProvider.refresh();
        const suffix =
          summary.implementationStatus === "not_implemented"
            ? "\n\n/account 当前仅为占位接口，等待后续调研后接入真实账户查询模块。"
            : "\n\n账户信息已从 giffgaff dashboard 刷新。";
        await ctx.reply(`${formatAccountSummary(summary)}${suffix}`);
      } catch (error) {
        const details = error instanceof Error ? error.message : String(error);
        this.#database.insertAlert("error", "account_refresh_failed", "Account refresh failed.", {
          error: details,
        });
        await ctx.reply(`账户刷新失败: ${details}`);
      }
    });

    this.#bot.command("accountcookie", async (ctx) => {
      const text = "message" in ctx && "text" in ctx.message ? ctx.message.text : undefined;
      const rawCookie = getCommandRemainder(text);

      if (!rawCookie) {
        await ctx.reply(
          [
            "请使用 /accountcookie <cookie> 设置 giffgaff dashboard cookie。",
            "如果要清除已保存的 cookie，请使用 /accountcookie clear。",
          ].join("\n"),
        );
        return;
      }

      if (rawCookie.toLowerCase() === "clear") {
        this.#database.setAccountDashboardCookie(null);
        logger.info("Cleared dashboard cookie from Telegram command.", { chatId: ctx.chat?.id });
        await safeDeleteMessage(ctx);
        await ctx.reply("dashboard cookie 已清除。");
        return;
      }

      this.#database.setAccountDashboardCookie(rawCookie);
      logger.info("Updated dashboard cookie from Telegram command.", {
        chatId: ctx.chat?.id,
        cookieLength: rawCookie.length,
      });
      await safeDeleteMessage(ctx);

      try {
        const summary = await this.#accountProvider.refresh();
        await ctx.reply(
          `dashboard cookie 已保存并验证成功。\n\n${formatAccountSummary(summary)}`,
        );
      } catch (error) {
        const details = error instanceof Error ? error.message : String(error);
        this.#database.insertAlert("warning", "account_cookie_validation_failed", "Dashboard cookie validation failed.", {
          error: details,
        });
        await ctx.reply(`dashboard cookie 已保存，但验证失败: ${details}`);
      }
    });

    this.#bot.command("sms", async (ctx) => {
      const text = "message" in ctx && "text" in ctx.message ? ctx.message.text : undefined;
      const args = parseCommandArgs(text);

      if (args[1] === "inbox") {
        const requestedLimit = Number.parseInt(args[2] ?? "10", 10);
        const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(20, requestedLimit)) : 10;
        const messages = this.#database.listRecentSms(limit);
        if (messages.length === 0) {
          await ctx.reply("当前没有短信记录。");
          return;
        }

        logger.info("Handling /sms inbox command.", {
          chatId: ctx.chat?.id,
          limit,
          count: messages.length,
        });

        const lines = ["最近短信"];
        for (const message of messages) {
          const prefix = message.direction === "inbound" ? "IN" : "OUT";
          lines.push(
            `${prefix} #${message.id} ${message.remoteNumber} ${formatDisplayTime(message.messageAt)} ${message.status}\n${message.body}`,
          );
        }

        await ctx.reply(lines.join("\n\n"));
        return;
      }

      const result = this.#drafts.beginCompose(String(ctx.chat?.id ?? this.#adminId));
      logger.info("Started compose SMS flow.", {
        chatId: ctx.chat?.id,
        created: result.created,
        sessionId: result.session.sessionId,
      });
      await ctx.reply(result.message);
    });

    this.#bot.on("callback_query", async (ctx) => {
      const callback = parseCallback(ctx.callbackQuery && "data" in ctx.callbackQuery ? ctx.callbackQuery.data : undefined);
      if (!callback || callback.type !== "sms") {
        await ctx.answerCbQuery("未知操作");
        return;
      }

      if (callback.action === "reply") {
        const smsId = Number.parseInt(callback.value, 10);
        const message = this.#database.getSmsById(smsId);
        if (!message) {
          await ctx.answerCbQuery("短信记录不存在");
          return;
        }

        const result = this.#drafts.beginReply(String(ctx.chat?.id ?? this.#adminId), message.remoteNumber, message.id);
        logger.info("Started reply SMS flow.", {
          chatId: ctx.chat?.id,
          created: result.created,
          sessionId: result.session.sessionId,
          sourceMessageId: message.id,
        });
        await ctx.answerCbQuery(result.created ? "已进入回复模式" : "已有进行中的草稿");
        await ctx.reply(result.message);
        return;
      }

      const chatId = String(ctx.chat?.id ?? this.#adminId);

      if (callback.action === "preview") {
        const result = this.#drafts.advancePreview(chatId, callback.value);
        logger.info("Advanced SMS draft to password step.", {
          chatId,
          sessionId: callback.value,
          ok: result.ok,
        });
        await ctx.answerCbQuery(result.ok ? "进入验密" : "无法继续");
        await ctx.reply(result.message);
        return;
      }

      if (callback.action === "cancel") {
        const cancelled = this.#drafts.cancel(chatId, callback.value);
        logger.info("Cancelled SMS draft.", {
          chatId,
          sessionId: callback.value,
          cancelled,
        });
        await ctx.answerCbQuery(cancelled ? "已取消草稿" : "没有活动草稿");
        await ctx.reply(cancelled ? "短信草稿已取消。" : "当前没有活动中的短信草稿。");
        return;
      }

      if (callback.action === "confirm") {
        const result = this.#drafts.canConfirm(chatId, callback.value);
        if (!result.ok || !result.session) {
          await ctx.answerCbQuery("当前草稿不可发送");
          await ctx.reply(result.message);
          return;
        }

        try {
          logger.info("Sending outbound SMS.", {
            chatId,
            sessionId: result.session.sessionId,
            remoteNumber: result.session.remoteNumber,
          });
          const outbound = await this.#modem.sendSms({
            remoteNumber: result.session.remoteNumber!,
            body: result.session.body!,
            sessionId: result.session.sessionId,
          });

          this.#database.insertOutboundSms({
            remoteNumber: result.session.remoteNumber!,
            body: result.session.body!,
            messageAt: outbound.sentAt,
            status: "sent",
            modemMessageId: outbound.modemMessageId,
            sessionId: result.session.sessionId,
          });
          this.#drafts.complete(chatId);

          logger.info("Outbound SMS sent.", {
            chatId,
            sessionId: result.session.sessionId,
            remoteNumber: result.session.remoteNumber,
            modemMessageId: outbound.modemMessageId,
          });

          await ctx.answerCbQuery("短信已发送");
          await ctx.reply(`短信已发送到 ${result.session.remoteNumber}。`);
        } catch (error) {
          const message = error instanceof Error ? error.message : "unknown error";
          this.#database.insertOutboundSms({
            remoteNumber: result.session.remoteNumber!,
            body: result.session.body!,
            messageAt: new Date().toISOString(),
            status: "failed",
            sessionId: result.session.sessionId,
          });
          this.#database.insertAlert("error", "sms_send_failed", "短信发送失败。", {
            error: message,
            remoteNumber: result.session.remoteNumber,
          });
          logger.error("Outbound SMS failed.", {
            error,
            chatId,
            sessionId: result.session.sessionId,
            remoteNumber: result.session.remoteNumber,
          });

          await ctx.answerCbQuery("发送失败");
          await ctx.reply(`短信发送失败: ${message}`);
        }
      }
    });

    this.#bot.on("text", async (ctx) => {
      const text = ctx.message.text;
      if (text.startsWith("/")) {
        return;
      }

      const chatId = String(ctx.chat?.id ?? this.#adminId);
      const activeSession = this.#drafts.getActiveSession(chatId);
      if (!activeSession) {
        return;
      }

      const result = this.#drafts.handleText(chatId, text);
      if (activeSession.state === "password") {
        await safeDeleteMessage(ctx);
      }

      logger.debug("Handled SMS draft text input.", {
        chatId,
        sessionId: activeSession.sessionId,
        previousState: activeSession.state,
        resultType: result.type,
      });

      switch (result.type) {
        case "recipient_collected":
          await ctx.reply(result.message);
          return;
        case "body_collected":
          await ctx.reply(result.message, previewButtons(result.session.sessionId));
          return;
        case "password_valid":
          await ctx.reply(result.message, confirmButtons(result.session.sessionId));
          return;
        case "invalid_recipient":
        case "invalid_body":
        case "password_invalid":
        case "awaiting_password":
          await ctx.reply(result.message);
          return;
        case "no_session":
        case "expired":
          return;
      }
    });
  }
}
