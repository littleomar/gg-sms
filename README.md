# gg-sms

`gg-sms` 是一个运行在 FNOS / Linux 主机上的 Bun 服务，用来通过 EC200 模块管理 giffgaff SIM 卡的短信收发、Telegram 交互和手动流量保号。

## 当前能力

- Bun + TypeScript 项目骨架
- Telegram bot 单管理员鉴权
- EC200 `ModemProvider` 接口和基础串口实现
- `/status`、`/data on`、`/data off`、`/sms`、`/sms inbox [n]`、`/keepalive`、`/account`
- 入站短信主动推送，并带 `Reply` 按钮
- 新建短信草稿或回复短信时的多步交互
- 每次发送都需要验密，并且验密后还要再确认一次
- SQLite 持久化短信、草稿、告警、任务和账户预留状态
- `/account` 占位实现与未来账户追踪字段预留

## 快速开始

1. 复制环境变量模板：

```bash
cp .env.example .env
```

2. 按实际环境填写 `.env`。

3. 安装依赖：

```bash
bun install
```

4. 启动服务：

```bash
bun run start
```

5. 运行测试：

```bash
bun test
```

## 重要环境变量

- `BOT_TOKEN`: Telegram bot token
- `BOT_ADMIN_ID`: 唯一允许操作 bot 的 Telegram user/chat id
- `TELEGRAM_PROXY_URL`: Telegram 出口代理地址，支持 `http://`、`https://`、`socks://`、`socks5://` 等 URL；中国大陆环境下通常需要配置
- `SMS_SEND_PASSWORD`: 每次发送短信都要输入的密码
- `MODEM_PORT`: EC200 串口，例如 `/dev/ttyUSB2`
- `MODEM_BAUD`: 串口波特率，默认 `115200`
- `APN_NAME`: giffgaff 数据 APN
- `KEEPALIVE_URL`: 手动保号时访问的极小 HTTPS 地址
- `DB_PATH`: SQLite 数据库路径

## 当前限制

- `/account` 还没有接入真实的 Playwright 或 API 抓取逻辑，目前只返回占位信息，并记录最近一次尝试时间。
- EC200 驱动目前是可运行的基础版本，真实部署前建议先在你的 FNOS + 模块环境上做一次串口和 AT 命令兼容验证。
- 自动保号调度还没有实现，当前只支持手动执行 `/keepalive`。

## 本地开发提示

- 如果你只想先调试 bot 和流程，可以把 `MODEM_PORT=mock`，这会启用内置的 mock modem，不依赖真实硬件。
- 如果宿主机无法直连 Telegram Bot API，请配置 `TELEGRAM_PROXY_URL`，例如 `socks5://127.0.0.1:7890`。
