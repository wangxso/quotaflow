# QuotaFlow

[English](README.en.md) · [路线图](ROADMAP.md#中文) · [贡献指南](AGENTS.md)

QuotaFlow 是一个额度感知的 AI 软件研发调度工具。它按账户额度、并发和预算安排 Codex 或 OpenCode 执行任务，将改动保存在独立的 Git 工作树和检查点中，供中断后恢复。

**当前状态（2026-11-27）**　Phase 0 技术门禁有条件通过。Phase 1 单机 CLI 已具备三平台监督、检查点恢复、预算审计和可选交接笔记。Phase 2 已启动：QuotaFlow 在真实 `mcarplay` 仓库完成 Issue #82，并创建 Draft PR [#141](https://github.com/wangxso/mcarplay/pull/141)，Android CI 与 GitGuardian 均通过，等待独立审查和人工合并。GUI 计划在 Phase 3 交付。 [Phase 0 验收](docs/PHASE-0-GATE-CLOSURE.md) · [Phase 1 实现与验证](docs/PHASE-1.md) · [mcarplay 试点证据](docs/evidence/phase1-mcarplay-issue-82-2026-11-27.json)

## 当前功能

- **任务调度**　SQLite v7 持久化任务、尝试、事件和预算租约。调度器以事务方式预留账户并发槽位、额度和已配置预算。`budget audit` 可审计到期租约，恢复产生的 unknown hold 会联动账户冷却。
- **执行与恢复**　CLI 支持提交、查看、取消和重试任务。Windows 使用 Job Object。macOS 原生监督器跟踪根进程、子进程和进程组。Linux 以 subreaper 收养 detached 后代并扫描 `/proc`。保存检查点和恢复任务均要求独立验证的停止凭证。已启动的受监督尝试在缺少凭证时进入 `blocked`，并保留写入权。`--handoff` 可在中断后把与检查点匹配的简短笔记交给下一个 Agent。
- **模型接入与用量**　默认 Codex App Server 与 OpenCode Adapter 支持 Windows、macOS 和 Linux 受监督执行。Magpie 路由需要配置中的显式授权，网关估算用于预算租约，服务商账单归属仍为 `UNKNOWN`。 [配置与适配器说明](docs/PHASE-1.md)

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
bun run src/cli.ts budget status
bun run src/cli.ts budget audit --limit 100
```

在受支持的平台上可运行 `bun run poc/demo.ts`，在临时 Git 仓库中复现额度中断和检查点接续，无需模型凭据。macOS 还需要 Xcode 或 Command Line Tools 提供的 C 编译器，Linux 需要 gcc 和 libc 开发头文件。开发时使用 `bun test` 跑测试，使用 `bun run build` 将 CLI 打包到 `dist/`。 [PoC 复跑说明](poc/README.md) · [本地命令与平台监督](docs/PHASE-1.md#本地命令与平台监督)

## 项目文档

| 文档 | 内容 |
| --- | --- |
| [路线图](ROADMAP.md#中文) · [建设计划](docs/PLAN.md) | 阶段状态、交付范围与验收门槛 |
| [架构](docs/ARCHITECTURE.md) · [编排 ADR](docs/adr/0001-orchestration-and-state.md) · [模型接入 ADR](docs/adr/0002-model-access.md) | 调度、恢复和模型接入决策 |
| [Phase 0 报告](docs/PHASE-0.md) · [Phase 1 说明](docs/PHASE-1.md) · [验收证据](docs/evidence/) | 验证方法、结果和已知限制 |
| [上游调研](docs/RESEARCH.md) · [许可证审查](docs/LICENSING-REVIEW.md) · [需求追踪](docs/TRACEABILITY.md) | 依赖评估与验收映射 |
