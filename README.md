# QuotaFlow

[English](README.en.md) · [路线图](ROADMAP.md#中文) · [贡献指南](AGENTS.md)

QuotaFlow 是一个额度感知的 AI 软件研发调度工具。它按账户额度、并发和预算安排 Codex 或 OpenCode 执行任务，将改动保存在独立的 Git 工作树和检查点中，供中断后恢复。

**当前状态（2026-11-28）**　Phase 0 技术门禁有条件通过。Phase 1 单机 CLI 已具备三平台监督、检查点恢复、预算审计和可选交接笔记。Phase 2 核心闭环完成：同 HEAD CI、独立审查、Draft 与人工合并门禁、签名 Webhook、双层幂等、受限任务物化、只读审查、Bot 批准、CI 日志分类、同 SHA 限次复跑和真实 CI 修复均已验证。真实 PR [#141](https://github.com/wangxso/mcarplay/pull/141) 已人工合并到 `main`，合并提交为 `23033142`。Actions read/write 在受控 PR #146 完成同 SHA 复跑；PR #147 完成失败日志→`ci_fix` 任务→免费 Magpie Agent→checkpoint→补丁回写→新 HEAD CI 转绿→门禁复核。写入应答丢失、重复投递、越权请求和隔离 secret 轮换演练也已通过。稳定入口为 `https://quotaflow-hooks.wangxso.com/github/webhook`，由 macOS launchd 监督并带公网健康自愈。Phase 3 Dashboard 已提供实时任务视图、项目／时间／Lane／审查状态组合筛选，以及带 session、CSRF、确认和审计的 `start`／`cancel`／`retry` 操作；任务详情按 `requestId` 展示 Worker 生命周期，并在关联校验、64 KiB 上限和内容脱敏后读取日志。 [Phase 1](docs/PHASE-1.md) · [Phase 2](docs/PHASE-2.md) · [Phase 3](docs/PHASE-3.md) · [组合筛选证据](docs/evidence/phase3-dashboard-filters-2026-11-28.json)

## 当前功能

- **任务调度**　SQLite v10 持久化任务、尝试、事件、预算租约、GitHub 门禁和 CI 复跑记录。调度器以事务方式预留账户并发槽位、额度和已配置预算。`budget audit` 可审计到期租约，恢复产生的 unknown hold 会联动账户冷却。
- **执行与恢复**　CLI 支持提交、查看、取消和重试任务。Windows 使用 Job Object。macOS 原生监督器跟踪根进程、子进程和进程组。Linux 以 subreaper 收养 detached 后代并扫描 `/proc`。保存检查点和恢复任务均要求独立验证的停止凭证。已启动的受监督尝试在缺少凭证时进入 `blocked`，并保留写入权。只读任务使用 Agent 原生只读策略，并在完成后校验工作树未变化。`--handoff` 可在中断后把与检查点匹配的简短笔记交给下一个 Agent。
- **模型接入与用量**　默认 Codex App Server 与 OpenCode Adapter 支持 Windows、macOS 和 Linux 受监督执行。Magpie 路由需要配置中的显式授权，网关估算用于预算租约，服务商账单归属仍为 `UNKNOWN`。 [配置与适配器说明](docs/PHASE-1.md)
- **GitHub 门禁**　`github snapshot` 通过 GitHub REST 自动读取 PR、当前 HEAD 检查和正式 Review，`github gate` 校验 Draft／mergeable 状态和人工合并要求，输出 Review–Fix／CI 分流计划，并可按稳定动作键物化受尝试次数和预算约束的 Agent 任务。Bot 批准默认不计入，可通过 `githubApproval.allowBotApprovals` 或 `--allow-bot-approvals` 显式启用。`github serve-webhook` 验签后自动写入 Gate，只对显式仓库映射和分支白名单建任务，并从失败 Actions job 提取经过脱敏的分类日志。仅对同一 HEAD 的纯基础设施或取消失败执行默认每 HEAD 一次的原子限额复跑，代码/测试、权限、未知和 SHA 漂移保留人工或修复路径。 [Phase 2 说明](docs/PHASE-2.md)
- **本地 Dashboard**　`dashboard` 在 `127.0.0.1:8788` 启动工作台，展示任务、事件、attempt、Worker Run、checkpoint、handoff、预算、仓库映射和 GitHub Gate/CI。项目与时间范围共享筛选上下文，Tasks 可组合 Lane，GitHub 可组合审查状态，SSE 从 SQLite event cursor 增量更新。受控 `start`／`cancel`／`retry` 使用同源校验、HttpOnly session、CSRF、精确确认、持久请求幂等和审计。`start` 只派生一次性 Worker 子进程，由其重新检查 Lane、额度、预算和 due 状态。Worker 日志必须与任务的 `start` 审计事件关联，只读取最后 64 KiB，并经过符号链接、ANSI、控制字符和敏感字段防护。界面采用 T3 Code 式高密度桌面层级，使用严格 CSP、无第三方资源和 `textContent` 渲染不可信文本。 [Phase 3 说明](docs/PHASE-3.md)

## 快速开始

在仓库根目录运行以下 PowerShell 命令。需要 Bun 和 Git，Windows 受监督执行还需要 Windows PowerShell（`powershell.exe`）。

```powershell
bun run src/cli.ts --help
if (-not (Test-Path -LiteralPath quotaflow.config.json)) {
  Copy-Item quotaflow.config.example.json quotaflow.config.json
}
bun run src/cli.ts config validate
bun run src/cli.ts task add "Inspect the repository" --prompt "Summarize the project layout" --repo .
bun run src/cli.ts task list
```

macOS 需要 Xcode 或 Command Line Tools 提供的 `/usr/bin/cc`。Linux 需要 C 编译器与 libc 开发头文件，例如 Debian／Ubuntu 的 `gcc libc6-dev`。macOS 和 Linux 初始化文件时使用 `cp quotaflow.config.example.json quotaflow.config.json`。其余 CLI 命令与上方相同；示例配置中的 Magpie 端点为 `http://127.0.0.1:3425/v1`。

用 `task add` 返回的任务 ID 替换下方的 `TASK_ID`。示例配置的额度窗口是占位值，使用该配置调用 `worker once` 会进入 `waiting_quota`。运行真实模型前，为已授权的执行通道配置实际额度观测和适配器。 [运行配置](docs/PHASE-1.md#本地运行)

```powershell
bun run src/cli.ts task show TASK_ID
bun run src/cli.ts task events TASK_ID
bun run src/cli.ts worker once --task-id TASK_ID
bun run src/cli.ts budget status
bun run src/cli.ts budget audit --limit 100
bun run src/cli.ts dashboard
```

在受支持的平台上可运行 `bun run poc/demo.ts`，在临时 Git 仓库中复现额度中断和检查点接续，无需模型凭据。macOS 还需要 Xcode 或 Command Line Tools 提供的 C 编译器，Linux 需要 gcc 和 libc 开发头文件。开发时使用 `bun test` 跑测试，使用 `bun run build` 将 CLI 打包到 `dist/`。 [PoC 复跑说明](poc/README.md) · [本地命令与平台监督](docs/PHASE-1.md#本地命令与平台监督)

## 项目文档

| 文档 | 内容 |
| --- | --- |
| [路线图](ROADMAP.md#中文) · [建设计划](docs/PLAN.md) | 阶段状态、交付范围与验收门槛 |
| [架构](docs/ARCHITECTURE.md) · [编排 ADR](docs/adr/0001-orchestration-and-state.md) · [模型接入 ADR](docs/adr/0002-model-access.md) | 调度、恢复和模型接入决策 |
| [Phase 0 报告](docs/PHASE-0.md) · [Phase 1 说明](docs/PHASE-1.md) · [Phase 2 说明](docs/PHASE-2.md) · [Phase 3 说明](docs/PHASE-3.md) · [验收证据](docs/evidence/) | 验证方法、结果和已知限制 |
| [上游调研](docs/RESEARCH.md) · [许可证审查](docs/LICENSING-REVIEW.md) · [需求追踪](docs/TRACEABILITY.md) | 依赖评估与验收映射 |
