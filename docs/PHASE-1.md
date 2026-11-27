# QuotaFlow Phase 1 · 核心 MVP

**状态** 已启动 · 2026-11-27

## 路由授权

2026-11-27 项目负责人允许 Phase 1 继续使用 Magpie 路由模型。该授权写入配置的 `routing.routedModelApproval`，不是全局默认值；未带明确审批的 Magpie Lane 会被配置校验拒绝。

路由模型仍按以下边界记录：Magpie 的 `cost`／`priced` 只是网关价格计算，服务商账单继续记为 `UNKNOWN`；不得把路由模型称为原生 ChatGPT 调用。

## 已落地首片

首个可运行切片覆盖单机任务底座：

- `quotaflow.config.example.json` 提供显式路由审批、Lane、额度窗口和 Worktree 根目录示例。
- SQLite v5 持久化 `tasks`、`attempts`、`cooldowns`、`events`、`attempt_usage` 和 `budget_leases`，开启 WAL 和完整同步；v1／v2／v3／v4 均可无损迁移。
- 原子预留同时检查账户并发槽位、冷却时间、额度窗口剩余量、保留额度、观测新鲜度、显式预算租约和尝试上限。
- 未知或过期额度不会被猜测为可用；关键任务可绕过普通任务保留额度，但不能绕过并发槽位。
- Git Worktree 可显式准备，私有检查点保存已暂存、未暂存、删除和未跟踪内容，并支持从检查点恢复。
- CLI 支持配置校验、任务提交、列表、详情、事件、取消、重试、Worktree 准备、低层队列领取、Worker 恢复和预算状态。
- Worker 编排已实现：预留尝试后自动准备 Worktree，运行注入的 Agent Adapter，保存检查点并结算完成、失败或额度等待；fixture 测试覆盖完成、失败、额度中断、缺少 Adapter 和从检查点恢复。
- Windows 受监督命令 Adapter 已接入：只有 `stopped.json` 中出现 `activeProcesses=0` 的监督器停止凭证后，Worker 才保存检查点；`worker once` 可执行配置中的 Lane `command`。
- Codex App Server Adapter 已接入：推理前执行零推理工作区预检，使用任务 prompt、Lane 模型和可选 `baseUrl`，并拒绝继承直接 API 环境变量。该路径不经过 Windows Job Object 监督器，关闭 App Server 后仅由 Adapter 报告 `activeProcesses=0`，不存在 `stopped.json`，不能把该字段当作进程监督凭证。
- OpenCode Adapter 已接入：当前要求 Magpie Lane 显式配置 `baseUrl`；使用隔离的 `OPENCODE_CONFIG`、`OPENCODE_DB` 和 `XDG_*` 运行 `opencode run --pure --format json`，拒绝外部目录、网络、task 和 skill 权限；必须在 `stopped.json` 确认 `activeProcesses=0`，并从 NDJSON 日志要求至少一个 `step_finish`。
- Magpie 请求级对账已接入：OpenCode 完成后按精确会话 ID 查询请求行，在本地按尝试时窗复核，写入 `attempt_usage` 并从一致的服务模型回填 `attempts.actual_model`。对账失败只记录 `usage_reconciled` 事件，不阻断任务完成；服务商账单始终保留为 `UNKNOWN`。
- 预算租约已接入：仅对显式配置 `budgets` 的账户记账；预留时先占用 `holdPerAttempt`，已定价用量结算后收缩到网关估算成本，用量未知或不完整时保留 hold 并标记 `pending`。预算不足会使任务进入 `waiting_quota`、`reason=budget`，并等待最早租约过期。`task show` 与 `budget status` 可审计租约。
- Worker 重启恢复已接入：每次预留后写入受控 `owner.json`；`worker once` 启动时检查遗留活动尝试。只有旧 owner 已退出且 Windows Job Object 提供 `activeProcesses=0` 的停止凭证时，才保存检查点并把任务重新入队。缺少停止凭证的 Codex 写入者会将任务置为 `blocked`，不会转移写权。
- 显式重试已接入：`task retry` 可从 `failed`、`blocked` 或等待状态重新入队，保留既有检查点和尝试历史；总尝试次数仍限制为 3。

预算的 `unit` 是自由文本；示例使用 `magpie-cost-estimate`，表示 Magpie 网关估算，不是服务商发票币种。没有配置预算的 Lane 保持原有额度调度行为。

## 本地运行

```powershell
Copy-Item quotaflow.config.example.json quotaflow.config.json
bun run src/cli.ts config validate
bun run src/cli.ts task add "Describe the first task" --prompt "Implement and verify the task" --repo C:\path\to\repo
bun run src/cli.ts task list
bun run src/cli.ts task show <task-id>
bun run src/cli.ts task events <task-id>
bun run src/cli.ts task retry <task-id>
bun run src/cli.ts task prepare <task-id>
bun run src/cli.ts budget status
bun run src/cli.ts worker recover
bun run src/cli.ts worker once
```

示例配置中的额度窗口是占位值，`remaining=null` 且时间已过期，因此队列会进入 `waiting_quota`，直到接入真实额度观测。`queue next` 只完成预留并返回活动尝试，供后续 Worker 使用；`worker once` 优先执行 Lane `command`，否则根据 Lane 的 `agent` 选择 Codex App Server 或 OpenCode Adapter。

## 真实路由 smoke

2026-11-27 在临时仓库完成一次受控 Codex 路由任务：`worker once` 经 Codex App Server 执行，`app.txt` 为 `41`，仅该文件改变，任务状态为 `completed`，实际模型为 `opencode-go/deepseek-v4.1-flash`，检查点为 `905ad3e357c6bcf3cb3a4d8628e6a109a46b2ca4`。任务于 15:28:30 预留，完成事件于 15:28:59 写入；Magpie 在同一尝试窗口记录 3 条来自 `quotaflow_phase0` 客户端会话的 HTTP 200，请求模型为 `opencode-go/deepseek-v4.1-flash`、服务模型为 `deepseek-v4.1-flash`，网关成本估算合计 0.00548382。脱敏结果见[路由 smoke 证据](evidence/phase1-codex-route-smoke-2026-11-27.json)。

该次运行只证明 Codex 路由任务闭环。Magpie 请求行没有 QuotaFlow `task_id`，上述关联依据是尝试时间窗口、唯一的 `quotaflow_phase0` 客户端身份和单一会话，属于可复核的时间关联，不是 Provider 侧账单归属。服务商账单仍为 `UNKNOWN`。

同日使用 Magpie 免费模型 `hy4-flash-free` 完成两次 OpenCode smoke。第一次发生在请求级回写接入前：任务状态为 `completed`，检查点为 `e75eb8e83093cb2cc487c5b073d82123d544596a`，OpenCode 会话 `ses_de40632d4ffeyg5XdzKi3E0zS8` 产生 4 个 `step_finish` 和 3 次工具调用，Magpie 记录 5 条 HTTP 200、成本估算为 0。脱敏结果见[OpenCode Adapter smoke 证据](evidence/phase1-opencode-adapter-smoke-2026-11-27.json)。

第二次 smoke 验证回写：任务于 16:13:24 开始，16:13:36 完成，检查点为 `0f1516e5b25f28cab2045fb3bcc0a66fad83d2b2`，`stopped.json` 再次记录 `exitCode=0`、`activeProcesses=0`。OpenCode 会话 `ses_de3ef00aeffep6QN3smvAV5eDW` 的 4 条 Magpie 请求行全部 HTTP 200、`priced=true`、成本估算为 0；其中 3 条对应 3 个步骤调用，1 条辅助请求单独保留。QuotaFlow 将 4 行写入 `attempt_usage`，把 `attempts.actual_model` 回填为服务模型 `hy4-flash-free`，并写入 `usage_reconciled` 与 `attempt_finished` 事件。脱敏结果见[Magpie 用量回写证据](evidence/phase1-magpie-usage-writeback-2026-11-27.json)。

第一次 smoke 的 `attempts.actual_model` 保持 `null`，准确反映了当时 OpenCode 1.19.6 `step_finish` 不含模型字段、且尚无请求级回写的状态。第二次 smoke 没有用请求模型冒充实际模型，而是只从 Magpie 服务模型回填。网关估算成本 0 不等于服务商发票，Provider 账单仍记 `UNKNOWN`；Magpie 行也没有 QuotaFlow `task_id`，但 QuotaFlow 现已持久化任务到请求行的关联。

上述用量回写证据产生于 schema v4；当前 schema v5 已包含无损 v4→v5 迁移和预算租约。预算租约的确定性测试证据见[预算租约证据](evidence/phase1-budget-lease-2026-11-27.json)。

重启恢复通过一次真实控制器进程终止演练验证：受监督任务写入部分结果后，控制器被强制结束；下一轮 `worker once` 依据 `stopped.json` 的 `activeProcesses=0` 凭证保存首个检查点、把任务重新入队，并由第二次尝试完成。结果见[重启恢复证据](evidence/phase1-restart-recovery-2026-11-27.json)。恢复不会释放未知用量的预算 hold，而是保留 `pending` 直到租约过期或后续核销。

本地 fixture 可在 Lane 中配置为 `["bun", "run", "src/fixture-agent.ts", "complete"]`。当前受监督命令 Adapter 和 OpenCode Adapter 只支持 Windows，并复用 Phase 0 已验证的 `poc/guard-win.ps1` 与 `GuardWin.cs`；打包前需要将监督器提升为独立发布制品。

## 尚未完成

- 活动 Codex／OpenCode 进程的跨进程取消；当前 CLI 取消仍要求尝试已结束。
- 无 Job Object 停止凭证时的 Codex 自动恢复；当前会保守置为 `blocked`，需要人工确认旧写入者退出。
- 基于实际 Provider 账单的预算归属；当前预算只使用网关估算租约。
- 真实任务级端到端测试、Worktree 生命周期自动化和 Linux／macOS 行为验证。

## 下一里程碑

1. 完成活动任务取消和 Codex 受监督停止路径，覆盖 Codex 与 OpenCode 两条执行链。
2. 完善预算租约的过期审计、恢复后冷却联动和重试策略，继续保留服务商账单为 `UNKNOWN`。
3. 在 mcarplay 或等价真实仓库完成端到端任务，并补并发、额度等待和失败恢复测试。
