import { randomUUID } from "node:crypto";

import { estimateSmsSegments } from "./encoding";

export type SmsDraftMode = "compose" | "reply";
export type SmsDraftState = "collect_recipient" | "collect_body" | "preview" | "password" | "confirm";

export type SmsDraftSession = {
  sessionId: string;
  chatId: string;
  mode: SmsDraftMode;
  state: SmsDraftState;
  remoteNumber: string | null;
  body: string | null;
  passwordVerified: boolean;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  sourceMessageId: number | null;
};

export type DraftInputResult =
  | { type: "no_session" }
  | { type: "expired" }
  | { type: "invalid_recipient"; message: string }
  | { type: "invalid_body"; message: string }
  | { type: "recipient_collected"; session: SmsDraftSession; message: string }
  | { type: "body_collected"; session: SmsDraftSession; message: string }
  | { type: "awaiting_password"; session: SmsDraftSession; message: string }
  | { type: "password_invalid"; session: SmsDraftSession; message: string }
  | { type: "password_valid"; session: SmsDraftSession; message: string };

export interface DraftSessionStore {
  getDraft(chatId: string): SmsDraftSession | null;
  saveDraft(session: SmsDraftSession): void;
  deleteDraft(chatId: string): void;
  pruneExpired(nowIso: string): void;
}

export class InMemoryDraftSessionStore implements DraftSessionStore {
  #items = new Map<string, SmsDraftSession>();

  getDraft(chatId: string): SmsDraftSession | null {
    return this.#items.get(chatId) ?? null;
  }

  saveDraft(session: SmsDraftSession): void {
    this.#items.set(session.chatId, session);
  }

  deleteDraft(chatId: string): void {
    this.#items.delete(chatId);
  }

  pruneExpired(nowIso: string): void {
    const now = Date.parse(nowIso);
    for (const [chatId, session] of this.#items.entries()) {
      if (Date.parse(session.expiresAt) <= now) {
        this.#items.delete(chatId);
      }
    }
  }
}

function isValidPhoneNumber(input: string): boolean {
  return /^\+?[0-9]{5,20}$/.test(input.trim());
}

function buildPreview(session: SmsDraftSession): string {
  const estimate = estimateSmsSegments(session.body ?? "");
  return [
    "短信预览",
    `号码: ${session.remoteNumber ?? "-"}`,
    `编码: ${estimate.encoding}`,
    `分段: ${estimate.segments}`,
    `内容: ${session.body ?? "-"}`,
  ].join("\n");
}

export class DraftSessionService {
  readonly #store: DraftSessionStore;
  readonly #ttlMs: number;
  readonly #password: string;
  readonly #now: () => Date;

  constructor(options: {
    store: DraftSessionStore;
    ttlMs: number;
    password: string;
    now?: () => Date;
  }) {
    this.#store = options.store;
    this.#ttlMs = options.ttlMs;
    this.#password = options.password;
    this.#now = options.now ?? (() => new Date());
  }

  beginCompose(chatId: string): { created: boolean; session: SmsDraftSession; message: string } {
    const existing = this.getActiveSession(chatId);
    if (existing) {
      return {
        created: false,
        session: existing,
        message: "已有进行中的短信草稿，请先完成或取消当前草稿。",
      };
    }

    const session = this.createSession(chatId, "compose", null, null);
    this.#store.saveDraft(session);
    return {
      created: true,
      session,
      message: "请输入目标号码，例如 +447700900123。",
    };
  }

  beginReply(chatId: string, remoteNumber: string, sourceMessageId: number | null): {
    created: boolean;
    session: SmsDraftSession;
    message: string;
  } {
    const existing = this.getActiveSession(chatId);
    if (existing) {
      return {
        created: false,
        session: existing,
        message: "已有进行中的短信草稿，请先完成或取消当前草稿。",
      };
    }

    const session = this.createSession(chatId, "reply", remoteNumber, sourceMessageId);
    session.state = "collect_body";
    this.#store.saveDraft(session);
    return {
      created: true,
      session,
      message: `准备回复 ${remoteNumber}，请输入短信内容。`,
    };
  }

  getActiveSession(chatId: string): SmsDraftSession | null {
    this.#store.pruneExpired(this.#now().toISOString());
    const session = this.#store.getDraft(chatId);
    if (!session) {
      return null;
    }
    if (Date.parse(session.expiresAt) <= this.#now().getTime()) {
      this.#store.deleteDraft(chatId);
      return null;
    }
    return session;
  }

  cancel(chatId: string, sessionId?: string): boolean {
    const existing = this.getActiveSession(chatId);
    if (!existing) {
      return false;
    }
    if (sessionId && existing.sessionId !== sessionId) {
      return false;
    }
    this.#store.deleteDraft(chatId);
    return true;
  }

  advancePreview(chatId: string, sessionId: string): { ok: boolean; session: SmsDraftSession | null; message: string } {
    const session = this.getActiveSession(chatId);
    if (!session) {
      return { ok: false, session: null, message: "当前没有活动中的短信草稿。" };
    }
    if (session.sessionId !== sessionId) {
      return { ok: false, session, message: "当前按钮对应的草稿已失效，请重新开始。" };
    }
    if (session.state !== "preview") {
      return { ok: false, session, message: "当前草稿还没有进入预览阶段。" };
    }

    const updated = this.touch({
      ...session,
      state: "password",
    });
    this.#store.saveDraft(updated);
    return {
      ok: true,
      session: updated,
      message: "请输入发送密码。密码验证后仍需再次确认才会真正发出。",
    };
  }

  validatePassword(chatId: string, input: string): DraftInputResult {
    const session = this.getActiveSession(chatId);
    if (!session) {
      return { type: "no_session" };
    }

    if (session.state !== "password") {
      return {
        type: "password_invalid",
        session,
        message: "当前草稿不在验密阶段。",
      };
    }

    if (input !== this.#password) {
      const updated = this.touch(session);
      this.#store.saveDraft(updated);
      return {
        type: "password_invalid",
        session: updated,
        message: "发送密码错误，请重试或取消当前草稿。",
      };
    }

    const updated = this.touch({
      ...session,
      passwordVerified: true,
      state: "confirm",
    });
    this.#store.saveDraft(updated);
    return {
      type: "password_valid",
      session: updated,
      message: `${buildPreview(updated)}\n\n密码验证通过。点击 Confirm 发送，或 Cancel 取消。`,
    };
  }

  handleText(chatId: string, input: string): DraftInputResult {
    const session = this.getActiveSession(chatId);
    if (!session) {
      return { type: "no_session" };
    }

    if (session.state === "collect_recipient") {
      if (!isValidPhoneNumber(input)) {
        return {
          type: "invalid_recipient",
          message: "号码格式不正确，请输入国际格式号码，例如 +447700900123。",
        };
      }

      const updated = this.touch({
        ...session,
        remoteNumber: input.trim(),
        state: "collect_body",
      });
      this.#store.saveDraft(updated);
      return {
        type: "recipient_collected",
        session: updated,
        message: "号码已记录，请输入短信内容。",
      };
    }

    if (session.state === "collect_body") {
      const body = input.trim();
      if (!body) {
        return {
          type: "invalid_body",
          message: "短信内容不能为空，请重新输入。",
        };
      }

      const updated = this.touch({
        ...session,
        body,
        state: "preview",
      });
      this.#store.saveDraft(updated);
      return {
        type: "body_collected",
        session: updated,
        message: `${buildPreview(updated)}\n\n确认无误后点击 Continue 进入验密，或 Cancel 取消。`,
      };
    }

    if (session.state === "password") {
      return this.validatePassword(chatId, input);
    }

    return {
      type: "awaiting_password",
      session,
      message: "请使用按钮继续当前短信草稿，或发送 /sms 重新开始。",
    };
  }

  canConfirm(chatId: string, sessionId: string): { ok: boolean; session: SmsDraftSession | null; message: string } {
    const session = this.getActiveSession(chatId);
    if (!session || session.sessionId !== sessionId) {
      return { ok: false, session: null, message: "当前草稿不存在或已过期。" };
    }

    if (session.state !== "confirm" || !session.passwordVerified || !session.remoteNumber || !session.body) {
      return { ok: false, session, message: "当前草稿还不能发送。" };
    }

    return { ok: true, session, message: "ready" };
  }

  complete(chatId: string): void {
    this.#store.deleteDraft(chatId);
  }

  createSession(chatId: string, mode: SmsDraftMode, remoteNumber: string | null, sourceMessageId: number | null): SmsDraftSession {
    const now = this.#now();
    const createdAt = now.toISOString();
    return {
      sessionId: randomUUID(),
      chatId,
      mode,
      state: "collect_recipient",
      remoteNumber,
      body: null,
      passwordVerified: false,
      createdAt,
      updatedAt: createdAt,
      expiresAt: new Date(now.getTime() + this.#ttlMs).toISOString(),
      sourceMessageId,
    };
  }

  touch(session: SmsDraftSession): SmsDraftSession {
    const now = this.#now();
    return {
      ...session,
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.#ttlMs).toISOString(),
    };
  }
}
