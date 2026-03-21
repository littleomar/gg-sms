import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database } from "bun:sqlite";

import { createLogger } from "../logger";
import type { AccountTrackingState, AlertLevel, InsertOutboundSmsInput, JobRunStatus, StoredSmsMessage } from "./types";
import type { InboundSms } from "../modem/types";
import type { SmsDraftSession } from "../sms/draft-session-service";

function serializeJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parseNullableJson<T>(value: string | null): T | null {
  if (!value) {
    return null;
  }
  return JSON.parse(value) as T;
}

type SmsRow = {
  id: number;
  direction: "inbound" | "outbound";
  remote_number: string;
  body: string;
  message_at: string;
  status: "received" | "sent" | "failed";
  modem_message_id: string | null;
  session_id: string | null;
};

type DraftRow = {
  chat_id: string;
  session_id: string;
  mode: "compose" | "reply";
  state: SmsDraftSession["state"];
  remote_number: string | null;
  body: string | null;
  password_verified: number;
  created_at: string;
  updated_at: string;
  expires_at: string;
  source_message_id: number | null;
};

type TrackingRow = {
  last_account_attempt_at: string | null;
  last_account_sync_at: string | null;
  last_known_airtime_credit: string | null;
  last_balance_change_at: string | null;
  next_keepalive_deadline_at: string | null;
  tracking_status: AccountTrackingState["trackingStatus"];
};

type BotRuntimeRow = {
  notify_chat_id: string | null;
  account_dashboard_cookie: string | null;
  account_dashboard_cookie_updated_at: string | null;
};

const logger = createLogger("database");

export class AppDatabase {
  readonly #db: Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new Database(dbPath);
    logger.info("Opened SQLite database.", { dbPath });
  }

  init(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS sms_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
        remote_number TEXT NOT NULL,
        body TEXT NOT NULL,
        message_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('received', 'sent', 'failed')),
        modem_message_id TEXT,
        session_id TEXT
      );

      CREATE TABLE IF NOT EXISTS sms_drafts (
        chat_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL UNIQUE,
        mode TEXT NOT NULL CHECK(mode IN ('compose', 'reply')),
        state TEXT NOT NULL CHECK(state IN ('collect_recipient', 'collect_body', 'preview', 'password', 'confirm')),
        remote_number TEXT,
        body TEXT,
        password_verified INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        source_message_id INTEGER
      );

      CREATE TABLE IF NOT EXISTS account_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fetched_at TEXT NOT NULL,
        airtime_credit_amount TEXT,
        plan_summary TEXT,
        data_remaining TEXT,
        valid_until TEXT,
        raw_snapshot TEXT
      );

      CREATE TABLE IF NOT EXISTS account_tracking_state (
        singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
        last_account_attempt_at TEXT,
        last_account_sync_at TEXT,
        last_known_airtime_credit TEXT,
        last_balance_change_at TEXT,
        next_keepalive_deadline_at TEXT,
        tracking_status TEXT NOT NULL DEFAULT 'unavailable'
          CHECK(tracking_status IN ('unavailable', 'unconfirmed', 'tracked', 'overdue'))
      );

      INSERT INTO account_tracking_state (
        singleton_id,
        last_account_attempt_at,
        last_account_sync_at,
        last_known_airtime_credit,
        last_balance_change_at,
        next_keepalive_deadline_at,
        tracking_status
      )
      VALUES (1, NULL, NULL, NULL, NULL, NULL, 'unavailable')
      ON CONFLICT(singleton_id) DO NOTHING;

      CREATE TABLE IF NOT EXISTS bot_runtime_state (
        singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
        notify_chat_id TEXT
      );

      INSERT INTO bot_runtime_state (
        singleton_id,
        notify_chat_id
      )
      VALUES (1, NULL)
      ON CONFLICT(singleton_id) DO NOTHING;

      CREATE TABLE IF NOT EXISTS job_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_name TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL CHECK(status IN ('running', 'success', 'failed')),
        details_json TEXT
      );

      CREATE TABLE IF NOT EXISTS alert_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT NOT NULL CHECK(level IN ('info', 'warning', 'error')),
        code TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL,
        payload_json TEXT
      );
    `);

    this.#ensureBotRuntimeColumn("account_dashboard_cookie", "TEXT");
    this.#ensureBotRuntimeColumn("account_dashboard_cookie_updated_at", "TEXT");
    logger.info("Database schema initialized.");
  }

  insertInboundSms(message: InboundSms): StoredSmsMessage {
    const statement = this.#db.query(`
      INSERT INTO sms_messages (
        direction,
        remote_number,
        body,
        message_at,
        status,
        modem_message_id,
        session_id
      )
      VALUES (?, ?, ?, ?, 'received', ?, NULL)
      RETURNING id, direction, remote_number, body, message_at, status, modem_message_id, session_id
    `);

    const row = statement.get(
      "inbound",
      message.remoteNumber,
      message.body,
      message.receivedAt,
      message.modemMessageId ?? null,
    ) as SmsRow;

    return this.#mapSmsRow(row);
  }

  insertOutboundSms(input: InsertOutboundSmsInput): StoredSmsMessage {
    const statement = this.#db.query(`
      INSERT INTO sms_messages (
        direction,
        remote_number,
        body,
        message_at,
        status,
        modem_message_id,
        session_id
      )
      VALUES ('outbound', ?, ?, ?, ?, ?, ?)
      RETURNING id, direction, remote_number, body, message_at, status, modem_message_id, session_id
    `);

    const row = statement.get(
      input.remoteNumber,
      input.body,
      input.messageAt,
      input.status,
      input.modemMessageId ?? null,
      input.sessionId ?? null,
    ) as SmsRow;

    return this.#mapSmsRow(row);
  }

  getSmsById(id: number): StoredSmsMessage | null {
    const statement = this.#db.query(`
      SELECT id, direction, remote_number, body, message_at, status, modem_message_id, session_id
      FROM sms_messages
      WHERE id = ?
      LIMIT 1
    `);
    const row = statement.get(id) as SmsRow | null;
    return row ? this.#mapSmsRow(row) : null;
  }

  listRecentSms(limit = 10): StoredSmsMessage[] {
    const statement = this.#db.query(`
      SELECT id, direction, remote_number, body, message_at, status, modem_message_id, session_id
      FROM sms_messages
      ORDER BY message_at DESC, id DESC
      LIMIT ?
    `);
    const rows = statement.all(limit) as SmsRow[];
    return rows.map((row) => this.#mapSmsRow(row));
  }

  saveDraft(session: SmsDraftSession): void {
    const statement = this.#db.query(`
      INSERT INTO sms_drafts (
        chat_id,
        session_id,
        mode,
        state,
        remote_number,
        body,
        password_verified,
        created_at,
        updated_at,
        expires_at,
        source_message_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        session_id = excluded.session_id,
        mode = excluded.mode,
        state = excluded.state,
        remote_number = excluded.remote_number,
        body = excluded.body,
        password_verified = excluded.password_verified,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        expires_at = excluded.expires_at,
        source_message_id = excluded.source_message_id
    `);

    statement.run(
      session.chatId,
      session.sessionId,
      session.mode,
      session.state,
      session.remoteNumber,
      session.body,
      session.passwordVerified ? 1 : 0,
      session.createdAt,
      session.updatedAt,
      session.expiresAt,
      session.sourceMessageId,
    );
  }

  getDraft(chatId: string): SmsDraftSession | null {
    const statement = this.#db.query(`
      SELECT
        chat_id,
        session_id,
        mode,
        state,
        remote_number,
        body,
        password_verified,
        created_at,
        updated_at,
        expires_at,
        source_message_id
      FROM sms_drafts
      WHERE chat_id = ?
      LIMIT 1
    `);
    const row = statement.get(chatId) as DraftRow | null;
    return row ? this.#mapDraftRow(row) : null;
  }

  deleteDraft(chatId: string): void {
    this.#db.query(`DELETE FROM sms_drafts WHERE chat_id = ?`).run(chatId);
  }

  pruneExpiredDrafts(nowIso: string): void {
    this.#db.query(`DELETE FROM sms_drafts WHERE expires_at <= ?`).run(nowIso);
  }

  getAccountTrackingState(): AccountTrackingState {
    const row = this.#db.query(`
      SELECT
        last_account_attempt_at,
        last_account_sync_at,
        last_known_airtime_credit,
        last_balance_change_at,
        next_keepalive_deadline_at,
        tracking_status
      FROM account_tracking_state
      WHERE singleton_id = 1
      LIMIT 1
    `).get() as TrackingRow;

    return {
      lastAccountAttemptAt: row.last_account_attempt_at,
      lastAccountSyncAt: row.last_account_sync_at,
      lastKnownAirtimeCredit: row.last_known_airtime_credit,
      lastBalanceChangeAt: row.last_balance_change_at,
      nextKeepaliveDeadlineAt: row.next_keepalive_deadline_at,
      trackingStatus: row.tracking_status,
    };
  }

  recordAccountAttempt(atIso: string): void {
    this.#db.query(`
      UPDATE account_tracking_state
      SET last_account_attempt_at = ?
      WHERE singleton_id = 1
    `).run(atIso);
    logger.debug("Recorded account attempt timestamp.", { atIso });
  }

  insertAccountSnapshot(input: {
    fetchedAt: string;
    airtimeCreditAmount: string | null;
    planSummary?: string | null;
    dataRemaining?: string | null;
    validUntil?: string | null;
    rawSnapshot?: string | null;
  }): void {
    this.#db.query(`
      INSERT INTO account_snapshots (
        fetched_at,
        airtime_credit_amount,
        plan_summary,
        data_remaining,
        valid_until,
        raw_snapshot
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.fetchedAt,
      input.airtimeCreditAmount,
      input.planSummary ?? null,
      input.dataRemaining ?? null,
      input.validUntil ?? null,
      input.rawSnapshot ?? null,
    );
  }

  updateAccountTrackingState(input: {
    lastAccountSyncAt: string;
    lastKnownAirtimeCredit: string | null;
    lastBalanceChangeAt: string | null;
    nextKeepaliveDeadlineAt: string | null;
    trackingStatus: AccountTrackingState["trackingStatus"];
  }): void {
    this.#db.query(`
      UPDATE account_tracking_state
      SET
        last_account_sync_at = ?,
        last_known_airtime_credit = ?,
        last_balance_change_at = ?,
        next_keepalive_deadline_at = ?,
        tracking_status = ?
      WHERE singleton_id = 1
    `).run(
      input.lastAccountSyncAt,
      input.lastKnownAirtimeCredit,
      input.lastBalanceChangeAt,
      input.nextKeepaliveDeadlineAt,
      input.trackingStatus,
    );
  }

  getNotifyChatId(): string | null {
    const row = this.#db.query(`
      SELECT notify_chat_id, account_dashboard_cookie, account_dashboard_cookie_updated_at
      FROM bot_runtime_state
      WHERE singleton_id = 1
      LIMIT 1
    `).get() as BotRuntimeRow;

    return row.notify_chat_id;
  }

  setNotifyChatId(chatId: string): void {
    this.#db.query(`
      UPDATE bot_runtime_state
      SET notify_chat_id = ?
      WHERE singleton_id = 1
    `).run(chatId);
    logger.info("Persisted Telegram notify chat id.", { chatId });
  }

  getAccountDashboardCookie(): string | null {
    const row = this.#db.query(`
      SELECT notify_chat_id, account_dashboard_cookie, account_dashboard_cookie_updated_at
      FROM bot_runtime_state
      WHERE singleton_id = 1
      LIMIT 1
    `).get() as BotRuntimeRow;

    return row.account_dashboard_cookie;
  }

  setAccountDashboardCookie(cookie: string | null, updatedAtIso = new Date().toISOString()): void {
    this.#db.query(`
      UPDATE bot_runtime_state
      SET
        account_dashboard_cookie = ?,
        account_dashboard_cookie_updated_at = ?
      WHERE singleton_id = 1
    `).run(cookie, cookie ? updatedAtIso : null);
    logger.info(cookie ? "Stored dashboard cookie." : "Cleared dashboard cookie.", {
      updatedAtIso: cookie ? updatedAtIso : null,
      storedValueLength: cookie?.length ?? 0,
    });
  }

  getAccountDashboardCookieUpdatedAt(): string | null {
    const row = this.#db.query(`
      SELECT notify_chat_id, account_dashboard_cookie, account_dashboard_cookie_updated_at
      FROM bot_runtime_state
      WHERE singleton_id = 1
      LIMIT 1
    `).get() as BotRuntimeRow;

    return row.account_dashboard_cookie_updated_at;
  }

  startJobRun(jobName: string): number {
    const row = this.#db.query(`
      INSERT INTO job_runs (job_name, started_at, status, details_json)
      VALUES (?, ?, 'running', NULL)
      RETURNING id
    `).get(jobName, new Date().toISOString()) as { id: number };

    logger.info("Started job run.", { jobName, runId: row.id });
    return row.id;
  }

  finishJobRun(runId: number, status: Exclude<JobRunStatus, "running">, details: unknown): void {
    this.#db.query(`
      UPDATE job_runs
      SET finished_at = ?, status = ?, details_json = ?
      WHERE id = ?
    `).run(new Date().toISOString(), status, serializeJson(details), runId);
    if (status === "failed") {
      logger.error("Job run finished with failure.", { runId, status, details });
      return;
    }

    logger.info("Job run finished.", { runId, status, details });
  }

  insertAlert(level: AlertLevel, code: string, message: string, payload?: unknown): void {
    this.#db.query(`
      INSERT INTO alert_events (level, code, message, created_at, payload_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(level, code, message, new Date().toISOString(), serializeJson(payload));
    if (level === "error") {
      logger.error("Stored alert event.", { code, message, payload });
      return;
    }

    if (level === "warning") {
      logger.warn("Stored alert event.", { code, message, payload });
      return;
    }

    logger.info("Stored alert event.", { code, message, payload });
  }

  close(): void {
    this.#db.close();
    logger.info("Closed SQLite database.");
  }

  #mapSmsRow(row: SmsRow): StoredSmsMessage {
    return {
      id: row.id,
      direction: row.direction,
      remoteNumber: row.remote_number,
      body: row.body,
      messageAt: row.message_at,
      status: row.status,
      modemMessageId: row.modem_message_id,
      sessionId: row.session_id,
    };
  }

  #mapDraftRow(row: DraftRow): SmsDraftSession {
    return {
      chatId: row.chat_id,
      sessionId: row.session_id,
      mode: row.mode,
      state: row.state,
      remoteNumber: row.remote_number,
      body: row.body,
      passwordVerified: row.password_verified === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
      sourceMessageId: row.source_message_id,
    };
  }

  #ensureBotRuntimeColumn(columnName: string, definition: string): void {
    const columns = this.#db.query(`PRAGMA table_info(bot_runtime_state)`).all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === columnName)) {
      return;
    }

    this.#db.exec(`ALTER TABLE bot_runtime_state ADD COLUMN ${columnName} ${definition}`);
  }
}

export class DatabaseDraftSessionStore {
  readonly #database: AppDatabase;

  constructor(database: AppDatabase) {
    this.#database = database;
  }

  getDraft(chatId: string): SmsDraftSession | null {
    return this.#database.getDraft(chatId);
  }

  saveDraft(session: SmsDraftSession): void {
    this.#database.saveDraft(session);
  }

  deleteDraft(chatId: string): void {
    this.#database.deleteDraft(chatId);
  }

  pruneExpired(nowIso: string): void {
    this.#database.pruneExpiredDrafts(nowIso);
  }
}
