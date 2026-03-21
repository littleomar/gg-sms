# gg-sms

`gg-sms` 是一个运行在 FNOS / Linux 主机上的 Bun 服务，用来通过 EC200 模块管理 giffgaff SIM 卡的短信收发、Telegram 交互和手动流量保号。

## 当前能力

- Bun + TypeScript 项目骨架
- Telegram bot 单管理员鉴权
- EC200 `ModemProvider` 接口和基于 POSIX TTY 的基础串口实现
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
- `BOT_NOTIFY_CHAT_ID`: 主动推送短信和告警的目标 chat id；不填时默认沿用管理员最近一次实际使用 bot 的 chat
- `LOG_LEVEL`: 全局日志级别，支持 `debug`、`info`、`warn`、`error`，默认 `info`
- `TELEGRAM_PROXY_URL`: Telegram 出口代理地址，支持 `http://`、`https://`、`socks://`、`socks5://` 等 URL；中国大陆环境下通常需要配置
- `GG_DASHBOARD_COOKIE`: giffgaff dashboard 登录后的完整 Cookie 串；只用于 `/account`，不要提交到 git
- `GG_DASHBOARD_URL`: dashboard 页面地址，默认 `https://www.giffgaff.com/dashboard`
- `GG_DASHBOARD_ACCEPT_LANGUAGE`: `/account` 抓取时使用的 `Accept-Language`
- `GG_DASHBOARD_USER_AGENT`: `/account` 抓取时使用的 `User-Agent`
- `MODEM_DEBUG`: 设为 `1` 后输出 modem AT 命令、串口返回和入站短信处理日志，排查收短信问题时很有用
- `SMS_SEND_PASSWORD`: 每次发送短信都要输入的密码
- `MODEM_PORT`: EC200 串口，例如 `/dev/ttyUSB2`
- `MODEM_BAUD`: 串口波特率，默认 `115200`
- `APN_NAME`: giffgaff 数据 APN
- `KEEPALIVE_URL`: 手动保号时访问的极小 HTTPS 地址
- `DB_PATH`: SQLite 数据库路径
- `SMS_POLL_INTERVAL_MS`: 后台未读短信轮询间隔，默认 `15000` 毫秒；设为 `0` 可关闭轮询兜底

## 当前限制

- `/account` 当前支持用 `GG_DASHBOARD_COOKIE` 或 TG 命令 `/accountcookie <cookie>` 直抓 giffgaff dashboard 余额。
- EC200 驱动当前通过 `stty + /dev/tty*` 的 POSIX TTY 方式工作，真实部署前建议先在你的 FNOS + 模块环境上做一次串口和 AT 命令兼容验证。
- 自动保号调度还没有实现，当前只支持手动执行 `/keepalive`。
- `/keepalive` 现在通过 EC200 模块自身发起 HTTP(S) 请求，流量走 SIM 卡而不是宿主机默认网络；如果执行前数据原本关闭，会在 keepalive 时自动临时打开并在完成后恢复关闭。为兼容性，模块侧 HTTPS 默认关闭证书校验。

## 本地开发提示

- 如果你只想先调试 bot 和流程，可以把 `MODEM_PORT=mock`，这会启用内置的 mock modem，不依赖真实硬件。
- 如果需要更详细的运行日志，可以把 `LOG_LEVEL=debug`；如果还要看原始 AT 收发，再额外设置 `MODEM_DEBUG=1`。
- 如果宿主机无法直连 Telegram Bot API，请配置 `TELEGRAM_PROXY_URL`，例如 `socks5://127.0.0.1:7890`。
- 如果怀疑短信没有被读取到，可以临时设置 `MODEM_DEBUG=1`，再观察是否出现 `+CMTI`、`AT+CMGR`、启动时 inbox scan，以及后台轮询日志。
- 如果你想直接在 TG 里更新 dashboard 登录态，可以发送 `/accountcookie <cookie>`；bot 会尽量删除原始消息，降低 cookie 暴露时间。
- 建议把 `KEEPALIVE_URL` 设成返回 `204` 或极小响应体的地址，这样模块侧 keepalive 消耗的 SIM 流量最少。
