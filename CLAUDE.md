# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

gg-sms is a Bun-based TypeScript service for managing SMS via an EC200 modem module with Telegram bot integration. It runs on FNOS/Linux hosts and manages giffgaff SIM cards for SMS sending/receiving, data control, and account tracking.

## Commands

- `bun run dev` — watch mode (`bun --watch src/index.ts`)
- `bun run start` — production run
- `bun test` — run all tests (Bun's native test runner, no Jest/Vitest)
- `bun test tests/sms-encoding.test.ts` — run a single test file

## Architecture

**Entry point**: `src/index.ts` → loads config → creates `GgSmsApp` → starts components → blocks until SIGINT/SIGTERM.

**`GgSmsApp`** (`src/app.ts`) is the central orchestrator that manages lifecycle of all components:
- Parallel bot & modem startup with timeouts and automatic retry
- Background SMS polling loop
- Graceful shutdown with state tracking

**Key modules:**

| Directory | Purpose |
|-----------|---------|
| `src/bot/` | Telegram bot (telegraf): commands, auth, proxy transport |
| `src/modem/` | Hardware abstraction — `ModemProvider` interface with EC200 (serial/AT commands) and Mock implementations |
| `src/sms/` | SMS draft state machine (collect_recipient → collect_body → preview → password → confirm) and encoding/segment calculation |
| `src/account/` | Giffgaff dashboard scraper for account balance tracking |
| `src/jobs/` | Background jobs (keepalive: minimal data traffic to keep SIM active) |
| `src/storage/` | SQLite via `bun:sqlite` (no ORM) — schema with sms_messages, sms_drafts, account_snapshots, bot_runtime_state, job_runs, alert_events |

**Patterns:**
- Interface-based DI: `ModemProvider`, `AccountProvider`, `DraftSessionStore` allow swapping implementations
- Private class fields (`#`) for encapsulation throughout
- Singleton tables use `WHERE singleton_id = 1` pattern
- Structured scoped logging with automatic sensitive data sanitization (token, password, cookie, secret)

## Environment

Copy `.env.example` to `.env`. Key variables:
- `MODEM_PORT` — TTY device path (e.g. `/dev/ttyUSB2`) or `mock` for testing without hardware
- `MODEM_DEBUG=1` — log AT commands
- `LOG_LEVEL` — debug/info/warn/error
- `BOT_TOKEN`, `BOT_ADMIN_ID`, `SMS_SEND_PASSWORD` — required
- `TELEGRAM_PROXY_URL` — proxy for Telegram API access (http/https/socks5)
- `DB_PATH` — SQLite file location (default `./data/gg-sms.sqlite`)

## Testing

Tests live in `tests/` and use Bun's native test framework. Use `MODEM_PORT=mock` to run without hardware. The mock modem provider (`src/modem/mock-modem-provider.ts`) simulates SMS behavior in-memory.
