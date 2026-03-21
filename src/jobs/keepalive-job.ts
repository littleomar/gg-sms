import type { ModemProvider } from "../modem/types";
import type { AppDatabase } from "../storage/database";

export class KeepaliveJob {
  #running = false;
  readonly #modem: ModemProvider;
  readonly #database: AppDatabase;
  readonly #keepaliveUrl: string;
  readonly #timeoutMs: number;

  constructor(options: {
    modem: ModemProvider;
    database: AppDatabase;
    keepaliveUrl: string;
    timeoutMs: number;
  }) {
    this.#modem = options.modem;
    this.#database = options.database;
    this.#keepaliveUrl = options.keepaliveUrl;
    this.#timeoutMs = options.timeoutMs;
  }

  async run(): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
    if (this.#running) {
      return { ok: false, message: "保号任务正在执行中，请稍后再试。" };
    }

    this.#running = true;
    const runId = this.#database.startJobRun("keepalive");
    try {
      const result = await this.#modem.performKeepaliveRequest(this.#keepaliveUrl, this.#timeoutMs);
      const message = `保号动作执行完成，HTTP ${result.httpStatus}，${result.protocol.toUpperCase()}，${result.responseLength} bytes。`;
      this.#database.finishJobRun(runId, "success", {
        transport: "modem",
        httpStatus: result.httpStatus,
        protocol: result.protocol,
        responseLength: result.responseLength,
        keepaliveUrl: this.#keepaliveUrl,
      });
      return { ok: true, message };
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      this.#database.finishJobRun(runId, "failed", {
        transport: "modem",
        keepaliveUrl: this.#keepaliveUrl,
        error: message,
      });
      this.#database.insertAlert("error", "keepalive_failed", "保号动作执行失败。", {
        error: message,
      });
      return { ok: false, message: `保号动作失败: ${message}` };
    } finally {
      this.#running = false;
    }
  }
}
