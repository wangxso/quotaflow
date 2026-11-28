# QuotaFlow Phase 3 · Dashboard 与部署

**状态** 已启动 · 2026-11-28

## 首个只读切片

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

服务默认绑定 `127.0.0.1:8788`，不能通过 `--host` 绑定非回环地址。Dashboard 当前没有写操作，只读取现有 SQLite 和配置。

macOS 当前通过 `com.quotaflow.dashboard` LaunchAgent 常驻，并由现有健康检查每分钟确认 `/api/health`。Dashboard 不经过 Cloudflare Named Tunnel，也不会暴露到公网。

## 视觉方向

界面参考 T3 Code 的桌面工作台密度：窄侧栏、最近任务上下文、紧凑状态层、低噪声边框和单一强调色。QuotaFlow 使用自己的信息架构、样式和数据视图，不复制 T3 Code 的界面、品牌素材或组件代码。

运行时不从 CDN 加载字体、脚本、样式或图片。动态任务、日志、PR 和 handoff 文本全部通过 `textContent` 写入页面，避免把仓库或 CI 内容解释为 HTML。

## Web 安全边界

- 默认且仅允许回环监听。
- 页面使用严格 CSP，禁止第三方脚本、样式、frame 和表单提交。
- API 设置 `nosniff`、`DENY` frame 和 `no-referrer`。
- 配置 API 不返回 GitHub App private key 路径、Webhook secret 或令牌。
- 当前只接受 GET，其他方法返回 `405`。
- Task/Event/PR 文本作为不可信内容展示。

Dashboard 当前仍是只读控制面。提交、取消、审批、合并和设置修改必须经过独立的权限、CSRF 与人工确认设计，不能直接复用只读 API。

## 主要 API

- `GET /api/health`
- `GET /api/overview`
- `GET /api/tasks`
- `GET /api/tasks/:id`
- `GET /api/github`
- `GET /api/budgets`
- `GET /api/config`

## 下一步

1. 增加 SSE 或增量事件游标，避免整页轮询。
2. 增加多项目、状态、时间和 Lane 组合筛选。
3. 在独立权限与 CSRF 设计下增加受控写操作。
4. 增加部署、备份、恢复和 Linux／Windows + WSL2 启动检查。
5. 用 CLI 与 Dashboard 的同状态 fixture 做端到端一致性验证。
