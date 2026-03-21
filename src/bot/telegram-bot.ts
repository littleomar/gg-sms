import { Markup, Telegraf, type Context } from "telegraf";

import type { AccountProvider } from "../account/provider";
import type { KeepaliveJob } from "../jobs/keepalive-job";
import type { ModemProvider } from "../modem/types";
import { createTelegramProxyAgent } from "./proxy-agent";
import { isAdminUser } from "./auth";
import type { DraftSessionService } from "../sms/draft-session-service";
import type { AppDatabase } from "../storage/database";

type AppContext = Context;

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
    `运营商: ${status.operatorName ?? "unknown"}`,
    `信号: ${status.signalQuality ?? "unknown"}`,
    `短信能力: ${status.smsReady ? "ready" : "not ready"}`,
    `数据附着: ${status.dataAttached ? "on" : "off"}`,
    `PDP: ${status.pdpActive ? "active" : "inactive"}`,
    `IP: ${status.ipAddress ?? "n/a"}`,
    `更新时间: ${status.lastUpdatedAt}`,
  ];

  return lines.join("\n");
}

function formatAccountSummary(summary: Awaited<ReturnType<AccountProvider["getSummary"]>>): string {
  return [
    "账户跟踪",
    `实现状态: ${summary.implementationStatus}`,
    `最近尝试: ${summary.lastAttemptAt ?? "未发生"}`,
    `余额: ${summary.airtimeCredit ?? "未可用"}`,
    `上次余额变化: ${summary.lastBalanceChangeAt ?? "未可用"}`,
    `下次截止日期: ${summary.nextKeepaliveDeadlineAt ?? "未可用"}`,
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
    "/account - 账户模块占位回复",
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
  readonly #chatId: string;
  #pollingTask: Promise<void> | null = null;

  constructor(options: {
    botToken: string;
    adminId: string;
    telegramProxyUrl?: string;
    modem: ModemProvider;
    database: AppDatabase;
    drafts: DraftSessionService;
    accountProvider: AccountProvider;
    keepaliveJob: KeepaliveJob;
  }) {
    const proxyAgent = createTelegramProxyAgent(options.telegramProxyUrl);
    this.#bot = new Telegraf<AppContext>(options.botToken, {
      telegram: proxyAgent
        ? {
            agent: proxyAgent,
            attachmentAgent: proxyAgent,
          }
        : undefined,
    });
    this.#adminId = options.adminId;
    this.#chatId = options.adminId;
    this.#modem = options.modem;
    this.#database = options.database;
    this.#drafts = options.drafts;
    this.#accountProvider = options.accountProvider;
    this.#keepaliveJob = options.keepaliveJob;

    this.#registerHandlers();
  }

  async start(): Promise<void> {
    const botInfo = await this.#bot.telegram.getMe();
    this.#bot.botInfo = botInfo;
    await this.#bot.telegram.deleteWebhook();

    const internalBot = this.#bot as any;
    this.#pollingTask = (internalBot.startPolling as (allowedUpdates?: string[]) => Promise<void>)([]).catch((error: unknown) => {
      const details = error instanceof Error ? error.message : String(error);
      console.error(`Telegram polling stopped: ${details}`);
      throw error;
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
  }

  async pushInboundSms(messageId: number): Promise<void> {
    const message = this.#database.getSmsById(messageId);
    if (!message) {
      return;
    }

    const payload = [
      "收到新短信",
      `号码: ${message.remoteNumber}`,
      `时间: ${message.messageAt}`,
      `内容: ${message.body}`,
    ].join("\n");

    await this.#bot.telegram.sendMessage(this.#chatId, payload, {
      reply_markup: Markup.inlineKeyboard([
        Markup.button.callback("Reply", `sms:reply:${message.id}`),
      ]).reply_markup,
    });
  }

  async pushAlert(title: string, body: string): Promise<void> {
    await this.#bot.telegram.sendMessage(this.#chatId, `${title}\n${body}`);
  }

  #registerHandlers(): void {
    this.#bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;
      if (!isAdminUser(userId, this.#adminId)) {
        if ("reply" in ctx) {
          await ctx.reply("未授权访问。");
        }
        return;
      }
      await next();
    });

    this.#bot.command("help", async (ctx) => {
      await ctx.reply(formatHelpText());
    });

    this.#bot.command("status", async (ctx) => {
      const [modemStatus, accountSummary] = await Promise.all([
        this.#modem.getStatus(),
        this.#accountProvider.getSummary(),
      ]);
      await ctx.reply(`${formatModemStatus(modemStatus)}\n\n${formatAccountSummary(accountSummary)}`);
    });

    this.#bot.command("data", async (ctx) => {
      const args = parseCommandArgs("message" in ctx && "text" in ctx.message ? ctx.message.text : undefined);
      const action = args[1];
      if (action !== "on" && action !== "off") {
        await ctx.reply("请使用 /data on 或 /data off。");
        return;
      }

      await this.#modem.setDataEnabled(action === "on");
      await ctx.reply(`数据会话已${action === "on" ? "打开" : "关闭"}。`);
    });

    this.#bot.command("keepalive", async (ctx) => {
      const result = await this.#keepaliveJob.run();
      await ctx.reply(result.message);
    });

    this.#bot.command("account", async (ctx) => {
      await this.#accountProvider.recordAttempt();
      const summary = await this.#accountProvider.getSummary();
      await ctx.reply(
        `${formatAccountSummary(summary)}\n\n/account 当前仅为占位接口，等待后续调研后接入真实账户查询模块。`,
      );
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

        const lines = ["最近短信"];
        for (const message of messages) {
          const prefix = message.direction === "inbound" ? "IN" : "OUT";
          lines.push(
            `${prefix} #${message.id} ${message.remoteNumber} ${message.messageAt} ${message.status}\n${message.body}`,
          );
        }

        await ctx.reply(lines.join("\n\n"));
        return;
      }

      const result = this.#drafts.beginCompose(String(ctx.chat?.id ?? this.#adminId));
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
        await ctx.answerCbQuery(result.created ? "已进入回复模式" : "已有进行中的草稿");
        await ctx.reply(result.message);
        return;
      }

      const chatId = String(ctx.chat?.id ?? this.#adminId);

      if (callback.action === "preview") {
        const result = this.#drafts.advancePreview(chatId, callback.value);
        await ctx.answerCbQuery(result.ok ? "进入验密" : "无法继续");
        await ctx.reply(result.message);
        return;
      }

      if (callback.action === "cancel") {
        const cancelled = this.#drafts.cancel(chatId, callback.value);
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
