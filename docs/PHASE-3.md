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
- 任务详情：attempt、实际模型、checkpoint、prompt、handoff、usage、预算租约、Worker Run 和事件时间线。
- GitHub：最近 Gate 结果、阻断原因和同 HEAD CI rerun 记录。
- Budgets：预算使用、余额、活跃租约和 Lane 配置。
- 组合筛选：项目与时间范围作用于任务、事件和 GitHub 数据；Tasks 可再按 Lane 筛选，GitHub 可再按审查状态筛选，筛选偏好保存在本地浏览器。
- 实时事件：`/api/events/stream` 通过 SSE 从 SQLite event cursor 增量推送任务和运行状态，断线后自动重连。
- 受控任务操作：支持 `start`、`cancel` 和 `retry`，均要求明确确认；动作请求写入 `dashboard_action`，Worker 启动和退出写入独立生命周期事件。
- 受控 GitHub 操作：配置 GitHub App、显式允许 Bot 批准并映射仓库后，可对 current-head 门禁执行 `approve` 或 `merge`。操作前重新拉取 PR，HEAD、分支或 fork 变化会中止；合并还会重新检查 CI、审查和 mergeable 状态。

服务默认绑定 `127.0.0.1:8788`，不能通过 `--host` 绑定非回环地址。Dashboard 本身不执行模型。`start` 只为已到期且没有活跃 attempt 的 `queued` 或 `waiting_quota` 任务派生一次性 Worker 子进程。子进程通过 `worker once --task-id` 定向领取该任务，并重新检查 Lane、额度、预算和调度状态；条件不满足时停在 `waiting_quota`，不会绕过现有调度器。Dashboard 仅通过受控 GitHub 接口处理 Review 批准与 PR 合并，不开放配置修改。

macOS 当前通过 `com.quotaflow.dashboard` LaunchAgent 常驻，并由现有健康检查每分钟确认 `/api/health`。Dashboard 不经过 Cloudflare Named Tunnel，也不会暴露到公网。

受控 PR #152 在 Bot 批准后以精确 HEAD 合并为 `d42c690`。合并后的 `main` 提交通过 [Android CI](https://github.com/wangxso/mcarplay/actions/runs/46128177378) 与 [Instrumentation](https://github.com/wangxso/mcarplay/actions/runs/46128177328)。Dashboard App merge 最初因缺少 `Contents: write` 被 GitHub 拒绝，最终合并使用仓库管理员授权路径。GitHub App 与 installation 的 `contents: write` 权限随后已完成设置、安装侧确认和 API 复核，Dashboard 也已重启刷新令牌。上述结果记录在[受控 PR 合并证据](evidence/phase3-github-controlled-pr-merge-2026-11-28.json)与[权限修复证据](evidence/phase3-github-app-contents-write-resolution-2026-11-28.json)。

第二个受控 PR #153 关联 Issue #81，在本地完整门禁和 current-head CI 通过后由 Dashboard App 于 exact HEAD `1e121ec` 提交 Review `6097234663`。门禁随后进入 `ready_for_human_merge`，同一个 App 通过 `contents: write` 权限以 merge commit `aa0a2b8` 完成合并，`mergedBy` 为 `app/quotaflow-review-gate-wangxso`，没有管理员回退。演练还发现并修复了 pending／missing Check 被错误物化为 `ci_fix` 任务的问题。Issue #81 的跨三条记忆路径统一和旧键迁移仍未完成，因此本 PR 只作为关联而不关闭该 Issue。

`aa0a2b8` 的 post-merge Android CI 随后连续三次收到 Robolectric 下载 Maven Central 429，而 Instrumentation 正常通过。受控 PR #155 将 API 21/35 两个 `android-all-instrumented` 运行时改为 Gradle 预取到 `app/build/robolectric-runtime`，测试 JVM 通过 `robolectric.dependency.dir` 本地加载。修复提交 `6985739` 经 Dashboard App 批准并合并为 `047cbbb`，不再通过机械重跑掩盖依赖下载竞态。证据见 [Robolectric 预取记录](evidence/phase3-github-ci-robolectric-preload-2026-11-28.json)。

随后 `047cbbb` 的 post-merge Instrumentation 暴露 RGP08 启动崩溃缺少内部重试。受控 PR #157 统一了 RGP07/RGP08 的 crash-only 判定，只在 `shortMsg=Process crashed` 且没有任何测试结论时重试一次，断言失败和超时仍立即失败。修复提交 `099ee2c` 经 Dashboard App 批准并合并为 `25ea99a`。证据见 [RGP08 重试记录](evidence/phase3-github-rgp08-crash-retry-2026-11-28.json)。

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
- `start` 的持久幂等阻止同一 `requestId` 重复派生 Worker；`dashboard_worker_started`、`dashboard_worker_exited` 和 `dashboard_worker_spawn_failed` 记录进程结果。
- GitHub 写操作要求输入完整 `owner/repo#pull@headSha`，并使用 `requestId` 在 `github_deliveries` 中原子登记 `running`、`succeeded` 或 `failed`。未知结果不会自动重放外部请求。
- Bot 批准使用当前 HEAD 的正式 Review。合并必须在重新拉取快照后通过当前门禁，并向 GitHub 发送同一 `headSha` 和固定 merge commit 策略。
- Worker 输出写入状态目录下的 `.quotaflow/dashboard-workers/<requestId>.log`，新文件权限为 `0600`；不会把 session 或 CSRF token 写入页面或日志。
- Worker 日志只对同一任务、同一 `requestId` 的 `start` 审计事件开放。读取上限为最后 64 KiB，拒绝符号链接，并清理 ANSI、控制字符和常见令牌、密码、私钥格式。
- Task/Event/PR 文本作为不可信内容展示。

审批和合并使用独立于任务动作的权限、确认和持久幂等审计接口；设置修改仍不开放。

## 主要 API

- `GET /api/health`
- `GET /api/overview`
- `GET /api/events/stream`
- `GET /api/session`
- `GET /api/tasks`
- `GET /api/tasks/:id`
- `GET /api/tasks/:id/workers/:requestId/log`
- `GET /api/github`
- `GET /api/budgets`
- `GET /api/config`
- `POST /api/tasks/:id/actions`
- `POST /api/github/actions`

## 下一步

1. 增加桌面发行、备份、恢复和 Linux／Windows + WSL2 启动检查。
