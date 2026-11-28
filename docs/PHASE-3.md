# QuotaFlow Phase 3 · Dashboard 与部署

**状态** 已启动 · 2026-11-28

## 首个本地控制切片

CLI 新增本地 Dashboard：

```sh
bun run src/cli.ts dashboard --config quotaflow.config.json
# http://127.0.0.1:8788/
```

首个切片提供：

- Overview：任务状态、事件流、Lane、仓库映射和 GitHub 指标。
- Tasks：状态筛选、搜索、最近任务和完整任务详情。
- 任务详情：attempt、实际模型、checkpoint、prompt、handoff、usage、预算租约和事件时间线。
- GitHub：最近 Gate 结果、阻断原因和同 HEAD CI rerun 记录。
- Budgets：预算使用、余额、活跃租约和 Lane 配置。
- 项目筛选：Overview、Tasks、GitHub 和最近任务共享同一个 repository 过滤上下文。
- 实时事件：`/api/events/stream` 通过 SSE 从 SQLite event cursor 增量推送任务和运行状态，断线后自动重连。
- 受控任务操作：支持 `cancel` 和 `retry`，均要求明确确认并写入 `dashboard_action` 审计事件。

服务默认绑定 `127.0.0.1:8788`，不能通过 `--host` 绑定非回环地址。Dashboard 只开放取消和重新入队，暂不直接启动 Worker、提交模型调用、批准 Review 或合并 PR。

macOS 当前通过 `com.quotaflow.dashboard` LaunchAgent 常驻，并由现有健康检查每分钟确认 `/api/health`。Dashboard 不经过 Cloudflare Named Tunnel，也不会暴露到公网。

## 视觉方向

界面参考 T3 Code 的桌面工作台密度：窄侧栏、最近任务上下文、紧凑状态层、低噪声边框和单一强调色。QuotaFlow 使用自己的信息架构、样式和数据视图，不复制 T3 Code 的界面、品牌素材或组件代码。

运行时不从 CDN 加载字体、脚本、样式或图片。动态任务、日志、PR 和 handoff 文本全部通过 `textContent` 写入页面，避免把仓库或 CI 内容解释为 HTML。

## Web 安全边界

- 默认且仅允许回环监听。
- 页面使用严格 CSP，禁止第三方脚本、样式、frame 和表单提交。
- API 设置 `nosniff`、`DENY` frame 和 `no-referrer`。
- 配置 API 不返回 GitHub App private key 路径、Webhook secret 或令牌。
- 读接口只接受 GET。写操作只接受带同源 Origin、HttpOnly 会话 Cookie 和 CSRF header 的 JSON POST。
- Session TTL 为 8 小时，Cookie 为 `SameSite=Strict`，session 与 CSRF token 只保存在 Dashboard 进程内存。
- 写操作要求 `confirmTaskId` 与目标任务完全一致，并用客户端 `requestId` 做持久幂等。
- 状态修改与 `dashboard_action` 审计事件在同一 SQLite 事务提交。
- Task/Event/PR 文本作为不可信内容展示。

开始 Worker、审批、合并和设置修改仍需后续设计，不能直接复用当前任务操作接口。

## 主要 API

- `GET /api/health`
- `GET /api/overview`
- `GET /api/events/stream`
- `GET /api/session`
- `GET /api/tasks`
- `GET /api/tasks/:id`
- `GET /api/github`
- `GET /api/budgets`
- `GET /api/config`
- `POST /api/tasks/:id/actions`

## 下一步

1. 增加时间范围、Lane 和审查状态组合筛选。
2. 在独立执行确认流程下增加启动 Worker。
3. 在 GitHub 写权限和人工确认流程下增加批准／合并。
4. 增加部署、备份、恢复和 Linux／Windows + WSL2 启动检查。
