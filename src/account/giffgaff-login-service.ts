import { createLogger } from "../logger";

const LOGIN_PAGE_URL = "https://www.giffgaff.com/auth/login";
const LOGIN_API_URL = "https://id.giffgaff.com/auth/login";
const MFA_TIMEOUT_MS = 90_000;
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

const logger = createLogger("account.login");

export interface GiffgaffLoginService {
  login(): Promise<string>;
  isLoginInProgress(): boolean;
  receiveMfaCode(code: string): boolean;
}

function extractCookies(response: Response): Map<string, string> {
  const cookies = new Map<string, string>();
  const raw = response.headers.getSetCookie?.() ?? [];
  for (const entry of raw) {
    const eqIndex = entry.indexOf("=");
    if (eqIndex < 1) continue;
    const name = entry.slice(0, eqIndex).trim();
    const rest = entry.slice(eqIndex + 1);
    const semiIndex = rest.indexOf(";");
    const value = semiIndex >= 0 ? rest.slice(0, semiIndex) : rest;
    cookies.set(name, value.trim());
  }
  return cookies;
}

function serializeCookies(jar: Map<string, string>): string {
  return Array.from(jar.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

export class GiffgaffHttpLoginService implements GiffgaffLoginService {
  readonly #username: string;
  readonly #password: string;
  readonly #userAgent: string;
  #loginInProgress = false;
  #mfaResolver: ((code: string) => void) | null = null;
  #onAwaitingMfa: (() => void) | null = null;

  constructor(options: {
    username: string;
    password: string;
    userAgent?: string;
    onAwaitingMfa?: () => void;
  }) {
    this.#username = options.username;
    this.#password = options.password;
    this.#userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.#onAwaitingMfa = options.onAwaitingMfa ?? null;
  }

  isLoginInProgress(): boolean {
    return this.#loginInProgress;
  }

  receiveMfaCode(code: string): boolean {
    if (this.#mfaResolver) {
      this.#mfaResolver(code);
      this.#mfaResolver = null;
      return true;
    }
    return false;
  }

  async login(): Promise<string> {
    if (this.#loginInProgress) {
      throw new Error("Login already in progress.");
    }

    this.#loginInProgress = true;
    try {
      return await this.#performLogin();
    } finally {
      this.#loginInProgress = false;
      this.#mfaResolver = null;
    }
  }

  async #performLogin(): Promise<string> {
    const cookieJar = new Map<string, string>();
    const commonHeaders = {
      "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      "User-Agent": this.#userAgent,
    };

    // Step 1: Fetch login page to collect cookies
    logger.info("Step 1: Fetching login page for session cookies.");
    const pageResponse = await fetch(LOGIN_PAGE_URL, {
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        ...commonHeaders,
        "Upgrade-Insecure-Requests": "1",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    for (const [name, value] of extractCookies(pageResponse)) {
      cookieJar.set(name, value);
    }

    // Follow redirects manually to collect all cookies
    if (pageResponse.status >= 300 && pageResponse.status < 400) {
      const redirectUrl = pageResponse.headers.get("location");
      if (redirectUrl) {
        const redirectResponse = await fetch(
          redirectUrl.startsWith("http") ? redirectUrl : new URL(redirectUrl, LOGIN_PAGE_URL).href,
          {
            headers: {
              Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              ...commonHeaders,
              Cookie: serializeCookies(cookieJar),
              "Upgrade-Insecure-Requests": "1",
            },
            redirect: "manual",
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          },
        );
        for (const [name, value] of extractCookies(redirectResponse)) {
          cookieJar.set(name, value);
        }
      }
    }

    const xsrfToken = cookieJar.get("XSRF-TOKEN");
    if (!xsrfToken) {
      throw new Error("Failed to obtain XSRF-TOKEN from login page.");
    }

    logger.info("Step 1 complete. Collected session cookies.", {
      cookieCount: cookieJar.size,
    });

    // Step 2: POST credentials
    logger.info("Step 2: Submitting credentials.");
    const deviceId = crypto.randomUUID().replace(/-/g, "");
    const credentialResponse = await fetch(LOGIN_API_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...commonHeaders,
        Cookie: serializeCookies(cookieJar),
        "x-csrf-token": xsrfToken,
        device: "web",
        "device-id": deviceId,
        Origin: "https://www.giffgaff.com",
      },
      body: JSON.stringify({
        memberName: this.#username,
        password: this.#password,
      }),
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    for (const [name, value] of extractCookies(credentialResponse)) {
      cookieJar.set(name, value);
    }

    const credentialBody = await credentialResponse.json() as { code?: string; message?: string };
    logger.info("Step 2 response.", { status: credentialResponse.status, body: credentialBody });

    const isMfaRequired =
      credentialBody.code === "mfa.required" ||
      credentialResponse.status === 401;

    if (!isMfaRequired) {
      // If not MFA required, might be a direct success or an error
      if (credentialResponse.ok) {
        logger.info("Login succeeded without MFA.");
        return serializeCookies(cookieJar);
      }
      throw new Error(
        `Login failed: ${credentialBody.message ?? credentialBody.code ?? `HTTP ${credentialResponse.status}`}`,
      );
    }

    logger.info("Step 2 complete. MFA required, waiting for verification SMS.");
    this.#onAwaitingMfa?.();

    // Step 3: Wait for MFA code from SMS
    const mfaCode = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#mfaResolver = null;
        reject(new Error(`MFA verification code not received within ${MFA_TIMEOUT_MS / 1000} seconds.`));
      }, MFA_TIMEOUT_MS);

      this.#mfaResolver = (code: string) => {
        clearTimeout(timer);
        resolve(code);
      };
    });

    logger.info("Step 3 complete. MFA code received.");

    // Step 4: POST with MFA code
    logger.info("Step 4: Submitting MFA code.");
    const mfaResponse = await fetch(LOGIN_API_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...commonHeaders,
        Cookie: serializeCookies(cookieJar),
        "x-csrf-token": xsrfToken,
        device: "web",
        "device-id": deviceId,
        Origin: "https://www.giffgaff.com",
      },
      body: JSON.stringify({
        memberName: this.#username,
        password: this.#password,
        mfaCode,
        rememberBrowser: false,
      }),
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    for (const [name, value] of extractCookies(mfaResponse)) {
      cookieJar.set(name, value);
    }

    if (!mfaResponse.ok) {
      const mfaBody = await mfaResponse.json().catch(() => null) as { message?: string } | null;
      throw new Error(
        `MFA login failed: ${mfaBody?.message ?? `HTTP ${mfaResponse.status}`}`,
      );
    }

    logger.info("Login completed successfully.", { cookieCount: cookieJar.size });
    return serializeCookies(cookieJar);
  }
}
