# Cloudflare Named Tunnel 部署

QuotaFlow 当前使用 Cloudflare Named Tunnel 提供稳定的 GitHub App Webhook 入口。该域名和 TLS 证书由 Cloudflare 管理，源站只监听 macOS 本机回环地址。

## 当前部署

- 公网 Webhook: `https://quotaflow-hooks.wangxso.com/github/webhook`
- 健康检查: `https://quotaflow-hooks.wangxso.com/healthz`
- 本地源站: `http://127.0.0.1:8787`
- Cloudflare 隧道: `quotaflow-webhook`
- 隧道 ID: `47a14564-86f8-47f2-9c04-edbb3c0fc7ed`
- Cloudflare 配置: `~/.cloudflared/config.yml`
- 隧道凭据: `~/.cloudflared/47a14564-86f8-47f2-9c04-edbb3c0fc7ed.json`
- Webhook secret: `~/.config/quotaflow/github-webhook-secret`
- GitHub App private key: `~/.config/quotaflow/github-app-5955591.pem`

凭据文件不得写入仓库或输出到日志。当前文件权限为当前用户可读。

## launchd 服务

部署包含三个用户级 LaunchAgent：

| Label | 作用 | 配置 |
| --- | --- | --- |
| `com.quotaflow.webhook` | 运行 `bun run src/cli.ts github serve-webhook` | `~/Library/LaunchAgents/com.quotaflow.webhook.plist` |
| `com.quotaflow.cloudflared` | 运行 `cloudflared tunnel run quotaflow-webhook` | `~/Library/LaunchAgents/com.quotaflow.cloudflared.plist` |
| `com.quotaflow.healthcheck` | 每 60 秒检查本地与公网健康状态 | `~/Library/LaunchAgents/com.quotaflow.healthcheck.plist` |

启动脚本位于 `~/.local/share/quotaflow/bin/`。日志位于 `~/.local/state/quotaflow/`。

```sh
launchctl print "gui/$(id -u)/com.quotaflow.webhook"
launchctl print "gui/$(id -u)/com.quotaflow.cloudflared"
launchctl print "gui/$(id -u)/com.quotaflow.healthcheck"

launchctl kickstart -k "gui/$(id -u)/com.quotaflow.webhook"
launchctl kickstart -k "gui/$(id -u)/com.quotaflow.cloudflared"
```

健康检查会重启本地失败或公网不可达的组件。`KeepAlive=true` 会在进程异常退出后自动拉起。

## Cloudflare 路由

`~/.cloudflared/config.yml` 将唯一主机名路由到本机：

```yaml
tunnel: 47a14564-86f8-47f2-9c04-edbb3c0fc7ed
credentials-file: /Users/wangxs/.cloudflared/47a14564-86f8-47f2-9c04-edbb3c0fc7ed.json
no-autoupdate: true

ingress:
  - hostname: quotaflow-hooks.wangxso.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

检查配置和连接：

```sh
cloudflared tunnel --config ~/.cloudflared/config.yml ingress validate
cloudflared tunnel info quotaflow-webhook
curl -fsS https://quotaflow-hooks.wangxso.com/healthz
```

## 轮换与恢复

Webhook secret 轮换需要同时更新 GitHub App 和本地 secret 文件，然后重启 `com.quotaflow.webhook`。轮换窗口内 GitHub 投递可能返回 401，应避开活跃任务。

GitHub App private key 轮换时，先在 App 设置中生成新 key，安全写入 `~/.config/quotaflow/`，更新 `quotaflow.config.json` 的 `privateKeyPath`，重启 Webhook 并确认安装令牌获取成功，再撤销旧 key。

若隧道凭据丢失，应重新创建 Named Tunnel、更新 DNS CNAME 和 `config.yml`，再重启 `com.quotaflow.cloudflared`。旧 tunnel 在确认无连接后删除。

执行 `launchctl bootout` 前先确认没有正在处理的 Webhook。Webhook 与 tunnel 同时不可用期间，GitHub 会按自身策略重试，但超过重试窗口的事件仍需人工检查。

## 边界

这些是用户级 LaunchAgent，依赖 macOS 用户会话。机器保持在线并保持用户登录时，服务会由 launchd 持续监督。若需要未登录也可启动，应改为系统级 LaunchDaemon，并使用独立服务账号和 `/Library/...` 权限模型。
