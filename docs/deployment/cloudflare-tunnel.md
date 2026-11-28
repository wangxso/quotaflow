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
| `com.quotaflow.dashboard` | 在 `127.0.0.1:8788` 运行受控任务 Dashboard | `~/Library/LaunchAgents/com.quotaflow.dashboard.plist` |
| `com.quotaflow.healthcheck` | 每 60 秒检查本地与公网健康状态 | `~/Library/LaunchAgents/com.quotaflow.healthcheck.plist` |

启动脚本位于 `~/.local/share/quotaflow/bin/`。日志位于 `~/.local/state/quotaflow/`。

```sh
launchctl print "gui/$(id -u)/com.quotaflow.webhook"
launchctl print "gui/$(id -u)/com.quotaflow.cloudflared"
launchctl print "gui/$(id -u)/com.quotaflow.dashboard"
launchctl print "gui/$(id -u)/com.quotaflow.healthcheck"

launchctl kickstart -k "gui/$(id -u)/com.quotaflow.webhook"
launchctl kickstart -k "gui/$(id -u)/com.quotaflow.cloudflared"
launchctl kickstart -k "gui/$(id -u)/com.quotaflow.dashboard"
```

健康检查会重启本地失败或公网不可达的组件。Dashboard 只检查本机 `/api/health`，不通过 Cloudflare 暴露。`KeepAlive=true` 会在进程异常退出后自动拉起。

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

Delivery 去重使用原始 Webhook 字节哈希，Gate 另存刷新后的 REST 快照哈希。因此同一 GitHub delivery 在首次写入后如果 PR 快照发生变化，重试仍按重复事件处理，不会被误报为内容冲突。

Webhook secret 轮换需要短暂维护窗口。不要在活跃任务处理期间执行：

1. 确认当前没有 `running` 或 `cancelling` 任务，并停止接收新的发布操作。
2. 在终端生成新值，不输出到会话或日志：

   ```sh
   umask 077
   openssl rand -hex 32 > ~/.config/quotaflow/github-webhook-secret.next
   pbcopy < ~/.config/quotaflow/github-webhook-secret.next
   ```

3. 在 GitHub App 设置中把 Webhook secret 更新为剪贴板中的新值。
4. 原子替换本地文件并重启服务：

   ```sh
   mv ~/.config/quotaflow/github-webhook-secret ~/.config/quotaflow/github-webhook-secret.previous
   mv ~/.config/quotaflow/github-webhook-secret.next ~/.config/quotaflow/github-webhook-secret
   launchctl kickstart -k "gui/$(id -u)/com.quotaflow.webhook"
   ```

5. 验证公网 `/healthz`，再从 GitHub App Recent Deliveries 重发一个 `ping` 或安全事件。成功后再删除 `.previous`。

若 GitHub 侧更新失败，保留原文件。若 GitHub 已更新而本地尚未切换，立即在 GitHub 恢复旧 secret，再重新执行整个流程。旧签名在新服务上必须返回 `401 invalid_signature`，新签名必须返回 `200`。

GitHub App private key 轮换时，先在 App 设置中生成新 key，安全写入 `~/.config/quotaflow/`，更新 `quotaflow.config.json` 的 `privateKeyPath`，重启 Webhook 并确认安装令牌获取成功，再撤销旧 key。

若隧道凭据丢失，应重新创建 Named Tunnel、更新 DNS CNAME 和 `config.yml`，再重启 `com.quotaflow.cloudflared`。旧 tunnel 在确认无连接后删除。

执行 `launchctl bootout` 前先确认没有正在处理的 Webhook。Webhook 与 tunnel 同时不可用期间，GitHub 会按自身策略重试，但超过重试窗口的事件仍需人工检查。

## 边界

这些是用户级 LaunchAgent，依赖 macOS 用户会话。机器保持在线并保持用户登录时，服务会由 launchd 持续监督。若需要未登录也可启动，应改为系统级 LaunchDaemon，并使用独立服务账号和 `/Library/...` 权限模型。
