# QuotaFlow Phase 1 · 核心 MVP

**状态** 已启动 · 2026-11-27

## 路由授权

2026-11-27 项目负责人允许 Phase 1 继续使用 Magpie 路由模型。该授权写入配置的 `routing.routedModelApproval`，不是全局默认值；未带明确审批的 Magpie Lane 会被配置校验拒绝。

路由模型仍按以下边界记录：Magpie 的 `cost`／`priced` 只是网关价格计算，服务商账单继续记为 `UNKNOWN`；不得把路由模型称为原生 ChatGPT 调用。

## 已落地首片

首个可运行切片覆盖单机任务底座：

- `quotaflow.config.example.json` 提供显式路由审批、Lane、额度窗口和 Worktree 根目录示例。
- SQLite v10 持久化任务、尝试、交接笔记、额度冷却、事件、用量、预算租约、GitHub 门禁和 CI 复跑记录，开启 WAL 和完整同步。v1 至 v9 可迁移到 v10。
- 原子预留同时检查账户并发槽位、冷却时间、额度窗口剩余量、保留额度、观测新鲜度、显式预算租约和尝试上限。
- 未知或过期额度不会被猜测为可用；关键任务可绕过普通任务保留额度，但不能绕过并发槽位。
- Git Worktree 可显式准备，私有检查点保存已暂存、未暂存、删除和未跟踪内容，并支持从检查点恢复。
- CLI 支持配置校验、任务提交、列表、详情、事件、活动取消、取消等待与强制升级、重试、Worktree 准备、低层队列领取、Worker 恢复和预算状态。
- Worker 编排已实现：预留尝试后自动准备 Worktree，运行注入的 Agent Adapter，保存检查点并结算完成、失败、取消或额度等待；fixture 测试覆盖完成、失败、活动取消、额度中断、缺少 Adapter 和从检查点恢复。
- 受监督命令 Adapter 支持 Windows、macOS 和 Linux。`worker once` 可执行 Lane `command`，并在 `stopped.json` 确认 `activeProcesses=0` 后保存检查点。macOS 持续记录根进程、子进程、进程组和 PID 启动身份。Linux 启用 child subreaper，使 detached／双重 fork 后代回收至监督器，再结合 `/proc` 枚举停止整个进程树。
- Codex App Server Adapter 已接入：推理前执行零推理工作区预检，使用任务 prompt、Lane 模型和可选 `baseUrl`，并拒绝继承直接 API 环境变量。Windows 通过 Job Object，macOS 和 Linux 通过各自的原生进程树监督保留 App Server 双向 stdio；关闭后必须取得 `stopped.json` 的 `activeProcesses=0`，否则抛出停止未验证错误，由 Worker 阻塞任务而不保存检查点。
- Codex 停止证明与 Server 返回值分离。默认 verifier 读取 `stopped.json`；自定义 `CodexServerFactory` 必须显式注入独立 `CodexStopVerifier`。缺少证明、PID 非法、`activeProcesses` 非零或停止对象结构无效时，Adapter 均拒绝报告成功。
- OpenCode Adapter 要求 Magpie Lane 显式配置 `baseUrl`，并使用隔离的 `OPENCODE_CONFIG`、`OPENCODE_DB` 和 `XDG_*`。`external_directory` 权限只为已启用交接的尝试草稿目录开例外，网络、task 和 skill 工具保持禁用。完成检查要求 `activeProcesses=0` 的停止凭证以及 NDJSON 中至少一个 `step_finish`。
- Magpie 请求级对账已接入：OpenCode 完成后按精确会话 ID 查询请求行，在本地按尝试时窗复核，写入 `attempt_usage` 并从一致的服务模型回填 `attempts.actual_model`。对账失败只记录 `usage_reconciled` 事件，不阻断任务完成；服务商账单始终保留为 `UNKNOWN`。
- 预算租约已接入：仅对显式配置 `budgets` 的账户记账；预留时先占用 `holdPerAttempt`，已定价用量结算后收缩到网关估算成本，用量未知或不完整时保留 hold 并标记 `pending`。活跃尝试持有的租约即使超过名义时间也继续占用预算，直到尝试结束并重新结算。已结束租约到期后以 `expired` 状态保留金额、`expiredAt` 和一次 `budget_lease_expired` 事件。预算不足会使任务进入 `waiting_quota`、`reason=budget` 或 `cooldown`，并等待最早到期时间。`budget status` 自动执行过期审计，`budget audit` 返回当前策略和最近过期租约。 [到期审计证据](evidence/phase1-budget-expiry-audit-2026-11-27.json)
- Worker 每次预留后写入 `owner.json`，`worker once` 启动时检查遗留活动尝试。已启动的受监督尝试须等旧 owner 退出并取得 `activeProcesses=0` 凭证，才能保存检查点并重新入队。凭证缺失时任务进入 `blocked` 并保留活动尝试。恢复结束时，unknown usage 形成的 `pending` lease 会把到期时间写入账户冷却和重新入队任务的 `nextWakeAt`，避免恢复后立即争抢同一预算窗口。之后取得凭证，可再次执行 `worker recover`。
- `task retry` 可将没有活动尝试的 `failed`、`blocked` 或等待任务重新入队，保留既有检查点和尝试历史。总尝试次数限制为 3。
- `task add --handoff` 为新任务启用交接笔记。`--handoff-protect` 可重复指定要在后续尝试保留的仓库路径。 [交接笔记](#跨-agent-交接笔记)
- 活动取消已接入：第二个 CLI 进程对运行中任务写入 `cancel_requested` 事件并把状态置为 `cancelling`；Worker 轮询后向 Adapter 发送 `AbortSignal`。受监督命令由 Job Object、macOS 进程树或 Linux subreaper 停止。Codex 先调用 `turn/interrupt`，再关闭受监督 App Server 并要求 `activeProcesses=0` 的停止凭证，随后保存检查点并结算为 `cancelled`。重启时发现未完成取消请求也会在停止凭证满足后完成取消。
- 取消超时升级与无响应 Worker 强制回收已接入：`task cancel --wait <ms>` 等待协作取消并明确报告超时；`--force` 写入原子取消标记并记录 `cancel_forced` 事件。受监督路径由 Job Object 监督器停止进程树，再终止无响应的 owner；控制面只在该停止凭证的 `activeProcesses=0` 且 owner 已退出后保存检查点并结算为 `cancelled`。默认 Codex App Server 已纳入该监督范围；自定义或未受监督的 Codex 路径缺少凭证时保守置为 `blocked`，不会转移写权。

预算的 `unit` 是自由文本；示例使用 `magpie-cost-estimate`，表示 Magpie 网关估算，不是服务商发票币种。没有配置预算的 Lane 保持原有额度调度行为。

## 本地运行

```powershell
Copy-Item quotaflow.config.example.json quotaflow.config.json
bun run src/cli.ts config validate
bun run src/cli.ts task add "Describe the first task" --prompt "Implement and verify the task" --repo C:\path\to\repo
bun run src/cli.ts task list
bun run src/cli.ts task show <task-id>
bun run src/cli.ts task events <task-id>
bun run src/cli.ts task cancel <task-id> --wait 5000
bun run src/cli.ts task cancel <task-id> --force --wait 10000
bun run src/cli.ts task retry <task-id>
bun run src/cli.ts task prepare <task-id>
bun run src/cli.ts budget status
bun run src/cli.ts budget audit --limit 100
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

上述用量回写证据产生于 schema v4。v5 引入预算租约，v6 引入交接数据，v7 增加租约过期时间并保留已有请求、预算和交接数据。 [既有预算租约证据](evidence/phase1-budget-lease-2026-11-27.json)

重启恢复通过一次真实控制器进程终止演练验证：受监督任务写入部分结果后，控制器被强制结束；下一轮 `worker once` 依据 `stopped.json` 的 `activeProcesses=0` 凭证保存首个检查点、把任务重新入队，并由第二次尝试完成。结果见[重启恢复证据](evidence/phase1-restart-recovery-2026-11-27.json)。恢复不会释放未知用量的预算 hold，而是保留 `pending` 直到租约过期或后续核销。

活动取消通过第二个 CLI 进程完成跨进程演练：受监督任务写入部分结果后进入等待，`task cancel` 将任务置为 `cancelling`；Worker 收到取消事件后停止 Job Object、保存检查点并结算为 `cancelled`。Codex turn 中断和 OpenCode AbortSignal 路径另有 Adapter 测试。结果见[活动取消证据](evidence/phase1-active-cancellation-2026-11-27.json)。

取消超时升级通过一个故意不轮询取消事件的无响应 owner 演练验证：第二个 CLI 先确认 `--wait` 超时，再使用 `--force` 写入 `cancel.flag`；Windows Job Object 监督器停止进程树并终止 owner，`stopped.json` 提供 `activeProcesses=0`，随后保存部分工作检查点并结算为 `cancelled`。默认 Codex App Server 已使用同一 Job Object 监督；任何自定义、未受监督或无凭证的 Codex 尝试仍置为 `blocked`，检查点保持为空。结果见[取消升级证据](evidence/phase1-cancel-escalation-2026-11-27.json)。

`--wait` 观察协作取消，超时以退出码 2 报告。`--force` 由 Windows Job Object 或 macOS 本地命令监督器先停止受监督进程集，再终止无响应的 owner。检查点与状态转移须等停止凭证发布，且 `owner.json` 指向的写入进程已经退出。缺少凭证的 Server 仍会保守置为 `blocked`。

Codex 受监督停止契约通过三层验证：受监督 stdio fixture 完成双向管道回显并发布停止凭证；Adapter 缺少 `activeProcesses=0` 时拒绝返回成功，Worker 不保存检查点并阻塞任务；本机 Codex CLI 0.172.0 的 `app-server` 完成零推理初始化和关闭，返回 `exitCode=0`、`activeProcesses=0`、`reason=worker_exit`。可用 `bun run poc/codex-app-server-guarded-smoke.ts <codex.exe>` 复跑。结果见[Codex 受监督停止证据](evidence/phase1-codex-supervised-stop-2026-11-27.json)。

## 本地命令与平台监督

Apple Silicon 上已用 macOS 26.6.2、Bun 1.4.5、Git 2.56.1 和 Apple clang 21 验证。Linux aarch64 上已用 Bun 1.4.5、Git 2.47.3 和 GCC 14.2 验证。macOS 需要 Xcode 或 Command Line Tools 提供的 `/usr/bin/cc`，Linux 需要 C 编译器与 libc 开发头文件。例如，在 macOS 或 Linux 终端运行以下命令复跑本地 PoC 和 App Server 零推理预检。

```sh
bun run src/cli.ts config validate --config quotaflow.config.example.json
bun test
bun run build
bun dist/cli.js --help
bun run poc/demo.ts
node poc/app-server-preflight.mjs codex --transport stdio
```

在本地 Lane 的 `command` 中指定可执行文件和参数。使用 fixture 时，为 `src/fixture-agent.ts` 提供绝对路径，因为命令会在任务工作树中运行。示例配置中的额度窗口仍为占位值，使用 fixture 时可为 `local` Lane 配置有测试余量的窗口。

启动前先写入 `launch.json`，再由独立的原生监督器创建命令进程组。macOS 每 25 毫秒枚举根进程的后代及其进程组，并用 PID 启动时间区分复用。Linux 监督器以 subreaper 收养失去原始父进程的后代，并扫描 `/proc` 跟踪 PID、进程组、会话和启动时间。命令退出、额度中断、超时、取消或控制器退出后，监督器停止整个已知进程树并用内核进程列表复核。`--force` 先停止该树，再终止仍在运行的 owner。只有在旧 owner 退出并收到凭证后，恢复流程才提交检查点。凭证缺失时保留活动尝试和工作树写入权。

macOS 监督适用于可信工作负载。已覆盖 Codex CLI 0.171.0 `command/exec` 创建的独立进程组，以及 OpenCode 1.19.6 在非 Windows 平台启动的 detached shell。显式 `worker_exit` 和取消演练都验证 `activeProcesses=0` 后才发布改写权。监督器跟踪观察到并记录在案的进程树，不对恶意规避枚举的进程提供安全隔离；不可信代码仍需外部沙箱。 [OpenCode shell 实现](https://github.com/anomalyco/opencode/blob/v1.19.6/packages/core/src/tool/bash.ts)

打包后的 CLI 在 QuotaFlow 临时克隆中完成了强制终止控制器、验证子进程停止、保存检查点、重建工作树和第二次尝试。复跑 `worker recover` 未产生重复恢复。Codex 安装版通过 `/bin/sh` 写入和读回预检，OpenCode 安装版使用模拟的环回响应完成一次 `step_finish`。两项 CLI 验证均使用临时配置，远程模型请求为 0。 [macOS 验证记录](evidence/phase1-macos-supervision-2026-11-27.json)

默认 Adapter 随后在 macOS 完成真实闭环。Codex App Server 经 Magpie `hy4-flash-free` 写入 `app.txt=41`；其零推理预检还通过 `command/exec` 启动后台子进程，关闭凭证为 `activeProcesses=0`。OpenCode 默认路径写入 `app.txt=42`，会话用量 4 行成功回写，实际服务模型为 `hy4-flash-free`。两次 Worker 都完成任务并保存检查点。 [macOS 默认 Adapter 证据](evidence/phase1-macos-default-adapters-2026-11-27.json)

Linux aarch64 在 Bun 官方容器中运行完整测试，结果为 95 通过、1 个 Windows 专用用例跳过、0 失败。同一镜像内使用 Codex CLI 0.171.0 完成零推理初始化、`command/exec` 写读和后台子进程回收，停止凭证为 `activeProcesses=0`。默认 Codex Adapter 另在 macOS 经 Magpie 免费模型写入 `app.txt=43`，通过独立 verifier 验证后保存检查点，确认接口分离没有破坏真实执行。Docker Desktop 默认禁止 Codex 的 namespace 沙箱，因此 Linux smoke 使用 `--privileged`；普通 Linux 主机按实际 namespace 权限运行。 [Linux 与停止契约证据](evidence/phase1-linux-supervision-2026-11-27.json)

## mcarplay 真实 Issue 试点

2026-11-27 在 `mcarplay` 当前 `main`（`daf67e87`）选择 Issue #82。该 Issue 只统一 iAP2 消息目录的方向注释、日志名称和未确认常量名称，不改变消息时序或载荷，可由 JVM 测试离线验证。QuotaFlow 创建独立 Worktree，Codex 经 Magpie `hy4-flash-free` 修改 3 个文件并写入交接笔记，任务在 88 秒内完成，检查点为 `f39bfdf7025ff48c200beb7f81d8dda172f82d15`，停止凭证为 `activeProcesses=0`。

控制面随后运行完整门禁。Android 标准 JVM 测试 1,344 项、remote JVM 测试 25 项、Python 测试 87 项全部通过；Spotless、lint 和 `assembleStandardDebug` 通过。提交 `abc4c5b618ae5a0b0d0e3f5790f44d69be2bff48` 已推送为 Draft PR [#141](https://github.com/wangxso/mcarplay/pull/141)，两次 Android CI 和 GitGuardian 均对同一 HEAD 通过。该 PR 保持 Draft，等待独立审查、人工批准与合并。目录修正不声明新的车型或手机兼容性。 [mcarplay 试点证据](evidence/phase1-mcarplay-issue-82-2026-11-27.json)

## 跨 Agent 交接笔记

在已配置运行 Lane 的仓库中，可用以下命令为一项新任务开启交接。`--handoff-protect` 也会开启交接，可重复指定仓库相对路径，路径使用正斜杠。

```sh
bun run src/cli.ts task add "Finish the retry label" --repo . --handoff --handoff-protect parser.ts
bun run src/cli.ts task show TASK_ID
bun run src/cli.ts task events TASK_ID
```

Agent 在当前回合中更新尝试专用的 `handoff/draft.json`。Codex 和 OpenCode 会收到草稿路径，受监督命令通过 `QUOTAFLOW_HANDOFF_FILE` 写入草稿，通过 `QUOTAFLOW_PROMPT_FILE` 读取本次提示。草稿最多 4 KiB，使用 `version: 1` 及 `completed`、`failedAttempts`、`blockers`、`nextSteps`、`checks` 五个字符串数组。可以将未知项留空，记录实际观察到的测试结果。

Worker 取得停止凭证后，把有效笔记与新检查点在同一次 SQLite 结算中绑定到任务和尝试。草稿位于尝试目录，独立于 Git 工作树。续作从当前检查点查找笔记，缺失、无效、不匹配或超出适配器提示长度时使用原任务提示。写笔记的约定会随当次提示一起传入，无需单独启动回合。`task show` 的 `handoffNote` 显示当前检查点的笔记，`handoff_input` 事件记录接手时选用的尝试。

受保护路径从首次检查点起生效。Worker 在接手前和发布新检查点前比较 Git 树。如果受保护路径有改动，任务进入 `blocked`，保留旧检查点和供检查的工作树改动。修复受保护路径后可重试。若此时已确认写入者因取消而停止，任务可以结算为 `cancelled`，同时拒收违规检查点。

macOS 已用受监督 fixture 验证额度中断后的跨 Lane 接手，并实际强制结束打包后的 Worker，复核笔记绑定、幂等恢复和接续结果。 [接入验证记录](evidence/phase1-handoff-integration-2026-11-27.json)

2026-11-27 又在原生 ChatGPT 返回额度耗尽后，用 Codex 通过 Magpie 的零标价 `hy4-flash-free` 完成任务落盘、草稿写入和 429 换手。三次带笔记与三次仅原提示的 OpenCode 接手均为 3/3 测试通过，且只修改待办的 `label.ts`。带笔记组的工具调用中位数为 8，对照组为 9；计入笔记生成后，总输入 Token 增加 519，输出 Token 减少 4,899，总耗时增加 3.16 秒。样本仍小，交接保持显式启用。 [真实模型交接证据](evidence/phase1-live-handoff-2026-11-27.json)

## 尚未完成

- 基于实际 Provider 账单的预算归属；当前预算只使用网关估算租约。
- Worktree 生命周期自动化。
- 扩大不同模型和任务的交接笔记样本，复核完成率、文件保留情况和含笔记生成的用量。

## 下一里程碑

1. 完成 Phase 2 的独立 Review–Fix、CI 失败分流、重复事件和人工合并门禁。
2. 自动化 Worktree 生命周期、清理和备份恢复。
3. 接入实际 Provider 账单证据，继续把无法核对的归属保留为 `UNKNOWN`。
