import type { GiffgaffLoginService } from "./giffgaff-login-service";
import type { AccountProvider, AccountSummary } from "./provider";
import { createLogger } from "../logger";
import type { AppDatabase } from "../storage/database";

const DEFAULT_DASHBOARD_URL = "https://www.giffgaff.com/dashboard";
const DEFAULT_ACCEPT_LANGUAGE = "en-GB,en;q=0.9";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";
const CREDIT_DEADLINE_DAYS = 180;
const logger = createLogger("account.dashboard");

function decodeHtmlEntities(value: string): string {
  return value
    .replaceAll("&pound;", "£")
    .replaceAll("&amp;", "&")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&#163;", "£")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)));
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ");
}

function normaliseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function extractAirtimeCreditFromDashboard(html: string): string | null {
  const match = html.match(/id="balance-value"[\s\S]*?<h4[^>]*>([\s\S]*?)<\/h4>/i);
  if (!match) {
    return null;
  }

  return normaliseWhitespace(decodeHtmlEntities(stripTags(match[1])));
}

function addDaysIso(iso: string, days: number): string {
  const date = new Date(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function computeTrackingStatus(nowIso: string, nextKeepaliveDeadlineAt: string | null): AccountSummary["trackingStatus"] {
  if (!nextKeepaliveDeadlineAt) {
    return "unconfirmed";
  }

  return nextKeepaliveDeadlineAt <= nowIso ? "overdue" : "tracked";
}

export class DashboardAccountProvider implements AccountProvider {
  readonly #database: AppDatabase;
  readonly #dashboardUrl: string;
  readonly #acceptLanguage: string;
  readonly #userAgent: string;
  readonly #timeoutMs: number;
  readonly #loginService?: GiffgaffLoginService;

  constructor(options: {
    database: AppDatabase;
    bootstrapCookie?: string;
    dashboardUrl?: string;
    acceptLanguage?: string;
    userAgent?: string;
    timeoutMs?: number;
    loginService?: GiffgaffLoginService;
  }) {
    this.#database = options.database;
    this.#dashboardUrl = options.dashboardUrl ?? DEFAULT_DASHBOARD_URL;
    this.#acceptLanguage = options.acceptLanguage ?? DEFAULT_ACCEPT_LANGUAGE;
    this.#userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#loginService = options.loginService;

    if (options.bootstrapCookie && !this.#database.getAccountDashboardCookie()) {
      this.#database.setAccountDashboardCookie(options.bootstrapCookie);
      logger.info("Bootstrapped dashboard cookie from configuration.");
    }
  }

  async getSummary(): Promise<AccountSummary> {
    const tracking = this.#database.getAccountTrackingState();
    const hasCookie = Boolean(this.#database.getAccountDashboardCookie());

    return {
      implementationStatus: hasCookie ? "available" : "not_implemented",
      lastAttemptAt: tracking.lastAccountAttemptAt,
      airtimeCredit: tracking.lastKnownAirtimeCredit,
      lastBalanceChangeAt: tracking.lastBalanceChangeAt,
      nextKeepaliveDeadlineAt: tracking.nextKeepaliveDeadlineAt,
      trackingStatus: tracking.trackingStatus,
    };
  }

  async recordAttempt(): Promise<void> {
    const attemptAt = new Date().toISOString();
    this.#database.recordAccountAttempt(attemptAt);
    logger.debug("Recorded dashboard account attempt.", { attemptAt });
  }

  async refresh(): Promise<AccountSummary> {
    let cookie = this.#database.getAccountDashboardCookie();

    // No cookie — try auto-login first
    if (!cookie && this.#loginService) {
      cookie = await this.#performAutoLogin();
    }
    if (!cookie) {
      logger.warn("Dashboard refresh requested without a configured cookie.");
      throw new Error("Dashboard cookie is not configured. 请先使用 /accountcookie <cookie> 或 /login 登录。");
    }

    const result = await this.#fetchDashboard(cookie);

    // If fetch failed and we have login service, try re-login once
    if (!result.airtimeCredit && this.#loginService) {
      logger.info("Dashboard fetch failed with current cookie, attempting auto-login.");
      const freshCookie = await this.#performAutoLogin();
      if (freshCookie) {
        const retryResult = await this.#fetchDashboard(freshCookie);
        if (retryResult.airtimeCredit) {
          return this.#applyDashboardResult(retryResult.airtimeCredit, retryResult.responseUrl);
        }
      }
      throw new Error("Could not find the dashboard credit balance after re-login. The page structure may have changed.");
    }

    if (!result.airtimeCredit) {
      throw new Error("Could not find the dashboard credit balance. The cookie may be expired or the page structure changed.");
    }

    return this.#applyDashboardResult(result.airtimeCredit, result.responseUrl);
  }

  async #fetchDashboard(cookie: string): Promise<{ airtimeCredit: string | null; responseUrl: string }> {
    logger.info("Refreshing dashboard account summary.", {
      dashboardUrl: this.#dashboardUrl,
      dashboardSessionUpdatedAt: this.#database.getAccountDashboardCookieUpdatedAt(),
    });

    const response = await fetch(this.#dashboardUrl, {
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": this.#acceptLanguage,
        "Cache-Control": "no-cache",
        Cookie: cookie,
        Pragma: "no-cache",
        "Upgrade-Insecure-Requests": "1",
        "User-Agent": this.#userAgent,
      },
      redirect: "follow",
      signal: AbortSignal.timeout(this.#timeoutMs),
    });

    const responseUrl = response.url || this.#dashboardUrl;

    if (!response.ok) {
      logger.warn("Dashboard request returned a non-OK response.", {
        status: response.status,
        url: responseUrl,
      });
      return { airtimeCredit: null, responseUrl };
    }

    const html = await response.text();
    const airtimeCredit = extractAirtimeCreditFromDashboard(html);
    if (!airtimeCredit) {
      logger.warn("Dashboard refresh could not extract airtime credit.", {
        dashboardUrl: responseUrl,
      });
    }

    return { airtimeCredit, responseUrl };
  }

  #applyDashboardResult(airtimeCredit: string, responseUrl: string): AccountSummary {
    const fetchedAt = new Date().toISOString();
    const current = this.#database.getAccountTrackingState();

    let lastBalanceChangeAt = current.lastBalanceChangeAt;
    let nextKeepaliveDeadlineAt = current.nextKeepaliveDeadlineAt;
    let trackingStatus: AccountSummary["trackingStatus"];

    if (!current.lastKnownAirtimeCredit) {
      trackingStatus = "unconfirmed";
    } else if (current.lastKnownAirtimeCredit !== airtimeCredit) {
      lastBalanceChangeAt = fetchedAt;
      nextKeepaliveDeadlineAt = addDaysIso(fetchedAt, CREDIT_DEADLINE_DAYS);
      trackingStatus = "tracked";
    } else {
      trackingStatus = computeTrackingStatus(fetchedAt, nextKeepaliveDeadlineAt);
    }

    this.#database.insertAccountSnapshot({
      fetchedAt,
      airtimeCreditAmount: airtimeCredit,
      rawSnapshot: JSON.stringify({
        source: "dashboard",
        url: responseUrl,
        extractedBalance: airtimeCredit,
      }),
    });

    this.#database.updateAccountTrackingState({
      lastAccountSyncAt: fetchedAt,
      lastKnownAirtimeCredit: airtimeCredit,
      lastBalanceChangeAt,
      nextKeepaliveDeadlineAt,
      trackingStatus,
    });

    logger.info("Dashboard account summary refreshed.", {
      airtimeCredit,
      fetchedAt,
      trackingStatus,
      lastBalanceChangeAt,
      nextKeepaliveDeadlineAt,
    });

    return {
      implementationStatus: "available",
      lastAttemptAt: this.#database.getAccountTrackingState().lastAccountAttemptAt,
      airtimeCredit,
      lastBalanceChangeAt,
      nextKeepaliveDeadlineAt,
      trackingStatus,
    };
  }

  async #performAutoLogin(): Promise<string | null> {
    try {
      const cookie = await this.#loginService!.login();
      this.#database.setAccountDashboardCookie(cookie);
      logger.info("Auto-login succeeded, cookie stored.");
      return cookie;
    } catch (error) {
      logger.warn("Auto-login failed.", { error });
      return null;
    }
  }
}
