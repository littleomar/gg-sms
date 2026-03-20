import type { ModemProvider } from "../modem/types";
import type { AppDatabase } from "../storage/database";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class KeepaliveJob {
  #running = false;
  readonly #modem: ModemProvider;
  readonly #database: AppDatabase;
  readonly #keepaliveUrl: string;
  readonly #timeoutMs: number;
  readonly #fetchImpl: FetchLike;

  constructor(options: {
    modem: ModemProvider;
    database: AppDatabase;
    keepaliveUrl: string;
    timeoutMs: number;
    fetchImpl?: FetchLike;
  }) {
    this.#modem = options.modem;
    this.#database = options.database;
    this.#keepaliveUrl = options.keepaliveUrl;
    this.#timeoutMs = options.timeoutMs;
    this.#fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async run(): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
    if (this.#running) {
      return { ok: false, message: "保号任务正在执行中，请稍后再试。" };
    }

    this.#running = true;
    const runId = this.#database.startJobRun("keepalive");
    try {
      await this.#modem.setDataEnabled(true);
      await this.#modem.waitForDataReady(this.#timeoutMs);

      const response = await this.#fetchImpl(this.#keepaliveUrl, {
        method: "GET",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });

      const message = `保号动作执行完成，HTTP ${response.status}。`;
      this.#database.finishJobRun(runId, "success", {
        httpStatus: response.status,
        keepaliveUrl: this.#keepaliveUrl,
      });
      return { ok: true, message };
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      this.#database.finishJobRun(runId, "failed", {
        keepaliveUrl: this.#keepaliveUrl,
        error: message,
      });
      this.#database.insertAlert("error", "keepalive_failed", "保号动作执行失败。", {
        error: message,
      });
      return { ok: false, message: `保号动作失败: ${message}` };
    } finally {
      try {
        await this.#modem.setDataEnabled(false);
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown error";
        this.#database.insertAlert("error", "data_disable_failed", "保号完成后关闭数据失败。", {
          error: message,
        });
      }
      this.#running = false;
    }
  }
}
