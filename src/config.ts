export type AppConfig = {
  botToken: string;
  botAdminId: string;
  telegramProxyUrl?: string;
  modemDebug: boolean;
  smsSendPassword: string;
  modemPort: string;
  modemBaud: number;
  simPin?: string;
  apnName: string;
  apnUser?: string;
  apnPass?: string;
  keepaliveUrl: string;
  dbPath: string;
  smsDraftTtlMs: number;
  keepaliveTimeoutMs: number;
};

const DEFAULT_SMS_DRAFT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_KEEPALIVE_TIMEOUT_MS = 15 * 1000;

function parseBoolean(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function requireEnv(name: string, env: Record<string, string | undefined>): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseOptional(name: string, env: Record<string, string | undefined>): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function parseNumber(
  name: string,
  env: Record<string, string | undefined>,
  fallback?: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) {
    if (fallback !== undefined) {
      return fallback;
    }
    throw new Error(`Missing required numeric environment variable: ${name}`);
  }

  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid numeric environment variable: ${name}`);
  }

  return value;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  return {
    botToken: requireEnv("BOT_TOKEN", env),
    botAdminId: requireEnv("BOT_ADMIN_ID", env),
    telegramProxyUrl: parseOptional("TELEGRAM_PROXY_URL", env),
    modemDebug: parseBoolean(env.MODEM_DEBUG),
    smsSendPassword: requireEnv("SMS_SEND_PASSWORD", env),
    modemPort: requireEnv("MODEM_PORT", env),
    modemBaud: parseNumber("MODEM_BAUD", env, 115200),
    simPin: parseOptional("SIM_PIN", env),
    apnName: requireEnv("APN_NAME", env),
    apnUser: parseOptional("APN_USER", env),
    apnPass: parseOptional("APN_PASS", env),
    keepaliveUrl: requireEnv("KEEPALIVE_URL", env),
    dbPath: requireEnv("DB_PATH", env),
    smsDraftTtlMs: parseNumber("SMS_DRAFT_TTL_MS", env, DEFAULT_SMS_DRAFT_TTL_MS),
    keepaliveTimeoutMs: parseNumber(
      "KEEPALIVE_TIMEOUT_MS",
      env,
      DEFAULT_KEEPALIVE_TIMEOUT_MS,
    ),
  };
}
