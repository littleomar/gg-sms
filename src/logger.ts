export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const MAX_OBJECT_DEPTH = 4;
const MAX_ARRAY_ITEMS = 20;
const MAX_STRING_LENGTH = 400;
const MAX_OBJECT_KEYS = 30;
const SENSITIVE_KEY_PATTERN = /(token|cookie|password|secret|authorization)/i;

let configuredLogLevel: LogLevel = "info";

function clampString(value: string): string {
  if (value.length <= MAX_STRING_LENGTH) {
    return value;
  }

  return `${value.slice(0, MAX_STRING_LENGTH)}...`;
}

function sanitiseValue(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
  parentKey?: string,
): unknown {
  if (parentKey && SENSITIVE_KEY_PATTERN.test(parentKey)) {
    return "[redacted]";
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return clampString(value);
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return value;
  }

  if (typeof value === "function") {
    return `[function ${value.name || "anonymous"}]`;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack ? clampString(value.stack) : undefined,
    };
  }

  if (Array.isArray(value)) {
    if (depth >= MAX_OBJECT_DEPTH) {
      return `[array(${value.length})]`;
    }

    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitiseValue(item, seen, depth + 1));
  }

  if (typeof value === "object") {
    if (seen.has(value as object)) {
      return "[circular]";
    }

    if (depth >= MAX_OBJECT_DEPTH) {
      return "[object]";
    }

    seen.add(value as object);

    const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_OBJECT_KEYS);
    const result: Record<string, unknown> = {};
    for (const [key, childValue] of entries) {
      result[key] = sanitiseValue(childValue, seen, depth + 1, key);
    }

    seen.delete(value as object);
    return result;
  }

  return String(value);
}

function serialiseMetadata(metadata: unknown): string {
  if (metadata === undefined) {
    return "";
  }

  return ` ${JSON.stringify(sanitiseValue(metadata, new WeakSet(), 0))}`;
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_WEIGHT[level] >= LOG_LEVEL_WEIGHT[configuredLogLevel];
}

export function parseLogLevel(value: string | undefined, fallback: LogLevel = "info"): LogLevel {
  const normalised = value?.trim().toLowerCase();
  if (!normalised) {
    return fallback;
  }

  if (normalised === "debug" || normalised === "info" || normalised === "warn" || normalised === "error") {
    return normalised;
  }

  throw new Error(`Invalid log level: ${value}`);
}

export function configureLogger(level: LogLevel): void {
  configuredLogLevel = level;
}

export type Logger = {
  child(scope: string): Logger;
  debug(message: string, metadata?: unknown): void;
  info(message: string, metadata?: unknown): void;
  warn(message: string, metadata?: unknown): void;
  error(message: string, metadata?: unknown): void;
};

class ScopedLogger implements Logger {
  readonly #scope: string;

  constructor(scope: string) {
    this.#scope = scope;
  }

  child(scope: string): Logger {
    return new ScopedLogger(`${this.#scope}.${scope}`);
  }

  debug(message: string, metadata?: unknown): void {
    this.#log("debug", message, metadata);
  }

  info(message: string, metadata?: unknown): void {
    this.#log("info", message, metadata);
  }

  warn(message: string, metadata?: unknown): void {
    this.#log("warn", message, metadata);
  }

  error(message: string, metadata?: unknown): void {
    this.#log("error", message, metadata);
  }

  #log(level: LogLevel, message: string, metadata?: unknown): void {
    if (!shouldLog(level)) {
      return;
    }

    const line = `${new Date().toISOString()} ${level.toUpperCase()} [${this.#scope}] ${message}${serialiseMetadata(metadata)}`;
    if (level === "error") {
      console.error(line);
      return;
    }

    if (level === "warn") {
      console.warn(line);
      return;
    }

    console.log(line);
  }
}

export function createLogger(scope: string): Logger {
  return new ScopedLogger(scope);
}
