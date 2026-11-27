# QuotaFlow

[English](README.en.md) · [路线图](ROADMAP.md#中文) · [贡献指南](AGENTS.md)

QuotaFlow 是一个额度感知的 AI 软件研发调度工具。它按账户额度、并发和预算安排 Codex 或 OpenCode 执行任务，将改动保存在独立的 Git 工作树和检查点中，供中断后恢复。

**当前状态（2026-11-27）**　Phase 0 技术门禁有条件通过，已在临时仓库验证 Codex 写入、保存检查点和 OpenCode 接续。Phase 1 单机 CLI 正在开发。Windows 已验证 Magpie 路由任务、OpenCode 请求级用量回写和受监督恢复。macOS 已验证本地命令的取消、子进程回收和 Git 检查点恢复。首个 GitHub 试点计划在 Phase 2 使用 `mcarplay`。 [Phase 0 验收](docs/PHASE-0-GATE-CLOSURE.md) · [Phase 1 实现与验证](docs/PHASE-1.md)

## 当前功能

- **任务调度**　SQLite 持久化任务、尝试和事件。调度器以事务方式预留账户并发槽位、额度和已配置的预算。
- **执行与恢复**　CLI 支持提交、查看、取消和重试任务。Windows 使用 Job Object。macOS 支持受监督的本地 `command`，命令及子进程须留在初始进程组中。保存检查点和恢复任务均要求停止凭证。已启动的受监督尝试在缺少凭证时进入 `blocked`，并保留写入权。
- **模型接入与用量**　默认 Codex App Server 与 OpenCode Adapter 需要 Windows 进程监督。Magpie 路由需要配置中的显式授权，网关估算用于预算租约，服务商账单归属仍为 `UNKNOWN`。 [配置与适配器说明](docs/PHASE-1.md)

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

用 `task add` 返回的任务 ID 替换下方的 `TASK_ID`。示例配置的额度窗口是占位值，使用该配置调用 `worker once` 会进入 `waiting_quota`。运行真实模型前，为已授权的执行通道配置实际额度观测和适配器。 [运行配置](docs/PHASE-1.md#本地运行)

```powershell
bun run src/cli.ts task show TASK_ID
bun run src/cli.ts task events TASK_ID
bun run src/cli.ts budget status
```

在 Windows 或 macOS 上可运行 `bun run poc/demo.ts`，在临时 Git 仓库中复现额度中断和检查点接续，无需模型凭据。macOS 还需要 Xcode 或 Command Line Tools 提供的 C 编译器。开发时使用 `bun test` 跑测试，使用 `bun run build` 将 CLI 打包到 `dist/`。 [PoC 复跑说明](poc/README.md) · [macOS 本地命令验证](docs/PHASE-1.md#macos-本地命令验证)

## 项目文档

| 文档 | 内容 |
| --- | --- |
| [路线图](ROADMAP.md#中文) · [建设计划](docs/PLAN.md) | 阶段状态、交付范围与验收门槛 |
| [架构](docs/ARCHITECTURE.md) · [编排 ADR](docs/adr/0001-orchestration-and-state.md) · [模型接入 ADR](docs/adr/0002-model-access.md) | 调度、恢复和模型接入决策 |
| [Phase 0 报告](docs/PHASE-0.md) · [Phase 1 说明](docs/PHASE-1.md) · [验收证据](docs/evidence/) | 验证方法、结果和已知限制 |
| [上游调研](docs/RESEARCH.md) · [许可证审查](docs/LICENSING-REVIEW.md) · [需求追踪](docs/TRACEABILITY.md) | 依赖评估与验收映射 |
