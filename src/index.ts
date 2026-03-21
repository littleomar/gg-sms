import { loadConfig } from "./config";
import { GgSmsApp } from "./app";

const config = loadConfig();
const app = new GgSmsApp(config);

console.log("Starting gg-sms...");
await app.start();
console.log(`gg-sms started with modem port ${config.modemPort}`);

const shutdown = async (signal: string) => {
  console.log(`Received ${signal}, shutting down...`);
  await app.stop();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
