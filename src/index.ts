import { loadConfig } from "./config";
import { GgSmsApp } from "./app";
import { configureLogger, createLogger } from "./logger";
import { applyTelegramProxyEnv } from "./bot/telegram-proxy-env";

const config = loadConfig();
applyTelegramProxyEnv(config.telegramProxyUrl, config.accountDashboardUrl);
configureLogger(config.logLevel);
const logger = createLogger("index");
const app = new GgSmsApp(config);

logger.info("Starting gg-sms.", {
  modemPort: config.modemPort,
  logLevel: config.logLevel,
  smsPollIntervalMs: config.smsPollIntervalMs,
});
await app.start();
logger.info("gg-sms service loop started.", {
  modemPort: config.modemPort,
});

const shutdown = async (signal: string) => {
  logger.info("Received shutdown signal.", { signal });
  try {
    await app.stop();
    logger.info("Application stopped cleanly.");
    process.exit(0);
  } catch (error) {
    logger.error("Application shutdown failed.", { error });
    process.exit(1);
  }
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection.", { reason });
});
process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception.", { error });
});
