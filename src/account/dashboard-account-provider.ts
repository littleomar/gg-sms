import type { AccountProvider, AccountSummary } from "./provider";
import type { AppDatabase } from "../storage/database";

const DEFAULT_DASHBOARD_URL = "https://www.giffgaff.com/dashboard";
const DEFAULT_ACCEPT_LANGUAGE = "en-GB,en;q=0.9";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";
const CREDIT_DEADLINE_DAYS = 180;

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

  constructor(options: {
    database: AppDatabase;
    bootstrapCookie?: string;
    dashboardUrl?: string;
    acceptLanguage?: string;
    userAgent?: string;
    timeoutMs?: number;
  }) {
    this.#database = options.database;
    this.#dashboardUrl = options.dashboardUrl ?? DEFAULT_DASHBOARD_URL;
    this.#acceptLanguage = options.acceptLanguage ?? DEFAULT_ACCEPT_LANGUAGE;
    this.#userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.#timeoutMs = options.timeoutMs ?? 15_000;

    if (options.bootstrapCookie && !this.#database.getAccountDashboardCookie()) {
      this.#database.setAccountDashboardCookie(options.bootstrapCookie);
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
    this.#database.recordAccountAttempt(new Date().toISOString());
  }

  async refresh(): Promise<AccountSummary> {
    const cookie = this.#database.getAccountDashboardCookie();
    if (!cookie) {
      throw new Error("Dashboard cookie is not configured. 请先使用 /accountcookie <cookie> 设置。");
    }

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

    if (!response.ok) {
      throw new Error(`Dashboard request failed with HTTP ${response.status}`);
    }

    const html = await response.text();
    const airtimeCredit = extractAirtimeCreditFromDashboard(html);
    if (!airtimeCredit) {
      throw new Error("Could not find the dashboard credit balance. The cookie may be expired or the page structure changed.");
    }

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
        url: response.url || this.#dashboardUrl,
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

    return this.getSummary();
  }
}
